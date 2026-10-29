package e2e_test

import (
	"bytes"
	"context"
	"crypto/ed25519"
	"crypto/rand"
	"crypto/sha256"
	"encoding/pem"
	"fmt"
	"io"
	"net"
	"net/http"
	"os"
	"os/exec"
	"os/user"
	"path/filepath"
	"slices"
	"strconv"
	"strings"
	"testing"
	"time"

	"golang.org/x/crypto/ssh"

	"github.com/belov38/boat-dev-clone/services/gateway/internal/config"
	"github.com/belov38/boat-dev-clone/services/gateway/internal/cpapi"
	"github.com/belov38/boat-dev-clone/services/gateway/internal/testenv"
)

// The OpenSSH tests run the real ssh client tools against the gateway and
// a real sshd behind port 22 of the machine. sshd runs as the current user
// on 127.0.0.1, so "the VM" is this host: remote commands, files and ports
// are local ones.

// opensshCmdTimeout bounds one OpenSSH command.
const opensshCmdTimeout = time.Minute

// sftpServerPaths are the usual places of sftp-server (macOS, Debian and
// Ubuntu, Fedora, Arch).
var sftpServerPaths = []string{
	"/usr/libexec/sftp-server",
	"/usr/lib/openssh/sftp-server",
	"/usr/libexec/openssh/sftp-server",
	"/usr/lib/ssh/sftp-server",
}

// opensshTools finds ssh and sshd, or skips the test.
func opensshTools(t *testing.T) (sshPath, sshdPath string) {
	t.Helper()
	sshPath, err := exec.LookPath("ssh")
	if err != nil {
		t.Skip("OpenSSH e2e skipped: ssh is not on PATH")
	}
	sshdPath, err = exec.LookPath("sshd")
	if err != nil {
		sshdPath = "/usr/sbin/sshd"
		if _, err := os.Stat(sshdPath); err != nil {
			t.Skip("OpenSSH e2e skipped: sshd is not on PATH or at /usr/sbin/sshd")
		}
	}
	// sshd re-executes itself and wants an absolute path.
	if sshdPath, err = filepath.Abs(sshdPath); err != nil {
		t.Fatal(err)
	}
	return sshPath, sshdPath
}

// needTool returns the path of a tool or skips the (sub)test.
func needTool(t *testing.T, name string) string {
	t.Helper()
	p, err := exec.LookPath(name)
	if err != nil {
		t.Skipf("%s is not on PATH", name)
	}
	return p
}

// shortTempDir is a temp dir with a short path: unix socket paths are
// limited to about 100 bytes, and t.TempDir is long on macOS.
func shortTempDir(t *testing.T) string {
	t.Helper()
	d, err := os.MkdirTemp("", "sbx")
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = os.RemoveAll(d) })
	return d
}

func freePort(t *testing.T) int {
	t.Helper()
	ln, err := (&net.ListenConfig{}).Listen(context.Background(), "tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatal(err)
	}
	p := ln.Addr().(*net.TCPAddr).Port
	_ = ln.Close()
	return p
}

// writeKey writes a new ed25519 private key in the OpenSSH format (mode
// 0600) and returns its signer.
func writeKey(t *testing.T, path string) ssh.Signer {
	t.Helper()
	_, priv, err := ed25519.GenerateKey(rand.Reader)
	if err != nil {
		t.Fatal(err)
	}
	writePrivateKey(t, path, priv)
	s, err := ssh.NewSignerFromKey(priv)
	if err != nil {
		t.Fatal(err)
	}
	return s
}

// writePrivateKey writes priv in the OpenSSH format with mode 0600.
func writePrivateKey(t *testing.T, path string, priv ed25519.PrivateKey) {
	t.Helper()
	block, err := ssh.MarshalPrivateKey(priv, "")
	if err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(path, pem.EncodeToMemory(block), 0o600); err != nil {
		t.Fatal(err)
	}
}

