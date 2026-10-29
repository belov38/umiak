package server_test

import (
	"context"
	"errors"
	"io"
	"net"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	"github.com/belov38/boat-dev-clone/libs/tunnel/gateway"
	"github.com/belov38/boat-dev-clone/libs/tunnel/tunneltest/pgtest"
	"github.com/belov38/boat-dev-clone/services/gateway/internal/routes"
	"github.com/belov38/boat-dev-clone/services/gateway/internal/server"
	"github.com/belov38/boat-dev-clone/services/gateway/internal/testenv"
)

func TestMain(m *testing.M) { pgtest.Main(m) }

func get(t *testing.T, url string) (int, string) {
	t.Helper()
	req, err := http.NewRequestWithContext(context.Background(), http.MethodGet, url, nil)
	if err != nil {
		t.Fatal(err)
	}
	resp, err := http.DefaultClient.Do(req)
	if err != nil {
		t.Fatal(err)
	}
	defer func() { _ = resp.Body.Close() }()
	b, _ := io.ReadAll(resp.Body)
	return resp.StatusCode, string(b)
}

func serveGet(h http.Handler, path string) int {
	rec := httptest.NewRecorder()
	h.ServeHTTP(rec, httptest.NewRequestWithContext(context.Background(), http.MethodGet, path, nil))
	return rec.Code
}

func eventually(t *testing.T, timeout time.Duration, what string, cond func() bool) {
	t.Helper()
	deadline := time.Now().Add(timeout)
	for !cond() {
		if time.Now().After(deadline) {
			t.Fatalf("timed out after %s waiting for %s", timeout, what)
		}
		time.Sleep(10 * time.Millisecond)
	}
}

func TestInstanceRunReady(t *testing.T) {
	env := testenv.New(t, testenv.Options{})
	inst, err := server.New(env.InstanceConfig("gw-ready", "http://127.0.0.1:1"), env.Deps())
	if err != nil {
		t.Fatal(err)
	}
	// Before Run nothing is ready, but the process is alive.
	if inst.Ready() {
		t.Fatal("Ready before Run")
	}
	if c := serveGet(inst.MetricsHandler(), "/readyz"); c != http.StatusServiceUnavailable {
		t.Fatalf("/readyz before Run = %d, want 503", c)
	}
	if c := serveGet(inst.MetricsHandler(), "/healthz"); c != http.StatusOK {
		t.Fatalf("/healthz before Run = %d, want 200", c)
	}

	ln, err := (&net.ListenConfig{}).Listen(context.Background(), "tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatal(err)
	}
	base := "http://" + ln.Addr().String()
	ctx, cancel := context.WithCancel(context.Background())
	done := make(chan error, 1)
	go func() { done <- inst.Run(ctx, server.Listeners{Metrics: ln}) }()

	eventually(t, 10*time.Second, "/readyz 200", func() bool {
		c, _ := get(t, base+"/readyz")
		return c == http.StatusOK
	})
	if c, _ := get(t, base+"/healthz"); c != http.StatusOK {
		t.Fatalf("/healthz = %d", c)
	}
	eventually(t, 10*time.Second, "postgres dependency up", func() bool {
		_, body := get(t, base+"/metrics")
		return strings.Contains(body, `sbx_gateway_dependency_up{dep="postgres"} 1`)
	})

	cancel()
	select {
	case err := <-done:
		if err != nil {
			t.Fatalf("Run = %v", err)
		}
	case <-time.After(10 * time.Second):
		t.Fatal("Run did not return")
	}
	if inst.Ready() {
		t.Fatal("Ready after Run returned")
	}
}

// A cancelled ctx is a normal stop, also when it interrupts the startup
// (the instance registration fails with the context error).
func TestInstanceRunCancelledAtStartup(t *testing.T) {
	env := testenv.New(t, testenv.Options{})
	for range 5 {
		inst, err := server.New(env.InstanceConfig("gw-cancel", "http://127.0.0.1:1"), env.Deps())
		if err != nil {
			t.Fatal(err)
		}
		ctx, cancel := context.WithCancel(context.Background())
		cancel()
		if err := inst.Run(ctx, server.Listeners{}); err != nil {
			t.Fatalf("Run with a cancelled ctx = %v, want nil", err)
		}
	}
}

// A peer CONNECT from instance B reaches a machine whose tunnel is on A.
func TestInstanceInternalListener(t *testing.T) {
	env := testenv.New(t, testenv.Options{})
	a := env.StartInstance(nil)
	m := env.NewMachine()
	m.ServeTCP(7000, testenv.Echo)
	b := env.StartInstance(nil)

	if _, ok := a.Tunnel().Machine(m.ID); !ok {
		t.Fatal("machine is not on A")
	}
	if _, ok := b.Tunnel().Machine(m.ID); ok {
		t.Fatal("machine is on B")
	}

	peer := gateway.NewPeerTransport()
	peer.DisableCompression = true
	t.Cleanup(peer.CloseIdleConnections)
	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()
	conn, err := gateway.DialRemoteTCP(ctx, peer, a.InternalURL, b.Config.PeerToken, m.ID, 7000, gateway.TCPOptions{})
	if err != nil {
		t.Fatalf("DialRemoteTCP: %v", err)
	}
	defer func() { _ = conn.Close() }()
	if _, err := conn.Write([]byte("hello")); err != nil {
		t.Fatal(err)
	}
	buf := make([]byte, 5)
	if _, err := io.ReadFull(conn, buf); err != nil {
		t.Fatal(err)
	}
	if string(buf) != "hello" {
		t.Fatalf("echo = %q", buf)
	}
}

