package desktop

import (
	"context"
	"sync"
	"time"

	"connectrpc.com/connect"

	v1 "github.com/belov38/boat-dev-clone/libs/proto/sbx/agent/v1"
)

// PrepareRuntime rotates copied upstream files before desktop readiness, without video startup.
func (s *Service) PrepareRuntime(ctx context.Context) error {
	s.mu.Lock()
	defer s.mu.Unlock()
	if adapter, ok := s.opts.Streamer.(interface {
		PrepareIdentity(context.Context, Credentials, []*v1.DesktopIceServer) error
	}); ok {
		return adapter.PrepareIdentity(ctx, s.state.Credentials, s.ice)
	}
	return nil
}

// StreamerIdleStop is how long the streamer runs without a viewer before the
// agent stops it (spec section 8.4); the next Open starts it again.
const StreamerIdleStop = 15 * time.Minute

// StaleViewerWindow bounds how long failed observations keep the last viewer
// count (spec section 11.4): a broken observation must not keep a sandbox
// busy forever, so after this window of consecutive failures it counts zero.
const StaleViewerWindow = 2 * time.Minute

// viewerActivity is the state of PollViewers and the idle stop.
type viewerActivity struct {
	mu sync.Mutex
	// lastActive is the last Open or observed viewer.
	lastActive time.Time
	// failingSince is the first of the current run of failed observations.
	failingSince time.Time
	// idleStopped: the streamer was stopped for this idle period.
	idleStopped bool
}

func (a *viewerActivity) touch(now time.Time) {
	a.mu.Lock()
	defer a.mu.Unlock()
	a.lastActive = now
	a.idleStopped = false
}

// PollViewers samples the viewer count once (the desktop loop calls it every
// second). A failed observation keeps the previous count, at least one, for
// StaleViewerWindow and counts zero after it. With no viewer for
// StreamerIdleStop since the last Open or viewer, the streamer is stopped once.
func (s *Service) PollViewers(ctx context.Context) {
	adapter, ok := s.opts.Streamer.(interface {
		Viewers(context.Context) (uint32, error)
	})
	if !ok {
		return
	}
	octx, cancel := context.WithTimeout(ctx, 2*time.Second)
	count, e := adapter.Viewers(octx)
	cancel()
	now := s.now()
	a := &s.activity
	a.mu.Lock()
	if e != nil {
		if a.failingSince.IsZero() {
			a.failingSince = now
		}
		if now.Sub(a.failingSince) < StaleViewerWindow {
			count = max(s.Streams(), 1)
		} else {
			count = 0
		}
	} else {
		a.failingSince = time.Time{}
	}
	if count > 0 {
		a.lastActive = now
		a.idleStopped = false
	}
	stop := count == 0 && !a.idleStopped && now.Sub(a.lastActive) >= StreamerIdleStop
	if stop {
		a.idleStopped = true
	}
	a.mu.Unlock()
	s.StreamingChanged(count)
	if stop {
		// Idempotent: stopping a streamer that is not running is a no-op.
		if _, err := s.StopStreamer(ctx, connect.NewRequest(&v1.DesktopStopStreamerRequest{})); err != nil {
			// Try again after another idle period, not every second.
			a.touch(s.now())
		}
	}
}
