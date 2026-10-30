package logx

import (
	"bytes"
	"log/slog"
	"strings"
	"sync"
	"testing"
	"time"
)

type blockedWriter struct{ release chan struct{} }

func (w blockedWriter) Write(p []byte) (int, error) {
	<-w.release
	return len(p), nil
}

func TestHandlerNeverBlocks(t *testing.T) {
	w := blockedWriter{release: make(chan struct{})}
	h := NewHandler(w, slog.LevelInfo, 16)
	defer func() {
		close(w.release)
		h.Close()
	}()
	log := slog.New(h)

	done := make(chan struct{})
	go func() {
		for i := range 10000 {
			log.Info("record", "i", i)
		}
		close(done)
	}()
	select {
	case <-done:
	case <-time.After(time.Second):
		t.Fatal("Handle blocked")
	}
	if h.Dropped() == 0 {
		t.Error("Dropped() = 0, want > 0")
	}
}

type syncBuffer struct {
	mu sync.Mutex
	b  bytes.Buffer
}

func (s *syncBuffer) Write(p []byte) (int, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	return s.b.Write(p)
}

func (s *syncBuffer) String() string {
	s.mu.Lock()
	defer s.mu.Unlock()
	return s.b.String()
}

func TestHandlerFlushesOnClose(t *testing.T) {
	var buf syncBuffer
	h := NewHandler(&buf, slog.LevelInfo, 64)
	log := slog.New(h).With("svc", "agent").WithGroup("g")
	log.Debug("hidden")
	log.Info("hello", "k", "v")
	h.Close()
	h.Close() // idempotent

	out := buf.String()
	if strings.Contains(out, "hidden") {
		t.Errorf("debug record below level was written: %q", out)
	}
	for _, want := range []string{"msg=hello", "svc=agent", "g.k=v"} {
		if !strings.Contains(out, want) {
			t.Errorf("output %q lacks %q", out, want)
		}
	}
	if h.Dropped() != 0 {
		t.Errorf("Dropped() = %d", h.Dropped())
	}
	// Records after Close are dropped, not a panic.
	log.Info("late")
	if h.Dropped() != 1 {
		t.Errorf("Dropped() after close = %d, want 1", h.Dropped())
	}
}
