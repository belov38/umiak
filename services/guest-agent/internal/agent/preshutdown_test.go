package agent

import (
	"context"
	"net"
	"net/http"
	"os"
	"path/filepath"
	"testing"
	"time"

	"connectrpc.com/connect"

	agentv1 "github.com/belov38/boat-dev-clone/libs/proto/sbx/agent/v1"
	"github.com/belov38/boat-dev-clone/libs/proto/sbx/agent/v1/agentv1connect"
	"github.com/belov38/boat-dev-clone/libs/tunnel/wire"
)

// TestPreShutdownWipesSecrets: PreShutdown (the Windows PRESHUTDOWN
// control) wipes the secret files like System/PrepareStop and then stops
// the agent without its context being cancelled.
func TestPreShutdownWipesSecrets(t *testing.T) {
	h := newHarness(t)
	h.seedIdentity(machineA)
	dir, err := os.MkdirTemp("", "sbxdbg")
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = os.RemoveAll(dir) })
	sock := filepath.Join(dir, "a.sock")
	h.debugListen = "unix:" + sock
	h.preShutdown = make(chan struct{})
	h.start()
	h.waitReady()

	hc := &http.Client{Transport: &http.Transport{
		DialContext: func(ctx context.Context, _, _ string) (net.Conn, error) {
			var d net.Dialer
			return d.DialContext(ctx, "unix", sock)
		},
	}}
	sys := agentv1connect.NewSystemClient(hc, "http://agent")
	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()
	req := connect.NewRequest(&agentv1.ClaimRequest{
		SandboxId:   "sbx_1",
		Hostname:    "sbx-1",
		SecretFiles: []*agentv1.SecretFile{{Name: "token", Content: []byte("s3cret"), Mode: 0o600}},
	})
	req.Header().Set(wire.HeaderRequestID, "0192f1a4-7c3e-7b2a-9d4f-000000000010")
	if _, err := sys.Claim(ctx, req); err != nil {
		t.Fatalf("Claim: %v", err)
	}
	secret := filepath.Join(h.l.SecretFilesDir, "token")
	if _, err := os.Stat(secret); err != nil {
		t.Fatalf("secret file after Claim: %v", err)
	}

	close(h.preShutdown)
	select {
	case err := <-h.done:
		if err != nil {
			t.Fatalf("Run = %v, want nil", err)
		}
		h.done = nil
	case <-time.After(10 * time.Second):
		t.Fatal("the agent did not stop after PreShutdown")
	}
	if _, err := os.Stat(secret); !os.IsNotExist(err) {
		t.Errorf("secret file after PreShutdown: %v", err)
	}
}