func writeFile(t *testing.T, path, content string) {
	t.Helper()
	if err := os.WriteFile(path, []byte(content), 0o600); err != nil {
		t.Fatal(err)
	}
}

// signUserCert signs a user certificate for key and returns it.
func signUserCert(t *testing.T, ca ssh.Signer, key ssh.PublicKey, keyID string, principals ...string) *ssh.Certificate {
	t.Helper()
	now := time.Now()
	cert := &ssh.Certificate{
		Key: key, Serial: 99, CertType: ssh.UserCert, KeyId: keyID, ValidPrincipals: principals,
		ValidAfter:  uint64(now.Add(-time.Minute).Unix()),
		ValidBefore: uint64(now.Add(10 * time.Minute).Unix()),
		Permissions: ssh.Permissions{Extensions: map[string]string{"permit-pty": ""}},
	}
	if err := cert.SignCert(rand.Reader, ca); err != nil {
		t.Fatal(err)
	}
	return cert
}

// realSSHD is an OpenSSH sshd run as the current user.
type realSSHD struct {
	port    int
	logPath string
	stderr  *testenv.LogBuffer
}

func (s *realSSHD) log() string {
	b, _ := os.ReadFile(s.logPath)
	return string(b)
}

// startSSHD starts sshd on 127.0.0.1:<free port>, trusting userCA for
// certificates whose principal is the login user. When sshd cannot run
// here it returns nil and the reason, promptly.
func startSSHD(t *testing.T, sshdPath string, userCA ssh.PublicKey) (*realSSHD, string) {
	t.Helper()
	dir := shortTempDir(t)
	writeKey(t, filepath.Join(dir, "host"))
	writeFile(t, filepath.Join(dir, "ca.pub"), string(ssh.MarshalAuthorizedKey(userCA)))
	sftp := "internal-sftp"
	for _, p := range sftpServerPaths {
		if _, err := os.Stat(p); err == nil {
			sftp = p
			break
		}
	}
	s := &realSSHD{port: freePort(t), logPath: filepath.Join(dir, "sshd.log"), stderr: &testenv.LogBuffer{}}
	cfg := strings.Join([]string{
		"ListenAddress 127.0.0.1",
		"Port " + strconv.Itoa(s.port),
		"HostKey " + filepath.Join(dir, "host"),
		"TrustedUserCAKeys " + filepath.Join(dir, "ca.pub"),
		"AuthorizedPrincipalsFile none",
		"AuthorizedKeysFile none",
		"PasswordAuthentication no",
		"KbdInteractiveAuthentication no",
		"UsePAM no",
		"StrictModes no",
		"PidFile " + filepath.Join(dir, "sshd.pid"),
		"LogLevel VERBOSE",
		"AllowAgentForwarding yes",
		"AllowTcpForwarding yes",
		"GatewayPorts no",
		"Subsystem sftp " + sftp,
		"",
	}, "\n")
	cfgPath := filepath.Join(dir, "sshd_config")
	writeFile(t, cfgPath, cfg)
	// Killed by the cleanup below.
	cmd := exec.CommandContext(context.Background(), sshdPath, "-D", "-e", "-f", cfgPath, "-E", s.logPath)
	cmd.Stdout, cmd.Stderr = s.stderr, s.stderr
	if err := cmd.Start(); err != nil {
		return nil, fmt.Sprintf("sshd does not start: %v", err)
	}
	// exited is closed once sshd ended; waitErr is set before that. Both
	// the readiness loop and the cleanup may wait for it.
	var waitErr error
	exited := make(chan struct{})
	go func() {
		waitErr = cmd.Wait()
		close(exited)
	}()
	t.Cleanup(func() {
		_ = cmd.Process.Kill()
		<-exited
	})
	deadline := time.Now().Add(10 * time.Second)
	for {
		c, err := (&net.Dialer{Timeout: time.Second}).DialContext(context.Background(), "tcp", s.addr())
		if err == nil {
			_ = c.Close()
			return s, ""
		}
		select {
		case <-exited:
			return nil, fmt.Sprintf("sshd exited (%v): %s %s", waitErr, s.stderr.String(), s.log())
		default:
		}
		if time.Now().After(deadline) {
			return nil, fmt.Sprintf("sshd does not listen: %s %s", s.stderr.String(), s.log())
		}
		time.Sleep(20 * time.Millisecond)
	}
}

