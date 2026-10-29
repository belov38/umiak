//go:build unix

package main

import (
	"bufio"
	"bytes"
	"context"
	"crypto/tls"
	"crypto/x509"
	"encoding/json"
	"errors"
	"io"
	"net"
	"net/http"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"sync"
	"syscall"
	"testing"
	"time"

	"github.com/belov38/boat-dev-clone/libs/tunnel/tunneltest/pgtest"
	"github.com/belov38/boat-dev-clone/services/gateway/internal/devsecrets"
)

func TestMain(m *testing.M) { pgtest.Main(m) }

// build builds sbx-gateway into a temporary directory of the test.
func build(t *testing.T) string {
	t.Helper()
	bin := filepath.Join(t.TempDir(), "sbx-gateway")
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Minute)
	defer cancel()
	if out, err := exec.CommandContext(ctx, "go", "build", "-o", bin, ".").CombinedOutput(); err != nil {
		t.Fatalf("go build: %v\n%s", err, out)
	}
	return bin
}

// syncBuffer is a bytes.Buffer safe for the writer goroutine of exec.Cmd and
// the test reading it.
type syncBuffer struct {
	mu sync.Mutex
	b  bytes.Buffer
}

func (s *syncBuffer) Write(p []byte) (int, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	return s.b.Write(p)
}

func (s *syncBuffer) String() string {
	s.mu.Lock()
	defer s.mu.Unlock()
	return s.b.String()
}

func freePort(t *testing.T) string {
	t.Helper()
	ln, err := (&net.ListenConfig{}).Listen(context.Background(), "tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatal(err)
	}
	addr := ln.Addr().String()
	_ = ln.Close()
	return addr
}

// cleanEnv is the test's environment without SBX_GATEWAY_* and DATABASE_URL.
func cleanEnv() []string {
	var out []string
	for _, kv := range os.Environ() {
		if strings.HasPrefix(kv, "SBX_GATEWAY_") || strings.HasPrefix(kv, "DATABASE_URL=") {
			continue
		}
		out = append(out, kv)
	}
	return out
}

func runBin(t *testing.T, bin string, env []string, args ...string) (string, string, int) {
	t.Helper()
	ctx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
	defer cancel()
	cmd := exec.CommandContext(ctx, bin, args...)
	cmd.Env = env
	var stdout, stderr bytes.Buffer
	cmd.Stdout, cmd.Stderr = &stdout, &stderr
	err := cmd.Run()
	code := 0
	if ee := (*exec.ExitError)(nil); errors.As(err, &ee) {
		code = ee.ExitCode()
	} else if err != nil {
		t.Fatalf("%v: %v", args, err)
	}
	return stdout.String(), stderr.String(), code
}

func httpGet(ctx context.Context, c *http.Client, url, host string) (int, string, error) {
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, url, nil)
	if err != nil {
		return 0, "", err
	}
	if host != "" {
		req.Host = host
	}
	resp, err := c.Do(req)
	if err != nil {
		return 0, "", err
	}
	defer func() { _ = resp.Body.Close() }()
	b, _ := io.ReadAll(resp.Body)
	return resp.StatusCode, string(b), nil
}

