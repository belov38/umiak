package events_test

import (
	"context"
	"testing"
	"time"

	"google.golang.org/protobuf/types/known/wrapperspb"

	"github.com/belov38/umiak/services/guest-agent/internal/events"
	"github.com/belov38/umiak/services/guest-agent/internal/store"
)

func TestRecorderOf(t *testing.T) {
	var r events.Recorder
	var e events.Emitter = &r
	e.Emit(events.TypeActivity, wrapperspb.Int64(1))
	e.Emit(events.TypeDiskLow, nil)
	e.Emit(events.TypeActivity, wrapperspb.Int64(2))

	got := r.Of(events.TypeActivity)
	if len(got) != 2 || got[0].(*wrapperspb.Int64Value).Value != 1 || got[1].(*wrapperspb.Int64Value).Value != 2 {
		t.Fatalf("Of(activity) = %v", got)
	}
	if got := r.Of(events.TypeDiskLow); len(got) != 1 || got[0] != nil {
		t.Fatalf("Of(disk.low) = %v", got)
	}
	if got := r.Of(events.TypePtyClosed); len(got) != 0 {
		t.Fatalf("Of(pty.closed) = %v", got)
	}
}

func TestStoreEmitterJournals(t *testing.T) {
	st, err := store.Open(t.TempDir()+"/state.db", store.Options{})
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = st.Close() })

	e := events.StoreEmitter(st)
	e.Emit(events.TypeClaimApplied, wrapperspb.String("umiak-1"))
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	if err := st.Flush(ctx); err != nil {
		t.Fatal(err)
	}
	evs, err := st.Journal().Read(ctx, 0, 10)
	if err != nil {
		t.Fatal(err)
	}
	if len(evs) != 1 || evs[0].GetType() != events.TypeClaimApplied {
		t.Fatalf("events = %v", evs)
	}
	var p wrapperspb.StringValue
	if err := evs[0].GetPayload().UnmarshalTo(&p); err != nil || p.Value != "umiak-1" {
		t.Fatalf("payload = %v, %v", &p, err)
	}
}

func TestTypeNames(t *testing.T) {
	for typ, want := range map[string]string{
		events.TypeAgentStarted:      "agent.started",
		events.TypeIdentityReset:     "identity.reset",
		events.TypeCommandExited:     "command.exited",
		events.TypeReadinessChanged:  "readiness.changed",
		events.TypeClaimApplied:      "claim.applied",
		events.TypePortsChanged:      "ports.changed",
		events.TypeIdleChanged:       "idle.changed",
		events.TypeActivity:          "activity",
		events.TypePtyClosed:         "pty.closed",
		events.TypeQuiesceAutoThawed: "quiesce.auto_thawed",
		events.TypeDiskLow:           "disk.low",
		events.TypeDiskOK:            "disk.ok",
		events.TypeUpdateResult:      "update.result",
		events.TypeJournalGap:        "journal.gap",
		events.TypeOutputTruncated:   "output.truncated",
	} {
		if typ != want {
			t.Errorf("type %q, want %q", typ, want)
		}
	}
}
