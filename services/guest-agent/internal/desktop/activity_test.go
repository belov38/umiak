package desktop

import (
	"context"
	"errors"
	"testing"
	"time"
)

// viewerStreamer scripts Viewers results on top of fakeStreamer.
type viewerStreamer struct {
	fakeStreamer
	count uint32
	err   error
}

func (v *viewerStreamer) Viewers(context.Context) (uint32, error) { return v.count, v.err }

type clock struct{ t time.Time }

func (c *clock) now() time.Time      { return c.t }
func (c *clock) add(d time.Duration) { c.t = c.t.Add(d) }

func activityService(t *testing.T) (*Service, *viewerStreamer, *clock) {
	t.Helper()
	c := &clock{t: time.Date(2026, 11, 1, 12, 0, 0, 0, time.UTC)}
	v := &viewerStreamer{}
	s, err := New(Options{Enabled: true, Identity: "a", Dir: t.TempDir(), Session: &fakeSession{}, Streamer: v, Now: c.now})
	if err != nil {
		t.Fatal(err)
	}
	return s, v, c
}

// TestStreamerStopsAfterIdleWithoutViewers: section 8.4, the streamer is
// stopped once after 15 minutes without a viewer; a viewer or Open restarts
// the period.
func TestStreamerStopsAfterIdleWithoutViewers(t *testing.T) {
	s, v, c := activityService(t)
	ctx := context.Background()
	if _, err := s.Open(ctx, nil); err != nil {
		t.Fatal(err)
	}
	v.count = 1
	c.add(20 * time.Minute)
	s.PollViewers(ctx)
	v.count = 0
	c.add(StreamerIdleStop - time.Second)
	s.PollViewers(ctx)
	if v.stops != 0 {
		t.Fatalf("stopped %d times before the idle period ended", v.stops)
	}
	c.add(time.Second)
	s.PollViewers(ctx)
	c.add(time.Minute)
	s.PollViewers(ctx)
	if v.stops != 1 {
		t.Fatalf("stops = %d, want exactly 1", v.stops)
	}
	if _, err := s.Open(ctx, nil); err != nil {
		t.Fatal(err)
	}
	c.add(StreamerIdleStop)
	s.PollViewers(ctx)
	if v.stops != 2 {
		t.Fatalf("stops after the next open = %d, want 2", v.stops)
	}
}

// TestFailedObservationsStopCountingAfterWindow: section 11.4, a failing
// observation keeps the last viewer only for StaleViewerWindow.
func TestFailedObservationsStopCountingAfterWindow(t *testing.T) {
	s, v, c := activityService(t)
	ctx := context.Background()
	v.count = 2
	s.PollViewers(ctx)
	v.err = errors.New("conntrack unavailable")
	s.PollViewers(ctx)
	c.add(StaleViewerWindow - time.Second)
	s.PollViewers(ctx)
	if s.Streams() != 2 {
		t.Fatalf("streams during the window = %d, want the last count 2", s.Streams())
	}
	c.add(time.Second)
	s.PollViewers(ctx)
	if s.Streams() != 0 {
		t.Fatalf("streams after the window = %d, want 0", s.Streams())
	}
	v.err = nil
	v.count = 1
	s.PollViewers(ctx)
	v.err = errors.New("again")
	c.add(time.Second)
	s.PollViewers(ctx)
	if s.Streams() != 1 {
		t.Fatalf("a new failure run restarts the window; streams = %d", s.Streams())
	}
}
