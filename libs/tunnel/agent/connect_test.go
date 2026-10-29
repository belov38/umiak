package agent_test

import (
	"context"
	"errors"
	"io"
	"net"
	"net/http"
	"strconv"
	"sync"
	"testing"

	"github.com/belov38/boat-dev-clone/libs/tunnel/agent"
)

func TestConnectPolicy(t *testing.T) {
	e := startEnv(t, fastConfig(), nil)
	c := e.gw.nextConn()

	echo := startEcho(t)
	s := dialConnect(t, c, echo.Addr().String())
	if s.status != http.StatusOK {
		t.Fatalf("CONNECT local: status %d", s.status)
	}
	s.echo(t, "hello")
	// Half-close towards the target: the echo server sees EOF, answers and
	// closes, and the stream ends cleanly.
	if err := s.w.Close(); err != nil {
		t.Fatal(err)
	}
	rest, err := io.ReadAll(s.body)
	if err != nil {
		t.Fatalf("read after half-close: %v", err)
	}
	if string(rest) != "|eof" {
		t.Fatalf("after half-close got %q, want |eof", rest)
	}

	// The same echo through "localhost" works too.
	_, port, _ := net.SplitHostPort(echo.Addr().String())
	s2 := dialConnect(t, c, "localhost:"+port)
	if s2.status != http.StatusOK {
		t.Fatalf("CONNECT localhost: status %d", s2.status)
	}
	s2.echo(t, "again")

	var lc net.ListenConfig
	refused, err := lc.Listen(context.Background(), "tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatal(err)
	}
	refusedAddr := refused.Addr().String()
	_ = refused.Close()

	for _, tc := range []struct {
		authority string
		want      int
	}{
		{"10.255.255.1:80", http.StatusForbidden},
		{"example.com:80", http.StatusForbidden},
		{"0.0.0.0:" + port, http.StatusForbidden},
		{"127.0.0.1:0", http.StatusBadRequest},
		{"127.0.0.1:70000", http.StatusBadRequest},
		{"127.0.0.1:ssh", http.StatusBadRequest},
		{refusedAddr, http.StatusBadGateway},
	} {
		got := dialConnect(t, c, tc.authority)
		if got.status != tc.want {
			t.Errorf("CONNECT %s: status %d, want %d", tc.authority, got.status, tc.want)
		}
	}
}

func TestCustomDialHook(t *testing.T) {
	type call struct {
		host string
		port int
	}
	var (
		mu    sync.Mutex
		calls []call
		fail  bool
	)
	cfg := fastConfig()
	cfg.Dial = func(_ context.Context, host string, port int) (net.Conn, error) {
		mu.Lock()
		calls = append(calls, call{host, port})
		f := fail
		mu.Unlock()
		if f {
			return nil, errors.New("no route")
		}
		a, b := net.Pipe()
		go func() {
			defer func() { _ = b.Close() }()
			_, _ = io.Copy(b, b)
		}()
		return a, nil
	}
	e := startEnv(t, cfg, nil)
	c := e.gw.nextConn()

	s := dialConnect(t, c, "127.0.0.1:1234")
	if s.status != http.StatusOK {
		t.Fatalf("status %d", s.status)
	}
	s.echo(t, "via hook")

	if got := dialConnect(t, c, "10.255.255.1:80"); got.status != http.StatusForbidden {
		t.Fatalf("non-local: status %d", got.status)
	}
	mu.Lock()
	fail = true
	mu.Unlock()
	if got := dialConnect(t, c, "[::1]:22"); got.status != http.StatusBadGateway {
		t.Fatalf("hook error: status %d", got.status)
	}

	mu.Lock()
	defer mu.Unlock()
	want := []call{{"127.0.0.1", 1234}, {"::1", 22}}
	if len(calls) != len(want) {
		t.Fatalf("calls = %v, want %v", calls, want)
	}
	for i := range want {
		if calls[i] != want[i] {
			t.Fatalf("calls = %v, want %v", calls, want)
		}
	}
}

func TestLocalOnly(t *testing.T) {
	p := agent.LocalOnly()
	ok := []string{"localhost", "LocalHost", "127.0.0.1", "127.1.2.3", "::1", "::ffff:127.0.0.1"}
	if addrs, err := net.InterfaceAddrs(); err == nil {
		for _, a := range addrs {
			if ipn, isNet := a.(*net.IPNet); isNet && !ipn.IP.IsLinkLocalUnicast() {
				ok = append(ok, ipn.IP.String())
			}
		}
	}
	for _, h := range ok {
		if err := p(h, 22); err != nil {
			t.Errorf("%s: %v, want allowed", h, err)
		}
	}
	for _, tc := range []struct {
		host string
		port int
		want int
	}{
		{"example.com", 80, http.StatusForbidden},
		{"localhost.example.com", 80, http.StatusForbidden},
		{"10.255.255.1", 80, http.StatusForbidden},
		{"0.0.0.0", 80, http.StatusForbidden},
		{"::", 80, http.StatusForbidden},
		{"127.0.0.1", 0, http.StatusBadRequest},
		{"127.0.0.1", 65536, http.StatusBadRequest},
		{"127.0.0.1", -1, http.StatusBadRequest},
	} {
		err := p(tc.host, tc.port)
		var pe *agent.PolicyError
		if !errors.As(err, &pe) || pe.Status != tc.want {
			t.Errorf("%s:%s: err %v, want status %d", tc.host, strconv.Itoa(tc.port), err, tc.want)
		}
	}
}
