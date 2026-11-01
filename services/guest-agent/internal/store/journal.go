package store

import (
	"context"
	"errors"
	"math"

	"go.etcd.io/bbolt"
	"google.golang.org/protobuf/proto"
	"google.golang.org/protobuf/types/known/anypb"
	"google.golang.org/protobuf/types/known/timestamppb"

	tunnelv1 "github.com/belov38/umiak/libs/proto/umiak/tunnel/v1"
	"github.com/belov38/umiak/libs/tunnel/agent"
)

// TypeJournalGap is the type of the event that records lost journal events.
// It equals events.TypeJournalGap.
const TypeJournalGap = "journal.gap"

// pendingEvent is a journal event waiting for the writer, without seq.
type pendingEvent struct {
	ev   *tunnelv1.Event
	size int64 // proto.Size of ev without seq
}

// journalResult is what a transaction did to the journal.
type journalResult struct {
	j     journalCounters
	added bool // events were appended
}

// SetBootID sets the BootId of events appended from now on.
func (s *Store) SetBootID(id string) {
	s.mu.Lock()
	defer s.mu.Unlock()
	s.bootID = id
}

// AppendEvent journals an event. It never blocks: the event is queued in
// memory with its Time and BootId set now and gets its seq in the writer's
// next transaction. The queue is bounded by FrozenMaxRecords and
// FrozenMaxBytes; on overflow the oldest queued event is dropped and the
// writer later reserves seqs for the dropped events and records them with a
// journal.gap. An event that cannot be encoded is logged and dropped. A nil
// payload yields an event without payload.
func (s *Store) AppendEvent(typ string, payload proto.Message) {
	s.mu.Lock()
	bootID := s.bootID
	s.mu.Unlock()
	ev, err := s.newEvent(typ, payload, bootID)
	if err == nil {
		_, err = proto.Marshal(ev) // reject what the writer could not store
	}
	if err != nil {
		s.opts.Log.Error("store: dropping unencodable event", "type", typ, "err", err)
		return
	}
	pe := pendingEvent{ev: ev, size: int64(proto.Size(ev))}

	s.mu.Lock()
	defer s.mu.Unlock()
	if s.closed {
		return
	}
	s.pending = append(s.pending, pe)
	s.pendingBytes += pe.size
	s.boundPendingLocked()
	s.wakeWriter()
}

// boundPendingLocked drops the oldest pending events above the limits.
func (s *Store) boundPendingLocked() {
	n := 0
	for len(s.pending) > 0 &&
		(len(s.pending) > s.opts.FrozenMaxRecords || s.pendingBytes > s.opts.FrozenMaxBytes) {
		s.pendingBytes -= s.pending[0].size
		s.pending[0] = pendingEvent{}
		s.pending = s.pending[1:]
		n++
	}
	if n == 0 {
		return
	}
	if s.dropped == 0 {
		s.opts.Log.Warn("store: journal queue full, dropping oldest events",
			"max_records", s.opts.FrozenMaxRecords, "max_bytes", s.opts.FrozenMaxBytes)
	}
	s.dropped += uint64(n)
}

// requeue puts the events of a failed batch back in front of the queue.
func (s *Store) requeue(b *batch) {
	s.mu.Lock()
	defer s.mu.Unlock()
	var size int64
	for _, pe := range b.events {
		pe.ev.Seq = 0
		size += pe.size
	}
	s.pending = append(append([]pendingEvent(nil), b.events...), s.pending...)
	s.pendingBytes += size
	s.dropped += b.dropped
	s.boundPendingLocked()
}

// newEvent builds an envelope without seq.
func (s *Store) newEvent(typ string, payload proto.Message, bootID string) (*tunnelv1.Event, error) {
	ev := &tunnelv1.Event{Time: timestamppb.New(s.opts.Now()), BootId: bootID, Type: typ}
	if payload != nil {
		a, err := anypb.New(payload)
		if err != nil {
			return nil, err
		}
		ev.Payload = a
	}
	return ev, nil
}

// gapEvent builds a journal.gap envelope for the lost seqs from..to.
func (s *Store) gapEvent(from, to uint64, bootID string) *tunnelv1.Event {
	var payload proto.Message
	if s.opts.GapPayload != nil {
		payload = s.opts.GapPayload(from, to)
	}
	ev, err := s.newEvent(TypeJournalGap, payload, bootID)
	if err != nil {
		s.opts.Log.Error("store: journal gap payload", "err", err)
		ev, _ = s.newEvent(TypeJournalGap, nil, bootID)
	}
	return ev
}

