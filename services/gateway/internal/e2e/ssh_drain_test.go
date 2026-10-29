package e2e_test

import (
	"context"
	"crypto/ed25519"
	"crypto/rand"
	"io"
	"net"
	"net/http"
	"os/exec"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"golang.org/x/crypto/ssh"
	"golang.org/x/crypto/ssh/knownhosts"

	"github.com/belov38/boat-dev-clone/services/gateway/internal/config"
	"github.com/belov38/boat-dev-clone/services/gateway/internal/cpapi"
	"github.com/belov38/boat-dev-clone/services/gateway/internal/testenv"
	"github.com/belov38/boat-dev-clone/services/gateway/internal/testenv/sshdtest"
)

// sshDrain is the SSH drain deadline of the drain tests.
const sshDrain = 3 * time.Second

// drainWarning1 is the drain warning when less than a minute is left.
const drainWarning1 = "sbx: gateway restarting, this SSH session will close in 1 min; reconnect to continue\r\n"

// sshCluster is a cluster with the sshd double on a machine on C and a
// user key that api allows for its sandbox.
type sshCluster struct {
	*cluster
	m    *testenv.Machine
	sshd *sshdtest.Server
	key  ssh.Signer
	priv ed25519.PrivateKey
	slug string
}

func newSSHCluster(t *testing.T, mod func(*config.Config)) *sshCluster {
	t.Helper()
	c := newCluster(t, testenv.Options{}, mod)
	m := c.newMachine(t)
	const loginUser = "sbx"
	sshd := sshdtest.New(t, c.env.Keys.UserCA.PublicKey(), loginUser)
	m.ServeSSHD(sshd)
	_, priv, err := ed25519.GenerateKey(rand.Reader)
	if err != nil {
		t.Fatal(err)
	}
	key, err := ssh.NewSignerFromKey(priv)
	if err != nil {
		t.Fatal(err)
	}
	sc := &sshCluster{cluster: c, m: m, sshd: sshd, key: key, priv: priv, slug: "quiet-otter-lamp"}
	line := strings.TrimSpace(string(ssh.MarshalAuthorizedKey(sc.key.PublicKey())))
	c.env.API.SetSSH(func(r cpapi.SSHAuthorizeRequest) bool {
		return r.Sandbox == sc.slug && r.PublicKey == line
	}, cpapi.SSHAuthorization{
		Allowed: true, Actor: cpapi.SSHActor{Kind: "user", UserID: "usr_1"}, UserID: "usr_1",
		SandboxID: "sb_x", MachineID: m.ID, SandboxState: "ready", LoginUser: loginUser, TeamID: "team_1",
	})
	return sc
}

// dial connects an x/crypto client to front with hostKeys checking the
// server key (nil: the gateway host key).
func (sc *sshCluster) dial(t *testing.T, front *testenv.Inst, hostKeys ssh.HostKeyCallback) (*ssh.Client, error) {
	t.Helper()
	if hostKeys == nil {
		hostKeys = ssh.FixedHostKey(sc.env.Keys.SSHHost.PublicKey())
	}
	cl, err := ssh.Dial("tcp", front.SSHAddr, &ssh.ClientConfig{
		User: sc.slug, Auth: []ssh.AuthMethod{ssh.PublicKeys(sc.key)},
		HostKeyCallback: hostKeys, Timeout: testenv.WaitTimeout,
	})
	if err == nil {
		t.Cleanup(func() { _ = cl.Close() })
	}
	return cl, err
}

func (sc *sshCluster) mustDial(t *testing.T, front *testenv.Inst) *ssh.Client {
	t.Helper()
	cl, err := sc.dial(t, front, nil)
	if err != nil {
		t.Fatalf("ssh to %s: %v", front.Name, err)
	}
	return cl
}

// echoOK runs "echo ok" on a new session of cl.
func echoOK(t *testing.T, cl *ssh.Client) {
	t.Helper()
	s, err := cl.NewSession()
	if err != nil {
		t.Fatalf("new session: %v", err)
	}
	defer func() { _ = s.Close() }()
	if out, err := s.Output("echo ok"); err != nil || string(out) != "ok\n" {
		t.Fatalf("echo ok = %q, %v", out, err)
	}
}

// ptyShell opens an interactive shell on cl and returns its stderr.
func ptyShell(t *testing.T, cl *ssh.Client) io.Reader {
	t.Helper()
	s, err := cl.NewSession()
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = s.Close() })
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
	return stderr
}