func (s *realSSHD) addr() string { return net.JoinHostPort("127.0.0.1", strconv.Itoa(s.port)) }

// proxyTo is a Machine.ServeTCP function that connects the stream to addr
// on this host.
func proxyTo(addr string) func(net.Conn) {
	return func(c net.Conn) {
		b, err := (&net.Dialer{Timeout: 5 * time.Second}).DialContext(context.Background(), "tcp", addr)
		if err != nil {
			return
		}
		defer func() { _ = b.Close() }()
		done := make(chan struct{}, 2)
		go func() { _, _ = io.Copy(b, c); done <- struct{}{} }()
		go func() { _, _ = io.Copy(c, b); done <- struct{}{} }()
		<-done
	}
}

// opensshEnv is the cluster, the real sshd behind the machine and the
// client files.
type opensshEnv struct {
	c         *cluster
	sshPath   string
	sshd      *realSSHD
	dir       string
	knownHost string
	userKey   string // path of the registered user key
	slug      string
	loginUser string
}

const opensshSlug = "quiet-otter-lamp"

// args are the common client options for entering at instance front.
func (e *opensshEnv) args(front *testenv.Inst, extra ...string) []string {
	_, port, _ := net.SplitHostPort(front.SSHAddr)
	a := []string{
		"-F", "none",
		"-o", "UserKnownHostsFile=" + e.knownHost,
		"-o", "GlobalKnownHostsFile=/dev/null",
		"-o", "StrictHostKeyChecking=yes",
		"-o", "IdentitiesOnly=yes",
		"-o", "BatchMode=yes",
		"-o", "ConnectTimeout=10",
		"-p", port,
	}
	return append(a, extra...)
}

// sshArgs are args with the registered user key and no agent.
func (e *opensshEnv) sshArgs(front *testenv.Inst, extra ...string) []string {
	return e.args(front, append([]string{"-i", e.userKey, "-o", "IdentityAgent=none"}, extra...)...)
}

func (e *opensshEnv) target() string { return e.slug + "@127.0.0.1" }

// clientEnv is the environment of client commands: no agent from the
// developer's session.
func clientEnv(extra ...string) []string {
	var env []string
	for _, kv := range os.Environ() {
		if !strings.HasPrefix(kv, "SSH_AUTH_SOCK=") {
			env = append(env, kv)
		}
	}
	return append(env, extra...)
}

type cmdResult struct {
	stdout, stderr string
	err            error
	took           time.Duration
}

func (r cmdResult) String() string {
	return fmt.Sprintf("err %v after %s, stdout %q, stderr %q", r.err, r.took, r.stdout, r.stderr)
}

// runCmd runs name with args, stdin and env, bounded by opensshCmdTimeout.
func runCmd(t *testing.T, stdin io.Reader, env []string, name string, args ...string) cmdResult {
	t.Helper()
	ctx, cancel := context.WithTimeout(context.Background(), opensshCmdTimeout)
	defer cancel()
	cmd := exec.CommandContext(ctx, name, args...)
	var out, errb bytes.Buffer
	cmd.Stdin, cmd.Stdout, cmd.Stderr = stdin, &out, &errb
	if env != nil {
		cmd.Env = env
	}
	start := time.Now()
	err := cmd.Run()
	return cmdResult{stdout: out.String(), stderr: errb.String(), err: err, took: time.Since(start)}
}

// ssh runs the ssh client with the user key through A.
func (e *opensshEnv) ssh(t *testing.T, stdin io.Reader, extra ...string) cmdResult {
	t.Helper()
	return runCmd(t, stdin, clientEnv(), e.sshPath, e.sshArgs(e.c.A, extra...)...)
}

