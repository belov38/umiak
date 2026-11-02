package journal_test

import (
	"context"
	"errors"
	"testing"
	"time"

	"google.golang.org/protobuf/types/known/wrapperspb"

	"github.com/belov38/umiak/libs/tunnel/tunneltest/journal"
)

func TestAppendReadAck(t *testing.T) {
	j := journal.New()
	ctx := context.Background()
	for i, typ := range []string{"a", "b", "c"} {
		if seq := j.Append(typ, wrapperspb.Int64(int64(i))); seq != uint64(i+1) {
			t.Fatalf("seq = %d, want %d", seq, i+1)
		}
	}
	evs, err := j.Read(ctx, 0, 2)
	if err != nil || len(evs) != 2 || evs[0].GetSeq() != 1 || evs[1].GetSeq() != 2 {
		t.Fatalf("Read(0, 2) = %v, %v", evs, err)
	}
	if evs[0].GetTime() == nil || evs[0].GetPayload() == nil {
		t.Fatalf("event = %v", evs[0])
	}
	if err := j.Ack(ctx, 2); err != nil {
		t.Fatal(err)
	}
	if j.AckedSeq() != 2 {
		t.Fatalf("AckedSeq = %d", j.AckedSeq())
	}
	// Acked events are dropped; an older ack does not move the mark back.
	if err := j.Ack(ctx, 1); err != nil {
		t.Fatal(err)
	}
	evs, err = j.Read(ctx, 0, 10)
	if err != nil || len(evs) != 1 || evs[0].GetSeq() != 3 || j.AckedSeq() != 2 {
		t.Fatalf("Read after ack = %v, %v (acked %d)", evs, err, j.AckedSeq())
	}
}

func TestReadBlocksUntilAppend(t *testing.T) {
	j := journal.New()
	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()
	got := make(chan uint64, 1)
	go func() {
		evs, err := j.Read(ctx, 0, 10)
		if err != nil || len(evs) == 0 {
			got <- 0
			return
		}
		got <- evs[0].GetSeq()
	}()
	select {
	case <-got:
		t.Fatal("Read returned on an empty journal")
	case <-time.After(20 * time.Millisecond):
	}
	j.Append("x", nil)
	if seq := <-got; seq != 1 {
		t.Fatalf("seq = %d, want 1", seq)
	}

	short, cancelShort := context.WithCancel(context.Background())
	cancelShort()
	if _, err := j.Read(short, 1, 10); !errors.Is(err, context.Canceled) {
		t.Fatalf("Read on cancelled ctx = %v", err)
	}
}
