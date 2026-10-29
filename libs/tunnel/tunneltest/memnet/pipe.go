package memnet

import (
	"fmt"
	"io"
	"net"
	"os"
	"sync"
	"sync/atomic"
	"time"
)

var (
	errCut        = fmt.Errorf("memnet: link cut: %w", net.ErrClosed)
	errPeerClosed = fmt.Errorf("memnet: peer closed the connection: %w", io.ErrClosedPipe)
)

// ring is a byte queue that grows on demand up to max bytes.
type ring struct {
	buf  []byte
	head int
	n    int
	max  int
}

func (r *ring) free() int { return r.max - r.n }

// write copies as much of p as fits and returns the byte count.
func (r *ring) write(p []byte) int {
	k := min(len(p), r.free())
	if k == 0 {
		return 0
	}
	r.grow(r.n + k)
	tail := (r.head + r.n) % len(r.buf)
	c := copy(r.buf[tail:], p[:k])
	copy(r.buf, p[c:k])
	r.n += k
	return k
}

func (r *ring) grow(need int) {
	if need <= len(r.buf) {
		return
	}
	c := max(2*len(r.buf), 512)
	for c < need {
		c *= 2
	}
	c = min(c, r.max)
	nb := make([]byte, c)
	r.copyOut(nb[:r.n])
	r.buf, r.head = nb, 0
}

// copyOut copies the first len(dst) queued bytes into dst without consuming them.
func (r *ring) copyOut(dst []byte) {
	c := copy(dst, r.buf[r.head:min(r.head+len(dst), len(r.buf))])
	copy(dst[c:], r.buf)
}

func (r *ring) read(p []byte) int {
	k := min(len(p), r.n)
	r.copyOut(p[:k])
	r.head = (r.head + k) % max(len(r.buf), 1)
	r.n -= k
	if r.n == 0 {
		r.head = 0
	}
	return k
}

func (r *ring) reset() { r.buf, r.head, r.n = nil, 0, 0 }

// half is one direction of a link: a bounded queue plus the state flags of
// both of its ends.
type half struct {
	link *Link

	mu       sync.Mutex
	q        ring
	wClosed  bool // the writing end was closed: readers get EOF after the queue drains
	rClosed  bool // the reading end was closed: reads fail locally, writes fail on the peer
	cut      bool
	notifyCh chan struct{} // closed and cleared on every state change; nil if nobody waits
}

func newHalf(l *Link, size int) *half {
	return &half{link: l, q: ring{max: size}}
}

// broadcast wakes all waiters. h.mu must be held.
func (h *half) broadcast() {
	if h.notifyCh != nil {
		close(h.notifyCh)
		h.notifyCh = nil
	}
}

// waitCh returns a channel closed on the next state change. h.mu must be held.
func (h *half) waitCh() chan struct{} {
	if h.notifyCh == nil {
		h.notifyCh = make(chan struct{})
	}
	return h.notifyCh
}

func (h *half) doCut() {
	h.mu.Lock()
	h.cut = true
	h.q.reset()
	h.broadcast()
	h.mu.Unlock()
}

func (h *half) wake() {
	h.mu.Lock()
	h.broadcast()
	h.mu.Unlock()
}

// deadline is a resettable deadline whose channel is closed on expiry.
type deadline struct {
	mu      sync.Mutex
	timer   *time.Timer
	cancel  chan struct{}
	gen     uint64
	stopped bool
}

func newDeadline() *deadline { return &deadline{cancel: make(chan struct{})} }

func (d *deadline) set(t time.Time) {
	d.mu.Lock()
	defer d.mu.Unlock()
	if d.stopped {
		return
	}
	d.gen++
	if d.timer != nil {
		d.timer.Stop()
		d.timer = nil
	}
	select {
	case <-d.cancel:
		d.cancel = make(chan struct{})
	default:
	}
	if t.IsZero() {
		return
	}
	dur := time.Until(t)
	if dur <= 0 {
		close(d.cancel)
		return
	}
	gen, cancel := d.gen, d.cancel
	d.timer = time.AfterFunc(dur, func() {
		d.mu.Lock()
		defer d.mu.Unlock()
		if d.gen == gen {
			close(cancel)
		}
	})
}

