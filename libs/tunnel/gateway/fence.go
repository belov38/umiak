package gateway

import (
	"context"
	"errors"
	"fmt"
	"sync"
	"time"

	"github.com/belov38/boat-dev-clone/libs/tunnel/registry"
)

// listenLoop feeds registry notifications to the fence and instance
// workers. The handlers only enqueue: they run on the LISTEN goroutine.
func (g *Gateway) listenLoop(ctx context.Context) {
	h := registry.ListenHandlers{Session: g.fenceQ.push}
	if g.cfg.OnInstanceChange != nil {
		h.Instance = g.instQ.push
	}
	_ = g.store.Listen(ctx, h)
}

// instanceWorker calls OnInstanceChange for every queued instance id.
func (g *Gateway) instanceWorker(ctx context.Context) {
	for {
		select {
		case <-ctx.Done():
			return
		case <-g.instQ.signal:
		}
		for _, id := range g.instQ.take() {
			if ctx.Err() != nil {
				return
			}
			g.cfg.OnInstanceChange(id)
		}
	}
}

// fenceWorker re-checks local sessions against the registry (spec 8.3).
// "" (after a LISTEN reconnect, when notifications may have been missed)
// re-checks every local session.
func (g *Gateway) fenceWorker(ctx context.Context) {
	for {
		select {
		case <-ctx.Done():
			return
		case <-g.fenceQ.signal:
		}
		ids, all := g.fenceQ.take()
		if all {
			for _, s := range g.snapshotSessions() {
				ids[s.machineID] = struct{}{}
			}
		}
		for id := range ids {
			if ctx.Err() != nil {
				return
			}
			g.checkFence(ctx, id)
		}
	}
}

// checkFence closes or moves the local session of a machine when the
// registry says it is superseded: a higher epoch (or another instance), the
// machine retired, or the row at our epoch already disconnected (swept).
// Registry errors re-queue the machine after fenceRetry.
func (g *Gateway) checkFence(ctx context.Context, machineID string) {
	s, st := g.lookup(machineID)
	if s == nil || st == stateMoved {
		return
	}
	cctx, cancel := context.WithTimeout(ctx, dbTimeout)
	defer cancel()
	reg, err := g.store.Session(cctx, machineID)
	missing := errors.Is(err, registry.ErrNotFound)
	if err != nil && !missing {
		g.fenceRetryLater(ctx, machineID, err)
		return
	}
	retired, err := g.store.Retired(cctx, machineID)
	if err != nil {
		g.fenceRetryLater(ctx, machineID, err)
		return
	}
	epoch := s.info.Epoch
	switch {
	case retired:
		// A retired machine has no new owner to move to: close at once.
		s.log.Info("gateway: closing session of a retired machine", "reason", "machine retired")
		s.close("machine retired")
	case missing:
		s.fence("session row missing")
	case reg.Epoch > epoch || (reg.Epoch == epoch && reg.InstanceID != g.cfg.InstanceID):
		s.fence(fmt.Sprintf("superseded by epoch %d on %s", reg.Epoch, reg.InstanceID))
	case reg.Epoch == epoch && reg.State == registry.SessionDisconnected:
		s.fence("registry marked the session disconnected")
	}
}

func (g *Gateway) fenceRetryLater(ctx context.Context, machineID string, err error) {
	if ctx.Err() != nil {
		return
	}
	g.log.Warn("gateway: fence check failed, retrying", "machine_id", machineID, "err", err, "retry_in", fenceRetry)
	time.AfterFunc(fenceRetry, func() {
		if ctx.Err() == nil {
			g.fenceQ.push(machineID)
		}
	})
}

// machineQueue is an unbounded, coalescing set of machine ids to check.
type machineQueue struct {
	mu     sync.Mutex
	ids    map[string]struct{}
	all    bool
	signal chan struct{}
}

func newMachineQueue() *machineQueue {
	return &machineQueue{ids: map[string]struct{}{}, signal: make(chan struct{}, 1)}
}

// push queues a machine id; "" queues a check of every local session. It never blocks.
func (q *machineQueue) push(id string) {
	q.mu.Lock()
	if id == "" {
		q.all = true
	} else {
		q.ids[id] = struct{}{}
	}
	q.mu.Unlock()
	select {
	case q.signal <- struct{}{}:
	default:
	}
}

func (q *machineQueue) take() (map[string]struct{}, bool) {
	q.mu.Lock()
	defer q.mu.Unlock()
	ids, all := q.ids, q.all
	q.ids, q.all = map[string]struct{}{}, false
	return ids, all
}

// idQueue is an unbounded FIFO of ids.
type idQueue struct {
	mu     sync.Mutex
	ids    []string
	signal chan struct{}
}

func newIDQueue() *idQueue { return &idQueue{signal: make(chan struct{}, 1)} }

// push queues id. It never blocks.
func (q *idQueue) push(id string) {
	q.mu.Lock()
	q.ids = append(q.ids, id)
	q.mu.Unlock()
	select {
	case q.signal <- struct{}{}:
	default:
	}
}

func (q *idQueue) take() []string {
	q.mu.Lock()
	defer q.mu.Unlock()
	ids := q.ids
	q.ids = nil
	return ids
}
