package store

import (
	"context"
	"errors"
	"testing"
	"time"

	"google.golang.org/protobuf/types/known/wrapperspb"

	agentv1 "github.com/belov38/boat-dev-clone/libs/proto/sbx/agent/v1"
	tunnelv1 "github.com/belov38/boat-dev-clone/libs/proto/sbx/tunnel/v1"
)

// readAll returns every committed event with seq > after without blocking.
func readAll(t *testing.T, s *Store, after uint64) []*tunnelv1.Event {
	t.Helper()
	evs, err := s.readCommitted(after, 1<<30)
	if err != nil {
		t.Fatal(err)
	}
	return evs
}

// appendN appends n events of type "e<i>" and flushes them.
func appendN(t *testing.T, s *Store, n int) {
	t.Helper()
	for i := range n {
		s.AppendEvent("e", wrapperspb.Int64(int64(i)))
	}
	if err := s.Flush(context.Background()); err != nil {
		t.Fatal(err)
	}
}

func seqs(evs []*tunnelv1.Event) []uint64 {
	out := make([]uint64, len(evs))
	for i, ev := range evs {
		out[i] = ev.GetSeq()
	}
	return out
}

func equalSeqs(a, b []uint64) bool {
	if len(a) != len(b) {
		return false
	}
	for i := range a {
		if a[i] != b[i] {
			return false
		}
	}
	return true
}

func span(from, to uint64) []uint64 {
	var out []uint64
	for s := from; s <= to; s++ {
		out = append(out, s)
	}
	return out
}

func TestJournalSeqMonotonicAcrossReopen(t *testing.T) {
	s, path := openTest(t, Options{})
	appendN(t, s, 3)
	if err := s.Close(); err != nil {
		t.Fatal(err)
	}
	s = reopen(t, path, Options{})
	appendN(t, s, 1)
	if got := seqs(readAll(t, s, 0)); !equalSeqs(got, span(1, 4)) {
		t.Errorf("seqs = %v, want 1..4", got)
	}
}

func TestJournalEnvelope(t *testing.T) {
	now := time.Date(2026, 10, 30, 12, 0, 0, 0, time.UTC)
	s, _ := openTest(t, Options{Now: func() time.Time { return now }})
	s.SetBootID("boot-1")
	s.AppendEvent("claim.applied", wrapperspb.String("sbx-1"))
	if err := s.Flush(context.Background()); err != nil {
		t.Fatal(err)
	}
	evs := readAll(t, s, 0)
	if len(evs) != 1 {
		t.Fatalf("events = %d", len(evs))
	}
	ev := evs[0]
	if ev.GetType() != "claim.applied" || ev.GetBootId() != "boot-1" || !ev.GetTime().AsTime().Equal(now) {
		t.Errorf("event = %v", ev)
	}
	var v wrapperspb.StringValue
	if err := ev.GetPayload().UnmarshalTo(&v); err != nil || v.GetValue() != "sbx-1" {
		t.Errorf("payload = %v, %v", v.GetValue(), err)
	}
}

func TestJournalReadBlocksUntilCommit(t *testing.T) {
	s, _ := openTest(t, Options{})
	j := s.Journal()
	type result struct {
		evs []*tunnelv1.Event
		err error
	}
	res := make(chan result, 1)
	go func() {
		evs, err := j.Read(context.Background(), 0, 10)
		res <- result{evs, err}
	}()
	select {
	case r := <-res:
		t.Fatalf("Read returned on an empty journal: %v %v", r.evs, r.err)
	case <-time.After(50 * time.Millisecond):
	}
	s.AppendEvent("x", nil)
	select {
	case r := <-res:
		if r.err != nil || len(r.evs) != 1 || r.evs[0].GetSeq() != 1 {
			t.Errorf("Read = %v, %v", r.evs, r.err)
		}
	case <-time.After(2 * time.Second):
		t.Fatal("Read did not wake up after commit")
	}

	ctx, cancel := context.WithTimeout(context.Background(), 20*time.Millisecond)
	defer cancel()
	if _, err := j.Read(ctx, 1, 10); !errors.Is(err, context.DeadlineExceeded) {
		t.Errorf("Read after last = %v, want deadline", err)
	}
}

func TestJournalReadLimit(t *testing.T) {
	s, _ := openTest(t, Options{})
	appendN(t, s, 5)
	evs, err := s.Journal().Read(context.Background(), 1, 2)
	if err != nil {
		t.Fatal(err)
	}
	if got := seqs(evs); !equalSeqs(got, []uint64{2, 3}) {
		t.Errorf("seqs = %v", got)
	}
}

