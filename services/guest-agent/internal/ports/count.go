package ports

import "sync/atomic"

// Counter counts live CONNECT streams. The zero value is ready to use and
// safe for concurrent use.
type Counter struct{ n atomic.Int64 }

// Inc adds one stream.
func (c *Counter) Inc() { c.n.Add(1) }

// Dec removes one stream.
func (c *Counter) Dec() { c.n.Add(-1) }

// Load returns the number of live streams.
func (c *Counter) Load() int64 { return c.n.Load() }
