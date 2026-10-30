//go:build integration && linux

package integration

import (
	"bytes"
	"context"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"connectrpc.com/connect"
	"github.com/google/uuid"

	agentv1 "github.com/belov38/boat-dev-clone/libs/proto/sbx/agent/v1"
	tunnelv1 "github.com/belov38/boat-dev-clone/libs/proto/sbx/tunnel/v1"
	"github.com/belov38/boat-dev-clone/services/guest-agent/internal/events"
)

// versions returns the versions run.sh built: v1 (installed), v2 (good),
// v3 (failRun build) and v4 (signed with a foreign key).
func versions(t *testing.T) (v1, v2, v3, v4 string) {
	t.Helper()
	f := strings.Fields(string(readFileT(t, filepath.Join(pkgDir, "versions"))))
	if len(f) != 4 {
		t.Fatalf("versions file: %q", f)
	}
	return f[0], f[1], f[2], f[3]
}

// upload sends the file at path through /files/uploads in 8 MiB chunks
// without committing it and returns the upload id.
func upload(t *testing.T, c *agentClient, path string) string {
	t.Helper()
	data := readFileT(t, path)
	id := "upl_it_" + strings.ReplaceAll(uuid.NewString(), "-", "")
	dst := "/home/user/" + id + ".tar"
	const chunk = 8 << 20
	for off := 0; off < len(data); off += chunk {
		end := min(off+chunk, len(data))
		q := url.Values{"offset": {fmt.Sprint(off)}}
		if off == 0 {
			q.Set("path", dst)
		}
		req, err := http.NewRequestWithContext(tctx(t, time.Minute), http.MethodPut,
			"http://agent/files/uploads/"+id+"?"+q.Encode(), bytes.NewReader(data[off:end]))
		if err != nil {
			t.Fatal(err)
		}
		res, err := c.hc.Do(req)
		if err != nil {
			t.Fatalf("upload chunk at %d: %v", off, err)
		}
		body, _ := io.ReadAll(res.Body)
		_ = res.Body.Close()
		if res.StatusCode != http.StatusOK {
			t.Fatalf("upload chunk at %d: %d %s", off, res.StatusCode, body)
		}
	}
	return id
}

// applyUpdate uploads the package at path and calls ApplyUpdate.
func applyUpdate(t *testing.T, c *agentClient, pkg string) (*agentv1.ApplyUpdateResponse, error) {
	t.Helper()
	id := upload(t, c, filepath.Join(pkgDir, pkg))
	res, err := c.sys.ApplyUpdate(tctx(t, 2*time.Minute), connect.NewRequest(&agentv1.ApplyUpdateRequest{UploadId: id}))
	if err != nil {
		return nil, err
	}
	return res.Msg, nil
}

// waitVersion waits until the agent answers with version v.
func waitVersion(t *testing.T, v string, d time.Duration) {
	t.Helper()
	c := newClient()
	eventually(t, d, "agent version "+v, func() bool {
		ctx, cancel := context.WithTimeout(context.Background(), 2*time.Second)
		defer cancel()
		res, err := c.sys.Info(ctx, connect.NewRequest(&agentv1.InfoRequest{}))
		return err == nil && res.Msg.GetVersion() == v
	})
}

// currentVersion returns the version current points at.
func currentVersion(t *testing.T) string {
	t.Helper()
	target, err := os.Readlink("/usr/local/lib/sbx-agent/current")
	if err != nil {
		t.Fatal(err)
	}
	return filepath.Base(target)
}