func TestMainServeSmoke(t *testing.T) {
	_, dsn := pgtest.New(t)
	bin := build(t)
	dir := t.TempDir()

	out, errOut, code := runBin(t, bin, cleanEnv(), "dev-secrets", "-dir", dir)
	if code != 0 || !strings.Contains(out, "ca.pem") {
		t.Fatalf("dev-secrets: code %d\nstdout: %s\nstderr: %s", code, out, errOut)
	}
	if out, _, code := runBin(t, bin, cleanEnv(), "dev-secrets", "-dir", dir); code != 0 || strings.Contains(out, "wrote") {
		t.Fatalf("second dev-secrets: code %d, stdout %q", code, out)
	}

	internal, metrics, tlsAddr, sshAddr := freePort(t), freePort(t), freePort(t), freePort(t)
	f := func(name string) string { return filepath.Join(dir, name) }
	env := append(serveEnv(dsn, dir, internal, metrics),
		"SBX_GATEWAY_TLS_LISTEN="+tlsAddr,
		"SBX_GATEWAY_SSH_LISTEN="+sshAddr,
		// Shrunk drain: the default waits 5 s for the load balancer.
		"SBX_GATEWAY_ENDPOINT_WAIT=100ms",
		"SBX_GATEWAY_DRAIN_TIMEOUT=10s",
	)
	p := start(t, bin, env)
	ctx := context.Background()
	p.waitOK(t, "http://"+metrics+"/healthz")
	p.waitOK(t, "http://"+metrics+"/readyz")
	if _, errOut, code := runBin(t, bin, cleanEnv(), "healthcheck", "-url", "http://"+metrics+"/readyz"); code != 0 {
		t.Fatalf("healthcheck: code %d: %s", code, errOut)
	}

	// The TLS edge serves the dev certificate; without api every route
	// lookup is unavailable.
	caPEM, err := os.ReadFile(f("ca.pem"))
	if err != nil {
		t.Fatal(err)
	}
	roots := x509.NewCertPool()
	roots.AppendCertsFromPEM(caPEM)
	tlsClient := &http.Client{Timeout: 5 * time.Second, Transport: &http.Transport{
		TLSClientConfig: &tls.Config{RootCAs: roots, MinVersion: tls.VersionTLS13},
		DialContext: func(ctx context.Context, network, _ string) (net.Conn, error) {
			return (&net.Dialer{}).DialContext(ctx, network, tlsAddr)
		},
	}}
	c, body, err := httpGet(ctx, tlsClient, "https://demo-3000.sbx.localhost/", "")
	if err != nil {
		t.Fatal(err)
	}
	var eb struct {
		Error struct{ Code string } `json:"error"`
	}
	if c != http.StatusServiceUnavailable || json.Unmarshal([]byte(body), &eb) != nil || eb.Error.Code != "route_lookup_unavailable" {
		t.Fatalf("GET demo-3000.sbx.localhost = %d %s, want 503 route_lookup_unavailable", c, body)
	}
	// The access log is JSON lines on stdout.
	waitFor(t, 5*time.Second, "access log line", func() bool {
		return strings.Contains(p.stdout.String(), `"label":"demo-3000"`)
	})
	sc := bufio.NewScanner(strings.NewReader(p.stdout.String()))
	for sc.Scan() {
		if !json.Valid(sc.Bytes()) {
			t.Fatalf("stdout line is not JSON: %q", sc.Text())
		}
	}

	// The SSH listener speaks SSH.
	conn, err := (&net.Dialer{Timeout: 2 * time.Second}).DialContext(ctx, "tcp", sshAddr)
	if err != nil {
		t.Fatal(err)
	}
	_ = conn.SetReadDeadline(time.Now().Add(5 * time.Second))
	banner, err := bufio.NewReader(conn).ReadString('\n')
	_ = conn.Close()
	if err != nil || !strings.HasPrefix(banner, "SSH-2.0-") {
		t.Fatalf("ssh banner %q, err %v", banner, err)
	}

	// SIGTERM: a clean drain and exit 0 within 3 s.
	begin := time.Now()
	p.signal(t, syscall.SIGTERM)
	if err := p.wait(t, 3*time.Second); err != nil {
		t.Fatalf("exit after SIGTERM: %v", err)
	}
	t.Logf("drained and exited in %s", time.Since(begin))
	if !strings.Contains(p.stderr.String(), "drain finished") {
		t.Fatalf("stderr lacks the drain log:\n%s", p.stderr.String())
	}
}

// TestMainSecondSignal: the first SIGTERM starts the drain (/readyz 503),
// a second one ends the process at once with a non-zero status.
func TestMainSecondSignal(t *testing.T) {
	_, dsn := pgtest.New(t)
	bin := build(t)
	dir := t.TempDir()
	if _, errOut, code := runBin(t, bin, cleanEnv(), "dev-secrets", "-dir", dir); code != 0 {
		t.Fatalf("dev-secrets: %s", errOut)
	}
	internal, metrics := freePort(t), freePort(t)
	p := start(t, bin, append(serveEnv(dsn, dir, internal, metrics),
		"SBX_GATEWAY_TLS_LISTEN=off",
		"SBX_GATEWAY_SSH_LISTEN=off",
		"SBX_GATEWAY_ENDPOINT_WAIT=1m",
	))
	p.waitOK(t, "http://"+metrics+"/readyz")
	p.signal(t, syscall.SIGTERM)
	client := &http.Client{Timeout: 2 * time.Second}
	waitFor(t, 5*time.Second, "/readyz 503 while draining", func() bool {
		c, _, err := httpGet(context.Background(), client, "http://"+metrics+"/readyz", "")
		return err == nil && c == http.StatusServiceUnavailable
	})
	p.signal(t, syscall.SIGINT)
	err := p.wait(t, 7*time.Second)
	var ee *exec.ExitError
	if !errors.As(err, &ee) || ee.ExitCode() != 1 {
		t.Fatalf("exit after the second signal: %v, want status 1", err)
	}
	if !strings.Contains(p.stderr.String(), "second signal") {
		t.Fatalf("stderr lacks the forced stop:\n%s", p.stderr.String())
	}
}

