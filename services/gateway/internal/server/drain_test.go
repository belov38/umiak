package server_test

import (
	"bufio"
	"context"
	"crypto/ed25519"
	"crypto/rand"
	"errors"
	"io"
	"net"
	"net/http"
	"strings"
	"sync/atomic"
	"testing"
	"time"

	"github.com/prometheus/client_golang/prometheus/testutil"
	"golang.org/x/crypto/ssh"

	"github.com/belov38/umiak/libs/tunnel/gateway"
	"github.com/belov38/umiak/services/gateway/internal/config"
	"github.com/belov38/umiak/services/gateway/internal/cpapi"
	"github.com/belov38/umiak/services/gateway/internal/server"
	"github.com/belov38/umiak/services/gateway/internal/testenv"
	"github.com/belov38/umiak/services/gateway/internal/testenv/sshdtest"
)

func TestGraceArithmetic(t *testing.T) {
	cfg := config.Config{
		HTTPDrainDeadline: config.DefaultHTTPDrainDeadline,
		SSHDrainDeadline:  config.DefaultSSHDrainDeadline,
	}
	budget := server.DrainBudget(cfg, gateway.Timing{})
	// EndpointWait 5 s + DrainSpread 5 s + SSH drain 15 min + margin 10 s.
	if budget != 920*time.Second {
		t.Fatalf("budget %s, want 920s", budget)
	}
	// terminationGracePeriodSeconds (spec 10.5), with room for the
	// process's own bound (950 s).
	if grace := 960 * time.Second; budget > grace || 950*time.Second > grace {
		t.Fatalf("budget %s exceeds the grace period %s", budget, grace)
	}
	// The longest stream drain deadline fits: SSH streams keep 15 min,
	// HTTP streams 2 min, both after EndpointWait and the spread.
	for _, longest := range []time.Duration{cfg.SSHDrainDeadline, cfg.HTTPDrainDeadline, 15 * time.Minute} {
		if budget < 5*time.Second+5*time.Second+longest {
			t.Fatalf("budget %s below the stream deadline %s", budget, longest)
		}
	}
	// A longer SSH deadline grows the budget.
	cfg.SSHDrainDeadline = 20 * time.Minute
	if got := server.DrainBudget(cfg, gateway.Timing{}); got != 20*time.Minute+20*time.Second {
		t.Fatalf("budget %s with a 20 min SSH deadline", got)
	}
}

const drainSlug = "quiet-otter-lamp"

// sshShell logs in to the sandbox of m through inst and starts an
// interactive shell; it returns the client and the shell's stderr.
func sshShell(t *testing.T, env *testenv.Env, inst *testenv.Inst, m *testenv.Machine) (*ssh.Client, io.Reader) {
	t.Helper()
	sshd := sshdtest.New(t, env.Keys.UserCA.PublicKey(), "umiak")
	m.ServeSSHD(sshd)
	_, priv, err := ed25519.GenerateKey(rand.Reader)
	if err != nil {
		t.Fatal(err)
	}
	key, err := ssh.NewSignerFromKey(priv)
	if err != nil {
		t.Fatal(err)
	}
	line := strings.TrimSpace(string(ssh.MarshalAuthorizedKey(key.PublicKey())))
	env.API.SetSSH(func(r cpapi.SSHAuthorizeRequest) bool { return r.Sandbox == drainSlug && r.PublicKey == line },
		cpapi.SSHAuthorization{
			Allowed: true, Actor: cpapi.SSHActor{Kind: "user", UserID: "usr_1"}, UserID: "usr_1",
			SandboxID: "sb_x", MachineID: m.ID, SandboxState: "ready", LoginUser: "umiak", TeamID: "team_1",
		})
	c, err := ssh.Dial("tcp", inst.SSHAddr, &ssh.ClientConfig{
		User:            drainSlug,
		Auth:            []ssh.AuthMethod{ssh.PublicKeys(key)},
		HostKeyCallback: ssh.FixedHostKey(env.Keys.SSHHost.PublicKey()),
		Timeout:         testenv.WaitTimeout,
	})
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = c.Close() })
	s, err := c.NewSession()
	if err != nil {
		t.Fatal(err)
	}
	// The accepted pty-req marks the channel interactive before the reply
	// reaches the client.
	if err := s.RequestPty("xterm", 24, 80, ssh.TerminalModes{ssh.ECHO: 0}); err != nil {
		t.Fatal(err)
	}
	if _, err := s.StdinPipe(); err != nil {
		t.Fatal(err)
	}
	stderr, err := s.StderrPipe()
	if err != nil {
		t.Fatal(err)
	}
	if err := s.Shell(); err != nil {
		t.Fatal(err)
	}
	return c, stderr
}

