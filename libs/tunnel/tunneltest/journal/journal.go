// Package journal is an in-memory agent event journal for tests. It
// implements agent.EventJournal.
package journal

import (
	"context"
	"sync"

	"google.golang.org/protobuf/proto"
	"google.golang.org/protobuf/types/known/anypb"
	"google.golang.org/protobuf/types/known/timestamppb"

	tunnelv1 "github.com/belov38/umiak/libs/proto/umiak/tunnel/v1"
)

// Mem is a thread-safe in-memory journal. Seqs start at 1.
type Mem struct {
	mu     sync.Mutex
	events []*tunnelv1.Event // unacked events in seq order
	last   uint64
	acked  uint64
	wake   chan struct{} // closed and replaced on every Append
}

// New returns an empty journal.
func New() *Mem {
	return &Mem{wake: make(chan struct{})}
}

// Append journals an event with seq = last + 1 and wakes blocked readers. A
// nil payload yields an event without payload. It panics if payload cannot
// be packed into an Any.
func (m *Mem) Append(typ string, payload proto.Message) uint64 {
	ev := &tunnelv1.Event{Type: typ, Time: timestamppb.Now()}
	if payload != nil {
		a, err := anypb.New(payload)
		if err != nil {
			panic("journal: pack payload: " + err.Error())
		}
		ev.Payload = a
	}
	m.mu.Lock()
	defer m.mu.Unlock()
	m.last++
	ev.Seq = m.last
	m.events = append(m.events, ev)
	close(m.wake)
	m.wake = make(chan struct{})
	return ev.Seq
}

// AckedSeq returns the highest acknowledged seq.
func (m *Mem) AckedSeq() uint64 {
	m.mu.Lock()
	defer m.mu.Unlock()
	return m.acked
}

// Read returns up to limit events with seq > after, blocking until at least one
// exists or ctx is done.
func (m *Mem) Read(ctx context.Context, after uint64, limit int) ([]*tunnelv1.Event, error) {
	if limit <= 0 {
		limit = 1
	}
	for {
		m.mu.Lock()
		var out []*tunnelv1.Event
		for _, ev := range m.events {
			if ev.GetSeq() > after {
				out = append(out, ev)
				if len(out) == limit {
					break
				}
			}
		}
		wake := m.wake
		m.mu.Unlock()
		if len(out) > 0 {
			return out, nil
		}
		select {
		case <-ctx.Done():
			return nil, ctx.Err()
		case <-wake:
		}
	}
}

// Ack marks events up to and including seq as delivered and drops them. An
// ack below the current mark is ignored.
func (m *Mem) Ack(_ context.Context, seq uint64) error {
	m.mu.Lock()
	defer m.mu.Unlock()
	if seq <= m.acked {
		return nil
	}
	m.acked = seq
	i := 0
	for i < len(m.events) && m.events[i].GetSeq() <= seq {
		i++
	}
	m.events = append([]*tunnelv1.Event(nil), m.events[i:]...)
	return nil
}