// readWithin reads len(want) bytes of r and fails unless they are want
// within d.
func readWithin(t *testing.T, r io.Reader, want string, d time.Duration) time.Duration {
	t.Helper()
	start := time.Now()
	type res struct {
		b   []byte
		err error
	}
	ch := make(chan res, 1)
	go func() {
		b := make([]byte, len(want))
		_, err := io.ReadFull(r, b)
		ch <- res{b, err}
	}()
	select {
	case got := <-ch:
		if got.err != nil || string(got.b) != want {
			t.Fatalf("read %q, %v; want %q", got.b, got.err, want)
		}
	case <-time.After(d):
		t.Fatalf("%q not read within %s", want, d)
	}
	return time.Since(start)
}

// closedWithin waits for the end of cl and returns when it ended.
func closedWithin(t *testing.T, cl *ssh.Client, d time.Duration) time.Time {
	t.Helper()
	done := make(chan struct{})
	go func() {
		_ = cl.Wait()
		close(done)
	}()
	select {
	case <-done:
		return time.Now()
	case <-time.After(d):
		t.Fatalf("SSH connection not closed within %s", d)
	}
	return time.Time{}
}

// sshLogReason waits for an SSH log line of inst and returns the
// closeReason of the last one; the line is written after the conn closed.
func sshLogReason(t *testing.T, inst *testenv.Inst) string {
	t.Helper()
	reason := ""
	eventually(t, "SSH log line of "+inst.Name, func() bool {
		for line := range strings.SplitSeq(inst.AccessLog.String(), "\n") {
			if strings.Contains(line, `"sessionId"`) {
				_, after, _ := strings.Cut(line, `"closeReason":"`)
				reason, _, _ = strings.Cut(after, `"`)
			}
		}
		return reason != ""
	})
	return reason
}

func readyz(t *testing.T, inst *testenv.Inst) int {
	t.Helper()
	ctx, cancel := context.WithTimeout(context.Background(), reqTimeout)
	defer cancel()
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, inst.MetricsURL+"/readyz", nil)
	if err != nil {
		t.Fatal(err)
	}
	resp, err := http.DefaultClient.Do(req)
	if err != nil {
		t.Fatal(err)
	}
	_ = resp.Body.Close()
	return resp.StatusCode
}

// The front drains: its SSH session gets the warning at once and closes at
// the SSH drain deadline; the drain then returns.
func TestSSHFrontDrain(t *testing.T) {
	t.Parallel()
	sc := newSSHCluster(t, func(cfg *config.Config) { cfg.SSHDrainDeadline = sshDrain })
	cl := sc.mustDial(t, sc.A)
	stderr := ptyShell(t, cl)
	eventually(t, "one session on A", func() bool { return sc.A.SSH().Sessions() == 1 })

	t0 := time.Now()
	drained := make(chan error, 1)
	go func() {
		ctx, cancel := context.WithTimeout(context.Background(), reqTimeout)
		defer cancel()
		drained <- sc.A.Drain(ctx)
	}()
	if d := readWithin(t, stderr, drainWarning1, 5*time.Second); d > time.Second {
		t.Fatalf("warning after %s, want at once", d)
	}
	closed := closedWithin(t, cl, 10*time.Second).Sub(t0)
	if closed < sshDrain-200*time.Millisecond || closed > sshDrain+time.Second {
		t.Fatalf("closed %s after the drain start, want about %s", closed, sshDrain)
	}
	if r := sshLogReason(t, sc.A); r != "drain" {
		t.Fatalf("closeReason %q", r)
	}
	// Other fronts take the new conns.
	echoOK(t, sc.mustDial(t, sc.B))
	select {
	case err := <-drained:
		if err != nil {
			t.Fatalf("Drain of A = %v", err)
		}
	case <-time.After(reqTimeout):
		t.Fatal("Drain of A did not return")
	}
	t.Logf("closed after %s, drain returned after %s", closed, time.Since(t0))
}

