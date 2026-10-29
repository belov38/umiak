package agent

import (
	"math/rand/v2"
	"time"
)

// Default reconnect timings (spec section 6).
const (
	defaultBackoffFirst      = 250 * time.Millisecond
	defaultBackoffBase       = 500 * time.Millisecond
	defaultBackoffMax        = 10 * time.Second
	defaultBackoffResetAfter = 30 * time.Second
)

// Backoff is the reconnect delay schedule with full jitter: the first attempt
// waits rand[0, First], then rand[0, min(Base*2^(n-1), Max)]. A connection
// that lived at least ResetAfter resets the schedule. Zero fields take the
// spec defaults (250ms, 500ms, 10s, 30s). The zero value is usable; a Backoff
// is not safe for concurrent use.
type Backoff struct {
	First, Base, Max, ResetAfter time.Duration

	attempt int
	// rand returns a uniformly random duration in [0, n]; nil uses math/rand/v2.
	rand func(n time.Duration) time.Duration
}

func (b Backoff) withDefaults() Backoff {
	if b.First <= 0 {
		b.First = defaultBackoffFirst
	}
	if b.Base <= 0 {
		b.Base = defaultBackoffBase
	}
	if b.Max <= 0 {
		b.Max = defaultBackoffMax
	}
	if b.ResetAfter <= 0 {
		b.ResetAfter = defaultBackoffResetAfter
	}
	return b
}

// Next returns the delay before the next attempt and advances the schedule.
func (b *Backoff) Next() time.Duration {
	limit := b.First
	if b.attempt > 0 {
		limit = b.Base
		for i := 1; i < b.attempt && limit < b.Max; i++ {
			limit *= 2
		}
		limit = min(limit, b.Max)
	}
	b.attempt++
	return b.jitter(limit)
}

// Reset restarts the schedule from the first attempt.
func (b *Backoff) Reset() { b.attempt = 0 }

func (b *Backoff) jitter(n time.Duration) time.Duration {
	if b.rand != nil {
		return b.rand(n)
	}
	return randUpTo(n)
}

// randUpTo returns a uniformly random duration in [0, n].
func randUpTo(n time.Duration) time.Duration {
	if n <= 0 {
		return 0
	}
	return time.Duration(rand.Int64N(int64(n) + 1)) //nolint:gosec // jitter, not security sensitive
}
