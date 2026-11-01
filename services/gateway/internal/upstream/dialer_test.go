package upstream_test

import (
	"context"
	"errors"
	"io"
	"net"
	"net/http"
	"net/http/httptest"
	"sync/atomic"
	"testing"
	"time"

	"github.com/google/uuid"
	"github.com/prometheus/client_golang/prometheus/testutil"

	"github.com/belov38/umiak/libs/tunnel/tunneltest/pgtest"
	"github.com/belov38/umiak/libs/tunnel/wire"
	"github.com/belov38/umiak/services/gateway/internal/config"
	"github.com/belov38/umiak/services/gateway/internal/server"
	"github.com/belov38/umiak/services/gateway/internal/testenv"
	"github.com/belov38/umiak/services/gateway/internal/upstream"
)

func TestMain(m *testing.M) { pgtest.Main(m) }

// dialTimeout bounds a test's dial on success paths (the machine is loaded).
const dialTimeout = 30 * time.Second

func dial(t *testing.T, i *testenv.Inst, machineID string, port uint16) (*upstream.Conn, error) {
	t.Helper()
	ctx, cancel := context.WithTimeout(context.Background(), dialTimeout)
	defer cancel()
	return i.Upstream().Dial(ctx, machineID, port, time.Second)
}

func mustDial(t *testing.T, i *testenv.Inst, machineID string, port uint16) *upstream.Conn {
	t.Helper()
	c, err := dial(t, i, machineID, port)
	if err != nil {
		t.Fatalf("Dial(%d): %v", port, err)
	}
	t.Cleanup(func() { _ = c.Close() })
	return c
}

func echoRoundTrip(t *testing.T, c net.Conn, msg string) {
	t.Helper()
	if _, err := c.Write([]byte(msg)); err != nil {
		t.Fatalf("write: %v", err)
	}
	buf := make([]byte, len(msg))
	if _, err := io.ReadFull(c, buf); err != nil {
		t.Fatalf("read: %v", err)
	}
	if string(buf) != msg {
		t.Fatalf("echo = %q, want %q", buf, msg)
	}
}

// wantError checks that err is an *upstream.Error with the given status,
// code and reason.
func wantError(t *testing.T, err error, status int, code, reason string) {
	t.Helper()
	var ue *upstream.Error
	if !errors.As(err, &ue) {
		t.Fatalf("err = %v (%T), want *upstream.Error %s", err, err, code)
	}
	if ue.Status != status || ue.Code != code || ue.Reason != reason {
		t.Fatalf("err = {%d %s %s} (%v), want {%d %s %s}", ue.Status, ue.Code, ue.Reason, ue.Err, status, code, reason)
	}
}

func dialErrors(i *testenv.Inst, reason string) float64 {
	return testutil.ToFloat64(i.Metrics().UpstreamDialErrors.WithLabelValues(reason))
}

func eventually(t *testing.T, what string, cond func() bool) {
	t.Helper()
	deadline := time.Now().Add(testenv.WaitTimeout)
	for !cond() {
		if time.Now().After(deadline) {
			t.Fatalf("timed out waiting for %s", what)
		}
		time.Sleep(10 * time.Millisecond)
	}
}

func TestDialLocal(t *testing.T) {
	env := testenv.New(t, testenv.Options{})
	a := env.StartInstance(nil)
	m := env.NewMachine()
	m.ServeTCP(7000, testenv.Echo)

	c := mustDial(t, a, m.ID, 7000)
	if c.Via != upstream.ViaLocal || c.OwnerInstance != a.Name {
		t.Fatalf("Via, OwnerInstance = %q, %q; want local, %s", c.Via, c.OwnerInstance, a.Name)
	}
	echoRoundTrip(t, c, "hello local")
}

func TestDialPeer(t *testing.T) {
	env := testenv.New(t, testenv.Options{})
	a := env.StartInstance(nil)
	m := env.NewMachine()
	m.ServeTCP(7000, testenv.Echo)
	b := env.StartInstance(nil)

	c := mustDial(t, b, m.ID, 7000)
	if c.Via != upstream.ViaPeer || c.OwnerInstance != a.Name {
		t.Fatalf("Via, OwnerInstance = %q, %q; want peer, %s", c.Via, c.OwnerInstance, a.Name)
	}
	echoRoundTrip(t, c, "hello peer")
}

