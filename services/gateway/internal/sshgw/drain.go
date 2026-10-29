package sshgw

import (
	"context"
	"errors"
	"fmt"
	"time"

	"github.com/belov38/boat-dev-clone/libs/tunnel/registry"
)

// Clock is the time source of the drain deadlines; tests use a fake one.
type Clock interface {
	Now() time.Time
	// AfterFunc calls f on its own goroutine once d has passed.
	AfterFunc(d time.Duration, f func()) Timer
}

// Timer is a pending Clock.AfterFunc call.
type Timer interface {
	Stop() bool
}

// realClock is Config.Now with the runtime timers.
type realClock struct{ now func() time.Time }

func (c realClock) Now() time.Time { return c.now() }

func (realClock) AfterFunc(d time.Duration, f func()) Timer { return time.AfterFunc(d, f) }

// OwnerSource gives the current tunnel owner of a machine
// (registry.OwnerCache satisfies it).
type OwnerSource interface {
	Lookup(ctx context.Context, machineID string) (registry.Owner, bool, error)
}

// drainWarningFormat is the drain warning (spec 10.3); %d is whole minutes,
// rounded up.
const drainWarningFormat = "sbx: gateway restarting, this SSH session will close in %d min; reconnect to continue"

// lastWarning is how long before the deadline the second warning goes out.
const lastWarning = time.Minute

// jobTimeout bounds one queued registry read or recheck call batch.
const jobTimeout = 30 * time.Second

func drainWarning(remaining time.Duration) string {
	n := max((remaining+time.Minute-1)/time.Minute, 1)
	return fmt.Sprintf(drainWarningFormat, int64(n))
}

// drainEntry is the drain deadline of one session. Guarded by
// Server.sessMu.
type drainEntry struct {
	// at is the deadline; zero while none is known.
	at time.Time
	// gen tells the timers of an older deadline from the current ones.
	gen    uint64
	timers []Timer
}

func (e *drainEntry) stop() {
	for _, t := range e.timers {
		t.Stop()
	}
	e.timers = nil
}

// Drain starts the instance's own drain at start: every session, also the
// ones accepted later, closes at start + DrainDeadline at the latest, with
// warnings on its interactive channels. It does not stop accepting (see
// StopAccepting): the load balancer still sends conns for a few seconds.
// An earlier start than a previous call's wins.
func (s *Server) Drain(start time.Time) {
	s.sessMu.Lock()
	if !s.ownStart.IsZero() && !start.Before(s.ownStart) {
		s.sessMu.Unlock()
		return
	}
	s.ownStart = start
	s.sessMu.Unlock()
	s.log.Info("sshgw: drain started", "sessions", s.Sessions(), "deadline", start.Add(s.cfg.DrainDeadline))
	for _, t := range s.targets() {
		s.applyDeadline(t)
	}
}

// StopAccepting closes the listeners; Serve returns nil and open
// connections keep running. Later Serve calls close their listener at once.
func (s *Server) StopAccepting() {
	s.mu.Lock()
	defer s.mu.Unlock()
	s.noAccept = true
	for ln := range s.lns {
		_ = ln.Close()
	}
}

// InstanceChanged re-reads the drain start of a gateway instance that owns
// the tunnel of some sessions' backend streams and moves their deadlines
// earlier when it drains. "" re-reads every owner of an open session. An
// instance that is gone is forgotten: its streams end by themselves.
func (s *Server) InstanceChanged(ctx context.Context, id string) {
	if id != "" {
		s.readOwner(ctx, id)
		return
	}
	seen := map[string]bool{}
	for _, t := range s.targets() {
		if o := t.ownerInstance(); o != "" && !seen[o] {
			seen[o] = true
			s.readOwner(ctx, o)
		}
	}
}

// MachineChanged is the fallback signal of an owner drain (spec 10.3): when
// the tunnel of a machine moved while a session's backend stream still runs
// through the old owner, that owner drains, so its drain start is re-read.
// "" checks the machines of all open sessions.
func (s *Server) MachineChanged(ctx context.Context, machineID string) {
	if s.cfg.Owners == nil {
		return
	}
	// machine -> the owner instances of its sessions' backend streams.
	owners := map[string]map[string]bool{}
	for _, t := range s.targets() {
		m, o := t.ident().Auth.MachineID, t.ownerInstance()
		if m == "" || o == "" || (machineID != "" && m != machineID) {
			continue
		}
		if owners[m] == nil {
			owners[m] = map[string]bool{}
		}
		owners[m][o] = true
	}
	stale := map[string]bool{}
	for m, insts := range owners {
		cur, ok, err := s.cfg.Owners.Lookup(ctx, m)
		if err != nil {
			s.log.Warn("sshgw: owner lookup failed", "machine_id", m, "err", err)
			continue
		}
		for o := range insts {
			if !ok || cur.InstanceID != o {
				stale[o] = true
			}
		}
	}
	for o := range stale {
		s.readOwner(ctx, o)
	}
}

