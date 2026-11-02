// Package events names the agent's journal events and gives components a
// narrow way to emit them (spec section 14.4).
package events

import (
	"slices"
	"sync"

	"google.golang.org/protobuf/proto"

	"github.com/belov38/umiak/services/guest-agent/internal/store"
)

// Event types written to the journal.
const (
	TypeAgentStarted      = "agent.started"
	TypeIdentityReset     = "identity.reset"
	TypeCommandExited     = "command.exited"
	TypeReadinessChanged  = "readiness.changed"
	TypeClaimApplied      = "claim.applied"
	TypePortsChanged      = "ports.changed"
	TypeIdleChanged       = "idle.changed"
	TypeActivity          = "activity"
	TypePtyClosed         = "pty.closed"
	TypeQuiesceAutoThawed = "quiesce.auto_thawed"
	TypeDiskLow           = "disk.low"
	TypeDiskOK            = "disk.ok"
	TypeUpdateResult      = "update.result"
	TypeJournalGap        = "journal.gap"
	TypeOutputTruncated   = "output.truncated"
)

// Emitter publishes an event. Emit never blocks and never fails; a nil
// payload yields an event without payload.
type Emitter interface {
	Emit(typ string, payload proto.Message)
}

// StoreEmitter returns an Emitter that appends to the journal of st.
func StoreEmitter(st *store.Store) Emitter {
	return storeEmitter{st: st}
}

type storeEmitter struct{ st *store.Store }

// Emit implements Emitter.
func (e storeEmitter) Emit(typ string, payload proto.Message) {
	e.st.AppendEvent(typ, payload)
}

// Recorded is one event captured by a Recorder.
type Recorded struct {
	Type    string
	Payload proto.Message
}

// Recorder is an Emitter for tests: it keeps what it was given. The zero
// value is ready to use and safe for concurrent use.
type Recorder struct {
	mu  sync.Mutex
	all []Recorded
}

// Emit implements Emitter.
func (r *Recorder) Emit(typ string, payload proto.Message) {
	r.mu.Lock()
	defer r.mu.Unlock()
	r.all = append(r.all, Recorded{Type: typ, Payload: payload})
}

// All returns every recorded event in emit order.
func (r *Recorder) All() []Recorded {
	r.mu.Lock()
	defer r.mu.Unlock()
	return slices.Clone(r.all)
}

// Of returns the payloads of the recorded events of type typ in emit order.
func (r *Recorder) Of(typ string) []proto.Message {
	r.mu.Lock()
	defer r.mu.Unlock()
	var out []proto.Message
	for _, ev := range r.all {
		if ev.Type == typ {
			out = append(out, ev.Payload)
		}
	}
	return out
}
