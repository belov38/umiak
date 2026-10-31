package desktop

import "context"

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