// writeJournal applies the batch's ack, appends its events with new seqs and
// trims the journal, all in tx.
func (s *Store) writeJournal(tx *bbolt.Tx, b *batch) (journalResult, error) {
	j := s.journal // only the writer changes it
	meta := tx.Bucket(bucketMeta)
	evb := tx.Bucket(bucketEvents)
	start := j.lastSeq

	put := func(ev *tunnelv1.Event) error {
		j.lastSeq++
		ev.Seq = j.lastSeq
		data, err := marshalEvent(ev)
		if err != nil {
			return err
		}
		if err := evb.Put(encodeU64(ev.Seq), data); err != nil {
			return err
		}
		j.count++
		j.bytes += int64(len(data))
		return nil
	}

	if b.ackTo > j.ackedSaved {
		c := evb.Cursor()
		for k, v := c.First(); k != nil && decodeU64(k) <= b.ackTo; k, v = c.First() {
			if err := c.Delete(); err != nil {
				return journalResult{}, err
			}
			j.count--
			j.bytes -= int64(len(v))
		}
		if err := meta.Put([]byte(MetaAckedSeq), encodeU64(b.ackTo)); err != nil {
			return journalResult{}, err
		}
		j.ackedSaved = b.ackTo
	}

	// Events dropped from the in-memory queue precede the queued ones: their
	// seqs are skipped and reported first.
	if b.dropped > 0 {
		from := j.lastSeq + 1
		j.lastSeq += b.dropped
		if err := put(s.gapEvent(from, j.lastSeq, b.bootID)); err != nil {
			return journalResult{}, err
		}
	}
	for _, pe := range b.events {
		if err := put(pe.ev); err != nil {
			return journalResult{}, err
		}
	}

	maxN, maxB := s.opts.JournalMaxEvents, s.opts.JournalMaxBytes
	if j.count > maxN || j.bytes > maxB {
		// Make room for the gap event itself.
		probe := s.gapEvent(math.MaxUint64, math.MaxUint64, b.bootID)
		probe.Seq = math.MaxUint64
		gapMax := int64(proto.Size(probe))
		var from, to uint64
		c := evb.Cursor()
		for k, v := c.First(); k != nil && (j.count > maxN-1 || j.bytes > maxB-gapMax); k, v = c.First() {
			seq := decodeU64(k)
			if from == 0 {
				from = seq
			}
			to = seq
			if err := c.Delete(); err != nil {
				return journalResult{}, err
			}
			j.count--
			j.bytes -= int64(len(v))
		}
		if to > 0 {
			s.opts.Log.Warn("store: journal full, dropped oldest events", "from_seq", from, "to_seq", to)
			if err := put(s.gapEvent(from, to, b.bootID)); err != nil {
				return journalResult{}, err
			}
		}
	}

	if j.lastSeq != start {
		if err := meta.Put([]byte(MetaLastSeq), encodeU64(j.lastSeq)); err != nil {
			return journalResult{}, err
		}
	}
	return journalResult{j: j, added: j.lastSeq != start}, nil
}

// publish makes a committed journal state visible and wakes readers.
func (s *Store) publish(res journalResult) {
	s.mu.Lock()
	defer s.mu.Unlock()
	s.journal = res.j
	if res.added {
		close(s.notify)
		s.notify = make(chan struct{})
	}
}

// readCommitted returns up to limit committed events with seq > after.
// Undecodable records are logged and skipped.
func (s *Store) readCommitted(after uint64, limit int) ([]*tunnelv1.Event, error) {
	var out []*tunnelv1.Event
	err := s.db.View(func(tx *bbolt.Tx) error {
		c := tx.Bucket(bucketEvents).Cursor()
		for k, v := c.Seek(encodeU64(after + 1)); k != nil && len(out) < limit; k, v = c.Next() {
			ev := &tunnelv1.Event{}
			if err := proto.Unmarshal(v, ev); err != nil {
				s.opts.Log.Error("store: skipping corrupt journal event", "seq", decodeU64(k), "err", err)
				continue
			}
			out = append(out, ev)
		}
		return nil
	})
	return out, err
}

// Journal returns the event journal served to the tunnel.
func (s *Store) Journal() agent.EventJournal {
	return journal{s: s}
}

// journal implements agent.EventJournal over the events bucket.
type journal struct {
	s *Store
}

// AckedSeq returns the highest acknowledged seq.
func (j journal) AckedSeq() uint64 {
	j.s.mu.Lock()
	defer j.s.mu.Unlock()
	return j.s.acked
}

// Read blocks until a committed event with seq > after (and above the acked
// seq) exists or ctx is done, and returns up to limit events in seq order.
func (j journal) Read(ctx context.Context, after uint64, limit int) ([]*tunnelv1.Event, error) {
	s := j.s
	if limit <= 0 {
		limit = 1
	}
	for {
		s.mu.Lock()
		wake, closed, acked := s.notify, s.closed, s.acked
		s.mu.Unlock()
		if closed {
			return nil, ErrClosed
		}
		evs, err := s.readCommitted(max(after, acked), limit)
		if err != nil {
			if s.isClosed() {
				return nil, ErrClosed
			}
			return nil, err
		}
		if len(evs) > 0 {
			return evs, nil
		}
		select {
		case <-ctx.Done():
			return nil, ctx.Err()
		case <-wake:
		case <-s.closing:
		}
	}
}

// Ack marks events up to and including seq as delivered. A seq at or below
// the acked one is ignored (two gateways may ack during a drain); a seq
// beyond the last committed one is clamped to it. The mark takes effect at
// once; the deletion is durable when Ack returns, except while frozen, when
// it is written after the thaw.
func (j journal) Ack(ctx context.Context, seq uint64) error {
	s := j.s
	s.mu.Lock()
	seq = min(seq, s.journal.lastSeq)
	if seq <= s.acked {
		s.mu.Unlock()
		return nil
	}
	s.acked = seq
	if s.frozen {
		s.mu.Unlock()
		return nil
	}
	o, err := s.enqueueLocked(ctx, func(*bbolt.Tx) error { return nil })
	s.mu.Unlock()
	if err != nil {
		return err
	}
	if err := s.wait(o); err != nil && !errors.Is(err, ErrFrozen) {
		return err
	}
	return nil
}

func (s *Store) isClosed() bool {
	s.mu.Lock()
	defer s.mu.Unlock()
	return s.closed
}
