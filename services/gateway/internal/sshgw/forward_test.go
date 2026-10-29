package sshgw_test

import (
	"bytes"
	"context"
	"crypto/ed25519"
	"crypto/rand"
	"encoding/json"
	"errors"
	"io"
	"net"
	"slices"
	"strings"
	"testing"
	"time"

	"github.com/prometheus/client_golang/prometheus/testutil"
	"golang.org/x/crypto/ssh"
	"golang.org/x/crypto/ssh/agent"

	"github.com/belov38/boat-dev-clone/services/gateway/internal/config"
	"github.com/belov38/boat-dev-clone/services/gateway/internal/cpapi"
	"github.com/belov38/boat-dev-clone/services/gateway/internal/ratelimit"
	"github.com/belov38/boat-dev-clone/services/gateway/internal/sshgw"
	"github.com/belov38/boat-dev-clone/services/gateway/internal/testenv"
)

// userClient returns a fixture whose key logs in as usr_1, and a client.
func userClient(t *testing.T, mod func(*config.Config)) (*fixture, *ssh.Client, ssh.Signer) {
	t.Helper()
	f := newFixture(t, mod)
	key := newSigner(t)
	f.allowKey(key.PublicKey(), f.userAuth("usr_1"))
	return f, f.mustDial(t, f.slug, ssh.PublicKeys(key)), key
}

// sshLog returns the SSH log lines written so far.
func (f *fixture) sshLog(t *testing.T) []map[string]any {
	t.Helper()
	var out []map[string]any
	for line := range strings.SplitSeq(f.inst.AccessLog.String(), "\n") {
		if !strings.Contains(line, `"sessionId"`) {
			continue
		}
		var m map[string]any
		if err := json.Unmarshal([]byte(line), &m); err != nil {
			t.Fatalf("log line %q: %v", line, err)
		}
		out = append(out, m)
	}
	return out
}

// waitLog waits for the first SSH log line.
func (f *fixture) waitLog(t *testing.T) map[string]any {
	t.Helper()
	eventually(t, "the SSH log line", func() bool { return len(f.sshLog(t)) > 0 })
	return f.sshLog(t)[0]
}

// waitClosed waits until the client conn ends.
func waitClosed(t *testing.T, c *ssh.Client) {
	t.Helper()
	done := make(chan struct{})
	go func() {
		_ = c.Wait()
		close(done)
	}()
	select {
	case <-done:
	case <-time.After(testenv.WaitTimeout):
		t.Fatal("connection not closed")
	}
}

func TestForwardExecStdoutStderrExit(t *testing.T) {
	f, c, _ := userClient(t, nil)
	r := run(t, c, "echo out; stderr e2; exit 3")
	if r.err != nil || r.stdout != "out\n" || r.stderr != "err\ne2\n" || r.exit != 3 {
		t.Fatalf("exec: %v", r)
	}

	// exit-signal is passed on.
	s, err := c.NewSession()
	if err != nil {
		t.Fatal(err)
	}
	var out bytes.Buffer
	s.Stdout = &out
	err = s.Run("echo x; signal KILL")
	var ee *ssh.ExitError
	if !errors.As(err, &ee) || ee.Signal() != "KILL" || ee.Msg() != "killed" || out.String() != "x\n" {
		t.Fatalf("signal run: %v, stdout %q", err, out.String())
	}

	if got := testutil.ToFloat64(f.inst.Metrics().SSHSessions.WithLabelValues("ok")); got != 2 {
		t.Fatalf("ssh_sessions_total{ok} = %v", got)
	}
	if got := testutil.ToFloat64(f.inst.Metrics().SSHChannels.WithLabelValues("session")); got != 2 {
		t.Fatalf("ssh_channels_total{session} = %v", got)
	}
	if got := testutil.ToFloat64(f.inst.Metrics().SSHConnectionsActive); got != 1 {
		t.Fatalf("ssh_connections_active = %v", got)
	}

	_ = c.Close()
	l := f.waitLog(t)
	if l["closeReason"] != "client_closed" || l["userId"] != "usr_1" || l["actorKind"] != "user" || l["sandboxId"] != "sb_x" {
		t.Fatalf("log %v", l)
	}
	if l["backendHostKey"] != ssh.FingerprintSHA256(f.sshd.HostKey()) {
		t.Fatalf("backendHostKey %v", l["backendHostKey"])
	}
	if ch, _ := l["channels"].(map[string]any); ch["session"] != float64(2) || len(ch) != 1 {
		t.Fatalf("channels %v", l["channels"])
	}
	// out\n + err\ne2\n + x\n go to the client; nothing was sent.
	if l["bytesOut"] != float64(len("out\n")+len("err\ne2\n")+len("x\n")) || l["bytesIn"] != float64(0) {
		t.Fatalf("bytes in %v out %v", l["bytesIn"], l["bytesOut"])
	}
	eventually(t, "the gauge to drop", func() bool {
		return testutil.ToFloat64(f.inst.Metrics().SSHConnectionsActive) == 0
	})
}