func TestDialWaitsForAgent(t *testing.T) {
	env := testenv.New(t, testenv.Options{})
	a := env.StartInstance(func(c *config.Config) { c.Timeouts.AgentWait = 20 * time.Second })
	m := env.NewMachine()
	m.ServeTCP(7000, testenv.Echo)
	m.Stop()
	eventually(t, "the machine to disconnect", func() bool {
		if _, ok := a.Tunnel().Machine(m.ID); ok {
			return false
		}
		_, ok, err := env.Store.Owner(context.Background(), m.ID, time.Minute)
		return err == nil && !ok
	})

	start := time.Now()
	go func() {
		time.Sleep(time.Second)
		m.Start()
	}()
	c := mustDial(t, a, m.ID, 7000)
	if el := time.Since(start); el < 900*time.Millisecond {
		t.Fatalf("dial returned after %s, before the agent started", el)
	}
	if c.Via != upstream.ViaLocal {
		t.Fatalf("Via = %q", c.Via)
	}
	echoRoundTrip(t, c, "after wait")
}

func TestDialAgentTimeout(t *testing.T) {
	env := testenv.New(t, testenv.Options{})
	a := env.StartInstance(func(c *config.Config) { c.Timeouts.AgentWait = 500 * time.Millisecond })

	start := time.Now()
	_, err := dial(t, a, uuid.NewString(), 7000)
	el := time.Since(start)
	wantError(t, err, http.StatusServiceUnavailable, "agent_unavailable", "agent_unavailable")
	if el < 450*time.Millisecond || el > 10*time.Second {
		t.Fatalf("agent_unavailable after %s, want about 500ms", el)
	}
	if n := dialErrors(a, "agent_unavailable"); n != 1 {
		t.Fatalf("dial errors{agent_unavailable} = %v", n)
	}
}

func TestDialRefusedTimeout(t *testing.T) {
	env := testenv.New(t, testenv.Options{})
	short := func(c *config.Config) { c.Timeouts.Dial = 500 * time.Millisecond }
	a := env.StartInstance(short)
	m := env.NewMachine()
	m.Blackhole(7001)
	b := env.StartInstance(short)

	for _, tc := range []struct {
		name string
		inst *testenv.Inst
	}{{"local", a}, {"peer", b}} {
		t.Run(tc.name, func(t *testing.T) {
			_, err := dial(t, tc.inst, m.ID, 7999)
			wantError(t, err, http.StatusBadGateway, "app_not_listening", "refused")
			if n := dialErrors(tc.inst, "refused"); n != 1 {
				t.Fatalf("dial errors{refused} = %v", n)
			}

			start := time.Now()
			_, err = dial(t, tc.inst, m.ID, 7001)
			wantError(t, err, http.StatusGatewayTimeout, "app_timeout", "timeout")
			if el := time.Since(start); el > 10*time.Second {
				t.Fatalf("app_timeout after %s, want about 500ms", el)
			}
			if n := dialErrors(tc.inst, "timeout"); n != 1 {
				t.Fatalf("dial errors{timeout} = %v", n)
			}
		})
	}
}