func newOpenSSHEnv(t *testing.T) *opensshEnv {
	t.Helper()
	sshPath, sshdPath := opensshTools(t)
	u, err := user.Current()
	if err != nil {
		t.Skipf("OpenSSH e2e skipped: no current user: %v", err)
	}
	c := newCluster(t, testenv.Options{}, func(cfg *config.Config) {
		// About 20 OpenSSH conns from 127.0.0.1 in one test.
		cfg.RateLimit.SSHConnPerMin = 1000
		cfg.RateLimit.SSHConnBurst = 1000
	})
	sshd, why := startSSHD(t, sshdPath, c.env.Keys.UserCA.PublicKey())
	if sshd == nil {
		// As in preflight: on CI sshd is installed for this test, so a
		// failing start is an error, not a skip.
		if os.Getenv("CI") != "" {
			t.Fatal("OpenSSH e2e: " + why)
		}
		t.Skip("OpenSSH e2e skipped: " + why)
	}
	e := &opensshEnv{c: c, sshPath: sshPath, sshd: sshd, dir: shortTempDir(t), slug: opensshSlug, loginUser: u.Username}

	// The environment check: sshd lets the current user in with a
	// certificate of the gateway user CA. If not, the test cannot say
	// anything about the gateway.
	e.preflight(t)

	m := c.newMachine(t)
	m.ServeTCP(22, proxyTo(sshd.addr()))

	// known_hosts holds the gateway host key for every front.
	var kh strings.Builder
	hostKey := strings.TrimSpace(string(ssh.MarshalAuthorizedKey(c.env.Keys.SSHHost.PublicKey())))
	for _, i := range []*testenv.Inst{c.A, c.B, c.C} {
		_, port, _ := net.SplitHostPort(i.SSHAddr)
		kh.WriteString("[127.0.0.1]:" + port + " " + hostKey + "\n")
	}
	e.knownHost = filepath.Join(e.dir, "known_hosts")
	writeFile(t, e.knownHost, kh.String())

	e.userKey = filepath.Join(e.dir, "id_user")
	userKey := writeKey(t, e.userKey)
	fp := ssh.FingerprintSHA256(userKey.PublicKey())
	c.env.API.SetSSH(func(r cpapi.SSHAuthorizeRequest) bool {
		return r.Sandbox == opensshSlug && r.Fingerprint == fp
	}, cpapi.SSHAuthorization{
		Allowed: true, Actor: cpapi.SSHActor{Kind: "user", UserID: "usr_1", Email: "u@example.com"},
		UserID: "usr_1", Email: "u@example.com", SandboxID: "sb_x", MachineID: m.ID,
		SandboxState: "ready", LoginUser: e.loginUser, TeamID: "team_1",
	})
	c.env.API.SetSSH(func(r cpapi.SSHAuthorizeRequest) bool {
		return r.Sandbox == opensshSlug && r.Certificate != nil && r.Certificate.Principal == "sb_x" &&
			r.Certificate.KeyID == "sbx:key:key_1"
	}, cpapi.SSHAuthorization{
		Allowed: true, Actor: cpapi.SSHActor{Kind: "team_key", APIKeyID: "key_1"},
		SandboxID: "sb_x", MachineID: m.ID, SandboxState: "ready", LoginUser: e.loginUser, TeamID: "team_1",
	})
	return e
}

