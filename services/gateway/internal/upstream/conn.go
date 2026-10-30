package upstream

import (
	"errors"
	"net"
	"sync"
	"sync/atomic"
	"time"
)

// Values of Conn.Via.
const (
	ViaLocal = "local"
	ViaPeer  = "peer"
)

// Conn is a stream to an application port: a tunnel CONNECT stream on this
// instance (Via local) or a peer CONNECT to the owner instance (Via peer).
//
// The underlying streams have no deadlines (their setters fail with
// errors.ErrUnsupported). Conn's deadline setters therefore do nothing and
// return nil, so http.Transport works on it; only Close unblocks Read and
// Write. SetIdleTimeout closes the conn after a period without bytes.
type Conn struct {
	net.Conn
	// Via is ViaLocal or ViaPeer.
	Via string
	// OwnerInstance is the id of the gateway instance holding the tunnel.
	OwnerInstance string

	idle  time.Duration
	base  time.Time    // monotonic origin of last
	last  atomic.Int64 // time since base of the last Read/Write progress
	mu    sync.Mutex
	timer *time.Timer
	done  bool

	// head checks HTTP/1.1 response heads; nil unless WatchResponseHeads.
	head *headScanner
}

// SetIdleTimeout makes the conn close itself once no byte was read or
// written for d. It may be called once, before the conn is in use; d <= 0
// does nothing.
func (c *Conn) SetIdleTimeout(d time.Duration) {
	if d <= 0 {
		return
	}
	c.mu.Lock()
	defer c.mu.Unlock()
	if c.done || c.timer != nil {
		return
	}
	c.idle = d
	c.base = time.Now()
	c.last.Store(0)
	c.timer = time.AfterFunc(d, c.idleCheck)
}

// idleCheck runs when the idle timer fires. Instead of resetting the timer
// on every Read and Write it checks the last activity and re-arms itself
// for the rest of the period.
func (c *Conn) idleCheck() {
	c.mu.Lock()
	if c.done {
		c.mu.Unlock()
		return
	}
	since := time.Since(c.base) - time.Duration(c.last.Load())
	if since < c.idle {
		c.timer.Reset(c.idle - since)
		c.mu.Unlock()
		return
	}
	c.done = true
	c.mu.Unlock()
	_ = c.Conn.Close()
}

func (c *Conn) touch() {
	if c.idle > 0 {
		c.last.Store(int64(time.Since(c.base)))
	}
}

// Read reads from the stream and records the activity.
func (c *Conn) Read(p []byte) (int, error) {
	n, err := c.Conn.Read(p)
	if n > 0 {
		c.touch()
		if c.head != nil {
			c.head.feed(p[:n])
		}
	}
	return n, err
}

// Write writes to the stream and records the activity.
func (c *Conn) Write(p []byte) (int, error) {
	n, err := c.Conn.Write(p)
	if n > 0 {
		c.touch()
	}
	return n, err
}

// Close stops the idle timer and closes the stream.
func (c *Conn) Close() error {
	c.mu.Lock()
	c.done = true
	if c.timer != nil {
		c.timer.Stop()
	}
	c.mu.Unlock()
	return c.Conn.Close()
}

// CloseWrite half-closes the stream (the application reads EOF) when the
// underlying stream supports it, else it returns errors.ErrUnsupported.
func (c *Conn) CloseWrite() error {
	if cw, ok := c.Conn.(interface{ CloseWrite() error }); ok {
		return cw.CloseWrite()
	}
	return errors.ErrUnsupported
}

// SetDeadline does nothing: the streams have no deadlines.
func (c *Conn) SetDeadline(time.Time) error { return nil }

// SetReadDeadline does nothing: the streams have no deadlines.
func (c *Conn) SetReadDeadline(time.Time) error { return nil }

// SetWriteDeadline does nothing: the streams have no deadlines.
func (c *Conn) SetWriteDeadline(time.Time) error { return nil }
