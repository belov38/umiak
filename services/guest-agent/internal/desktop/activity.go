package desktop

import (
	"context"

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

// PollViewers never turns a failed observation into zero activity.
func (s *Service) PollViewers(ctx context.Context) {
	if adapter, ok := s.opts.Streamer.(interface {
		Viewers(context.Context) (uint32, error)
	}); ok {
		ctx, cancel := context.WithTimeout(ctx, 2e9)
		defer cancel()
		count, e := adapter.Viewers(ctx)
		if e != nil {
			s.StreamingChanged(max(s.Streams(), 1))
			return
		}
		s.StreamingChanged(count)
	}
}
