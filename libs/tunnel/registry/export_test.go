package registry

import "time"

// SetListenLiveness shortens the LISTEN liveness timings for tests.
func SetListenLiveness(s *Store, idle, pingTimeout time.Duration) {
	s.listenIdle, s.listenPingTimeout = idle, pingTimeout
}

// ListenPings returns how many liveness pings Listen made.
func ListenPings(s *Store) int64 { return s.listenPings.Load() }