// The owner cache of B holds an outdated internal URL for A. The instance
// behind it answers 421 with a URL no live instance has; B must not send its
// token there, and dials the owner found by a fresh registry lookup.
func TestDialMovedValidated(t *testing.T) {
	env := testenv.New(t, testenv.Options{})
	a := env.StartInstance(nil)
	m := env.NewMachine()
	m.ServeTCP(7000, testenv.Echo)
	b := env.StartInstance(nil)

	var bogusHits atomic.Int64
	bogus := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		bogusHits.Add(1)
		w.WriteHeader(http.StatusOK)
	}))
	t.Cleanup(bogus.Close)

	var fakeHits atomic.Int64
	fake := httptest.NewUnstartedServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		fakeHits.Add(1)
		w.Header().Set(wire.HeaderErrorCode, wire.CodeMachineMoved)
		w.Header().Set(wire.HeaderInstanceURL, bogus.URL)
		w.WriteHeader(http.StatusMisdirectedRequest)
	}))
	var p http.Protocols
	p.SetUnencryptedHTTP2(true)
	fake.Config.Protocols = &p
	fake.Start()
	t.Cleanup(fake.Close)

	// Point A's row at the fake, let B cache it, then restore the row.
	setURL := func(u string) {
		t.Helper()
		if _, err := env.Pool.Exec(context.Background(),
			`UPDATE tunnel.gateway_instances SET internal_url = $2 WHERE id = $1`, a.Name, u); err != nil {
			t.Fatal(err)
		}
	}
	b.Owners().Invalidate(m.ID)
	setURL(fake.URL)
	o, ok, err := b.Owners().Lookup(context.Background(), m.ID)
	if err != nil || !ok || o.InternalURL != fake.URL {
		t.Fatalf("Lookup = %+v, %v, %v; want the fake URL", o, ok, err)
	}
	setURL(a.InternalURL)

	c := mustDial(t, b, m.ID, 7000)
	if c.Via != upstream.ViaPeer || c.OwnerInstance != a.Name {
		t.Fatalf("Via, OwnerInstance = %q, %q; want peer, %s", c.Via, c.OwnerInstance, a.Name)
	}
	echoRoundTrip(t, c, "after move")
	if n := fakeHits.Load(); n != 1 {
		t.Fatalf("fake owner got %d requests, want 1", n)
	}
	if n := bogusHits.Load(); n != 0 {
		t.Fatalf("unvalidated URL got %d requests", n)
	}
}

// fakePeer starts a cleartext HTTP/2 server standing in for an owner's
// internal listener.
func fakePeer(t *testing.T, h http.HandlerFunc) *httptest.Server {
	t.Helper()
	srv := httptest.NewUnstartedServer(h)
	var p http.Protocols
	p.SetUnencryptedHTTP2(true)
	srv.Config.Protocols = &p
	srv.Start()
	t.Cleanup(srv.Close)
	return srv
}

// staleOwner makes the owner cache of from hold owner's instance at url:
// owner's registry row points at url while the cache is filled, then gets
// its real URL back.
func staleOwner(t *testing.T, env *testenv.Env, owner, from *testenv.Inst, machineID, url string) {
	t.Helper()
	setURL := func(u string) {
		t.Helper()
		if _, err := env.Pool.Exec(context.Background(),
			`UPDATE tunnel.gateway_instances SET internal_url = $2 WHERE id = $1`, owner.Name, u); err != nil {
			t.Fatal(err)
		}
	}
	from.Owners().Invalidate(machineID)
	setURL(url)
	o, ok, err := from.Owners().Lookup(context.Background(), machineID)
	if err != nil || !ok || o.InternalURL != url {
		t.Fatalf("Lookup = %+v, %v, %v; want %s", o, ok, err, url)
	}
	setURL(owner.InternalURL)
}

// A 421 pointing at a live instance is followed once, there.
func TestDialMovedToLiveInstance(t *testing.T) {
	env := testenv.New(t, testenv.Options{})
	a := env.StartInstance(nil)
	m := env.NewMachine()
	m.ServeTCP(7000, testenv.Echo)
	b := env.StartInstance(nil)

	fake := fakePeer(t, func(w http.ResponseWriter, _ *http.Request) {
		w.Header().Set(wire.HeaderInstanceURL, a.InternalURL)
		w.WriteHeader(http.StatusMisdirectedRequest)
	})
	staleOwner(t, env, a, b, m.ID, fake.URL)

	c := mustDial(t, b, m.ID, 7000)
	if c.Via != upstream.ViaPeer || c.OwnerInstance != a.Name {
		t.Fatalf("Via, OwnerInstance = %q, %q; want peer, %s", c.Via, c.OwnerInstance, a.Name)
	}
	echoRoundTrip(t, c, "followed")
}