func label(t *testing.T, raw string) routes.Label {
	t.Helper()
	l, ok := routes.ParseHost(raw+"."+testenv.SbxDomain, testenv.SbxDomain, routes.DefaultGrammar())
	if !ok {
		t.Fatalf("bad label %q", raw)
	}
	return l
}

func TestRoutesNotifyInvalidates(t *testing.T) {
	env := testenv.New(t, testenv.Options{})
	inst := env.StartInstance(nil)
	r := env.Route(nil, 8080, nil)
	l := label(t, r.Label)
	ctx := context.Background()

	for range 2 {
		if _, err := inst.Routes().Get(ctx, l); err != nil {
			t.Fatal(err)
		}
	}
	if n := env.API.Calls("LookupRoute"); n != 1 {
		t.Fatalf("lookups = %d, want 1 (cached)", n)
	}

	env.NotifyRoutes(r.Slug)
	eventually(t, time.Second, "lookup after NOTIFY", func() bool {
		if _, err := inst.Routes().Get(ctx, l); err != nil {
			t.Fatal(err)
		}
		return env.API.Calls("LookupRoute") == 2
	})

	// "*" drops everything.
	env.NotifyRoutes("*")
	eventually(t, time.Second, "lookup after NOTIFY *", func() bool {
		if _, err := inst.Routes().Get(ctx, l); err != nil {
			t.Fatal(err)
		}
		return env.API.Calls("LookupRoute") == 3
	})
}

func TestRoutesFlushOnListenReconnect(t *testing.T) {
	env := testenv.New(t, testenv.Options{})
	inst := env.StartInstance(nil)
	r := env.Route(nil, 8080, nil)
	if _, err := inst.Routes().Get(context.Background(), label(t, r.Label)); err != nil {
		t.Fatal(err)
	}
	if inst.Routes().Len() != 1 {
		t.Fatalf("cache len = %d, want 1", inst.Routes().Len())
	}

	var killed int
	err := env.Pool.QueryRow(context.Background(), `SELECT count(pg_terminate_backend(pid)) FROM pg_stat_activity
		WHERE datname = current_database() AND pid <> pg_backend_pid() AND query ILIKE 'listen %'`).Scan(&killed)
	if err != nil || killed != 1 {
		t.Fatalf("terminate listener: killed=%d err=%v", killed, err)
	}
	eventually(t, 10*time.Second, "cache flush after LISTEN reconnect", func() bool { return inst.Routes().Len() == 0 })
}

// A Drain that comes before Run (SIGTERM during startup) waits for Run,
// drains as usual and lets Run return; it never leaves Run serving.
func TestDrainBeforeRun(t *testing.T) {
	env := testenv.New(t, testenv.Options{})
	inst, err := server.New(env.InstanceConfig("gw-early-drain", "http://127.0.0.1:1"), env.Deps())
	if err != nil {
		t.Fatal(err)
	}
	drainDone := make(chan error, 1)
	go func() {
		ctx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
		defer cancel()
		drainDone <- inst.Drain(ctx)
	}()
	time.Sleep(100 * time.Millisecond) // the drain is waiting for Run
	select {
	case err := <-drainDone:
		t.Fatalf("Drain returned before Run: %v", err)
	default:
	}

	ln, err := (&net.ListenConfig{}).Listen(context.Background(), "tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatal(err)
	}
	runDone := make(chan error, 1)
	go func() { runDone <- inst.Run(context.Background(), server.Listeners{Metrics: ln}) }()
	for name, ch := range map[string]chan error{"Drain": drainDone, "Run": runDone} {
		select {
		case err := <-ch:
			if err != nil {
				t.Fatalf("%s = %v", name, err)
			}
		case <-time.After(15 * time.Second):
			t.Fatalf("%s did not return", name)
		}
	}
}

// A Drain before Run ends with its ctx when Run never comes, and returns
// nil at once when Run already returned without serving.
func TestDrainBeforeRunBounded(t *testing.T) {
	env := testenv.New(t, testenv.Options{})
	inst, err := server.New(env.InstanceConfig("gw-no-run", "http://127.0.0.1:1"), env.Deps())
	if err != nil {
		t.Fatal(err)
	}
	ctx, cancel := context.WithTimeout(context.Background(), 200*time.Millisecond)
	defer cancel()
	if err := inst.Drain(ctx); !errors.Is(err, context.DeadlineExceeded) {
		t.Fatalf("Drain without Run = %v, want the ctx error", err)
	}

	// Run fails at once: TLS on without certificate files.
	cfg := env.InstanceConfig("gw-bad-tls", "http://127.0.0.1:1")
	cfg.SbxCertFile, cfg.SbxKeyFile = "/nonexistent.pem", "/nonexistent.key"
	inst, err = server.New(cfg, env.Deps())
	if err != nil {
		t.Fatal(err)
	}
	ln, err := (&net.ListenConfig{}).Listen(context.Background(), "tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatal(err)
	}
	if err := inst.Run(context.Background(), server.Listeners{TLS: ln}); err == nil {
		t.Fatal("Run without certificates succeeded")
	}
	ctx2, cancel2 := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel2()
	if err := inst.Drain(ctx2); err != nil {
		t.Fatalf("Drain after a failed Run = %v, want nil", err)
	}
}

// The metrics listener bounds slow and idle clients.
func TestMetricsServerTimeouts(t *testing.T) {
	env := testenv.New(t, testenv.Options{})
	i := env.StartInstance(nil)
	srv := i.MetricsServer()
	if srv.ReadHeaderTimeout != 10*time.Second || srv.IdleTimeout != 120*time.Second {
		t.Fatalf("ReadHeaderTimeout=%s IdleTimeout=%s, want 10s and 2m", srv.ReadHeaderTimeout, srv.IdleTimeout)
	}
}