func TestForwardPTYShell(t *testing.T) {
	f, c, _ := userClient(t, nil)
	s, err := c.NewSession()
	if err != nil {
		t.Fatal(err)
	}
	if err := s.RequestPty("xterm", 24, 80, ssh.TerminalModes{ssh.ECHO: 0}); err != nil {
		t.Fatalf("pty-req: %v", err)
	}
	if err := s.Setenv("FOO", "bar"); err != nil {
		t.Fatalf("env: %v", err)
	}
	stdin, err := s.StdinPipe()
	if err != nil {
		t.Fatal(err)
	}
	stdout, err := s.StdoutPipe()
	if err != nil {
		t.Fatal(err)
	}
	stderr, err := s.StderrPipe()
	if err != nil {
		t.Fatal(err)
	}
	if err := s.Shell(); err != nil {
		t.Fatalf("shell: %v", err)
	}
	readN := func(r io.Reader, want string) {
		t.Helper()
		buf := make([]byte, len(want))
		if _, err := io.ReadFull(r, buf); err != nil || string(buf) != want {
			t.Fatalf("read %q, %v; want %q", buf, err, want)
		}
	}
	if _, err := io.WriteString(stdin, "hello\n"); err != nil {
		t.Fatal(err)
	}
	readN(stdout, "hello\n")
	if err := s.WindowChange(40, 100); err != nil {
		t.Fatalf("window-change: %v", err)
	}

	// The pty-req marked the channel interactive: a gateway notice
	// reaches its stderr.
	srv := f.inst.SSH()
	eventually(t, "one interactive channel", func() bool { return sshgw.InteractiveChannels(srv) == 1 })
	sshgw.NotifyInteractive(srv, "sbx: notice")
	readN(stderr, "sbx: notice\r\n")

	if _, err := io.WriteString(stdin, "more\n"); err != nil {
		t.Fatal(err)
	}
	readN(stdout, "more\n")
	_ = stdin.Close()
	if err := s.Wait(); err != nil {
		t.Fatalf("wait: %v", err)
	}
	want := []string{"pty-req", "env", "shell", "window-change"}
	if got := f.sshd.Requests(); !slices.Equal(got, want) {
		t.Fatalf("sshd requests %q, want %q", got, want)
	}
	// A plain exec session is not interactive.
	if r := run(t, c, "echo hi"); r.stdout != "hi\n" {
		t.Fatalf("exec: %v", r)
	}
	if n := sshgw.InteractiveChannels(srv); n != 0 {
		t.Fatalf("%d interactive channels after the shell ended", n)
	}
}

func TestForwardSubsystem(t *testing.T) {
	f, c, _ := userClient(t, nil)
	s, err := c.NewSession()
	if err != nil {
		t.Fatal(err)
	}
	// RequestSubsystem does not start the session's copies, so the pipes
	// are used directly.
	stdin, err := s.StdinPipe()
	if err != nil {
		t.Fatal(err)
	}
	stdout, err := s.StdoutPipe()
	if err != nil {
		t.Fatal(err)
	}
	if err := s.RequestSubsystem("sftp"); err != nil {
		t.Fatalf("subsystem: %v", err)
	}
	if _, err := io.WriteString(stdin, "sftp bytes"); err != nil {
		t.Fatal(err)
	}
	_ = stdin.Close()
	if out, err := io.ReadAll(stdout); err != nil || string(out) != "sftp bytes" {
		t.Fatalf("stdout %q, %v", out, err)
	}
	if got := f.sshd.Requests(); !slices.Equal(got, []string{"subsystem"}) {
		t.Fatalf("sshd requests %q", got)
	}
}