// serveEnv is the environment of a gateway on internal and metrics with the
// dev secrets of dir and no api.
func serveEnv(dsn, dir, internal, metrics string) []string {
	f := func(name string) string { return filepath.Join(dir, name) }
	return append(cleanEnv(),
		"DATABASE_URL="+dsn,
		"SBX_GATEWAY_INTERNAL_LISTEN="+internal,
		"SBX_GATEWAY_INTERNAL_URL=http://"+internal,
		"SBX_GATEWAY_METRICS_LISTEN="+metrics,
		"SBX_GATEWAY_SBX_DOMAIN=sbx.localhost",
		"SBX_GATEWAY_TUNNEL_HOST=tunnel.localhost",
		"SBX_GATEWAY_SSH_HOST=ssh.localhost",
		"SBX_GATEWAY_API_URL=none",
		"SBX_GATEWAY_SERVICE_TOKENS_FILE="+f("service-tokens.json"),
		"SBX_GATEWAY_COOKIE_KEYS_FILE="+f("cookie-keys"),
		"SBX_GATEWAY_TLS_SBX_CERT_FILE="+f("sbx.pem"),
		"SBX_GATEWAY_TLS_SBX_KEY_FILE="+f("sbx.key"),
		"SBX_GATEWAY_TLS_TUNNEL_CERT_FILE="+f("tunnel.pem"),
		"SBX_GATEWAY_TLS_TUNNEL_KEY_FILE="+f("tunnel.key"),
		"SBX_GATEWAY_SSH_HOST_KEY_FILES="+f("ssh_host_ed25519_key")+","+f("ssh_host_ecdsa_key"),
		"SBX_GATEWAY_SSH_USER_CA_KEY_FILE="+f("ssh_user_ca"),
		"SBX_GATEWAY_SSH_LOGIN_CA_KEYS_FILE="+f("login-ca-keys"),
	)
}

// proc is a running sbx-gateway serve.
type proc struct {
	cmd            *exec.Cmd
	stdout, stderr syncBuffer
	done           chan struct{} // closed when the process exited
	err            error         // of Wait, set before done is closed
}

func start(t *testing.T, bin string, env []string) *proc {
	t.Helper()
	p := &proc{done: make(chan struct{})}
	p.cmd = exec.CommandContext(context.Background(), bin, "serve")
	p.cmd.Env = env
	p.cmd.Stdout, p.cmd.Stderr = &p.stdout, &p.stderr
	if err := p.cmd.Start(); err != nil {
		t.Fatal(err)
	}
	go func() {
		p.err = p.cmd.Wait()
		close(p.done)
	}()
	t.Cleanup(func() {
		_ = p.cmd.Process.Kill()
		<-p.done
		if t.Failed() {
			t.Logf("gateway stderr:\n%s\ngateway stdout:\n%s", p.stderr.String(), p.stdout.String())
		}
	})
	return p
}

func (p *proc) signal(t *testing.T, sig os.Signal) {
	t.Helper()
	if err := p.cmd.Process.Signal(sig); err != nil {
		t.Fatal(err)
	}
}

// wait returns the exit error of the process, failing after timeout.
func (p *proc) wait(t *testing.T, timeout time.Duration) error {
	t.Helper()
	select {
	case <-p.done:
		return p.err
	case <-time.After(timeout):
		t.Fatalf("no exit within %s", timeout)
		return nil
	}
}

// waitOK polls url until it answers 200.
func (p *proc) waitOK(t *testing.T, url string) {
	t.Helper()
	client := &http.Client{Timeout: 2 * time.Second}
	deadline := time.Now().Add(30 * time.Second)
	for {
		c, _, err := httpGet(context.Background(), client, url, "")
		if err == nil && c == http.StatusOK {
			return
		}
		select {
		case <-p.done:
			t.Fatalf("gateway exited before %s turned 200: %v", url, p.err)
		default:
		}
		if time.Now().After(deadline) {
			t.Fatalf("%s: status %d, err %v", url, c, err)
		}
		time.Sleep(50 * time.Millisecond)
	}
}

func waitFor(t *testing.T, timeout time.Duration, what string, cond func() bool) {
	t.Helper()
	deadline := time.Now().Add(timeout)
	for !cond() {
		if time.Now().After(deadline) {
			t.Fatalf("timed out waiting for %s", what)
		}
		time.Sleep(20 * time.Millisecond)
	}
}

