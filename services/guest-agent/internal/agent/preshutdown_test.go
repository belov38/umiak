package agent

import (
	"context"
	"net"
	"net/http"
	"os"
	"path/filepath"
	"sync"
	"testing"
	"time"

	"connectrpc.com/connect"

	agentv1 "github.com/belov38/umiak/libs/proto/umiak/agent/v1"
	"github.com/belov38/umiak/libs/proto/umiak/agent/v1/agentv1connect"
	"github.com/belov38/umiak/libs/tunnel/wire"

	"github.com/belov38/umiak/services/guest-agent/internal/supervisor"
)

// killOrder wraps the fake supervisor and records, for each KillCgroup,
// whether the secret file was still on disk.
type killOrder struct {
	*supervisor.Fake
	secret string
	mu     sync.Mutex
	kills  map[string]bool // id -> secret file present at the kill
}

func (k *killOrder) KillCgroup(ctx context.Context, id string) error {
	_, err := os.Stat(k.secret)
	k.mu.Lock()
	k.kills[id] = err == nil
	k.mu.Unlock()
	return k.Fake.KillCgroup(ctx, id)
}

// TestPreShutdownWipesSecrets: PreShutdown (the Windows PRESHUTDOWN
// control) ends the commands first, then wipes the secret files like
// System/PrepareStop and stops the agent without its context being
// cancelled.
func TestPreShutdownWipesSecrets(t *testing.T) {
	h := newHarness(t)
	h.seedIdentity(machineA)
	secret := filepath.Join(h.l.SecretFilesDir, "token")
	ko := &killOrder{Fake: h.sup, secret: secret, kills: map[string]bool{}}
	h.supervisor = ko
	// A live command (unit active) and a finished one (unit gone).
	h.sup.SetState("live", supervisor.UnitActive)
	for _, id := range []string{"live", "gone"} {
		if err := os.MkdirAll(h.l.CommandDir(id), 0o700); err != nil {
			t.Fatal(err)
		}
	}
	dir, err := os.MkdirTemp("", "umiakdbg")
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
		SandboxId:   "umiak_1",
		Hostname:    "umiak-1",
		SecretFiles: []*agentv1.SecretFile{{Name: "token", Content: []byte("s3cret"), Mode: 0o600}},
	})
	req.Header().Set(wire.HeaderRequestID, "0192f1a4-7c3e-7b2a-9d4f-000000000010")
	if _, err := sys.Claim(ctx, req); err != nil {
		t.Fatalf("Claim: %v", err)
	}
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
	ko.mu.Lock()
	defer ko.mu.Unlock()
	for _, id := range []string{"live", "gone"} {
		present, ok := ko.kills[id]
		if !ok || !present {
			t.Errorf("command %s: killed %t, secret file present at the kill %t; want a kill before the wipe", id, ok, present)
		}
	}
	if h.sup.CgroupKills("live") != 1 {
		t.Errorf("live command kills = %d", h.sup.CgroupKills("live"))
	}
}