// Only the owner drains: the front learns the owner's deadline through
// NOTIFY gateway_instances, warns and closes at that deadline without
// draining itself.
func TestSSHOwnerDrainOnly(t *testing.T) {
	t.Parallel()
	sc := newSSHCluster(t, func(cfg *config.Config) { cfg.SSHDrainDeadline = sshDrain })
	cl := sc.mustDial(t, sc.A)
	stderr := ptyShell(t, cl)
	eventually(t, "one session on A", func() bool { return sc.A.SSH().Sessions() == 1 })

	sc.env.RouteOnly(sc.B)
	t0 := time.Now()
	drained := make(chan error, 1)
	go func() {
		ctx, cancel := context.WithTimeout(context.Background(), reqTimeout)
		defer cancel()
		drained <- sc.C.Drain(ctx)
	}()
	if d := readWithin(t, stderr, drainWarning1, 5*time.Second); d > 2*time.Second {
		t.Fatalf("warning after %s, want soon after the owner's NOTIFY", d)
	}
	closed := closedWithin(t, cl, 10*time.Second).Sub(t0)
	if closed < sshDrain-200*time.Millisecond || closed > sshDrain+time.Second {
		t.Fatalf("closed %s after the owner's drain start, want about %s", closed, sshDrain)
	}
	// The front's own timer and the owner's stream close fire at the same
	// deadline; either may end the session first.
	r := sshLogReason(t, sc.A)
	if r != "drain" && r != "backend_closed" {
		t.Fatalf("closeReason %q", r)
	}
	t.Logf("closeReason on A: %s", r)
	if code := readyz(t, sc.A); code != http.StatusOK {
		t.Fatalf("A /readyz = %d: A must not drain", code)
	}
	// A still takes new conns; the machine moved to B.
	eventually(t, "machine on B", func() bool { return sc.m.Owner() == sc.B })
	echoOK(t, sc.mustDial(t, sc.A))
	select {
	case err := <-drained:
		if err != nil {
			t.Fatalf("Drain of C = %v", err)
		}
	case <-time.After(reqTimeout):
		t.Fatal("Drain of C did not return")
	}
}

// A new SSH conn after the machine moved works through the new owner, and
// the client sees the same gateway host key, so its known_hosts entry
// keeps working.
func TestSSHAcrossMove(t *testing.T) {
	t.Parallel()
	sc := newSSHCluster(t, nil)
	dir := t.TempDir()
	khPath := filepath.Join(dir, "known_hosts")
	_, port, _ := net.SplitHostPort(sc.A.SSHAddr)
	kh := "[127.0.0.1]:" + port + " " + strings.TrimSpace(string(ssh.MarshalAuthorizedKey(sc.env.Keys.SSHHost.PublicKey()))) + "\n"
	writeFile(t, khPath, kh)
	hostKeys, err := knownhosts.New(khPath)
	if err != nil {
		t.Fatal(err)
	}

	// OpenSSH, when present, checks known_hosts the way users do.
	sshPath, _ := exec.LookPath("ssh")
	keyPath := filepath.Join(dir, "id")
	if sshPath != "" {
		writePrivateKey(t, keyPath, sc.priv)
	}
	realSSH := func(what string) {
		t.Helper()
		if sshPath == "" {
			return
		}
		r := runCmd(t, nil, clientEnv(), sshPath, "-F", "none", "-o", "UserKnownHostsFile="+khPath,
			"-o", "GlobalKnownHostsFile=/dev/null", "-o", "StrictHostKeyChecking=yes", "-o", "IdentitiesOnly=yes",
			"-o", "IdentityAgent=none", "-o", "BatchMode=yes", "-i", keyPath, "-p", port,
			sc.slug+"@127.0.0.1", "echo ok")
		if r.err != nil || r.stdout != "ok\n" {
			t.Fatalf("%s: OpenSSH through A: %v", what, r)
		}
	}

	cl, err := sc.dial(t, sc.A, hostKeys)
	if err != nil {
		t.Fatalf("before the move: %v", err)
	}
	echoOK(t, cl)
	realSSH("before the move")
	if o := sc.m.Owner(); o != sc.C {
		t.Fatalf("owner %v, want C", o)
	}
	logins := len(sc.sshd.KeyIDs())

	// The agent reconnects to B.
	sc.env.RouteOnly(sc.B)
	sc.m.Restart()
	eventually(t, "machine on B", func() bool { return sc.m.Owner() == sc.B })

	var cl2 *ssh.Client
	eventually(t, "a new SSH conn through A after the move", func() bool {
		c2, err := sc.dial(t, sc.A, hostKeys)
		if err != nil {
			if strings.Contains(err.Error(), "knownhosts") {
				t.Fatalf("host key changed after the move: %v", err)
			}
			return false
		}
		s, err := c2.NewSession()
		if err != nil {
			_ = c2.Close()
			return false
		}
		out, err := s.Output("echo ok")
		_ = s.Close()
		if err != nil || string(out) != "ok\n" {
			_ = c2.Close()
			return false
		}
		cl2 = c2
		return true
	})
	echoOK(t, cl2)
	realSSH("after the move")
	if n := len(sc.sshd.KeyIDs()); n <= logins {
		t.Fatalf("sshd saw %d logins, want more than %d", n, logins)
	}
}