// stop releases the timer; later set calls are ignored.
func (d *deadline) stop() {
	d.mu.Lock()
	defer d.mu.Unlock()
	d.stopped = true
	d.gen++
	if d.timer != nil {
		d.timer.Stop()
		d.timer = nil
	}
}

func (d *deadline) ch() chan struct{} {
	d.mu.Lock()
	defer d.mu.Unlock()
	return d.cancel
}

func expired(ch chan struct{}) bool {
	select {
	case <-ch:
		return true
	default:
		return false
	}
}

type addr string

func (addr) Network() string  { return "memnet" }
func (a addr) String() string { return string(a) }

// conn is one end of a link.
type conn struct {
	link   *Link
	r, w   *half
	rd, wd *deadline
	local  addr
	remote addr
	closed atomic.Bool
}

var _ net.Conn = (*conn)(nil)

func (c *conn) Read(p []byte) (int, error) {
	h := c.r
	for {
		h.mu.Lock()
		switch {
		case h.cut:
			h.mu.Unlock()
			return 0, errCut
		case h.rClosed:
			h.mu.Unlock()
			return 0, net.ErrClosed
		}
		dl := c.rd.ch()
		if expired(dl) {
			h.mu.Unlock()
			return 0, os.ErrDeadlineExceeded
		}
		if len(p) == 0 {
			h.mu.Unlock()
			return 0, nil
		}
		if !h.link.stalled() {
			if h.q.n > 0 {
				n := h.q.read(p)
				h.broadcast() // free space for writers
				h.mu.Unlock()
				return n, nil
			}
			if h.wClosed {
				h.mu.Unlock()
				return 0, io.EOF
			}
		}
		ch := h.waitCh()
		h.mu.Unlock()
		select {
		case <-ch:
		case <-dl:
		}
	}
}

func (c *conn) Write(p []byte) (int, error) {
	h := c.w
	total := 0
	for {
		h.mu.Lock()
		switch {
		case h.cut:
			h.mu.Unlock()
			return total, errCut
		case h.wClosed:
			h.mu.Unlock()
			return total, net.ErrClosed
		case h.rClosed:
			h.mu.Unlock()
			return total, errPeerClosed
		}
		dl := c.wd.ch()
		if expired(dl) {
			h.mu.Unlock()
			return total, os.ErrDeadlineExceeded
		}
		if n := h.q.write(p); n > 0 {
			p = p[n:]
			total += n
			h.broadcast()
		}
		if len(p) == 0 {
			h.mu.Unlock()
			return total, nil
		}
		ch := h.waitCh()
		h.mu.Unlock()
		select {
		case <-ch:
		case <-dl:
		}
	}
}

// Close closes this end: the peer drains what was already written and then
// reads io.EOF, and the peer's writes fail.
func (c *conn) Close() error {
	if !c.closed.CompareAndSwap(false, true) {
		return nil
	}
	c.w.mu.Lock()
	c.w.wClosed = true
	c.w.broadcast()
	c.w.mu.Unlock()

	c.r.mu.Lock()
	c.r.rClosed = true
	c.r.q.reset()
	c.r.broadcast()
	c.r.mu.Unlock()

	c.rd.stop()
	c.wd.stop()
	c.link.terminate()
	return nil
}

func (c *conn) LocalAddr() net.Addr  { return c.local }
func (c *conn) RemoteAddr() net.Addr { return c.remote }

func (c *conn) SetDeadline(t time.Time) error {
	c.rd.set(t)
	c.wd.set(t)
	return nil
}

func (c *conn) SetReadDeadline(t time.Time) error {
	c.rd.set(t)
	return nil
}

func (c *conn) SetWriteDeadline(t time.Time) error {
	c.wd.set(t)
	return nil
}