// echoServer is an app "in the VM": it echoes every conn.
func echoServer(t *testing.T) string {
	t.Helper()
	ln, err := (&net.ListenConfig{}).Listen(context.Background(), "tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = ln.Close() })
	go func() {
		for {
			c, err := ln.Accept()
			if err != nil {
				return
			}
			go func() {
				defer func() { _ = c.Close() }()
				_, _ = io.Copy(c, c)
			}()
		}
	}()
	return ln.Addr().String()
}

func echoRoundTrip(t *testing.T, c net.Conn, msg string) {
	t.Helper()
	if _, err := io.WriteString(c, msg); err != nil {
		t.Fatal(err)
	}
	buf := make([]byte, len(msg))
	if _, err := io.ReadFull(c, buf); err != nil || string(buf) != msg {
		t.Fatalf("echo %q, %v", buf, err)
	}
}

func TestDirectTCPIP(t *testing.T) {
	f, c, _ := userClient(t, nil)
	addr := echoServer(t)
	tc, err := c.Dial("tcp", addr)
	if err != nil {
		t.Fatalf("dial through ssh: %v", err)
	}
	echoRoundTrip(t, tc, "ping")
	_ = tc.Close()

	// A refusal by the VM is passed on with its reason.
	dead, err := (&net.ListenConfig{}).Listen(context.Background(), "tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatal(err)
	}
	deadAddr := dead.Addr().String()
	_ = dead.Close()
	_, err = c.Dial("tcp", deadAddr)
	var oce *ssh.OpenChannelError
	if !errors.As(err, &oce) || oce.Reason != ssh.ConnectionFailed {
		t.Fatalf("dial to a closed port: %v", err)
	}
	if got := testutil.ToFloat64(f.inst.Metrics().SSHChannels.WithLabelValues("direct-tcpip")); got != 1 {
		t.Fatalf("ssh_channels_total{direct-tcpip} = %v", got)
	}
}

func TestRemoteForward(t *testing.T) {
	f, c, _ := userClient(t, nil)
	ln, err := c.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatalf("tcpip-forward: %v", err)
	}
	port := ln.Addr().(*net.TCPAddr).Port
	if port == 0 {
		t.Fatal("tcpip-forward reply carried no port")
	}
	go func() {
		for {
			sc, err := ln.Accept()
			if err != nil {
				return
			}
			go func() {
				defer func() { _ = sc.Close() }()
				_, _ = io.Copy(sc, sc)
			}()
		}
	}()
	// A conn to the forwarded port "in the VM" reaches the client.
	ctx, cancel := context.WithTimeout(context.Background(), testenv.WaitTimeout)
	defer cancel()
	vc, err := (&net.Dialer{}).DialContext(ctx, "tcp", ln.Addr().String())
	if err != nil {
		t.Fatal(err)
	}
	echoRoundTrip(t, vc, "remote")
	_ = vc.Close()
	if err := ln.Close(); err != nil {
		t.Fatalf("cancel-tcpip-forward: %v", err)
	}
	if got := f.sshd.GlobalRequests(); !slices.Equal(got, []string{"tcpip-forward", "cancel-tcpip-forward"}) {
		t.Fatalf("sshd global requests %q", got)
	}
	if got := testutil.ToFloat64(f.inst.Metrics().SSHChannels.WithLabelValues("forwarded-tcpip")); got != 1 {
		t.Fatalf("ssh_channels_total{forwarded-tcpip} = %v", got)
	}
}

func TestAgentForward(t *testing.T) {
	f, c, _ := userClient(t, nil)
	keyring := agent.NewKeyring()
	_, priv, err := ed25519.GenerateKey(rand.Reader)
	if err != nil {
		t.Fatal(err)
	}
	if err := keyring.Add(agent.AddedKey{PrivateKey: priv}); err != nil {
		t.Fatal(err)
	}
	if err := agent.ForwardToAgent(c, keyring); err != nil {
		t.Fatal(err)
	}
	s, err := c.NewSession()
	if err != nil {
		t.Fatal(err)
	}
	defer func() { _ = s.Close() }()
	if err := agent.RequestAgentForwarding(s); err != nil {
		t.Fatalf("auth-agent-req: %v", err)
	}
	eventually(t, "the agent reply in the VM", func() bool { return len(f.sshd.AgentReplies()) == 1 })
	const agentIdentitiesAnswer = 12
	msg := f.sshd.AgentReplies()[0]
	if len(msg) < 5 || msg[0] != agentIdentitiesAnswer || !bytes.Equal(msg[1:5], []byte{0, 0, 0, 1}) {
		t.Fatalf("agent reply % x", msg)
	}
	if err := s.Run("exit 0"); err != nil {
		t.Fatal(err)
	}
}

