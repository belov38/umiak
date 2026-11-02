// Package readiness tracks the agent's readiness phases (spec section 8.5)
// and reports every change as a readiness.changed event.
package readiness

import (
	"context"
	"slices"
	"sync"
	"time"

	"google.golang.org/protobuf/types/known/timestamppb"

	agentv1 "github.com/belov38/umiak/libs/proto/umiak/agent/v1"

	"github.com/belov38/umiak/services/guest-agent/internal/events"
)

// Base phases, in report order.
const (
	PhaseAgent    = "agent"
	PhaseIdentity = "identity"
	PhaseClaim    = "claim"
	PhaseSecrets  = "secrets"
	PhaseDocker   = "docker"
)

// basePhases are always reported, before any extra phase.
var basePhases = []string{PhaseAgent, PhaseIdentity, PhaseClaim, PhaseSecrets, PhaseDocker}

// phase is the state of one phase.
type phase struct {
	state     agentv1.PhaseState
	err       string
	changedAt time.Time
	readyAt   time.Time // first transition into ready; zero until then
}

// Tracker holds the state of every phase. Its methods are safe for
// concurrent use.
type Tracker struct {
	required []string
	emit     events.Emitter
	now      func() time.Time

	mu      sync.Mutex
	order   []string // base phases, then extras in registration order
	phases  map[string]*phase
	changed chan struct{} // closed and replaced on every change
}

// New returns a Tracker with the base phases and the required phases
// pending. required lists the phases that gate Ready; emit receives
// readiness.changed (nil discards); now is the clock (nil: time.Now).
func New(required []string, emit events.Emitter, now func() time.Time) *Tracker {
	if now == nil {
		now = time.Now
	}
	t := &Tracker{
		required: slices.Clone(required),
		emit:     emit,
		now:      now,
		phases:   map[string]*phase{},
		changed:  make(chan struct{}),
	}
	t.registerLocked(basePhases...)
	t.registerLocked(required...)
	return t
}

// Register adds phases unknown so far as pending without an event.
func (t *Tracker) Register(names ...string) {
	t.mu.Lock()
	defer t.mu.Unlock()
	t.registerLocked(names...)
}

func (t *Tracker) registerLocked(names ...string) {
	at := t.now()
	for _, n := range names {
		if _, ok := t.phases[n]; ok || n == "" {
			continue
		}
		t.phases[n] = &phase{state: agentv1.PhaseState_PHASE_STATE_PENDING, changedAt: at}
		t.order = append(t.order, n)
	}
}

// Set records the state of a phase and emits readiness.changed if the state
// or the error text changed. An unknown phase is added after the others.
func (t *Tracker) Set(name string, state agentv1.PhaseState, errMsg string) {
	t.mu.Lock()
	defer t.mu.Unlock()
	p, ok := t.phases[name]
	if ok && p.state == state && p.err == errMsg {
		return
	}
	at := t.now()
	if !ok {
		p = &phase{}
		t.phases[name] = p
		t.order = append(t.order, name)
	}
	p.state, p.err, p.changedAt = state, errMsg, at
	if state == agentv1.PhaseState_PHASE_STATE_READY && p.readyAt.IsZero() {
		p.readyAt = at
	}
	close(t.changed)
	t.changed = make(chan struct{})
	if t.emit != nil {
		t.emit.Emit(events.TypeReadinessChanged, &agentv1.ReadinessChanged{Phase: name, State: state, Error: errMsg})
	}
}

// State returns the state and error text of a phase; an unknown phase is
// reported as unspecified.
func (t *Tracker) State(name string) (agentv1.PhaseState, string) {
	t.mu.Lock()
	defer t.mu.Unlock()
	p, ok := t.phases[name]
	if !ok {
		return agentv1.PhaseState_PHASE_STATE_UNSPECIFIED, ""
	}
	return p.state, p.err
}

// Phases returns every phase in report order: agent, identity, claim,
// secrets, docker, then the extras.
func (t *Tracker) Phases() []*agentv1.Phase {
	t.mu.Lock()
	defer t.mu.Unlock()
	return t.phasesLocked()
}

func (t *Tracker) phasesLocked() []*agentv1.Phase {
	out := make([]*agentv1.Phase, 0, len(t.order))
	for _, n := range t.order {
		p := t.phases[n]
		out = append(out, &agentv1.Phase{
			Name:      n,
			State:     p.state,
			Error:     p.err,
			ChangedAt: timestamppb.New(p.changedAt),
		})
	}
	return out
}

// Ready reports whether every required phase is ready or disabled.
func (t *Tracker) Ready() bool {
	t.mu.Lock()
	defer t.mu.Unlock()
	return t.readyLocked()
}

func (t *Tracker) readyLocked() bool {
	for _, n := range t.required {
		if p, ok := t.phases[n]; !ok || !satisfied(p.state) {
			return false
		}
	}
	return true
}

// ReadyAt returns when the phase first became ready, or the zero time. The
// value comes from the tracker's clock and keeps its monotonic reading.
func (t *Tracker) ReadyAt(name string) time.Time {
	t.mu.Lock()
	defer t.mu.Unlock()
	if p, ok := t.phases[name]; ok {
		return p.readyAt
	}
	return time.Time{}
}

// Wait blocks until the phase is ready or disabled, or ctx ends.
func (t *Tracker) Wait(ctx context.Context, name string) error {
	for {
		t.mu.Lock()
		p, ok := t.phases[name]
		done := ok && satisfied(p.state)
		ch := t.changed
		t.mu.Unlock()
		if done {
			return nil
		}
		select {
		case <-ch:
		case <-ctx.Done():
			return ctx.Err()
		}
	}
}

// satisfied reports whether a state counts as done for Ready and Wait.
func satisfied(s agentv1.PhaseState) bool {
	return s == agentv1.PhaseState_PHASE_STATE_READY || s == agentv1.PhaseState_PHASE_STATE_DISABLED
}

// Snapshot returns Phases and Ready from one consistent read.
func (t *Tracker) Snapshot() ([]*agentv1.Phase, bool) {
	t.mu.Lock()
	defer t.mu.Unlock()
	return t.phasesLocked(), t.readyLocked()
}
