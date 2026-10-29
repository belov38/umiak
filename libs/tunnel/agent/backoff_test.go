package agent

import (
	"math/rand/v2"
	"testing"
	"time"
)

func TestBackoffSchedule(t *testing.T) {
	b := Backoff{First: 250 * time.Millisecond, Base: 500 * time.Millisecond, Max: 10 * time.Second, ResetAfter: 30 * time.Second}

	// With rand returning its upper bound the delays are the caps.
	b.rand = func(n time.Duration) time.Duration { return n }
	wantCaps := []time.Duration{
		250 * time.Millisecond, 500 * time.Millisecond, time.Second, 2 * time.Second,
		4 * time.Second, 8 * time.Second, 10 * time.Second, 10 * time.Second, 10 * time.Second,
	}
	for i, want := range wantCaps {
		if got := b.Next(); got != want {
			t.Fatalf("cap %d = %v, want %v", i, got, want)
		}
	}
	b.Reset()
	if got := b.Next(); got != 250*time.Millisecond {
		t.Fatalf("after Reset = %v, want 250ms", got)
	}
	// Many attempts must not overflow the cap.
	for range 200 {
		if got := b.Next(); got > 10*time.Second || got < 0 {
			t.Fatalf("delay %v out of range", got)
		}
	}

	// Full jitter with a seeded source: every delay is within [0, cap].
	r := rand.New(rand.NewPCG(1, 2))
	b.rand = func(n time.Duration) time.Duration { return time.Duration(r.Int64N(int64(n) + 1)) }
	b.Reset()
	var distinct = map[time.Duration]bool{}
	for i := range 50 {
		got := b.Next()
		limit := wantCaps[min(i, len(wantCaps)-1)]
		if got < 0 || got > limit {
			t.Fatalf("delay %d = %v, want in [0, %v]", i, got, limit)
		}
		distinct[got] = true
	}
	if len(distinct) < 10 {
		t.Fatalf("delays not jittered: %v", distinct)
	}
}

func TestBackoffDefaults(t *testing.T) {
	b := Backoff{}.withDefaults()
	if b.First != 250*time.Millisecond || b.Base != 500*time.Millisecond || b.Max != 10*time.Second || b.ResetAfter != 30*time.Second {
		t.Fatalf("defaults = %+v", b)
	}
	for range 100 {
		if d := b.Next(); d < 0 || d > 250*time.Millisecond {
			t.Fatalf("first delay %v", d)
		}
		b.Reset()
	}
}
