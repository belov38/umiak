package agent_test

import (
	"context"
	"log/slog"
	"strings"
	"testing"

	"connectrpc.com/connect"
	"google.golang.org/protobuf/proto"
	"google.golang.org/protobuf/types/known/anypb"
	"google.golang.org/protobuf/types/known/timestamppb"
	"google.golang.org/protobuf/types/known/wrapperspb"

	tunnelv1 "github.com/belov38/boat-dev-clone/libs/proto/sbx/tunnel/v1"
	"github.com/belov38/boat-dev-clone/libs/tunnel/tunneltest/journal"
	"github.com/belov38/boat-dev-clone/libs/tunnel/wire"
)

func TestEventsSubscribeAndAck(t *testing.T) {
	j := journal.New()
	for _, typ := range []string{"a", "b", "c"} {
		j.Append(typ, wrapperspb.String(typ))
	}
	ctx, cancel := context.WithTimeout(context.Background(), waitTimeout)
	defer cancel()
	if err := j.Ack(ctx, 1); err != nil {
		t.Fatal(err)
	}

	cfg := fastConfig()
	cfg.Journal = j
	e := startEnv(t, cfg, nil)
	c := e.gw.nextConn()

	sub, err := c.events.Subscribe(ctx, connect.NewRequest(&tunnelv1.SubscribeRequest{}))
	if err != nil {
		t.Fatal(err)
	}
	defer func() { _ = sub.Close() }()
	recv := func() *tunnelv1.Event {
		t.Helper()
		if !sub.Receive() {
			t.Fatalf("stream ended: %v", sub.Err())
		}
		return sub.Msg().GetEvent()
	}
	for _, want := range []struct {
		seq uint64
		typ string
	}{{2, "b"}, {3, "c"}} {
		ev := recv()
		if ev.GetSeq() != want.seq || ev.GetType() != want.typ {
			t.Fatalf("event = %v, want seq %d type %s", ev, want.seq, want.typ)
		}
		var s wrapperspb.StringValue
		if err := ev.GetPayload().UnmarshalTo(&s); err != nil || s.GetValue() != want.typ {
			t.Fatalf("payload = %v (%v)", ev.GetPayload(), err)
		}
		if ev.GetTime() == nil {
			t.Fatal("event without time")
		}
	}

	if _, err := c.events.Ack(ctx, connect.NewRequest(&tunnelv1.AckRequest{Seq: 3})); err != nil {
		t.Fatal(err)
	}
	if got := j.AckedSeq(); got != 3 {
		t.Fatalf("AckedSeq = %d, want 3", got)
	}

	if seq := j.Append("d", nil); seq != 4 {
		t.Fatalf("Append seq = %d, want 4", seq)
	}
	if ev := recv(); ev.GetSeq() != 4 || ev.GetType() != "d" || ev.GetPayload() != nil {
		t.Fatalf("event = %v, want seq 4 type d without payload", ev)
	}

	// An explicit after_seq overrides the acked seq.
	sub2, err := c.events.Subscribe(ctx, connect.NewRequest(&tunnelv1.SubscribeRequest{AfterSeq: new(uint64(3))}))
	if err != nil {
		t.Fatal(err)
	}
	defer func() { _ = sub2.Close() }()
	if !sub2.Receive() || sub2.Msg().GetEvent().GetSeq() != 4 {
		t.Fatalf("after_seq=3: %v %v", sub2.Msg(), sub2.Err())
	}
}

func TestEventsWithoutJournal(t *testing.T) {
	e := startEnv(t, fastConfig(), nil)
	c := e.gw.nextConn()
	ctx, cancel := context.WithCancel(context.Background())
	sub, err := c.events.Subscribe(ctx, connect.NewRequest(&tunnelv1.SubscribeRequest{}))
	if err != nil {
		t.Fatal(err)
	}
	done := make(chan bool, 1)
	go func() { done <- sub.Receive() }()
	if _, err := c.events.Ack(context.Background(), connect.NewRequest(&tunnelv1.AckRequest{Seq: 5})); err != nil {
		t.Fatal(err)
	}
	cancel()
	if <-done {
		t.Fatal("empty journal delivered an event")
	}
	_ = sub.Close()
}

// fixedJournal serves a fixed list of events.
type fixedJournal struct{ evs []*tunnelv1.Event }

func (fixedJournal) AckedSeq() uint64 { return 0 }

func (f fixedJournal) Read(ctx context.Context, after uint64, limit int) ([]*tunnelv1.Event, error) {
	var out []*tunnelv1.Event
	for _, ev := range f.evs {
		if ev.GetSeq() > after && len(out) < limit {
			out = append(out, ev)
		}
	}
	if len(out) == 0 {
		<-ctx.Done()
		return nil, ctx.Err()
	}
	return out, nil
}

func (fixedJournal) Ack(context.Context, uint64) error { return nil }

// An event above MaxEventBytes is sent as a stub with the same seq, time
// and boot_id, so the stream neither breaks at the gateway's read limit nor
// skips a seq.
func TestEventsOversizeEventStubbed(t *testing.T) {
	payload, err := anypb.New(wrapperspb.Bytes(make([]byte, 4096)))
	if err != nil {
		t.Fatal(err)
	}
	at := timestamppb.Now()
	evs := []*tunnelv1.Event{
		{Seq: 1, Time: at, BootId: "boot-1", Type: "test.small"},
		{Seq: 2, Time: at, BootId: "boot-1", Type: "test.huge", Payload: payload},
		{Seq: 3, Time: at, BootId: "boot-1", Type: "test.small"},
	}
	var logs syncBuffer
	cfg := fastConfig()
	cfg.Journal = fixedJournal{evs}
	cfg.MaxEventBytes = 1024
	cfg.Logger = slog.New(slog.NewTextHandler(&logs, nil))
	e := startEnv(t, cfg, nil)
	c := e.gw.nextConn()
	ctx, cancel := context.WithTimeout(context.Background(), waitTimeout)
	defer cancel()

	sub, err := c.events.Subscribe(ctx, connect.NewRequest(&tunnelv1.SubscribeRequest{}))
	if err != nil {
		t.Fatal(err)
	}
	defer func() { _ = sub.Close() }()
	var got []*tunnelv1.Event
	for len(got) < 3 && sub.Receive() {
		got = append(got, sub.Msg().GetEvent())
	}
	if len(got) != 3 {
		t.Fatalf("got %d events, stream err %v", len(got), sub.Err())
	}
	want := &tunnelv1.Event{Seq: 2, Time: at, BootId: "boot-1", Type: wire.EventTypeTooLarge}
	if !proto.Equal(got[1], want) {
		t.Fatalf("oversize event sent as seq %d type %s payload %d bytes, want %v",
			got[1].GetSeq(), got[1].GetType(), proto.Size(got[1].GetPayload()), want)
	}
	if !proto.Equal(got[0], evs[0]) || !proto.Equal(got[2], evs[2]) {
		t.Fatalf("small events changed: %v, %v", got[0], got[2])
	}
	if l := logs.String(); !strings.Contains(l, "seq=2") || !strings.Contains(l, "type=test.huge") {
		t.Fatalf("oversize event not logged with its seq and type:\n%s", l)
	}
}
