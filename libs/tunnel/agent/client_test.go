package agent_test

import (
	"bytes"
	"context"
	"net/http"
	"runtime"
	"slices"
	"testing"
	"time"

	"connectrpc.com/connect"
	"google.golang.org/protobuf/types/known/durationpb"

	tunnelv1 "github.com/belov38/boat-dev-clone/libs/proto/sbx/tunnel/v1"
	"github.com/belov38/boat-dev-clone/libs/tunnel/agent"
	"github.com/belov38/boat-dev-clone/libs/tunnel/transport"
	"github.com/belov38/boat-dev-clone/libs/tunnel/tunneltest/memnet"
)

func TestConnectsWithBootstrapThenToken(t *testing.T) {
	e := startEnv(t, fastConfig(), nil)
	c1 := e.gw.nextConn()
	h := c1.hello
	if h.Scheme != transport.AuthBootstrap || !bytes.Equal(h.Secret, e.creds.bs) {
		t.Fatalf("first hello: scheme %v secret %x, want bootstrap %x", h.Scheme, h.Secret, e.creds.bs)
	}
	if h.MachineID != testMachineID || h.BootID != "boot-1" || h.AgentInstanceID != "inst-1" ||
		h.Vmgenid != "gen-1" || h.AgentVersion != "1.2.3" {
		t.Fatalf("hello identity = %+v", h)
	}

	token := newToken(t)
	setToken(t, c1, token)
	links := e.net.Links(testMachineID)
	if len(links) != 1 {
		t.Fatalf("links = %d, want 1", len(links))
	}
	links[0].Cut()

	c2 := e.gw.nextConn()
	if c2.hello.Scheme != transport.AuthToken || !bytes.Equal(c2.hello.Secret, token) {
		t.Fatalf("second hello: scheme %v secret %x, want token %x", c2.hello.Scheme, c2.hello.Secret, token)
	}

	evs := e.connEvents()
	var kinds []string
	for _, ev := range evs {
		kinds = append(kinds, ev.Kind)
	}
	if len(evs) < 3 || evs[0].Kind != "connected" || evs[0].ConnID != c1.info.ConnID ||
		evs[0].Epoch != c1.info.Epoch || evs[0].Gateway != "gw-a" || evs[0].Auth != transport.AuthBootstrap {
		t.Fatalf("conn events = %+v", evs)
	}
	if !slices.Contains(kinds, "disconnected") {
		t.Fatalf("no disconnected event: %v", kinds)
	}
}

func TestUnauthorizedTokenFallsBackToBootstrap(t *testing.T) {
	cfg := fastConfig()
	// A large backoff shows that the retry after 401 on MT does not wait.
	cfg.Backoff = agent.Backoff{First: time.Millisecond, Base: 2 * time.Second, Max: 2 * time.Second, ResetAfter: time.Minute}
	e := startEnv(t, cfg, nil)
	c1 := e.gw.nextConn()
	setToken(t, c1, newToken(t))
	e.gw.setReject(rejectWhen(func(_ int, h transport.Hello) bool { return h.Scheme == transport.AuthToken },
		&transport.RejectError{Status: http.StatusUnauthorized, Reason: "unknown token"}))
	n := e.gw.attemptCount()
	e.net.CutAll()

	// The reconnect itself follows the backoff; the fallback must be immediate.
	as := e.gw.waitAttempts(n + 2)
	rej, next := as[n], as[n+1]
	if rej.hello.Scheme != transport.AuthToken || rej.err == nil {
		t.Fatalf("attempt after cut: scheme %v err %v, want rejected token", rej.hello.Scheme, rej.err)
	}
	if next.hello.Scheme != transport.AuthBootstrap {
		t.Fatalf("attempt after 401: scheme %v, want bootstrap", next.hello.Scheme)
	}
	if gap := next.at.Sub(rej.at); gap > 50*time.Millisecond {
		t.Fatalf("bootstrap retry after %v, want within 50ms", gap)
	}
	e.gw.nextConn()
}

func TestBadBootstrapRereadsCredentials(t *testing.T) {
	cfg := fastConfig()
	cfg.RejectDelays.BadBootstrap = 100 * time.Millisecond
	e := startEnv(t, cfg, func(g *fakeGateway) {
		g.reject = rejectWhen(func(n int, _ transport.Hello) bool { return n == 0 },
			&transport.RejectError{Status: http.StatusUnauthorized, Reason: "bad bootstrap"})
	})
	as := e.gw.waitAttempts(2)
	if gap := as[1].at.Sub(as[0].at); gap < 100*time.Millisecond {
		t.Fatalf("retry after %v, want >= 100ms", gap)
	}
	if n := e.creds.calls.Load(); n < 2 {
		t.Fatalf("Bootstrap called %d times, want >= 2", n)
	}
	e.gw.nextConn()
	var rejected bool
	for _, ev := range e.connEvents() {
		if ev.Kind == "rejected" && ev.Status == http.StatusUnauthorized && ev.Auth == transport.AuthBootstrap {
			rejected = true
		}
	}
	if !rejected {
		t.Fatalf("no rejected event: %+v", e.connEvents())
	}
}

