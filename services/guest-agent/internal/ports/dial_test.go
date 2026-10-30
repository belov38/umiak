package ports

import (
	"context"
	"errors"
	"net"
	"net/netip"
	"slices"
	"sync"
	"testing"
	"time"

	"github.com/belov38/boat-dev-clone/libs/tunnel/agent"
)

func listen(t *testing.T, network, addr string) net.Listener {
	t.Helper()
	var lc net.ListenConfig
	ln, err := lc.Listen(t.Context(), network, addr)
	if err != nil {
		t.Skipf("cannot listen on %s: %v", addr, err)
	}
	t.Cleanup(func() { _ = ln.Close() })
	go func() {
		for {
			c, err := ln.Accept()
			if err != nil {
				return
			}
			_ = c.Close()
		}
	}()
	return ln
}

func portOf(ln net.Listener) int { return ln.Addr().(*net.TCPAddr).Port }

// closedPort returns a TCP port nothing listens on.
func closedPort(t *testing.T) int {
	t.Helper()
	var lc net.ListenConfig
	ln, err := lc.Listen(t.Context(), "tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatal(err)
	}
	p := portOf(ln)
	_ = ln.Close()
	return p
}

func noLocal() []netip.Addr { return nil }

func TestDialOrderLoopbackV6(t *testing.T) {
	ln := listen(t, "tcp6", "[::1]:0")
	d := Dialer{LocalAddrs: noLocal}
	for _, host := range []string{"localhost", "LocalHost", "127.0.0.1", ""} {
		conn, err := d.Dial(t.Context(), host, portOf(ln))
		if err != nil {
			t.Fatalf("%q: %v", host, err)
		}
		if got := conn.RemoteAddr().(*net.TCPAddr).IP; !got.Equal(net.IPv6loopback) {
			t.Fatalf("%q: connected to %v, want ::1", host, got)
		}
		_ = conn.Close()
	}
}

func TestDialInterfaceAddressFallback(t *testing.T) {
	// The fake interface address is just a second name for loopback here:
	// 127.0.0.2 answers on Linux but not on every OS, so use a recorder.
	var mu sync.Mutex
	var tried []string
	d := Dialer{
		LocalAddrs: func() []netip.Addr {
			return []netip.Addr{netip.MustParseAddr("fd00::5"), netip.MustParseAddr("10.0.0.5"), netip.MustParseAddr("fe80::1"), netip.MustParseAddr("127.0.0.1")}
		},
		dial: func(_ context.Context, _, addr string) (net.Conn, error) {
			mu.Lock()
			defer mu.Unlock()
			tried = append(tried, addr)
			return nil, &net.OpError{Op: "dial", Err: errors.New("connection refused")}
		},
	}
	_, err := d.Dial(t.Context(), "localhost", 8080)
	var de *agent.DialError
	if !errors.As(err, &de) || de.Reason != "refused" {
		t.Fatalf("err = %v, want refused DialError", err)
	}
	want := []string{"127.0.0.1:8080", "[::1]:8080", "10.0.0.5:8080", "[fd00::5]:8080"}
	if !slices.Equal(tried, want) {
		t.Fatalf("tried %v, want %v", tried, want)
	}
}

func TestDialRefused(t *testing.T) {
	p := closedPort(t)
	d := Dialer{LocalAddrs: noLocal}
	for _, host := range []string{"localhost", "127.0.0.1"} {
		conn, err := d.Dial(t.Context(), host, p)
		if conn != nil {
			_ = conn.Close()
		}
		var de *agent.DialError
		if !errors.As(err, &de) || de.Reason != "refused" {
			t.Fatalf("%s: err = %v, want refused DialError", host, err)
		}
	}
}

func TestDialStrictHost(t *testing.T) {
	// A listener on 127.0.0.1 only: naming ::1 must not fall back to it.
	ln := listen(t, "tcp", "127.0.0.1:0")
	d := Dialer{LocalAddrs: noLocal}
	_, err := d.Dial(t.Context(), "::1", portOf(ln))
	var de *agent.DialError
	if !errors.As(err, &de) || de.Reason != "refused" {
		t.Fatalf("err = %v, want refused DialError", err)
	}

	// Any other address is the only attempt.
	var tried []string
	d.dial = func(_ context.Context, _, addr string) (net.Conn, error) {
		tried = append(tried, addr)
		return nil, errors.New("connection refused")
	}
	if _, err := d.Dial(t.Context(), "10.1.2.3", 8080); err == nil {
		t.Fatal("expected error")
	}
	if want := []string{"10.1.2.3:8080"}; !slices.Equal(tried, want) {
		t.Fatalf("tried %v, want %v", tried, want)
	}
}

func TestDialTimeout(t *testing.T) {
	blocked := func(ctx context.Context, _, _ string) (net.Conn, error) {
		<-ctx.Done()
		return nil, ctx.Err()
	}
	t.Run("attempts", func(t *testing.T) {
		d := Dialer{LocalAddrs: noLocal, Attempt: 20 * time.Millisecond, Total: 5 * time.Second, dial: blocked}
		_, err := d.Dial(t.Context(), "localhost", 1)
		var de *agent.DialError
		if !errors.As(err, &de) || de.Reason != "timeout" {
			t.Fatalf("err = %v, want timeout DialError", err)
		}
	})
	t.Run("total", func(t *testing.T) {
		d := Dialer{LocalAddrs: noLocal, Attempt: 5 * time.Second, Total: 50 * time.Millisecond, dial: blocked}
		start := time.Now()
		_, err := d.Dial(t.Context(), "localhost", 1)
		var de *agent.DialError
		if !errors.As(err, &de) || de.Reason != "timeout" {
			t.Fatalf("err = %v, want timeout DialError", err)
		}
		if time.Since(start) > 2*time.Second {
			t.Fatalf("Total not enforced: %v", time.Since(start))
		}
	})
	t.Run("caller cancel", func(t *testing.T) {
		ctx, cancel := context.WithCancel(t.Context())
		cancel()
		d := Dialer{LocalAddrs: noLocal, dial: blocked}
		_, err := d.Dial(ctx, "localhost", 1)
		if !errors.Is(err, context.Canceled) {
			t.Fatalf("err = %v, want context.Canceled", err)
		}
	})
}

func TestCounterTracksClose(t *testing.T) {
	ln := listen(t, "tcp", "127.0.0.1:0")
	var c Counter
	d := Dialer{LocalAddrs: noLocal, Counter: &c}
	a, err := d.Dial(t.Context(), "127.0.0.1", portOf(ln))
	if err != nil {
		t.Fatal(err)
	}
	b, err := d.Dial(t.Context(), "127.0.0.1", portOf(ln))
	if err != nil {
		t.Fatal(err)
	}
	if got := c.Load(); got != 2 {
		t.Fatalf("Load = %d, want 2", got)
	}
	_ = a.Close()
	_ = a.Close() // second Close must not decrement again
	if got := c.Load(); got != 1 {
		t.Fatalf("Load = %d, want 1", got)
	}
	if cw, ok := b.(interface{ CloseWrite() error }); !ok || cw.CloseWrite() != nil {
		t.Fatal("wrapped conn must support CloseWrite")
	}
	_ = b.Close()
	if got := c.Load(); got != 0 {
		t.Fatalf("Load = %d, want 0", got)
	}
	// Failed dials leave the counter alone.
	if _, err := d.Dial(t.Context(), "127.0.0.1", closedPort(t)); err == nil {
		t.Fatal("expected error")
	}
	if got := c.Load(); got != 0 {
		t.Fatalf("Load after failed dial = %d", got)
	}
}