// preflight logs in to sshd directly with a gateway-style certificate and
// skips the test when that fails (a locked account, a sandboxed sshd).
func (e *opensshEnv) preflight(t *testing.T) {
	t.Helper()
	key := filepath.Join(e.dir, "id_preflight")
	s := writeKey(t, key)
	cert := signUserCert(t, e.c.env.Keys.UserCA, s.PublicKey(), "sbx:user:preflight:0", e.loginUser)
	writeFile(t, key+"-cert.pub", string(ssh.MarshalAuthorizedKey(cert)))
	r := runCmd(t, nil, clientEnv(), e.sshPath, "-F", "none",
		"-o", "UserKnownHostsFile=/dev/null", "-o", "StrictHostKeyChecking=no",
		"-o", "IdentitiesOnly=yes", "-o", "IdentityAgent=none", "-o", "BatchMode=yes",
		"-o", "LogLevel=ERROR", "-i", key, "-p", strconv.Itoa(e.sshd.port),
		e.loginUser+"@127.0.0.1", "echo preflight")
	if r.err != nil || strings.TrimSpace(r.stdout) != "preflight" {
		msg := fmt.Sprintf("direct login to the local sshd fails (%v): %s\nsshd log:\n%s", r, e.sshd.stderr.String(), e.sshd.log())
		// On CI the environment is set up for this test: a failing
		// preflight must not turn the coverage into a silent skip.
		if os.Getenv("CI") != "" {
			t.Fatal("OpenSSH e2e: " + msg)
		}
		t.Skip("OpenSSH e2e skipped: " + msg)
	}
}

func sha256File(t *testing.T, path string) [32]byte {
	t.Helper()
	b, err := os.ReadFile(path)
	if err != nil {
		t.Fatal(err)
	}
	return sha256.Sum256(b)
}

func randomFile(t *testing.T, path string, size int) {
	t.Helper()
	b := make([]byte, size)
	if _, err := rand.Read(b); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(path, b, 0o600); err != nil {
		t.Fatal(err)
	}
}

// localApp serves body on 127.0.0.1 and returns its port.
func localApp(t *testing.T, body string) int {
	t.Helper()
	ln, err := (&net.ListenConfig{}).Listen(context.Background(), "tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatal(err)
	}
	srv := &http.Server{
		Handler:           http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) { _, _ = io.WriteString(w, body) }),
		ReadHeaderTimeout: 5 * time.Second,
	}
	go func() { _ = srv.Serve(ln) }()
	t.Cleanup(func() { _ = srv.Close() })
	return ln.Addr().(*net.TCPAddr).Port
}