func TestRejectDelays(t *testing.T) {
	const delay = 100 * time.Millisecond
	cases := []struct {
		name     string
		rej      *transport.RejectError
		attempts int
		cfg      func(*agent.Config)
	}{
		{"403 retired", &transport.RejectError{Status: http.StatusForbidden}, 2,
			func(c *agent.Config) { c.RejectDelays.Retired = delay }},
		{"426 outdated", &transport.RejectError{Status: http.StatusUpgradeRequired}, 2,
			func(c *agent.Config) { c.RejectDelays.Outdated = delay }},
		{"503 retry-after", &transport.RejectError{Status: http.StatusServiceUnavailable, RetryAfter: delay}, 6,
			func(*agent.Config) {}},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			cfg := fastConfig()
			tc.cfg(&cfg)
			e := startEnv(t, cfg, func(g *fakeGateway) {
				g.reject = func(int, transport.Hello) error { return tc.rej }
			})
			as := e.gw.waitAttempts(tc.attempts)
			for i := 1; i < len(as); i++ {
				if gap := as[i].at.Sub(as[i-1].at); gap < delay {
					t.Fatalf("gap %d = %v, want >= %v", i, gap, delay)
				}
			}
		})
	}
}

// A huge Retry-After is capped at RejectDelays.MaxRetryAfter.
func TestRetryAfterCapped(t *testing.T) {
	const capped = 100 * time.Millisecond
	cfg := fastConfig()
	cfg.RejectDelays.MaxRetryAfter = capped
	e := startEnv(t, cfg, func(g *fakeGateway) {
		g.reject = func(int, transport.Hello) error {
			return &transport.RejectError{Status: http.StatusServiceUnavailable, RetryAfter: 1000 * time.Hour}
		}
	})
	as := e.gw.waitAttempts(3)
	for i := 1; i < len(as); i++ {
		// The cap plus at most 20% jitter, with scheduling slack.
		if gap := as[i].at.Sub(as[i-1].at); gap < capped || gap > capped*6/5+500*time.Millisecond {
			t.Fatalf("gap %d = %v, want about %v", i, gap, capped)
		}
	}
}

func TestInfoDefaults(t *testing.T) {
	e := startEnv(t, fastConfig(), nil)
	c := e.gw.nextConn()
	resp, err := c.control.Info(context.Background(), connect.NewRequest(&tunnelv1.InfoRequest{}))
	if err != nil {
		t.Fatal(err)
	}
	got := resp.Msg
	if got.GetAgentVersion() != "1.2.3" || got.GetOs() != runtime.GOOS || got.GetArch() != runtime.GOARCH ||
		!slices.Equal(got.GetProtoPackages(), []string{"sbx.tunnel.v1"}) {
		t.Fatalf("Info = %v", got)
	}
}

func TestInfoProvided(t *testing.T) {
	for _, pkgs := range [][]string{{"sbx.agent.v1"}, {"sbx.agent.v1", "sbx.tunnel.v1"}} {
		cfg := fastConfig()
		cfg.Info = func(context.Context) *tunnelv1.InfoResponse {
			return &tunnelv1.InfoResponse{AgentVersion: "9.9.9", Os: "plan9", Arch: "mips",
				ProtoPackages: slices.Clone(pkgs), Capabilities: []string{"pty"}}
		}
		e := startEnv(t, cfg, nil)
		c := e.gw.nextConn()
		resp, err := c.control.Info(context.Background(), connect.NewRequest(&tunnelv1.InfoRequest{}))
		if err != nil {
			t.Fatal(err)
		}
		got := resp.Msg
		if got.GetAgentVersion() != "9.9.9" || got.GetOs() != "plan9" || got.GetArch() != "mips" ||
			!slices.Equal(got.GetProtoPackages(), []string{"sbx.agent.v1", "sbx.tunnel.v1"}) ||
			!slices.Equal(got.GetCapabilities(), []string{"pty"}) {
			t.Fatalf("Info = %v", got)
		}
		e.stop()
	}
}