// NotifyInstance queues InstanceChanged(id) and returns at once.
func (s *Server) NotifyInstance(id string) {
	s.enqueue(s.jobs, "instance:"+id, func(ctx context.Context) {
		ctx, cancel := context.WithTimeout(ctx, jobTimeout)
		defer cancel()
		s.InstanceChanged(ctx, id)
	})
}

// NotifyMachine queues MachineChanged(machineID) and returns at once.
func (s *Server) NotifyMachine(machineID string) {
	s.enqueue(s.jobs, "machine:"+machineID, func(ctx context.Context) {
		ctx, cancel := context.WithTimeout(ctx, jobTimeout)
		defer cancel()
		s.MachineChanged(ctx, machineID)
	})
}

// readOwner reads the drain start of instance id and applies it to the
// sessions whose backend stream runs through it.
func (s *Server) readOwner(ctx context.Context, id string) {
	src := s.cfg.Instances
	if src == nil {
		return
	}
	inst, err := src.Instance(ctx, id)
	switch {
	case errors.Is(err, registry.ErrNotFound):
		s.sessMu.Lock()
		delete(s.ownerDrain, id)
		s.sessMu.Unlock()
		return
	case err != nil:
		s.log.Warn("sshgw: reading the owner instance failed", "owner", id, "err", err)
		return
	case inst.DrainStartedAt == nil:
		return
	}
	start := *inst.DrainStartedAt
	s.sessMu.Lock()
	if prev, ok := s.ownerDrain[id]; ok && !start.Before(prev) {
		s.sessMu.Unlock()
		return
	}
	s.ownerDrain[id] = start
	s.sessMu.Unlock()
	s.log.Info("sshgw: owner instance draining", "owner", id, "drain_started_at", start)
	for _, t := range s.targets() {
		if t.ownerInstance() == id {
			s.applyDeadline(t)
		}
	}
}

// applyDeadline recomputes the deadline of t: min(own drain start, drain
// start of its owner instance) + DrainDeadline. A deadline only ever moves
// earlier. Each new deadline is announced at once and, when more than a
// minute is left, again a minute before it; at the deadline the connection
// closes.
func (s *Server) applyDeadline(t target) {
	owner := t.ownerInstance()
	s.sessMu.Lock()
	e, ok := s.sessions[t]
	if !ok {
		s.sessMu.Unlock()
		return
	}
	start := s.ownStart
	if od, ok := s.ownerDrain[owner]; ok && owner != "" && (start.IsZero() || od.Before(start)) {
		start = od
	}
	if start.IsZero() {
		s.sessMu.Unlock()
		return
	}
	at := start.Add(s.cfg.DrainDeadline)
	if !e.at.IsZero() && !at.Before(e.at) {
		s.sessMu.Unlock()
		return
	}
	e.stop()
	e.at = at
	e.gen++
	gen := e.gen
	remaining := at.Sub(s.clock.Now())
	if remaining > 0 {
		if remaining > lastWarning {
			e.timers = append(e.timers, s.clock.AfterFunc(remaining-lastWarning, func() { s.drainTimer(t, gen, false) }))
		}
		e.timers = append(e.timers, s.clock.AfterFunc(remaining, func() { s.drainTimer(t, gen, true) }))
	}
	s.sessMu.Unlock()
	if remaining <= 0 {
		t.closeWithReason(reasonDrain)
		return
	}
	t.notify(drainWarning(remaining), true)
}

// drainTimer is the second warning (final false) or the close at the
// deadline (final true) of deadline generation gen.
func (s *Server) drainTimer(t target, gen uint64, final bool) {
	s.sessMu.Lock()
	e, ok := s.sessions[t]
	if !ok || e.gen != gen {
		s.sessMu.Unlock()
		return
	}
	at := e.at
	s.sessMu.Unlock()
	if final {
		t.closeWithReason(reasonDrain)
		return
	}
	t.notify(drainWarning(at.Sub(s.clock.Now())), true)
}
