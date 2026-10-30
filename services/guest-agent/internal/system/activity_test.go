package system

import (
	"context"
	"testing"
	"time"

	agentv1 "github.com/belov38/boat-dev-clone/libs/proto/sbx/agent/v1"

	"github.com/belov38/boat-dev-clone/services/guest-agent/internal/events"
	"github.com/belov38/boat-dev-clone/services/guest-agent/internal/ports"
)

// activities returns the recorded activity payloads as [running, ptys, tcp].
func activities(t *testing.T, rec *events.Recorder) [][3]uint32 {
	t.Helper()
	var out [][3]uint32
	for _, p := range rec.Of(events.TypeActivity) {
		a, ok := p.(*agentv1.Activity)
		if !ok {
			t.Fatalf("activity payload %T", p)
		}
		out = append(out, [3]uint32{a.GetRunningCommands(), a.GetOpenPtys(), a.GetTcpStreams()})
	}
	return out
}

func TestActivityTransitionsAndHeartbeat(t *testing.T) {
	rec := &events.Recorder{}
	counts := &fakeCounts{}
	var tcp ports.Counter
	l := &ActivityLoop{Counts: counts, TCP: &tcp, Emit: rec}
	t0 := time.Date(2026, 10, 30, 12, 0, 0, 0, time.UTC)
	at := t0.Add

	// The first sample reports the starting state.
	l.step(at(0))
	if got := activities(t, rec); len(got) != 1 || got[0] != [3]uint32{} {
		t.Fatalf("initial events = %v", got)
	}

	steps := []struct {
		name                  string
		d                     time.Duration
		running, ptys, attach int
		tcp                   int
		want                  int // activity events so far
		last                  [3]uint32
	}{
		{"no change", time.Second, 0, 0, 0, 0, 1, [3]uint32{}},
		{"command starts", 2 * time.Second, 1, 0, 0, 0, 2, [3]uint32{1, 0, 0}},
		{"second command, no transition", 3 * time.Second, 2, 0, 0, 0, 2, [3]uint32{1, 0, 0}},
		{"attach does not count", 4 * time.Second, 2, 0, 3, 0, 2, [3]uint32{1, 0, 0}},
		{"commands end", 5 * time.Second, 0, 0, 0, 0, 3, [3]uint32{}},
		{"pty opens", 6 * time.Second, 1, 1, 0, 0, 4, [3]uint32{1, 1, 0}},
		{"tcp stream opens", 7 * time.Second, 1, 1, 0, 1, 5, [3]uint32{1, 1, 1}},
		{"tcp grows, no transition", 8 * time.Second, 1, 1, 0, 2, 5, [3]uint32{1, 1, 1}},
		{"all close", 9 * time.Second, 0, 0, 0, 0, 6, [3]uint32{}},
		{"59 s quiet", 9*time.Second + 59*time.Second, 0, 0, 0, 0, 6, [3]uint32{}},
		{"heartbeat at 60 s", 9*time.Second + 60*time.Second, 0, 0, 0, 0, 7, [3]uint32{}},
		{"after heartbeat", 9*time.Second + 61*time.Second, 0, 0, 0, 0, 7, [3]uint32{}},
		{"next heartbeat", 9*time.Second + 120*time.Second, 0, 0, 0, 0, 8, [3]uint32{}},
	}
	for _, s := range steps {
		counts.set(s.running, s.ptys, s.attach)
		for tcp.Load() < int64(s.tcp) {
			tcp.Inc()
		}
		for tcp.Load() > int64(s.tcp) {
			tcp.Dec()
		}
		l.step(at(s.d))
		got := activities(t, rec)
		if len(got) != s.want || got[len(got)-1] != s.last {
			t.Fatalf("%s: events = %v, want %d ending with %v", s.name, got, s.want, s.last)
		}
	}
}

func TestActivityZeroToOneToZero(t *testing.T) {
	rec := &events.Recorder{}
	counts := &fakeCounts{}
	l := &ActivityLoop{Counts: counts, Emit: rec}
	t0 := time.Date(2026, 10, 30, 12, 0, 0, 0, time.UTC)
	l.step(t0)
	counts.set(1, 0, 0)
	l.step(t0.Add(time.Second))
	counts.set(0, 0, 0)
	l.step(t0.Add(2 * time.Second))
	got := activities(t, rec)
	// Initial state plus two transitions.
	want := [][3]uint32{{}, {1, 0, 0}, {}}
	if len(got) != len(want) {
		t.Fatalf("events = %v, want %v", got, want)
	}
	for i := range want {
		if got[i] != want[i] {
			t.Fatalf("events = %v, want %v", got, want)
		}
	}
}

func TestActivityRun(t *testing.T) {
	rec := &events.Recorder{}
	counts := &fakeCounts{}
	l := &ActivityLoop{Counts: counts, Emit: rec, Tick: time.Millisecond}
	ctx, cancel := context.WithCancel(t.Context())
	done := make(chan struct{})
	go func() {
		defer close(done)
		l.Run(ctx)
	}()
	waitFor(t, func() bool { return len(rec.Of(events.TypeActivity)) >= 1 })
	counts.set(1, 0, 0)
	waitFor(t, func() bool { return len(rec.Of(events.TypeActivity)) >= 2 })
	cancel()
	<-done
}

// waitFor polls cond for up to 5 s.
func waitFor(t *testing.T, cond func() bool) {
	t.Helper()
	deadline := time.Now().Add(5 * time.Second)
	for !cond() {
		if time.Now().After(deadline) {
			t.Fatal("condition not met in 5 s")
		}
		time.Sleep(time.Millisecond)
	}
}