func TestDrainMakeBeforeBreak(t *testing.T) {
	cfg := fastConfig()
	cfg.DrainCloseExtra = 50 * time.Millisecond
	e := startEnv(t, cfg, nil)
	a := e.gw.nextConn()
	links := e.net.Links(testMachineID)
	if len(links) != 1 {
		t.Fatalf("links = %d", len(links))
	}
	linkA := links[0]

	echo := startEcho(t)
	s := dialConnect(t, a, echo.Addr().String())
	if s.status != http.StatusOK {
		t.Fatalf("CONNECT status %d", s.status)
	}
	s.echo(t, "before")

	ctx, cancel := context.WithTimeout(context.Background(), waitTimeout)
	defer cancel()
	if _, err := a.control.Drain(ctx, connect.NewRequest(&tunnelv1.DrainRequest{
		Reason: "deploy", TcpDeadline: durationpb.New(100 * time.Millisecond),
	})); err != nil {
		t.Fatal(err)
	}
	// A second drain on the retiring conn is a no-op.
	if _, err := a.control.Drain(ctx, connect.NewRequest(&tunnelv1.DrainRequest{Reason: "again"})); err != nil {
		t.Fatal(err)
	}

	b := e.gw.nextConn()
	select {
	case <-linkA.Closed():
		t.Fatal("old conn closed before the replacement was up")
	default:
	}
	s.echo(t, "during")
	closedAt := waitClosed(t, linkA.Closed(), "old conn close")
	if d := closedAt.Sub(b.at); d < 150*time.Millisecond || d > 5*time.Second {
		t.Fatalf("old conn closed %v after the replacement, want ~150ms", d)
	}
	if b.hello.Scheme != transport.AuthBootstrap {
		t.Fatalf("replacement scheme %v", b.hello.Scheme)
	}

	// Only one replacement was dialed and the new conn stays up.
	time.Sleep(100 * time.Millisecond)
	if n := e.gw.attemptCount(); n != 2 {
		t.Fatalf("attempts = %d, want 2", n)
	}
	if _, err := b.control.Info(ctx, connect.NewRequest(&tunnelv1.InfoRequest{})); err != nil {
		t.Fatalf("Info on replacement: %v", err)
	}
	var drain bool
	for _, ev := range e.connEvents() {
		if ev.Kind == "drain" && ev.ConnID == a.info.ConnID {
			drain = true
			if ev.TCPDeadline != 100*time.Millisecond {
				t.Fatalf("drain event TCPDeadline = %v, want 100ms", ev.TCPDeadline)
			}
		}
	}
	if !drain {
		t.Fatalf("no drain event: %+v", e.connEvents())
	}
}

func TestRunExitsOnCancel(t *testing.T) {
	cfg := fastConfig()
	e := startEnv(t, cfg, nil)
	a := e.gw.nextConn()
	// Keep a CONNECT stream and an event stream open while shutting down.
	echo := startEcho(t)
	s := dialConnect(t, a, echo.Addr().String())
	s.echo(t, "x")
	sub, err := a.events.Subscribe(context.Background(), connect.NewRequest(&tunnelv1.SubscribeRequest{}))
	if err != nil {
		t.Fatal(err)
	}
	defer func() { _ = sub.Close() }()

	var links []*memnet.Link
	links = append(links, e.net.Links(testMachineID)...)
	if len(links) != 1 {
		t.Fatalf("links = %d", len(links))
	}

	start := time.Now()
	e.stopOnce.Do(func() {
		e.cancel()
		select {
		case err := <-e.done:
			if err != nil {
				t.Errorf("Run = %v", err)
			}
		case <-time.After(time.Second):
			t.Error("Run did not return within 1s")
		}
	})
	if t.Failed() {
		t.FailNow()
	}
	if d := time.Since(start); d > time.Second {
		t.Fatalf("Run took %v", d)
	}
	for _, l := range links {
		select {
		case <-l.Closed():
		default:
			t.Fatal("link still open after Run returned")
		}
	}
	if n := len(e.net.Links(testMachineID)); n != 0 {
		t.Fatalf("live links after Run = %d", n)
	}
	if sub.Receive() {
		t.Fatal("subscribe stream delivered after shutdown")
	}
	evs := e.connEvents()
	if last := evs[len(evs)-1]; last.Kind != "disconnected" {
		t.Fatalf("last event %+v, want disconnected", last)
	}
}

func TestNewValidates(t *testing.T) {
	if _, err := agent.New(agent.Config{}); err == nil {
		t.Fatal("New without Dialer and Credentials succeeded")
	}
}

func TestReconnectsAfterGatewayCloses(t *testing.T) {
	e := startEnv(t, fastConfig(), nil)
	a := e.gw.nextConn()
	// The gateway closes its end only; the agent must notice and redial.
	if err := a.cc.Close(); err != nil {
		t.Fatal(err)
	}
	b := e.gw.nextConn()
	if b.info.Epoch <= a.info.Epoch {
		t.Fatalf("epoch %d after %d", b.info.Epoch, a.info.Epoch)
	}
	var reason string
	for _, ev := range e.connEvents() {
		if ev.Kind == agent.KindDisconnected && ev.ConnID == a.info.ConnID {
			reason = ev.Reason
		}
	}
	if reason == "" {
		t.Fatalf("no disconnected event for %s: %+v", a.info.ConnID, e.connEvents())
	}
}