func TestAckLowerSeqIgnored(t *testing.T) {
	s, path := openTest(t, Options{})
	appendN(t, s, 6)
	j := s.Journal()
	ctx := context.Background()
	if err := j.Ack(ctx, 5); err != nil {
		t.Fatal(err)
	}
	if err := j.Ack(ctx, 3); err != nil {
		t.Fatal(err)
	}
	if got := j.AckedSeq(); got != 5 {
		t.Errorf("AckedSeq = %d, want 5", got)
	}
	if got := seqs(readAll(t, s, 0)); !equalSeqs(got, []uint64{6}) {
		t.Errorf("seqs = %v, want [6]", got)
	}
	evs, err := j.Read(ctx, 3, 10)
	if err != nil {
		t.Fatal(err)
	}
	if got := seqs(evs); !equalSeqs(got, []uint64{6}) {
		t.Errorf("Read(after 3) = %v, want [6]", got)
	}
	if err := s.Close(); err != nil {
		t.Fatal(err)
	}
	s = reopen(t, path, Options{})
	if got := s.Journal().AckedSeq(); got != 5 {
		t.Errorf("AckedSeq after reopen = %d, want 5", got)
	}
	if got := seqs(readAll(t, s, 0)); !equalSeqs(got, []uint64{6}) {
		t.Errorf("seqs after reopen = %v, want [6]", got)
	}
}

func TestAckBeyondLastClamps(t *testing.T) {
	s, _ := openTest(t, Options{})
	appendN(t, s, 3)
	j := s.Journal()
	if err := j.Ack(context.Background(), 100); err != nil {
		t.Fatal(err)
	}
	if got := j.AckedSeq(); got != 3 {
		t.Errorf("AckedSeq = %d, want 3", got)
	}
	appendN(t, s, 1)
	if got := seqs(readAll(t, s, 0)); !equalSeqs(got, []uint64{4}) {
		t.Errorf("seqs = %v, want [4]", got)
	}
}

func TestAckWhileFrozen(t *testing.T) {
	s, path := openTest(t, Options{})
	appendN(t, s, 3)
	s.SetFrozen(true)
	j := s.Journal()
	if err := j.Ack(context.Background(), 2); err != nil {
		t.Fatalf("Ack while frozen = %v", err)
	}
	if got := j.AckedSeq(); got != 2 {
		t.Errorf("AckedSeq = %d", got)
	}
	evs, err := j.Read(context.Background(), 0, 10)
	if err != nil {
		t.Fatal(err)
	}
	if got := seqs(evs); !equalSeqs(got, []uint64{3}) {
		t.Errorf("Read = %v, want [3]", got)
	}
	s.SetFrozen(false)
	if err := s.Flush(context.Background()); err != nil {
		t.Fatal(err)
	}
	if err := s.Close(); err != nil {
		t.Fatal(err)
	}
	s = reopen(t, path, Options{})
	if got := s.Journal().AckedSeq(); got != 2 {
		t.Errorf("AckedSeq after reopen = %d, want 2", got)
	}
}

func gapOf(t *testing.T, ev *tunnelv1.Event) (from, to uint64) {
	t.Helper()
	if ev.GetType() != TypeJournalGap {
		t.Fatalf("event %d type = %q, want %q", ev.GetSeq(), ev.GetType(), TypeJournalGap)
	}
	var g agentv1.JournalGap
	if err := ev.GetPayload().UnmarshalTo(&g); err != nil {
		t.Fatal(err)
	}
	return g.GetFromSeq(), g.GetToSeq()
}

func TestJournalOverflowWritesGap(t *testing.T) {
	s, path := openTest(t, Options{JournalMaxEvents: 10})
	// One batch: freeze, append, thaw.
	s.SetFrozen(true)
	for range 15 {
		s.AppendEvent("e", nil)
	}
	s.SetFrozen(false)
	if err := s.Flush(context.Background()); err != nil {
		t.Fatal(err)
	}
	evs := readAll(t, s, 0)
	if got := seqs(evs); !equalSeqs(got, span(7, 16)) {
		t.Fatalf("seqs = %v, want 7..16", got)
	}
	if from, to := gapOf(t, evs[len(evs)-1]); from != 1 || to != 6 {
		t.Errorf("gap = %d..%d, want 1..6", from, to)
	}
	if err := s.Close(); err != nil {
		t.Fatal(err)
	}
	// Counters are rebuilt on open: one more event (17) trims 7 and 8 and
	// the gap takes seq 18.
	s = reopen(t, path, Options{JournalMaxEvents: 10})
	appendN(t, s, 1)
	evs = readAll(t, s, 0)
	if got := seqs(evs); !equalSeqs(got, span(9, 18)) {
		t.Fatalf("seqs after reopen = %v, want 9..18", got)
	}
	if from, to := gapOf(t, evs[len(evs)-1]); from != 7 || to != 8 {
		t.Errorf("gap = %d..%d, want 7..8", from, to)
	}
}

