package httpproxy

import (
	"bufio"
	"errors"
	"io"
	"net"
	"net/http"
	"sync"
	"sync/atomic"
	"time"
)

// StreamTracker holds the long-lived HTTP streams of an instance (WebSocket
// and other upgrades, SSE, bodies without a length), so the drain can close
// them at its deadline. It is safe for concurrent use.
type StreamTracker struct {
	mu      sync.Mutex
	streams map[*trackedStream]struct{}
	closed  bool
}

type trackedStream struct{ c io.Closer }

// NewStreamTracker returns an empty tracker.
func NewStreamTracker() *StreamTracker {
	return &StreamTracker{streams: map[*trackedStream]struct{}{}}
}

// Track registers c until done is called; done is idempotent. After
// CloseAll, c is closed at once (and still counted until done).
func (t *StreamTracker) Track(c io.Closer) (done func()) {
	s := &trackedStream{c: c}
	t.mu.Lock()
	t.streams[s] = struct{}{}
	closed := t.closed
	t.mu.Unlock()
	if closed {
		_ = c.Close()
	}
	var once sync.Once
	return func() {
		once.Do(func() {
			t.mu.Lock()
			delete(t.streams, s)
			t.mu.Unlock()
		})
	}
}

// CloseAll closes every tracked stream, and every stream tracked later.
// The streams stay counted until their owners call done.
func (t *StreamTracker) CloseAll() {
	t.mu.Lock()
	t.closed = true
	all := make([]io.Closer, 0, len(t.streams))
	for s := range t.streams {
		all = append(all, s.c)
	}
	t.mu.Unlock()
	for _, c := range all {
		_ = c.Close()
	}
}

// Count returns the number of tracked streams.
func (t *StreamTracker) Count() int {
	t.mu.Lock()
	defer t.mu.Unlock()
	return len(t.streams)
}

// closerFunc adapts a function (a request's cancel) to io.Closer.
type closerFunc func()

func (f closerFunc) Close() error {
	f()
	return nil
}

// recorder wraps the client's ResponseWriter: it records the status, the
// time to the response header, the Umiak-Error of gateway answers and the body
// bytes, and it wraps hijacked conns so upgrades are counted and tracked.
type recorder struct {
	rw    http.ResponseWriter
	start time.Time
	// onHijack registers a hijacked conn with the stream tracker.
	onHijack func(net.Conn)
	in       *atomic.Int64 // request bytes, shared with the body counter

	status   int // final status; 0 until the header is written
	umiakError string
	ttfb     time.Duration
	hijacked bool
	out      atomic.Int64
}

func (w *recorder) Header() http.Header { return w.rw.Header() }

// Unwrap lets http.ResponseController reach the server's writer.
func (w *recorder) Unwrap() http.ResponseWriter { return w.rw }

func (w *recorder) WriteHeader(code int) {
	// Informational answers (100, 103) pass through with the response
	// policy applied: ReverseProxy copies their headers here unfiltered.
	// One over the header cap is dropped: it is optional, and the final
	// answer follows. They are sent from the transport's goroutine, so they
	// must not touch the recorder's fields.
	if code >= 100 && code < 200 && code != http.StatusSwitchingProtocols {
		h := w.rw.Header()
		cleanResponseHeader(h)
		if headerSize(h) > maxHeaderBytes {
			clear(h)
			return
		}
		w.rw.WriteHeader(code)
		return
	}
	w.headerWritten(code)
	w.rw.WriteHeader(code)
}

func (w *recorder) headerWritten(code int) {
	if w.status != 0 {
		return
	}
	w.status = code
	w.umiakError = w.rw.Header().Get("Umiak-Error")
	w.ttfb = time.Since(w.start)
}

func (w *recorder) Write(p []byte) (int, error) {
	w.headerWritten(http.StatusOK)
	n, err := w.rw.Write(p)
	w.out.Add(int64(n))
	return n, err
}

// FlushError is what http.ResponseController.Flush calls.
func (w *recorder) FlushError() error {
	w.headerWritten(http.StatusOK)
	return http.NewResponseController(w.rw).Flush()
}

func (w *recorder) Flush() { _ = w.FlushError() }

// Hijack is called by ReverseProxy for a 101 answer. The returned conn
// counts bytes both ways; the raw conn is what the tracker closes. Bytes
// written through the returned bufio.Writer (the 101 header) and bytes the
// server had already buffered are not counted, so upgrade byte counts are
// approximate.
func (w *recorder) Hijack() (net.Conn, *bufio.ReadWriter, error) {
	c, brw, err := http.NewResponseController(w.rw).Hijack()
	if err != nil {
		return nil, nil, err
	}
	w.headerWritten(http.StatusSwitchingProtocols)
	w.hijacked = true
	if w.onHijack != nil {
		w.onHijack(c)
	}
	return &countingConn{Conn: c, in: w.in, out: &w.out}, brw, nil
}

// countingConn counts the bytes of a hijacked conn.
type countingConn struct {
	net.Conn
	in, out *atomic.Int64
}

func (c *countingConn) Read(p []byte) (int, error) {
	n, err := c.Conn.Read(p)
	c.in.Add(int64(n))
	return n, err
}

func (c *countingConn) Write(p []byte) (int, error) {
	n, err := c.Conn.Write(p)
	c.out.Add(int64(n))
	return n, err
}

// CloseWrite half-closes the client conn when the application ended its
// side, as ReverseProxy does with an unwrapped conn.
func (c *countingConn) CloseWrite() error {
	if cw, ok := c.Conn.(interface{ CloseWrite() error }); ok {
		return cw.CloseWrite()
	}
	return errors.ErrUnsupported
}

// countingBody counts the request body bytes.
type countingBody struct {
	io.ReadCloser
	n *atomic.Int64
}

func (b *countingBody) Read(p []byte) (int, error) {
	n, err := b.ReadCloser.Read(p)
	b.n.Add(int64(n))
	return n, err
}