// rawClient connects with NewClientConn and records the global requests
// the client receives (answering false), so a test sees what the gateway
// sends.
type rawClient struct {
	*ssh.Client
	conn ssh.Conn
	got  chan string
}

func (f *fixture) rawClient(t *testing.T, key ssh.Signer) *rawClient {
	t.Helper()
	ctx, cancel := context.WithTimeout(context.Background(), testenv.WaitTimeout)
	defer cancel()
	raw, err := (&net.Dialer{}).DialContext(ctx, "tcp", f.inst.SSHAddr)
	if err != nil {
		t.Fatal(err)
	}
	sc, chans, reqs, err := ssh.NewClientConn(raw, f.inst.SSHAddr, &ssh.ClientConfig{
		User:            f.slug,
		Auth:            []ssh.AuthMethod{ssh.PublicKeys(key)},
		HostKeyCallback: ssh.FixedHostKey(f.env.Keys.SSHHost.PublicKey()),
	})
	if err != nil {
		t.Fatal(err)
	}
	rc := &rawClient{conn: sc, got: make(chan string, 100)}
	go func() {
		for r := range reqs {
			rc.got <- r.Type
			_ = r.Reply(false, nil)
		}
	}()
	none := make(chan *ssh.Request)
	close(none)
	rc.Client = ssh.NewClient(sc, chans, none)
	t.Cleanup(func() { _ = rc.Close() })
	return rc
}

func (rc *rawClient) received() []string {
	var out []string
	for {
		select {
		case s := <-rc.got:
			out = append(out, s)
		default:
			return out
		}
	}
}

func TestHostkeysDropped(t *testing.T) {
	f := newFixture(t, nil)
	key := newSigner(t)
	f.allowKey(key.PublicKey(), f.userAuth("usr_1"))
	rc := f.rawClient(t, key)
	// The exec proves the backend is connected; sshd sent hostkeys-00
	// right after its handshake.
	if r := run(t, rc.Client, "echo hi"); r.stdout != "hi\n" {
		t.Fatalf("exec: %v", r)
	}
	ok, _, err := rc.SendRequest("hostkeys-prove-00@openssh.com", true, ssh.Marshal(struct{ K string }{"x"}))
	if err != nil || ok {
		t.Fatalf("hostkeys-prove-00: ok %v err %v", ok, err)
	}
	time.Sleep(100 * time.Millisecond)
	if got := rc.received(); len(got) != 0 {
		t.Fatalf("client received global requests %q", got)
	}
	if got := f.sshd.GlobalRequests(); len(got) != 0 {
		t.Fatalf("sshd received %q", got)
	}
}

func TestUnknownGlobalRefused(t *testing.T) {
	f, c, _ := userClient(t, nil)
	for _, name := range []string{"foo@example.com", "keepalive@openssh.com", "hostkeys-00@openssh.com"} {
		ok, _, err := c.SendRequest(name, true, nil)
		if err != nil || ok {
			t.Fatalf("%s: ok %v err %v", name, ok, err)
		}
	}
	// no-more-sessions@openssh.com is passed on to the VM.
	if _, _, err := c.SendRequest("no-more-sessions@openssh.com", false, nil); err != nil {
		t.Fatal(err)
	}
	eventually(t, "no-more-sessions in the VM", func() bool {
		return slices.Equal(f.sshd.GlobalRequests(), []string{"no-more-sessions@openssh.com"})
	})
}

func TestKeepaliveDeadBackend(t *testing.T) {
	f, c, _ := userClient(t, func(c *config.Config) {
		c.SSHKeepaliveInterval = 100 * time.Millisecond
		c.SSHKeepaliveMax = 3
	})
	// A healthy idle connection survives many intervals.
	time.Sleep(600 * time.Millisecond)
	if r := run(t, c, "echo alive"); r.stdout != "alive\n" {
		t.Fatalf("exec after idle: %v", r)
	}
	f.sshd.Stall()
	start := time.Now()
	waitClosed(t, c)
	if d := time.Since(start); d < 250*time.Millisecond {
		t.Fatalf("closed after %v, before 3 misses", d)
	}
	if l := f.waitLog(t); l["closeReason"] != "keepalive_timeout" {
		t.Fatalf("close reason %v", l["closeReason"])
	}
}