// since returns when ch fires, measured from t0, or fails after d.
func since(t *testing.T, what string, t0 time.Time, ch <-chan time.Time, d time.Duration) time.Duration {
	t.Helper()
	select {
	case at := <-ch:
		return at.Sub(t0)
	case <-time.After(d):
		t.Fatalf("timed out waiting for %s", what)
		return 0
	}
}

func TestInstanceDrainOrder(t *testing.T) {
	// FastTiming: EndpointWait 100 ms, DrainSpread 100 ms, DrainMargin 1 s;
	// the test config: HTTP drain 1 s, SSH drain 2 s.
	env := testenv.New(t, testenv.Options{})
	inst := env.StartInstance(nil)
	m := env.NewMachine()
	entered := make(chan struct{}, 1)
	m.ServeHTTP(3000, http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		switch r.URL.Path {
		case "/slow":
			entered <- struct{}{}
			time.Sleep(500 * time.Millisecond)
			_, _ = io.WriteString(w, "done")
		case "/ws":
			c, brw, err := http.NewResponseController(w).Hijack()
			if err != nil {
				return
			}
			defer func() { _ = c.Close() }()
			_, _ = brw.WriteString("HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\n\r\n")
			_ = brw.Flush()
			_, _ = io.Copy(c, brw)
		}
	}))
	host := testenv.Host(env.Route(m, 3000, nil).Label)

	sshc, stderr := sshShell(t, env, inst, m)

	// A WebSocket over TLS.
	ws, err := env.TLSDial(inst, host, "http/1.1")
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = ws.Close() })
	if _, err := io.WriteString(ws, "GET /ws HTTP/1.1\r\nHost: "+host+"\r\nUpgrade: websocket\r\nConnection: Upgrade\r\n"+
		"Sec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==\r\nSec-WebSocket-Version: 13\r\n\r\n"); err != nil {
		t.Fatal(err)
	}
	br := bufio.NewReader(ws)
	resp, err := http.ReadResponse(br, nil)
	if err != nil {
		t.Fatalf("upgrade: %v", err)
	}
	_ = resp.Body.Close()
	if resp.StatusCode != http.StatusSwitchingProtocols {
		t.Fatalf("upgrade status %d", resp.StatusCode)
	}
	if _, err := io.WriteString(ws, "ping"); err != nil {
		t.Fatal(err)
	}
	buf := make([]byte, 4)
	if _, err := io.ReadFull(br, buf); err != nil || string(buf) != "ping" {
		t.Fatalf("ws echo %q %v", buf, err)
	}

	// A request in flight when the drain starts.
	type slowResult struct {
		code int
		body string
		err  error
	}
	slow := make(chan slowResult, 1)
	client := env.HTTPClient(inst, false)
	go func() {
		req, _ := http.NewRequestWithContext(context.Background(), http.MethodGet, "https://"+host+"/slow", nil)
		resp, err := client.Do(req)
		if err != nil {
			slow <- slowResult{err: err}
			return
		}
		defer func() { _ = resp.Body.Close() }()
		b, err := io.ReadAll(resp.Body)
		slow <- slowResult{resp.StatusCode, string(b), err}
	}()
	select {
	case <-entered:
	case <-time.After(testenv.WaitTimeout):
		t.Fatal("slow request did not reach the app")
	}

	t0 := time.Now()
	drained := make(chan time.Time, 1)
	var drainErr atomic.Value
	go func() {
		ctx, cancel := context.WithTimeout(context.Background(), testenv.WaitTimeout)
		defer cancel()
		if err := inst.Drain(ctx); err != nil {
			drainErr.Store(err)
		}
		drained <- time.Now()
	}()

	// The internal listener is watched from the start: when it first
	// refuses a conn, the tunnel drain must be over.
	internalClosed := make(chan time.Time, 1)
	var tunnelDrainedFirst atomic.Bool
	go func() {
		addr := strings.TrimPrefix(inst.InternalURL, "http://")
		for {
			c, err := (&net.Dialer{Timeout: time.Second}).DialContext(context.Background(), "tcp", addr)
			if err != nil {
				ctx, cancel := context.WithTimeout(context.Background(), 20*time.Millisecond)
				err := inst.Tunnel().Drain(ctx)
				cancel()
				tunnelDrainedFirst.Store(!errors.Is(err, context.DeadlineExceeded))
				internalClosed <- time.Now()
				return
			}
			_ = c.Close()
			time.Sleep(10 * time.Millisecond)
		}
	}()

	// Ready turns false at once.
	eventually(t, time.Second, "/readyz 503", func() bool {
		return serveGet(inst.MetricsHandler(), "/readyz") == http.StatusServiceUnavailable
	})
	if d := time.Since(t0); d >= 100*time.Millisecond {
		t.Errorf("/readyz 503 after %s", d)
	}
	// New TLS conns are still accepted during EndpointWait.
	if c, err := env.TLSDial(inst, host, "http/1.1"); err != nil {
		if time.Since(t0) < 80*time.Millisecond {
			t.Errorf("TLS dial during EndpointWait: %v", err)
		}
	} else {
		_ = c.Close()
	}

	// SSH: the warning goes out at once (2 s left: "1 min").
	want := "umiak: gateway restarting, this SSH session will close in 1 min; reconnect to continue\r\n"
	warned := make(chan string, 1)
	go func() {
		wb := make([]byte, len(want))
		n, _ := io.ReadFull(stderr, wb)
		warned <- string(wb[:n])
	}()
	select {
	case got := <-warned:
		if got != want {
			t.Fatalf("ssh stderr %q", got)
		}
	case <-time.After(5 * time.Second):
		t.Fatal("no SSH drain warning")
	}
	gauge := func(kind string) float64 {
		return testutil.ToFloat64(inst.Metrics().DrainOpenStreams.WithLabelValues(kind))
	}
	if g := gauge("ssh"); g != 1 {
		t.Errorf("drain_open_streams{ssh} = %v, want 1", g)
	}
	if g := gauge("http"); g != 1 {
		t.Errorf("drain_open_streams{http} = %v, want 1", g)
	}

	// After EndpointWait new TLS conns are refused.
	refused := make(chan time.Time, 1)
	go func() {
		for {
			c, err := (&net.Dialer{Timeout: time.Second}).DialContext(context.Background(), "tcp", inst.HTTPSAddr)
			if err != nil {
				refused <- time.Now()
				return
			}
			_ = c.Close()
			time.Sleep(5 * time.Millisecond)
		}
	}()
	if d := since(t, "the TLS listener to close", t0, refused, 5*time.Second); d < 100*time.Millisecond {
		t.Errorf("TLS refused after %s, before EndpointWait", d)
	}

	// The request in flight completes.
	select {
	case r := <-slow:
		if r.err != nil || r.code != http.StatusOK || r.body != "done" {
			t.Fatalf("slow request: %+v", r)
		}
	case <-time.After(5 * time.Second):
		t.Fatal("slow request did not complete")
	}

	// The WebSocket is closed at the HTTP drain deadline (1 s).
	wsClosed := make(chan time.Time, 1)
	go func() {
		_, _ = io.Copy(io.Discard, br)
		wsClosed <- time.Now()
	}()
	if d := since(t, "the WebSocket to close", t0, wsClosed, 5*time.Second); d < time.Second || d > 1900*time.Millisecond {
		t.Errorf("WebSocket closed after %s, want 1 s", d)
	}

	// SSH closes at its deadline (2 s).
	sshClosed := make(chan time.Time, 1)
	go func() {
		_ = sshc.Wait()
		sshClosed <- time.Now()
	}()
	if d := since(t, "the SSH conn to close", t0, sshClosed, 5*time.Second); d < 1900*time.Millisecond || d > 2900*time.Millisecond {
		t.Errorf("SSH closed after %s, want 2 s", d)
	}

	// Drain returns: SSH 2 s + EndpointWait + DrainSpread + DrainMargin
	// bound the tunnel drain.
	if d := since(t, "Drain to return", t0, drained, 10*time.Second); d > 2*time.Second+200*time.Millisecond+time.Second+time.Second {
		t.Errorf("Drain took %s", d)
	}
	if err, _ := drainErr.Load().(error); err != nil {
		t.Fatalf("Drain = %v", err)
	}
	since(t, "the internal listener to close", t0, internalClosed, 5*time.Second)
	if !tunnelDrainedFirst.Load() {
		t.Error("the internal listener closed before the tunnel drain ended")
	}
	if g := gauge("ssh"); g != 0 {
		t.Errorf("drain_open_streams{ssh} = %v after the drain", g)
	}
	if g := gauge("http"); g != 0 {
		t.Errorf("drain_open_streams{http} = %v after the drain", g)
	}
	// A second Drain returns the first one's result at once.
	ctx, cancel := context.WithTimeout(context.Background(), time.Second)
	defer cancel()
	if err := inst.Drain(ctx); err != nil {
		t.Fatalf("second Drain = %v", err)
	}
}
