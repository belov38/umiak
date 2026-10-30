package system

import (
	"context"
	"sync"
	"testing"
	"time"

	agentv1 "github.com/belov38/boat-dev-clone/libs/proto/sbx/agent/v1"

	"github.com/belov38/boat-dev-clone/services/guest-agent/internal/events"
	"github.com/belov38/boat-dev-clone/services/guest-agent/internal/ports"
)

// fakeSample is a settable idle sample source; io is cumulative.
type fakeSample struct {
	mu  sync.Mutex
	cpu float64
	io  uint64
}

func (f *fakeSample) sample() (float64, uint64) {
	f.mu.Lock()
	defer f.mu.Unlock()
	return f.cpu, f.io
}

func (f *fakeSample) set(cpu float64, addIO uint64) {
	f.mu.Lock()
	defer f.mu.Unlock()
	f.cpu = cpu
	f.io += addIO
}

// idleEvents returns the recorded idle.changed payloads.
func idleEvents(t *testing.T, rec *events.Recorder) []*agentv1.IdleChanged {
	t.Helper()
	var out []*agentv1.IdleChanged
	for _, p := range rec.Of(events.TypeIdleChanged) {
		e, ok := p.(*agentv1.IdleChanged)
		if !ok {
			t.Fatalf("idle.changed payload %T", p)
		}
		out = append(out, e)
	}
	return out
}

// idleRig drives an IdleLoop with a fake clock in 10 s ticks.
type idleRig struct {
	t      *testing.T
	l      *IdleLoop
	rec    *events.Recorder
	counts *fakeCounts
	tcp    *ports.Counter
	s      *fakeSample
	now    time.Time
}

func newIdleRig(t *testing.T) *idleRig {
	r := &idleRig{
		t:      t,
		rec:    &events.Recorder{},
		counts: &fakeCounts{},
		tcp:    &ports.Counter{},
		s:      &fakeSample{cpu: 1},
		now:    time.Date(2026, 10, 30, 12, 0, 0, 0, time.UTC),
	}
	r.l = &IdleLoop{
		Counts: r.counts,
		TCP:    r.tcp,
		Sample: r.s.sample,
		Window: 5 * time.Minute,
		Emit:   r.rec,
	}
	return r
}

// advance runs n ticks of 10 s, adding io bytes before each.
func (r *idleRig) advance(n int, io uint64) {
	for range n {
		r.s.set(r.s.cpu, io)
		r.l.step(r.now)
		r.now = r.now.Add(10 * time.Second)
	}
}

func (r *idleRig) idle() bool {
	_, ok := r.l.IdleSince()
	return ok
}

func TestIdleRequiresWindow(t *testing.T) {
	r := newIdleRig(t)
	start := r.now

	// 0 s .. 290 s: 30 ticks, the window is not covered yet.
	r.advance(30, 0)
	if r.idle() || len(idleEvents(t, r.rec)) != 0 {
		t.Fatalf("idle before the window: %v", idleEvents(t, r.rec))
	}
	// The tick at 300 s completes the window.
	r.advance(1, 0)
	since, ok := r.l.IdleSince()
	if !ok || !since.Equal(start) {
		t.Fatalf("IdleSince = %v %v, want %v", since, ok, start)
	}
	ev := idleEvents(t, r.rec)
	if len(ev) != 1 || !ev[0].GetIdle() || !ev[0].GetSince().AsTime().Equal(start) {
		t.Fatalf("idle events = %v", ev)
	}
	r.advance(5, 0)
	if len(idleEvents(t, r.rec)) != 1 {
		t.Fatal("idle.changed repeated without a change")
	}

	// A running command ends idleness at once.
	r.counts.set(1, 0, 0)
	busyAt := r.now
	r.advance(1, 0)
	ev = idleEvents(t, r.rec)
	if r.idle() || len(ev) != 2 || ev[1].GetIdle() || !ev[1].GetSince().AsTime().Equal(busyAt) {
		t.Fatalf("after command: idle=%v events=%v", r.idle(), ev)
	}

	// After the command the full window must pass again.
	r.counts.set(0, 0, 0)
	r.advance(30, 0)
	if r.idle() {
		t.Fatal("idle before a full window after the command")
	}
	r.advance(1, 0)
	if !r.idle() || len(idleEvents(t, r.rec)) != 3 {
		t.Fatalf("not idle a window after the command: %v", idleEvents(t, r.rec))
	}
}

func TestIdleBlockers(t *testing.T) {
	tests := []struct {
		name  string
		setup func(r *idleRig)
		io    uint64 // bytes per 10 s tick
	}{
		{"attach stream", func(r *idleRig) { r.counts.set(0, 0, 1) }, 0},
		{"tcp stream", func(r *idleRig) { r.tcp.Inc() }, 0},
		{"cpu average 5%", func(r *idleRig) { r.s.set(5, 0) }, 0},
		// 16 MiB per minute is 16 MiB / 6 per 10 s tick.
		{"io 16 MiB/min", func(*idleRig) {}, 16<<20/6 + 1},
	}
	for _, tc := range tests {
		t.Run(tc.name, func(t *testing.T) {
			r := newIdleRig(t)
			tc.setup(r)
			r.advance(60, tc.io)
			if r.idle() || len(idleEvents(t, r.rec)) != 0 {
				t.Fatalf("idle with %s", tc.name)
			}
		})
	}
}

func TestIdleUsesWindowAverages(t *testing.T) {
	r := newIdleRig(t)
	// One CPU spike inside the window keeps the average below 5%.
	r.advance(15, 0)
	r.s.set(40, 0)
	r.advance(1, 0)
	r.s.set(1, 0)
	r.advance(15, 0)
	if !r.idle() {
		t.Fatal("a short CPU spike prevented idleness")
	}

	// A burst of IO is averaged over the window too: 10 MiB once is below
	// 16 MiB per minute over 5 min.
	r2 := newIdleRig(t)
	r2.advance(10, 0)
	r2.advance(1, 10<<20)
	r2.advance(20, 0)
	if !r2.idle() {
		t.Fatal("a small IO burst prevented idleness")
	}
}

func TestIdleRun(t *testing.T) {
	r := newIdleRig(t)
	r.l.Window = 20 * time.Millisecond
	r.l.Tick = time.Millisecond
	ctx, cancel := context.WithCancel(t.Context())
	done := make(chan struct{})
	go func() {
		defer close(done)
		r.l.Run(ctx)
	}()
	waitFor(t, r.idle)
	cancel()
	<-done
}
