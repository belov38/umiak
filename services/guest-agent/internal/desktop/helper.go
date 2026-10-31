package desktop

import (
	"context"
	"errors"
	"net"
	"net/http"
	"os"
	"path/filepath"
	"time"
)

// RunHelper executes in the interactive user session, with socket filesystem ACLs.
func RunHelper(ctx context.Context, path string) error {
	ctx, cancel := context.WithCancel(ctx)
	defer cancel()
	s, e := NativeSession(ctx)
	if e != nil {
		return e
	}
	if closer, ok := s.(interface{ Close() error }); ok {
		defer func() { _ = closer.Close() }()
	}
	if e = os.MkdirAll(filepath.Dir(path), 0700); e != nil {
		return e
	}
	// Never unlink another live helper's endpoint.
	if c, err := (&net.Dialer{Timeout: time.Second}).DialContext(ctx, "unix", path); err == nil {
		_ = c.Close()
		return errors.New("session helper already running")
	}
	if e = os.Remove(path); e != nil && !os.IsNotExist(e) {
		return e
	}
	listener, e := (&net.ListenConfig{}).Listen(ctx, "unix", path)
	if e != nil {
		return e
	}
	defer func() { _ = listener.Close() }()
	defer func() { _ = os.Remove(path) }()
	if e = secureSocket(ctx, path); e != nil {
		return e
	}
	srv := &http.Server{Handler: SessionHandler(s), ReadHeaderTimeout: 5 * time.Second, ReadTimeout: 10 * time.Second, WriteTimeout: 65 * time.Second, IdleTimeout: 30 * time.Second, MaxHeaderBytes: 8192}
	go func() {
		var dead <-chan struct{}
		if s, ok := s.(interface{ Done() <-chan struct{} }); ok {
			dead = s.Done()
		}
		select {
		case <-ctx.Done():
		case <-dead:
		}
		_ = srv.Close()
	}()
	e = srv.Serve(listener)
	if errors.Is(e, http.ErrServerClosed) {
		return nil
	}
	return e
}