func TestOpenSSH(t *testing.T) {
	t.Parallel()
	e := newOpenSSHEnv(t)
	c := e.c

	t.Run("exec", func(t *testing.T) {
		r := e.ssh(t, nil, e.target(), "echo ok")
		if r.err != nil || r.stdout != "ok\n" {
			t.Fatalf("ssh echo ok: %v", r)
		}
	})

	t.Run("stdin to cat", func(t *testing.T) {
		r := e.ssh(t, strings.NewReader("hi\n"), e.target(), "cat")
		if r.err != nil || r.stdout != "hi\n" {
			t.Fatalf("echo hi | ssh cat: %v", r)
		}
	})

	t.Run("-n cat returns at once", func(t *testing.T) {
		// stdin is /dev/null: the client sends EOF right after exec.
		// sshd drops an EOF that arrives before the command, and cat
		// would then wait forever.
		r := e.ssh(t, nil, "-n", e.target(), "cat")
		if r.err != nil || r.stdout != "" || r.took > 10*time.Second {
			t.Fatalf("ssh -n cat: %v", r)
		}
	})

	t.Run("pty", func(t *testing.T) {
		r := e.ssh(t, nil, "-tt", e.target(), "tty")
		if out := strings.TrimSpace(r.stdout); r.err != nil || !strings.HasPrefix(out, "/dev/") {
			t.Fatalf("ssh -t tty: %v", r)
		}
	})

	t.Run("scp", func(t *testing.T) {
		scp := needTool(t, "scp")
		dir := t.TempDir()
		src := filepath.Join(dir, "up.bin")
		randomFile(t, src, 10<<20)
		for _, mode := range []struct {
			name string
			flag []string
		}{{"sftp protocol", nil}, {"legacy protocol", []string{"-O"}}} {
			remote := filepath.Join(dir, "remote-"+strconv.Itoa(len(mode.flag)))
			down := filepath.Join(dir, "down-"+strconv.Itoa(len(mode.flag)))
			args := append(e.scpArgs(mode.flag...), src, e.target()+":"+remote)
			if r := runCmd(t, nil, clientEnv(), scp, args...); r.err != nil {
				t.Fatalf("%s: scp up: %v", mode.name, r)
			}
			if sha256File(t, remote) != sha256File(t, src) {
				t.Fatalf("%s: uploaded file differs", mode.name)
			}
			args = append(e.scpArgs(mode.flag...), e.target()+":"+remote, down)
			if r := runCmd(t, nil, clientEnv(), scp, args...); r.err != nil {
				t.Fatalf("%s: scp down: %v", mode.name, r)
			}
			if sha256File(t, down) != sha256File(t, src) {
				t.Fatalf("%s: downloaded file differs", mode.name)
			}
		}
	})

	t.Run("sftp batch", func(t *testing.T) {
		sftp := needTool(t, "sftp")
		dir := t.TempDir()
		remoteDir := filepath.Join(dir, "remote")
		if err := os.Mkdir(remoteDir, 0o700); err != nil {
			t.Fatal(err)
		}
		src := filepath.Join(dir, "put.bin")
		randomFile(t, src, 1<<20)
		got := filepath.Join(dir, "got.bin")
		batch := filepath.Join(dir, "batch")
		writeFile(t, batch, fmt.Sprintf("put %s %s/put.bin\nget %s/put.bin %s\nls -1 %s\n", src, remoteDir, remoteDir, got, remoteDir))
		args := append(e.scpArgs(), "-b", batch, e.target())
		r := runCmd(t, nil, clientEnv(), sftp, args...)
		if r.err != nil {
			t.Fatalf("sftp -b: %v", r)
		}
		// sftp echoes each batch command; the listing is what follows
		// the ls command.
		if ls := sftpOutputOf(r.stdout, "ls"); !slices.ContainsFunc(ls, func(l string) bool { return filepath.Base(l) == "put.bin" }) {
			t.Fatalf("sftp ls output %q does not list put.bin (stdout %q)", ls, r.stdout)
		}
		if sha256File(t, got) != sha256File(t, src) || sha256File(t, filepath.Join(remoteDir, "put.bin")) != sha256File(t, src) {
			t.Fatal("sftp files differ")
		}
	})

	t.Run("rsync", func(t *testing.T) {
		rsync := needTool(t, "rsync")
		dir := t.TempDir()
		src := filepath.Join(dir, "src")
		if err := os.Mkdir(src, 0o700); err != nil {
			t.Fatal(err)
		}
		randomFile(t, filepath.Join(src, "a.bin"), 2<<20)
		writeFile(t, filepath.Join(src, "b.txt"), "hello\n")
		dst := filepath.Join(dir, "dst")
		sshCmd := e.sshPath + " " + strings.Join(e.sshArgs(c.A), " ")
		r := runCmd(t, nil, clientEnv(), rsync, "-a", "-e", sshCmd, src+"/", e.target()+":"+dst+"/")
		if r.err != nil {
			t.Fatalf("rsync: %v", r)
		}
		for _, f := range []string{"a.bin", "b.txt"} {
			if sha256File(t, filepath.Join(dst, f)) != sha256File(t, filepath.Join(src, f)) {
				t.Fatalf("rsync: %s differs", f)
			}
		}
	})

	t.Run("-L to an app", func(t *testing.T) {
		appPort := localApp(t, "vm app")
		lport := freePort(t)
		ctx, cancel := context.WithCancel(context.Background())
		defer cancel()
		cmd := exec.CommandContext(ctx, e.sshPath, e.sshArgs(c.A, "-N", "-o", "ExitOnForwardFailure=yes",
			"-L", fmt.Sprintf("127.0.0.1:%d:127.0.0.1:%d", lport, appPort), e.target())...)
		errb := &testenv.LogBuffer{}
		cmd.Env, cmd.Stderr = clientEnv(), errb
		if err := cmd.Start(); err != nil {
			t.Fatal(err)
		}
		defer func() {
			cancel()
			_ = cmd.Wait()
		}()
		url := fmt.Sprintf("http://127.0.0.1:%d/", lport)
		// Each try is bounded, so the loop deadline holds.
		hc := &http.Client{Timeout: 2 * time.Second}
		var body string
		deadline := time.Now().Add(testenv.WaitTimeout)
		for body != "vm app" {
			if time.Now().After(deadline) {
				t.Fatalf("no answer through -L; ssh stderr %q", errb.String())
			}
			time.Sleep(50 * time.Millisecond)
			resp, err := hc.Get(url) //nolint:noctx // bounded by the client timeout
			if err != nil {
				continue
			}
			b, _ := io.ReadAll(resp.Body)
			_ = resp.Body.Close()
			body = string(b)
		}
	})

	t.Run("-R with curl in the VM", func(t *testing.T) {
		needTool(t, "curl")
		appPort := localApp(t, "client app")
		rport := freePort(t)
		url := fmt.Sprintf("http://127.0.0.1:%d/", rport)
		// The forward is requested before the session; a short retry
		// covers the listener set-up in sshd.
		remote := fmt.Sprintf("for i in 1 2 3 4 5 6 7 8 9 10; do curl -sf %s && exit 0; sleep 0.2; done; exit 1", url)
		r := e.ssh(t, nil, "-o", "ExitOnForwardFailure=yes",
			"-R", fmt.Sprintf("127.0.0.1:%d:127.0.0.1:%d", rport, appPort), e.target(), remote)
		if r.err != nil || r.stdout != "client app" {
			t.Fatalf("ssh -R curl: %v", r)
		}
	})

	t.Run("-A agent forwarding", func(t *testing.T) {
		agentPath := needTool(t, "ssh-agent")
		addPath := needTool(t, "ssh-add")
		sock := filepath.Join(shortTempDir(t), "agent.sock")
		ctx, cancel := context.WithCancel(context.Background())
		agent := exec.CommandContext(ctx, agentPath, "-D", "-a", sock)
		if err := agent.Start(); err != nil {
			t.Fatal(err)
		}
		defer func() {
			cancel()
			_ = agent.Wait()
		}()
		eventually(t, "ssh-agent socket", func() bool {
			_, err := os.Stat(sock)
			return err == nil
		})
		agentKeyPath := filepath.Join(e.dir, "id_agent")
		agentKey := writeKey(t, agentKeyPath)
		if r := runCmd(t, nil, clientEnv("SSH_AUTH_SOCK="+sock), addPath, agentKeyPath); r.err != nil {
			t.Fatalf("ssh-add: %v", r)
		}
		args := e.args(c.A, "-i", e.userKey, "-o", "IdentityAgent="+sock, "-A", e.target(), "ssh-add -l")
		r := runCmd(t, nil, clientEnv(), e.sshPath, args...)
		fp := ssh.FingerprintSHA256(agentKey.PublicKey())
		if r.err != nil || !strings.Contains(r.stdout, fp) {
			t.Fatalf("ssh -A ssh-add -l: %v; want %s", r, fp)
		}
	})

	t.Run("login certificate", func(t *testing.T) {
		key := filepath.Join(e.dir, "id_cert")
		s := writeKey(t, key)
		cert := signUserCert(t, c.env.Keys.LoginCA, s.PublicKey(), "sbx:key:key_1", "sb_x")
		certPath := filepath.Join(e.dir, "id_cert-login.pub")
		writeFile(t, certPath, string(ssh.MarshalAuthorizedKey(cert)))
		args := e.args(c.A, "-i", key, "-o", "CertificateFile="+certPath, "-o", "IdentityAgent=none", e.target(), "echo cert")
		if r := runCmd(t, nil, clientEnv(), e.sshPath, args...); r.err != nil || r.stdout != "cert\n" {
			t.Fatalf("ssh with a login certificate: %v", r)
		}
		eventually(t, "sshd log line of the team key", func() bool {
			return acceptedWith(e.sshd.log(), "ID sbx:key:key_1:")
		})
	})

	t.Run("sshd log names the user", func(t *testing.T) {
		// Its own login: one more accepted line with the user's KeyId.
		const id = "ID sbx:user:usr_1:"
		before := acceptedCount(e.sshd.log(), id)
		if r := e.ssh(t, nil, e.target(), "echo logged"); r.err != nil || r.stdout != "logged\n" {
			t.Fatalf("ssh: %v", r)
		}
		eventually(t, "the accepted line of this login", func() bool {
			return acceptedCount(e.sshd.log(), id) > before
		})
	})

	t.Run("-v shows no hostkeys errors", func(t *testing.T) {
		// UpdateHostKeys makes the client act on hostkeys-00: the VM's
		// would not match the gateway's key the client knows.
		r := runCmd(t, nil, clientEnv(), e.sshPath, e.sshArgs(c.A, "-v", "-o", "UpdateHostKeys=yes", e.target(), "echo ok")...)
		if r.err != nil || r.stdout != "ok\n" {
			t.Fatalf("ssh -v: %v", r)
		}
		// A direct login to sshd logs "client_input_hostkeys" and the
		// hostkeys-00 request here; through the gateway nothing about
		// hostkeys may show (load_hostkeys is the client reading its own
		// known_hosts files).
		for line := range strings.SplitSeq(r.stderr, "\n") {
			if l := strings.ToLower(line); strings.Contains(l, "hostkeys") && !strings.Contains(l, "load_hostkeys") {
				t.Errorf("ssh -v: %s", line)
			}
		}
	})
}