func TestSessionLimit(t *testing.T) {
	f, c, key := userClient(t, func(c *config.Config) { c.RateLimit.SSHSessionsPerUser = 2 })
	s1, err := c.NewSession()
	if err != nil {
		t.Fatal(err)
	}
	s2, err := c.NewSession()
	if err != nil {
		t.Fatal(err)
	}
	defer func() { _ = s2.Close() }()
	wantLimited := func(c *ssh.Client) {
		t.Helper()
		_, err := c.NewSession()
		var oce *ssh.OpenChannelError
		if !errors.As(err, &oce) || oce.Reason != ssh.ResourceShortage || oce.Message != "sbx: too many SSH sessions for this user" {
			t.Fatalf("third session: %v", err)
		}
	}
	wantLimited(c)
	// The limit is per user, across connections.
	c2 := f.mustDial(t, f.slug, ssh.PublicKeys(key))
	wantLimited(c2)
	// Other channel types are not limited.
	if _, err := c.Dial("tcp", echoServer(t)); err != nil {
		t.Fatalf("direct-tcpip at the session limit: %v", err)
	}
	if got := testutil.ToFloat64(f.inst.Metrics().SSHSessions.WithLabelValues("limited")); got != 2 {
		t.Fatalf("ssh_sessions_total{limited} = %v", got)
	}

	// Closing a session frees its slot.
	_ = s1.Close()
	eventually(t, "a free slot", func() bool {
		s, err := c2.NewSession()
		if err != nil {
			return false
		}
		_ = s.Close()
		return true
	})
}

func TestBackendCloseWriteEndsStream(t *testing.T) {
	_, c, _ := userClient(t, nil)
	s, err := c.NewSession()
	if err != nil {
		t.Fatal(err)
	}
	// stdin stays open: the backend half-closes first.
	stdin, err := s.StdinPipe()
	if err != nil {
		t.Fatal(err)
	}
	defer func() { _ = stdin.Close() }()
	var out bytes.Buffer
	s.Stdout = &out
	if err := s.Start("echo x; closewrite; sleep 100ms; exit 4"); err != nil {
		t.Fatal(err)
	}
	done := make(chan error, 1)
	go func() { done <- s.Wait() }()
	select {
	case err := <-done:
		var ee *ssh.ExitError
		if !errors.As(err, &ee) || ee.ExitStatus() != 4 || out.String() != "x\n" {
			t.Fatalf("wait: %v, stdout %q", err, out.String())
		}
	case <-time.After(testenv.WaitTimeout):
		t.Fatal("session hung after the backend half-closed")
	}
	// The connection still works.
	if r := run(t, c, "echo y"); r.stdout != "y\n" {
		t.Fatalf("exec: %v", r)
	}
}

// TestSSHCertSandboxMismatch: a login certificate for one sandbox is not
// accepted when api answers for another.
func TestSSHCertSandboxMismatch(t *testing.T) {
	f := newFixture(t, nil)
	f.env.API.SetSSH(func(r cpapi.SSHAuthorizeRequest) bool { return r.Certificate != nil }, f.userAuth("usr_1"))
	s := loginCert(t, f.env.Keys.LoginCA, newSigner(t), func(c *ssh.Certificate) { c.ValidPrincipals = []string{"sb_y"} })
	if _, err := f.dial(f.slug, ssh.PublicKeys(s)); err == nil {
		t.Fatal("login with a certificate for another sandbox")
	}
	if f.env.API.Calls("AuthorizeSSH") == 0 {
		t.Fatal("api not called")
	}
}

// TestSSHAPIDownNotAFailure: api outages do not count towards the
// per-IP authentication failure limit.
func TestSSHAPIDownNotAFailure(t *testing.T) {
	f := newFixture(t, func(c *config.Config) { c.RateLimit.SSHAuthFailPerMin = 1 })
	key := newSigner(t)
	f.allowKey(key.PublicKey(), f.userAuth("usr_1"))
	f.env.API.SetDown(true)
	for range 3 {
		if _, err := f.dial(f.slug, ssh.PublicKeys(key)); err == nil {
			t.Fatal("login allowed with the api down")
		}
	}
	eventually(t, "the unavailable metric", func() bool { return f.authMetric("unavailable") == 3 })
	if got := f.authMetric("fail"); got != 0 {
		t.Fatalf("ssh_auth_total{fail} = %v", got)
	}
	if got := f.limitedMetric(ratelimit.LimitSSHAuth); got != 0 {
		t.Fatalf("ratelimited_total{ssh_auth_fail} = %v", got)
	}
	f.env.API.SetDown(false)
	if r := run(t, f.mustDial(t, f.slug, ssh.PublicKeys(key)), "echo up"); r.stdout != "up\n" {
		t.Fatalf("exec: %v", r)
	}
}