func TestMainServeConfigErrors(t *testing.T) {
	bin := build(t)
	dir := t.TempDir()
	if _, errOut, code := runBin(t, bin, cleanEnv(), "dev-secrets", "-dir", dir); code != 0 {
		t.Fatalf("dev-secrets: %s", errOut)
	}
	base := append(cleanEnv(),
		"DATABASE_URL=postgres://sbx:sbx@127.0.0.1:1/sbx",
		"SBX_GATEWAY_INTERNAL_URL=http://127.0.0.1:7000",
		"SBX_GATEWAY_TLS_LISTEN=off",
		"SBX_GATEWAY_SSH_LISTEN=off",
		"SBX_GATEWAY_SBX_DOMAIN=sbx.localhost",
		"SBX_GATEWAY_TUNNEL_HOST=tunnel.localhost",
		"SBX_GATEWAY_SERVICE_TOKENS_FILE="+filepath.Join(dir, "service-tokens.json"),
		"SBX_GATEWAY_COOKIE_KEYS_FILE="+filepath.Join(dir, "cookie-keys"),
	)
	// No SBX_GATEWAY_API_URL: a startup error, not a silent dev mode.
	_, errOut, code := runBin(t, bin, base, "serve")
	if code != 1 || !strings.Contains(errOut, "SBX_GATEWAY_API_URL") {
		t.Fatalf("serve without API_URL: code %d, stderr %s", code, errOut)
	}
	if _, errOut, code := runBin(t, bin, base, "bogus"); code != 2 || !strings.Contains(errOut, "usage") {
		t.Fatalf("unknown command: code %d, stderr %s", code, errOut)
	}
}

// getenvOf turns KEY=VALUE pairs into a getenv function.
func getenvOf(env []string) func(string) string {
	m := map[string]string{}
	for _, kv := range env {
		if k, v, ok := strings.Cut(kv, "="); ok {
			m[k] = v
		}
	}
	return func(k string) string { return m[k] }
}

// startupEnv prepares dev secrets and a database for an in-process serve
// without the TLS and SSH listeners.
func startupEnv(t *testing.T) []string {
	t.Helper()
	_, dsn := pgtest.New(t)
	dir := t.TempDir()
	if _, err := devsecrets.Generate(devsecrets.Options{Dir: dir}); err != nil {
		t.Fatal(err)
	}
	return append(serveEnv(dsn, dir, freePort(t), freePort(t)),
		"SBX_GATEWAY_TLS_LISTEN=off",
		"SBX_GATEWAY_SSH_LISTEN=off",
		"SBX_GATEWAY_ENDPOINT_WAIT=100ms",
		"SBX_GATEWAY_DRAIN_TIMEOUT=10s",
	)
}

func serveAsync(o serveOptions) <-chan int {
	done := make(chan int, 1)
	go func() { done <- serveWith(o) }()
	return done
}

func waitCode(t *testing.T, done <-chan int, timeout time.Duration, stderr *syncBuffer) int {
	t.Helper()
	select {
	case code := <-done:
		return code
	case <-time.After(timeout):
		t.Fatalf("serve did not return within %s; log:\n%s", timeout, stderr.String())
		return 0
	}
}

// A SIGTERM that arrives before Run started (it was queued during the
// setup) drains once Run is up, and the process exits 0.
func TestServeSignalBeforeRun(t *testing.T) {
	env := startupEnv(t)
	sigs := make(chan os.Signal, 2)
	sigs <- syscall.SIGTERM
	var stdout, stderr syncBuffer
	done := serveAsync(serveOptions{
		getenv: getenvOf(env), sigs: sigs, stdout: &stdout, stderr: &stderr,
		beforeRun: func() { time.Sleep(500 * time.Millisecond) },
	})
	if code := waitCode(t, done, 15*time.Second, &stderr); code != 0 {
		t.Fatalf("exit %d, want 0; log:\n%s", code, stderr.String())
	}
	if !strings.Contains(stderr.String(), "exiting after a clean drain") {
		t.Fatalf("log lacks the clean drain:\n%s", stderr.String())
	}
}

// A second signal while the drain still waits for Run's startup stops the
// process at once with status 1.
func TestServeSecondSignalDuringStartup(t *testing.T) {
	env := startupEnv(t)
	sigs := make(chan os.Signal, 2)
	sigs <- syscall.SIGTERM
	var stdout, stderr syncBuffer
	start := time.Now()
	done := serveAsync(serveOptions{
		getenv: getenvOf(env), sigs: sigs, stdout: &stdout, stderr: &stderr,
		beforeRun: func() {
			sigs <- syscall.SIGINT
			time.Sleep(time.Second)
		},
	})
	if code := waitCode(t, done, 10*time.Second, &stderr); code != 1 {
		t.Fatalf("exit %d, want 1; log:\n%s", code, stderr.String())
	}
	if !strings.Contains(stderr.String(), "second signal") {
		t.Fatalf("log lacks the forced stop:\n%s", stderr.String())
	}
	// forcedStopWait bounds the exit after the second signal.
	if took := time.Since(start); took > forcedStopWait+3*time.Second {
		t.Fatalf("took %s", took)
	}
}
