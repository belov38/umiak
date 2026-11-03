package devsecrets_test

import (
	"bytes"
	"context"
	"crypto/tls"
	"fmt"
	"net"
	"net/http"
	"os"
	"os/exec"
	"path/filepath"
	"runtime"
	"sync"
	"sync/atomic"
	"syscall"
	"testing"
	"time"

	"connectrpc.com/connect"

	tunnelv1 "github.com/belov38/umiak/libs/proto/umiak/tunnel/v1"
	"github.com/belov38/umiak/libs/proto/umiak/tunnel/v1/tunnelv1connect"
	"github.com/belov38/umiak/libs/tunnel/h2"
	"github.com/belov38/umiak/libs/tunnel/transport"
	"github.com/belov38/umiak/libs/tunnel/wire"
	"github.com/belov38/umiak/libs/tunnel/wstransport"
	"github.com/belov38/umiak/services/gateway/internal/devsecrets"
	"github.com/belov38/umiak/services/gateway/internal/edge"
)

type compiledGuestAdmission struct {
	parent *compiledGuestAdmitter
	epoch  uint64
}
type compiledGuestAdmitter struct {
	conns  chan *http.ClientConn
	errors chan error
	epoch  atomic.Uint64
}

func (a *compiledGuestAdmitter) Admit(_ context.Context, hello transport.Hello) (transport.Admission, error) {
	if hello.MachineID != "0192f1a4-7c3e-7b2a-9d4f-1a2b3c4d5e6f" || hello.Scheme != transport.AuthBootstrap || !bytes.Equal(hello.Secret, bytes.Repeat([]byte{0x5a}, wire.SecretLen)) {
		return nil, fmt.Errorf("unexpected guest identity")
	}
	return &compiledGuestAdmission{parent: a, epoch: a.epoch.Add(1)}, nil
}
func (a *compiledGuestAdmission) Info() transport.ConnInfo {
	return transport.ConnInfo{GatewayInstance: "renewal-test", Epoch: a.epoch, ConnID: fmt.Sprintf("connection-%d", a.epoch)}
}
func (a *compiledGuestAdmission) Abort(err error) { a.parent.errors <- err }
func (a *compiledGuestAdmission) Serve(conn net.Conn) {
	go func() {
		cc, err := h2.NewClientConn(context.Background(), conn, h2.DefaultClientConfig())
		if err != nil {
			a.parent.errors <- err
			return
		}
		a.parent.conns <- cc
	}()
}

type compiledGuestLog struct {
	mu sync.Mutex
	bytes.Buffer
}

func (b *compiledGuestLog) Write(p []byte) (int, error) {
	b.mu.Lock()
	defer b.mu.Unlock()
	return b.Buffer.Write(p)
}
func (b *compiledGuestLog) String() string {
	b.mu.Lock()
	defer b.mu.Unlock()
	return b.Buffer.String()
}