// Spec 21 items 2 (self-update part) and 3: a good package is installed and
// confirmed (update.result{ok}) while a command keeps running; a package with
// a foreign signature is refused with signature_invalid; a package whose
// binary passes selftest but cannot run is rolled back after StartLimitBurst
// (update.result{rolled_back}). The confirmation comes from Control/Info on
// the debug socket (--debug-confirm): there is no gateway in the container.
func TestUpdateAndRollback(t *testing.T) {
	v1, v2, v3, v4 := versions(t)
	c := newClient()
	if got := waitAgent(t).GetVersion(); got != v1 {
		t.Skipf("running version %s, want the installed %s (run the update test once per container)", got, v1)
	}

	// A command that lives through the update.
	id := newID("upd")
	start(t, c, id, shellSpec("for i in $(seq 1 40); do echo tick-$i; sleep 1; done", "user"))
	time.Sleep(time.Second)

	t.Run("good package", func(t *testing.T) {
		after := lastSeq(t)
		res, err := applyUpdate(t, c, "v2.tar")
		if err != nil {
			t.Fatalf("ApplyUpdate v2: %v", err)
		}
		if res.GetFrom() != v1 || res.GetTo() != v2 {
			t.Errorf("ApplyUpdate = %v", res)
		}
		waitVersion(t, v2, 2*time.Minute)
		if _, err := c.ctl.Info(tctx(t, 10*time.Second), connect.NewRequest(&tunnelv1.InfoRequest{})); err != nil {
			t.Fatalf("Control/Info: %v", err)
		}
		var r agentv1.UpdateResult
		waitEvent(t, after, events.TypeUpdateResult, 30*time.Second, &r, func() bool { return r.GetTo() == v2 })
		if !r.GetOk() || r.GetFrom() != v1 || r.GetRolledBack() {
			t.Errorf("update.result = %v, want ok from %s", &r, v1)
		}
		eventually(t, 10*time.Second, "the pending update to be confirmed", func() bool {
			_, err := os.Stat(filepath.Join(stateDir, "pending-update.json"))
			return os.IsNotExist(err)
		})
		if st := get(t, c, id).GetState(); st != agentv1.CommandState_COMMAND_STATE_RUNNING {
			t.Errorf("command state after the update = %v, want RUNNING", st)
		}
	})

	t.Run("foreign signature", func(t *testing.T) {
		_, err := applyUpdate(t, c, "v4-badsig.tar")
		if errDetail(err) != "signature_invalid" {
			t.Fatalf("ApplyUpdate %s = %v (detail %q), want signature_invalid", v4, err, errDetail(err))
		}
		if cur := currentVersion(t); cur != v2 {
			t.Errorf("current = %s, want %s unchanged", cur, v2)
		}
		if _, err := os.Stat("/usr/local/lib/sbx-agent/versions/" + v4); !os.IsNotExist(err) {
			t.Errorf("version %s was placed: %v", v4, err)
		}
	})

	t.Run("rollback after StartLimitBurst", func(t *testing.T) {
		// A clean start-rate counter: exactly StartLimitBurst starts of v3.
		sh(t, "systemctl reset-failed "+agentUnit+" || true")
		after := lastSeq(t)
		res, err := applyUpdate(t, c, "v3-failrun.tar")
		if err != nil {
			t.Fatalf("ApplyUpdate %s: %v", v3, err)
		}
		if res.GetTo() != v3 {
			t.Errorf("ApplyUpdate = %v", res)
		}
		began := time.Now()
		// v3 exits 1 at every start; after StartLimitBurst=5 failures
		// OnFailure runs sbx-agent-rollback.service, which restores v2, and
		// v2 reports the rollback.
		var r agentv1.UpdateResult
		waitEventLoose(t, after, events.TypeUpdateResult, 3*time.Minute, &r, func() bool { return r.GetTo() == v3 })
		t.Logf("update.result after %v: %v", time.Since(began).Round(100*time.Millisecond), &r)
		waitVersion(t, v2, 30*time.Second)
		if !r.GetRolledBack() || r.GetOk() || r.GetFrom() != v2 {
			t.Errorf("update.result = %v, want rolled_back from %s", &r, v2)
		}
		if cur := currentVersion(t); cur != v2 {
			t.Errorf("current = %s, want %s", cur, v2)
		}
		info := waitAgent(t)
		if bad := info.GetUpdate().GetBadVersions(); len(bad) != 1 || bad[0] != v3 {
			t.Errorf("bad versions = %v, want [%s]", bad, v3)
		}
		if out := sh(t, "journalctl -m --no-pager -o cat -u sbx-agent-rollback.service"); strings.Count(out, "reverting an unconfirmed update") != 1 {
			t.Errorf("rollback unit journal:\n%s", out)
		}
		// RestartMode=direct: OnFailure ran once, after StartLimitBurst=5
		// failed starts, not after the first.
		if n := strings.Count(sh(t, "journalctl -m --no-pager -o cat -u "+agentUnit), "this build has failRun set"); n != 5 {
			t.Errorf("v3 started %d times before the rollback, want StartLimitBurst = 5", n)
		}
	})

	// The command outlived both version switches and the failed starts.
	r := attach(t, c, &agentv1.AttachRequest{CommandId: id}, true)
	if r.exit == nil || r.exit.GetCode() != 0 || !strings.HasSuffix(string(r.stdout), "tick-40\n") || strings.Count(string(r.stdout), "\n") != 40 {
		t.Errorf("command across the updates: exit %v, %d lines", r.exit, strings.Count(string(r.stdout), "\n"))
	}
}