// An owner that answers 503 has no session for the machine: the agent is
// reconnecting (spec 6.4). The dial waits for the new owner instead of
// failing at once.
func TestDialOwnerWithoutSessionWaits(t *testing.T) {
	env := testenv.New(t, testenv.Options{})
	a := env.StartInstance(nil)
	m := env.NewMachine()
	m.ServeTCP(7000, testenv.Echo)
	b := env.StartInstance(nil)

	var hits atomic.Int64
	fake := fakePeer(t, func(w http.ResponseWriter, _ *http.Request) {
		hits.Add(1)
		w.Header().Set(wire.HeaderErrorCode, wire.CodeAgentUnavailable)
		w.WriteHeader(http.StatusServiceUnavailable)
	})
	staleOwner(t, env, a, b, m.ID, fake.URL)

	c := mustDial(t, b, m.ID, 7000)
	if c.Via != upstream.ViaPeer || c.OwnerInstance != a.Name {
		t.Fatalf("Via, OwnerInstance = %q, %q; want peer, %s", c.Via, c.OwnerInstance, a.Name)
	}
	echoRoundTrip(t, c, "after the owner's 503")
	if n := hits.Load(); n != 1 {
		t.Fatalf("stale owner got %d CONNECTs, want 1", n)
	}
}

// An owner that keeps answering 503 ends in agent_unavailable after
// AgentWait, polling the registry rather than spinning.
func TestDialOwnerWithoutSessionTimeout(t *testing.T) {
	const wait = 1500 * time.Millisecond
	env := testenv.New(t, testenv.Options{})
	a := env.StartInstance(nil)
	m := env.NewMachine()
	b := env.StartInstance(func(c *config.Config) { c.Timeouts.AgentWait = wait })

	var hits atomic.Int64
	fake := fakePeer(t, func(w http.ResponseWriter, _ *http.Request) {
		hits.Add(1)
		w.WriteHeader(http.StatusServiceUnavailable)
	})
	// The registry keeps naming the fake: every lookup gets its URL.
	if _, err := env.Pool.Exec(context.Background(),
		`UPDATE tunnel.gateway_instances SET internal_url = $2 WHERE id = $1`, a.Name, fake.URL); err != nil {
		t.Fatal(err)
	}
	b.Owners().Invalidate(m.ID)

	start := time.Now()
	_, err := dial(t, b, m.ID, 7000)
	el := time.Since(start)
	wantError(t, err, http.StatusServiceUnavailable, "agent_unavailable", "agent_unavailable")
	if el < wait*9/10 || el > wait+2*time.Second {
		t.Fatalf("agent_unavailable after %s, want about %s", el, wait)
	}
	// The poll backs off from 20 ms, doubling, to 200 ms: about 11 polls
	// in 1.5 s (a fixed 20 ms would be 75).
	if n := hits.Load(); n < 2 || n > 16 {
		t.Fatalf("owner got %d CONNECTs in %s, want a backed-off poll", n, el)
	}
}

// DialTimeout is one budget for the whole dial: a 421 that arrives late
// leaves the retry only the rest of it.
func TestDialSingleBudget(t *testing.T) {
	const budget = 2 * time.Second
	env := testenv.New(t, testenv.Options{})
	a := env.StartInstance(nil)
	m := env.NewMachine()
	m.Blackhole(7001)
	b := env.StartInstance(func(c *config.Config) { c.Timeouts.Dial = budget })

	// The stale owner answers 421 after 60% of the budget, pointing at the
	// live owner, where the dial hangs.
	fake := fakePeer(t, func(w http.ResponseWriter, r *http.Request) {
		select {
		case <-time.After(budget * 6 / 10):
		case <-r.Context().Done():
			return
		}
		w.Header().Set(wire.HeaderInstanceURL, a.InternalURL)
		w.WriteHeader(http.StatusMisdirectedRequest)
	})
	staleOwner(t, env, a, b, m.ID, fake.URL)

	start := time.Now()
	_, err := dial(t, b, m.ID, 7001)
	el := time.Since(start)
	wantError(t, err, http.StatusGatewayTimeout, "app_timeout", "timeout")
	if el < budget*9/10 || el > budget*13/10 {
		t.Fatalf("dial failed after %s, want about %s (one budget)", el, budget)
	}
}

