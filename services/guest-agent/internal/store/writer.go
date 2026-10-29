package store

import (
	"context"
	"slices"

	"go.etcd.io/bbolt"
)

// op is a queued durable write.
type op struct {
	ctx   context.Context
	fn    func(tx *bbolt.Tx) error
	done  chan error // buffered 1; receives the result once
	taken bool       // guarded by Store.mu: the writer owns it
}

// batch is what the writer commits in one transaction.
type batch struct {
	ops     []*op
	events  []pendingEvent
	dropped uint64 // events lost before this batch; journaled as a gap
	ackTo   uint64 // acked seq to persist
	bootID  string // BootId of a gap event written by this batch
}

// Update runs fn in a read-write transaction and waits until it is durable.
// The writer groups queued writes into one transaction; fn may therefore run
// more than once (when another fn of the batch fails, the batch is rolled
// back and re-run without it), must be free of side effects outside tx, and
// must not call Update. An error from fn rolls back only fn's own changes
// and is returned as is.
//
// While the store is frozen Update waits for the thaw; when ctx ends first
// the write is dropped and ErrFrozen is returned. When ctx ends while the
// writer already runs the batch, ctx.Err() is returned and the outcome is
// unknown.
func (s *Store) Update(ctx context.Context, fn func(tx *bbolt.Tx) error) error {
	s.mu.Lock()
	o, err := s.enqueueLocked(ctx, fn)
	s.mu.Unlock()
	if err != nil {
		return err
	}
	return s.wait(o)
}

// Flush waits until every write and journal event queued before the call is
// durable. It fails like Update.
func (s *Store) Flush(ctx context.Context) error {
	return s.Update(ctx, func(*bbolt.Tx) error { return nil })
}

// enqueueLocked queues a write and wakes the writer. s.mu must be held.
func (s *Store) enqueueLocked(ctx context.Context, fn func(tx *bbolt.Tx) error) (*op, error) {
	if s.closed {
		return nil, ErrClosed
	}
	o := &op{ctx: ctx, fn: fn, done: make(chan error, 1)}
	s.queue = append(s.queue, o)
	s.wakeWriter()
	return o, nil
}

// wait returns the result of o or gives up when its context ends.
func (s *Store) wait(o *op) error {
	select {
	case err := <-o.done:
		return err
	case <-o.ctx.Done():
	}
	s.mu.Lock()
	if !o.taken {
		if i := slices.Index(s.queue, o); i >= 0 {
			s.queue = slices.Delete(s.queue, i, i+1)
		}
		frozen := s.frozen
		s.mu.Unlock()
		if frozen {
			return ErrFrozen
		}
		return o.ctx.Err()
	}
	s.mu.Unlock()
	select {
	case err := <-o.done:
		return err
	default:
		return o.ctx.Err()
	}
}

// wakeWriter nudges the writer without blocking.
func (s *Store) wakeWriter() {
	select {
	case s.kick <- struct{}{}:
	default:
	}
}

// SetFrozen opens or closes the freeze gate. Freezing returns only after an
// in-flight commit has finished, so no write is in progress when the caller
// freezes the filesystem. Thawing wakes the writer, which flushes everything
// queued meanwhile.
func (s *Store) SetFrozen(frozen bool) {
	if frozen {
		// The writer holds commitMu from taking a batch to its commit.
		s.commitMu.Lock()
		defer s.commitMu.Unlock()
	}
	s.mu.Lock()
	s.frozen = frozen
	s.mu.Unlock()
	if !frozen {
		s.wakeWriter()
	}
}

// Frozen reports whether the freeze gate is closed.
func (s *Store) Frozen() bool {
	s.mu.Lock()
	defer s.mu.Unlock()
	return s.frozen
}

// run is the writer goroutine: the only caller of db.Update after Open.
func (s *Store) run() {
	defer close(s.done)
	for {
		select {
		case <-s.kick:
		case <-s.closing:
		}
		for s.writeOnce() {
		}
		select {
		case <-s.closing:
			s.shutdown()
			return
		default:
		}
	}
}

// writeOnce commits everything queued. It returns false when there was
// nothing to do, the store is frozen or the commit failed.
func (s *Store) writeOnce() bool {
	s.commitMu.Lock()
	defer s.commitMu.Unlock()
	s.mu.Lock()
	if s.frozen {
		s.mu.Unlock()
		return false
	}
	b := &batch{ops: s.queue, events: s.pending, dropped: s.dropped, ackTo: s.acked, bootID: s.bootID}
	for _, o := range b.ops {
		o.taken = true
	}
	s.queue, s.pending, s.pendingBytes, s.dropped = nil, nil, 0, 0
	empty := len(b.ops) == 0 && len(b.events) == 0 && b.dropped == 0 && b.ackTo <= s.journal.ackedSaved
	s.mu.Unlock()
	if empty {
		return false
	}
	return s.commit(b)
}

// commit writes b in one transaction. A failing fn is reported to its caller
// and the transaction is retried without it.
func (s *Store) commit(b *batch) bool {
	live := make([]*op, 0, len(b.ops))
	for _, o := range b.ops {
		if err := o.ctx.Err(); err != nil {
			o.done <- err
			continue
		}
		live = append(live, o)
	}
	for {
		failed := -1
		var failErr error
		var res journalResult
		err := s.db.Update(func(tx *bbolt.Tx) error {
			for i, o := range live {
				if err := o.fn(tx); err != nil {
					failed, failErr = i, err
					return err
				}
			}
			var err error
			res, err = s.writeJournal(tx, b)
			return err
		})
		if failed >= 0 {
			live[failed].done <- failErr
			live = slices.Delete(live, failed, failed+1)
			continue
		}
		if err != nil {
			s.opts.Log.Error("store: commit failed", "err", err, "writes", len(live), "events", len(b.events))
			for _, o := range live {
				o.done <- err
			}
			s.requeue(b)
			return false
		}
		for _, o := range live {
			o.done <- nil
		}
		s.publish(res)
		return true
	}
}

// shutdown fails what is still queued; it runs once the writer has drained
// everything it could.
func (s *Store) shutdown() {
	s.mu.Lock()
	ops := s.queue
	for _, o := range ops {
		o.taken = true
	}
	lost := len(s.pending)
	s.queue, s.pending, s.pendingBytes = nil, nil, 0
	s.mu.Unlock()
	for _, o := range ops {
		o.done <- ErrClosed
	}
	if lost > 0 {
		s.opts.Log.Warn("store: closed with unwritten journal events", "events", lost)
	}
}
