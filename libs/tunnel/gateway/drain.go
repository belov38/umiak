package gateway

import (
	"context"
	"errors"
	"sync"
	"time"

	"github.com/belov38/umiak/libs/tunnel/registry"
	"github.com/belov38/umiak/libs/tunnel/transport"
)

const (
	// drainReason is the reason sent in Control/Drain.
	drainReason = "gateway_shutdown"
	// drainCallTimeout bounds one Control/Drain call.
	drainCallTimeout = 10 * time.Second
)

// Drain takes the instance out of service without losing calls (spec 7):
//
//  1. Ready turns false, admission answers 503 and the registry row turns
//     draining (drain_started_at is set, NOTIFY gateway_instances).
//  2. It waits Timing.EndpointWait for the ingress to drop the instance.
//  3. It sends Control/Drain{reason: "gateway_shutdown"} to every active
//     session, the i-th of n at i*DrainSpread/n. The tcp_deadline sent is
//     the longest drain deadline of the session's open TCP streams, at
//     least Timing.TCPDeadline.
//  4. Agents reconnect elsewhere (make-before-break); a session whose machine
//     moved aborts its RPC streams at once and keeps each TCP stream until
//     its own deadline, then closes.
//  5. It waits until no session is left, or until EndpointWait + DrainSpread
//     + the longest TCP drain deadline + Timing.DrainMargin have passed since
//     the start.
//  6. It stops Run, which closes the remaining sessions (marking them
//     disconnected) and deletes the instance row.
//
// Drain returns once Run has returned. It is idempotent: later calls wait
// for the first one (or their own ctx) and return its result. When ctx ends,
// the waits are cut short, the remaining sessions are closed as in step 6
// and ctx's error is returned. Run must have been started.
//
// Drain does not stop the internal listener. Shut it down gracefully
// (http.Server.Shutdown) after Drain returns, so proxied streams aborted by
// the move can finish their end-stream message before the process exits.
func (g *Gateway) Drain(ctx context.Context) error {
	if !g.started.Load() {
		return errors.New("gateway: Drain called before Run")
	}
	if !g.drainStarted.CompareAndSwap(false, true) {
		select {
		case <-g.drainDone:
			return g.drainErr
		case <-ctx.Done():
			return ctx.Err()
		}
	}
	g.drainErr = g.drain(ctx)
	close(g.drainDone)
	return g.drainErr
}

func (g *Gateway) drain(ctx context.Context) error {
	select {
	case <-g.runDone:
		return nil // Run already stopped: nothing is served any more
	default:
	}
	t := g.cfg.Timing
	start := time.Now()
	g.draining.Store(true)
	g.log.Info("gateway: drain started", "sessions", g.sessionCount())

	// wctx ends with ctx, or when Run stopped by itself (its ctx, Abandon).
	wctx, cancel := context.WithCancel(ctx)
	defer cancel()
	go func() {
		select {
		case <-g.runDone:
			cancel()
		case <-wctx.Done():
		}
	}()

	sctx, scancel := context.WithTimeout(context.WithoutCancel(ctx), dbTimeout)
	if err := g.store.SetInstanceState(sctx, g.cfg.InstanceID, registry.InstanceDraining); err != nil {
		g.log.Warn("gateway: marking the instance draining failed", "err", err)
	}
	scancel()

	var calls sync.WaitGroup
	if sleepCtx(wctx, t.EndpointWait) {
		longest := g.drainSessions(wctx, &calls)
		// Streams opened after a session was drained count as well.
		for _, s := range g.snapshotSessions() {
			longest = max(longest, s.longestTCPDeadline())
		}
		deadline := start.Add(t.EndpointWait + t.DrainSpread + longest + t.DrainMargin)
		g.waitSessionsGone(wctx, deadline)
	}
	err := ctx.Err()
	remaining := g.sessionCount()

	g.drainedOnce.Do(func() { close(g.drainedCh) })
	<-g.runDone
	cancel()
	calls.Wait()
	g.log.Info("gateway: drain finished", "took", time.Since(start), "closed_sessions", remaining, "err", err)
	return err
}

// drainSessions sends Control/Drain to every active session, spread over
// DrainSpread, and returns the longest tcp_deadline sent (at least
// Timing.TCPDeadline). The calls run on calls.
func (g *Gateway) drainSessions(ctx context.Context, calls *sync.WaitGroup) time.Duration {
	t := g.cfg.Timing
	longest := t.TCPDeadline
	sessions := g.activeSessions()
	sent := make(map[*session]bool, len(sessions))
	base := time.Now()
	for i, s := range sessions {
		at := base.Add(t.DrainSpread * time.Duration(i) / time.Duration(len(sessions)))
		if !sleepCtx(ctx, time.Until(at)) {
			return longest
		}
		longest = max(longest, g.drainOne(ctx, s, calls))
		sent[s] = true
	}
	// Sessions whose admission raced with the draining flag.
	for _, s := range g.activeSessions() {
		if !sent[s] {
			longest = max(longest, g.drainOne(ctx, s, calls))
		}
	}
	return longest
}

// drainOne starts Control/Drain on one session and returns its tcp_deadline.
func (g *Gateway) drainOne(ctx context.Context, s *session, calls *sync.WaitGroup) time.Duration {
	d := s.longestTCPDeadline()
	calls.Go(func() {
		cctx, cancel := context.WithTimeout(ctx, drainCallTimeout)
		defer cancel()
		err := s.mc.Drain(cctx, transport.DrainOptions{Reason: drainReason, TCPDeadline: d})
		if err != nil && cctx.Err() == nil {
			s.log.Warn("gateway: Control/Drain failed", "err", err)
		}
	})
	return d
}

// activeSessions returns the registered sessions in the active state.
func (g *Gateway) activeSessions() []*session {
	all := g.snapshotSessions()
	out := all[:0]
	for _, s := range all {
		if s.state() == stateActive {
			out = append(out, s)
		}
	}
	return out
}

// sessionCount returns the number of registered sessions (any state but closed).
func (g *Gateway) sessionCount() int {
	g.mu.Lock()
	defer g.mu.Unlock()
	return len(g.sessions)
}

// waitSessionsGone waits until no session is registered, deadline passes or
// ctx ends.
func (g *Gateway) waitSessionsGone(ctx context.Context, deadline time.Time) {
	timer := time.NewTimer(time.Until(deadline))
	defer timer.Stop()
	for g.sessionCount() > 0 {
		select {
		case <-g.sessGone:
		case <-timer.C:
			g.log.Warn("gateway: drain deadline passed; closing the remaining sessions", "sessions", g.sessionCount())
			return
		case <-ctx.Done():
			return
		}
	}
}