func TestDialOverloaded(t *testing.T) {
	env := testenv.New(t, testenv.Options{Deps: func(d *server.Deps) { d.MaxTCPStreamsPerMachine = 2 }})
	a := env.StartInstance(nil)
	m := env.NewMachine()
	m.ServeTCP(7000, testenv.Echo)
	b := env.StartInstance(nil)

	c1 := mustDial(t, b, m.ID, 7000)
	c2 := mustDial(t, b, m.ID, 7000)
	echoRoundTrip(t, c1, "one")
	echoRoundTrip(t, c2, "two")

	_, err := dial(t, b, m.ID, 7000)
	wantError(t, err, http.StatusServiceUnavailable, "overloaded", "overloaded")
	_, err = dial(t, a, m.ID, 7000)
	wantError(t, err, http.StatusServiceUnavailable, "overloaded", "overloaded")

	// Closing a stream frees a slot.
	_ = c1.Close()
	eventually(t, "a free stream slot", func() bool {
		c, err := dial(t, b, m.ID, 7000)
		if err != nil {
			return false
		}
		_ = c.Close()
		return true
	})
}

// The owner is unreachable at its internal URL: agent_unavailable with the
// peer_error metric reason.
func TestDialPeerUnreachable(t *testing.T) {
	env := testenv.New(t, testenv.Options{})
	a := env.StartInstance(nil)
	m := env.NewMachine()
	b := env.StartInstance(nil)

	b.Owners().Invalidate(m.ID)
	if _, err := env.Pool.Exec(context.Background(),
		`UPDATE tunnel.gateway_instances SET internal_url = 'http://127.0.0.1:1' WHERE id = $1`, a.Name); err != nil {
		t.Fatal(err)
	}
	_, err := dial(t, b, m.ID, 7000)
	wantError(t, err, http.StatusServiceUnavailable, "agent_unavailable", "peer_error")
}

func TestErrorUnwrap(t *testing.T) {
	cause := errors.New("cause")
	err := error(&upstream.Error{Status: 502, Code: "upstream_error", Reason: "peer_error", Err: cause})
	if !errors.Is(err, cause) {
		t.Fatal("errors.Is does not see the cause")
	}
	if err.Error() == "" {
		t.Fatal("empty message")
	}
}

// A hostile or broken agent answers a CONNECT with a status that, from a
// peer, would mean a gateway signal: 503 (no session), 421 (moved), 429
// (too many streams), 401. From the agent it is only a refused dial: 502
// upstream_error at once, locally and through a peer. In particular an
// agent's 503 is not a reason to wait for the agent.
func TestDialAgentStatuses(t *testing.T) {
	env := testenv.New(t, testenv.Options{})
	a := env.StartInstance(func(c *config.Config) { c.Timeouts.AgentWait = 3 * time.Second })
	m := env.NewRawAgent(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.Method != http.MethodConnect {
			http.NotFound(w, r)
			return
		}
		_, port, _ := net.SplitHostPort(r.Host)
		w.Header().Set("Retry-After", "99999")
		w.Header().Set(wire.HeaderInstanceURL, "http://127.0.0.1:1")
		switch port {
		case "7001":
			w.WriteHeader(http.StatusServiceUnavailable)
		case "7002":
			w.WriteHeader(http.StatusMisdirectedRequest)
		case "7003":
			w.WriteHeader(http.StatusTooManyRequests)
		default:
			w.WriteHeader(http.StatusUnauthorized)
		}
	}))
	b := env.StartInstance(func(c *config.Config) { c.Timeouts.AgentWait = 3 * time.Second })

	for _, inst := range []*testenv.Inst{a, b} {
		for _, port := range []uint16{7001, 7002, 7003, 7004} {
			start := time.Now()
			_, err := dial(t, inst, m.ID, port)
			wantError(t, err, http.StatusBadGateway, "upstream_error", "upstream_error")
			if el := time.Since(start); el > time.Second {
				t.Fatalf("%s port %d: answer after %s, want at once", inst.Name, port, el)
			}
		}
	}
}
