// Package logx provides a slog handler that never blocks the caller: records
// are formatted synchronously and written by a background goroutine. When the
// buffer is full the record is dropped and counted. On Windows, which has no
// journald, the handler writes to a size-rotated file (NewRotatingFile) that
// `umiak-agent logs` reads back with Tail.
package logx

import (
	"context"
	"fmt"
	"io"
	"log/slog"
	"sync"
	"sync/atomic"
)

// core is shared by a Handler and every handler derived from it.
type core struct {
	mu      sync.RWMutex // guards closed and sends on ch
	closed  bool
	ch      chan []byte
	done    chan struct{}
	dropped atomic.Uint64
}

// Write implements io.Writer for the formatting handler: it copies p and
// queues it without blocking.
func (c *core) Write(p []byte) (int, error) {
	line := append([]byte(nil), p...)
	c.mu.RLock()
	defer c.mu.RUnlock()
	if c.closed {
		c.dropped.Add(1)
		return len(p), nil
	}
	select {
	case c.ch <- line:
	default:
		c.dropped.Add(1)
	}
	return len(p), nil
}

func (c *core) drain(w io.Writer) {
	defer close(c.done)
	var reported uint64
	for line := range c.ch {
		_, _ = w.Write(line)
		if d := c.dropped.Load(); d != reported {
			_, _ = fmt.Fprintf(w, "level=WARN msg=\"log records dropped\" total=%d\n", d)
			reported = d
		}
	}
}

// Handler is an asynchronous slog.Handler.
type Handler struct {
	core  *core
	inner slog.Handler
}

// NewHandler returns a Handler that writes text records to w at or above
// level. buf is the number of records that can wait for the writer.
func NewHandler(w io.Writer, level slog.Level, buf int) *Handler {
	c := &core{ch: make(chan []byte, max(buf, 1)), done: make(chan struct{})}
	go c.drain(w)
	return &Handler{
		core:  c,
		inner: slog.NewTextHandler(c, &slog.HandlerOptions{Level: level}),
	}
}

// Enabled implements slog.Handler.
func (h *Handler) Enabled(ctx context.Context, l slog.Level) bool {
	return h.inner.Enabled(ctx, l)
}

// Handle implements slog.Handler. It never blocks on the underlying writer.
func (h *Handler) Handle(ctx context.Context, r slog.Record) error {
	return h.inner.Handle(ctx, r)
}

// WithAttrs implements slog.Handler.
func (h *Handler) WithAttrs(attrs []slog.Attr) slog.Handler {
	return &Handler{core: h.core, inner: h.inner.WithAttrs(attrs)}
}

// WithGroup implements slog.Handler.
func (h *Handler) WithGroup(name string) slog.Handler {
	return &Handler{core: h.core, inner: h.inner.WithGroup(name)}
}

// Dropped returns the number of records discarded so far.
func (h *Handler) Dropped() uint64 {
	return h.core.dropped.Load()
}

// Close stops accepting records and waits until queued ones are written.
// Records logged afterwards are dropped. It is safe to call more than once.
func (h *Handler) Close() {
	c := h.core
	c.mu.Lock()
	if !c.closed {
		c.closed = true
		close(c.ch)
	}
	c.mu.Unlock()
	<-c.done
}
