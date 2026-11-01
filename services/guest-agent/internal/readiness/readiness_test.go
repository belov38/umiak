package readiness

import (
	"context"
	"slices"
	"testing"
	"time"

	agentv1 "github.com/belov38/umiak/libs/proto/umiak/agent/v1"

	"github.com/belov38/umiak/services/guest-agent/internal/events"
)

const (
	pending  = agentv1.PhaseState_PHASE_STATE_PENDING
	ready    = agentv1.PhaseState_PHASE_STATE_READY
	failed   = agentv1.PhaseState_PHASE_STATE_FAILED
	disabled = agentv1.PhaseState_PHASE_STATE_DISABLED
)

func TestTrackerEmitsOnChangeOnly(t *testing.T) {
	var rec events.Recorder
	tr := New([]string{"identity"}, &rec, nil)

	tr.Set(PhaseIdentity, pending, "") // initial state: no change
	tr.Set(PhaseIdentity, ready, "")
	tr.Set(PhaseIdentity, ready, "")
	tr.Set(PhaseDocker, failed, "ping: refused")
	tr.Set(PhaseDocker, failed, "ping: refused")
	tr.Set(PhaseDocker, failed, "ping: timeout") // error text changed
	tr.Set("desktop", pending, "")               // new extra phase

	got := rec.Of(events.TypeReadinessChanged)
	want := []*agentv1.ReadinessChanged{
		{Phase: PhaseIdentity, State: ready},
		{Phase: PhaseDocker, State: failed, Error: "ping: refused"},
		{Phase: PhaseDocker, State: failed, Error: "ping: timeout"},
		{Phase: "desktop", State: pending},
	}
	if len(got) != len(want) {
		t.Fatalf("got %d events %v, want %d", len(got), got, len(want))
	}
	for i, p := range got {
		ev := p.(*agentv1.ReadinessChanged)
		if ev.GetPhase() != want[i].GetPhase() || ev.GetState() != want[i].GetState() || ev.GetError() != want[i].GetError() {
			t.Errorf("event %d = %v, want %v", i, ev, want[i])
		}
	}

	var names []string
	for _, p := range tr.Phases() {
		names = append(names, p.GetName())
	}
	if wantNames := []string{"agent", "identity", "claim", "secrets", "docker", "desktop"}; !slices.Equal(names, wantNames) {
		t.Errorf("Phases order = %v, want %v", names, wantNames)
	}
	if st, msg := tr.State(PhaseDocker); st != failed || msg != "ping: timeout" {
		t.Errorf("State(docker) = %v %q", st, msg)
	}
}

func TestTrackerReady(t *testing.T) {
	now := time.Unix(1000, 0)
	clock := func() time.Time { return now }
	tr := New([]string{"identity", "claim", "docker", "desktop"}, nil, clock)

	if tr.Ready() {
		t.Fatal("ready with every phase pending")
	}
	// A required extra phase is reported before anyone sets it.
	if st, _ := tr.State("desktop"); st != pending {
		t.Fatalf("desktop = %v, want pending", st)
	}
	tr.Set(PhaseIdentity, ready, "")
	tr.Set(PhaseClaim, ready, "")
	tr.Set(PhaseDocker, disabled, "") // disabled satisfies a requirement
	if tr.Ready() {
		t.Fatal("ready while desktop is pending")
	}
	now = now.Add(time.Second)
	tr.Set("desktop", ready, "")
	if !tr.Ready() {
		t.Fatal("not ready with every required phase ready or disabled")
	}
	// A phase outside the required set does not matter.
	tr.Set(PhaseSecrets, failed, "x")
	if !tr.Ready() {
		t.Fatal("non-required phase changed the aggregate")
	}

	if got := tr.ReadyAt(PhaseIdentity); !got.Equal(time.Unix(1000, 0)) {
		t.Errorf("ReadyAt(identity) = %v", got)
	}
	if got := tr.ReadyAt("desktop"); !got.Equal(time.Unix(1001, 0)) {
		t.Errorf("ReadyAt(desktop) = %v", got)
	}
	if got := tr.ReadyAt(PhaseSecrets); !got.IsZero() {
		t.Errorf("ReadyAt(secrets) = %v, want zero", got)
	}
	// The mark is the first transition into ready and stays.
	now = now.Add(time.Minute)
	tr.Set(PhaseIdentity, failed, "lost")
	tr.Set(PhaseIdentity, ready, "")
	if got := tr.ReadyAt(PhaseIdentity); !got.Equal(time.Unix(1000, 0)) {
		t.Errorf("ReadyAt(identity) after flap = %v", got)
	}
}

func TestTrackerWait(t *testing.T) {
	tr := New(nil, nil, nil)
	ctx, cancel := context.WithTimeout(context.Background(), 50*time.Millisecond)
	defer cancel()
	if err := tr.Wait(ctx, PhaseIdentity); err == nil {
		t.Fatal("Wait returned nil for a pending phase")
	}

	done := make(chan error, 1)
	go func() { done <- tr.Wait(context.Background(), PhaseIdentity) }()
	time.Sleep(10 * time.Millisecond)
	tr.Set(PhaseIdentity, ready, "")
	select {
	case err := <-done:
		if err != nil {
			t.Fatalf("Wait = %v", err)
		}
	case <-time.After(5 * time.Second):
		t.Fatal("Wait did not return after the phase became ready")
	}
}