// scpArgs are the client options in scp/sftp form (-P for the port).
func (e *opensshEnv) scpArgs(extra ...string) []string {
	a := e.sshArgs(e.c.A)
	for i := range a {
		if a[i] == "-p" {
			a[i] = "-P"
		}
	}
	return append(a, extra...)
}

// acceptedWith reports an "Accepted publickey" line of the sshd log that
// contains s.
func acceptedWith(log, s string) bool { return acceptedCount(log, s) > 0 }

// acceptedCount counts the "Accepted publickey" lines of the sshd log that
// contain s.
func acceptedCount(log, s string) int {
	n := 0
	for line := range strings.SplitSeq(log, "\n") {
		if strings.Contains(line, "Accepted publickey") && strings.Contains(line, s) {
			n++
		}
	}
	return n
}

// sftpOutputOf returns the output lines of the batch command cmd in the
// stdout of sftp -b: the lines after the echoed "sftp> cmd ..." up to the
// next echoed command.
func sftpOutputOf(stdout, cmd string) []string {
	var out []string
	in := false
	for line := range strings.SplitSeq(stdout, "\n") {
		if rest, ok := strings.CutPrefix(line, "sftp> "); ok {
			in = rest == cmd || strings.HasPrefix(rest, cmd+" ")
			continue
		}
		if in && strings.TrimSpace(line) != "" {
			out = append(out, strings.TrimSpace(line))
		}
	}
	return out
}

// An sshd that exits at once (here: false) is reported promptly; the
// cleanup does not hang on the exit status that the readiness loop
// already consumed.
func TestStartSSHDExitsAtOnce(t *testing.T) {
	t.Parallel()
	falsePath, err := exec.LookPath("false")
	if err != nil {
		t.Skip("false is not on PATH")
	}
	ca := newSSHKey(t).PublicKey()
	done := make(chan string, 1)
	go func() {
		// A subtest runs the cleanups of startSSHD before it returns.
		var why string
		t.Run("start", func(t *testing.T) {
			s, reason := startSSHD(t, falsePath, ca)
			if s != nil {
				t.Error("startSSHD returned a server for false")
			}
			why = reason
		})
		done <- why
	}()
	select {
	case why := <-done:
		if !strings.Contains(why, "sshd exited") {
			t.Fatalf("reason %q", why)
		}
	case <-time.After(5 * time.Second):
		t.Fatal("startSSHD or its cleanup hung for an sshd that exited")
	}
}