func TestJournalOverflowBytes(t *testing.T) {
	s, _ := openTest(t, Options{JournalMaxBytes: 2000})
	big := wrapperspb.Bytes(make([]byte, 400))
	s.SetFrozen(true)
	for range 10 {
		s.AppendEvent("e", big)
	}
	s.SetFrozen(false)
	if err := s.Flush(context.Background()); err != nil {
		t.Fatal(err)
	}
	evs := readAll(t, s, 0)
	var total int64
	for _, ev := range evs {
		b, _ := marshalEvent(ev)
		total += int64(len(b))
	}
	if total > 2000 {
		t.Errorf("journal bytes = %d, want <= 2000", total)
	}
	last := evs[len(evs)-1]
	from, to := gapOf(t, last)
	if from != 1 || to != evs[0].GetSeq()-1 || last.GetSeq() != 11 {
		t.Errorf("gap %d..%d at seq %d, first kept %d", from, to, last.GetSeq(), evs[0].GetSeq())
	}
}

func TestFrozenEventsGetSeqAfterThaw(t *testing.T) {
	s, _ := openTest(t, Options{})
	j := s.Journal()
	s.SetFrozen(true)
	s.AppendEvent("first", nil)
	s.AppendEvent("second", nil)
	ctx, cancel := context.WithTimeout(context.Background(), 100*time.Millisecond)
	defer cancel()
	evs, err := j.Read(ctx, 0, 10)
	if !errors.Is(err, context.DeadlineExceeded) || len(evs) != 0 {
		t.Fatalf("Read while frozen = %v, %v", evs, err)
	}
	s.SetFrozen(false)
	evs, err = j.Read(context.Background(), 0, 10)
	if err != nil {
		t.Fatal(err)
	}
	if len(evs) == 1 { // the writer may commit them in two transactions
		more, err := j.Read(context.Background(), 1, 10)
		if err != nil {
			t.Fatal(err)
		}
		evs = append(evs, more...)
	}
	if len(evs) != 2 || evs[0].GetType() != "first" || evs[0].GetSeq() != 1 ||
		evs[1].GetType() != "second" || evs[1].GetSeq() != 2 {
		t.Errorf("events = %v", evs)
	}
}

func TestFrozenOverflowDropsOldestAndWritesGap(t *testing.T) {
	s, _ := openTest(t, Options{FrozenMaxRecords: 3})
	s.SetFrozen(true)
	for _, typ := range []string{"e1", "e2", "e3", "e4", "e5"} {
		s.AppendEvent(typ, nil)
	}
	s.SetFrozen(false)
	if err := s.Flush(context.Background()); err != nil {
		t.Fatal(err)
	}
	evs := readAll(t, s, 0)
	if got := seqs(evs); !equalSeqs(got, span(3, 6)) {
		t.Fatalf("seqs = %v, want 3..6", got)
	}
	if from, to := gapOf(t, evs[0]); from != 1 || to != 2 {
		t.Errorf("gap = %d..%d, want 1..2", from, to)
	}
	for i, want := range []string{"e3", "e4", "e5"} {
		if evs[i+1].GetType() != want {
			t.Errorf("event %d type = %q, want %q", evs[i+1].GetSeq(), evs[i+1].GetType(), want)
		}
	}
}

func TestReadAfterCloseFails(t *testing.T) {
	s, _ := openTest(t, Options{})
	j := s.Journal()
	res := make(chan error, 1)
	go func() {
		_, err := j.Read(context.Background(), 0, 10)
		res <- err
	}()
	time.Sleep(20 * time.Millisecond)
	if err := s.Close(); err != nil {
		t.Fatal(err)
	}
	select {
	case err := <-res:
		if !errors.Is(err, ErrClosed) {
			t.Errorf("Read = %v, want ErrClosed", err)
		}
	case <-time.After(2 * time.Second):
		t.Fatal("Read did not return after Close")
	}
}