func TestCompiledGuestAgentReconnectsAfterLeafRenewal(t *testing.T) {
	if runtime.GOOS == "windows" {
		t.Skip("fixture uses Unix signal shutdown")
	}
	ctx, cancel := context.WithTimeout(t.Context(), 45*time.Second)
	defer cancel()
	bin := filepath.Join(t.TempDir(), "compiled-guest-agent")
	build := exec.CommandContext(ctx, "go", "build", "-o", bin, "../../../guest-agent/test/compiled-tunnel")
	if out, err := build.CombinedOutput(); err != nil {
		t.Fatalf("build guest runtime fixture: %v\n%s", err, out)
	}
	dir := t.TempDir()
	now := time.Now()
	if _, err := devsecrets.Generate(devsecrets.Options{Dir: dir, TunnelHost: "localhost", Now: func() time.Time { return now.Add(-390 * 24 * time.Hour) }}); err != nil {
		t.Fatal(err)
	}
	ca, err := os.ReadFile(filepath.Join(dir, "ca.pem"))
	if err != nil {
		t.Fatal(err)
	}
	trust := t.TempDir()
	if err := os.WriteFile(filepath.Join(trust, "tunnel-ca.pem"), ca, 0o644); err != nil {
		t.Fatal(err)
	}
	source, err := edge.NewCertSource("tunnel", filepath.Join(dir, "tunnel.pem"), filepath.Join(dir, "tunnel.key"), nil)
	if err != nil {
		t.Fatal(err)
	}
	go source.Run(ctx)
	admitter := &compiledGuestAdmitter{conns: make(chan *http.ClientConn, 8), errors: make(chan error, 8)}
	server := &http.Server{Handler: wstransport.NewHandler(admitter, wstransport.HandlerOptions{}), ReadHeaderTimeout: 5 * time.Second}
	ln, err := tls.Listen("tcp", "127.0.0.1:0", &tls.Config{MinVersion: tls.VersionTLS12, GetCertificate: func(*tls.ClientHelloInfo) (*tls.Certificate, error) { return source.Get(), nil }})
	if err != nil {
		t.Fatal(err)
	}
	defer func() { _ = server.Close() }()
	go func() { _ = server.Serve(ln) }()
	cmd := exec.CommandContext(ctx, bin, t.TempDir(), fmt.Sprintf("wss://localhost:%d/v1/connect", ln.Addr().(*net.TCPAddr).Port), trust)
	var log compiledGuestLog
	cmd.Stdout, cmd.Stderr = &log, &log
	if err := cmd.Start(); err != nil {
		t.Fatal(err)
	}
	done := make(chan error, 1)
	go func() { done <- cmd.Wait() }()
	defer func() {
		_ = cmd.Process.Signal(syscall.SIGTERM)
		select {
		case err := <-done:
			_ = err
		case <-time.After(5 * time.Second):
			_ = cmd.Process.Kill()
			if err := <-done; err != nil {
				t.Logf("guest process terminated during cleanup: %v", err)
			}
		}
	}()
	awaitConn := func() *http.ClientConn {
		t.Helper()
		select {
		case c := <-admitter.conns:
			return c
		case err := <-admitter.errors:
			t.Fatalf("guest admission: %v", err)
		case <-ctx.Done():
			t.Fatalf("guest did not connect: %s", log.String())
		}
		return nil
	}
	info := func(cc *http.ClientConn) {
		t.Helper()
		client := tunnelv1connect.NewControlClient(&http.Client{Transport: cc}, "http://guest")
		response, err := client.Info(ctx, connect.NewRequest(&tunnelv1.InfoRequest{}))
		if err != nil {
			t.Fatalf("compiled guest Control/Info: %v\n%s", err, log.String())
		}
		if response.Msg.AgentVersion != "renewal-fixture" {
			t.Fatalf("unexpected guest version %s", response.Msg.AgentVersion)
		}
	}
	first := awaitConn()
	defer func() { _ = first.Close() }()
	info(first)
	old := bytes.Clone(source.Get().Certificate[0])
	if _, err := devsecrets.Generate(devsecrets.Options{Dir: dir, TunnelHost: "localhost", RenewBefore: 720 * time.Hour}); err != nil {
		t.Fatal(err)
	}
	deadline := time.Now().Add(3 * time.Second)
	for bytes.Equal(source.Get().Certificate[0], old) && time.Now().Before(deadline) {
		time.Sleep(10 * time.Millisecond)
	}
	if bytes.Equal(source.Get().Certificate[0], old) {
		t.Fatal("renewal did not hot reload")
	}
	info(first) // Existing guest tunnel stays usable while the leaf is replaced.
	if err := first.Close(); err != nil {
		t.Fatal(err)
	}
	second := awaitConn() // Same compiled guest process, same trust file, new TLS handshake.
	defer func() { _ = second.Close() }()
	info(second)
	if got, err := os.ReadFile(filepath.Join(trust, "tunnel-ca.pem")); err != nil || !bytes.Equal(got, ca) {
		t.Fatalf("guest trust changed: %v", err)
	}
}
