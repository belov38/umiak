package agent

import (
	"bytes"
	"context"
	"encoding/base64"
	"encoding/hex"
	"encoding/json"
	"errors"
	"net"
	"net/http"
	"os"
	"path/filepath"
	"slices"
	"strings"
	"sync"
	"sync/atomic"
	"testing"
	"time"

	"connectrpc.com/connect"
	"google.golang.org/protobuf/proto"

	agentv1 "github.com/belov38/boat-dev-clone/libs/proto/sbx/agent/v1"
	"github.com/belov38/boat-dev-clone/libs/proto/sbx/agent/v1/agentv1connect"
	tunnelv1 "github.com/belov38/boat-dev-clone/libs/proto/sbx/tunnel/v1"
	"github.com/belov38/boat-dev-clone/libs/proto/sbx/tunnel/v1/tunnelv1connect"
	"github.com/belov38/boat-dev-clone/libs/tunnel/wire"

	"github.com/belov38/boat-dev-clone/services/guest-agent/internal/events"
	"github.com/belov38/boat-dev-clone/services/guest-agent/internal/fsutil"
	"github.com/belov38/boat-dev-clone/services/guest-agent/internal/ident"
	"github.com/belov38/boat-dev-clone/services/guest-agent/internal/quiesce"
	"github.com/belov38/boat-dev-clone/services/guest-agent/internal/store"
	"github.com/belov38/boat-dev-clone/services/guest-agent/internal/update"
)

func TestStartupOrderIdentityReset(t *testing.T) {
	h := newHarness(t)
	// State of the previous identity: identity.json of machine A, a journal
	// with events and a command directory.
	if err := (&ident.File{MachineID: machineA}).Save(h.l.IdentityFile); err != nil {
		t.Fatal(err)
	}
	st, err := store.Open(h.l.StateDB, store.Options{})
	if err != nil {
		t.Fatal(err)
	}
	st.AppendEvent("old.event", nil)
	st.AppendEvent("old.event", nil)
	if err := st.Close(); err != nil {
		t.Fatal(err)
	}
	oldCmd := h.l.CommandDir("old")
	if err := os.MkdirAll(oldCmd, 0o755); err != nil {
		t.Fatal(err)
	}

	// The VM is a fork: smbios now names machine B.
	h.src.set(rawFor(machineB))
	h.start()
	h.waitReady()
	h.stop()

	if _, err := os.Stat(oldCmd); !os.IsNotExist(err) {
		t.Errorf("command dir of the old identity survived: %v", err)
	}
	f, err := ident.LoadFile(h.l.IdentityFile)
	if err != nil {
		t.Fatal(err)
	}
	if f.MachineID != machineB || f.ResetPending {
		t.Errorf("identity.json = %+v, want machine B without resetPending", f)
	}
	if !slices.Contains(h.resetter.Calls, "RestartSSH") || !slices.Contains(h.resetter.Calls, "ReloadNetwork") {
		t.Errorf("resetter calls = %v, want the agent fallback (RestartSSH, ReloadNetwork)", h.resetter.Calls)
	}

	evs := h.journal()
	if len(evs) < 2 {
		t.Fatalf("journal = %v, want at least identity.reset and agent.started", types(evs))
	}
	if evs[0].GetType() != events.TypeIdentityReset || evs[0].GetSeq() != 1 {
		t.Fatalf("first event = %s seq %d, want identity.reset seq 1 (journal %v)", evs[0].GetType(), evs[0].GetSeq(), types(evs))
	}
	var reset agentv1.IdentityReset
	if err := evs[0].GetPayload().UnmarshalTo(&reset); err != nil {
		t.Fatal(err)
	}
	if reset.GetMachineId() != machineB {
		t.Errorf("identity.reset machine_id = %q, want %q", reset.GetMachineId(), machineB)
	}
	if evs[1].GetType() != events.TypeAgentStarted {
		t.Errorf("second event = %s, want agent.started (journal %v)", evs[1].GetType(), types(evs))
	}
	if slices.Contains(types(evs), "old.event") {
		t.Errorf("journal of the old identity survived: %v", types(evs))
	}
}

func TestReadyBeforeTunnel(t *testing.T) {
	h := newHarness(t)
	h.dialer.block = true
	h.start()
	h.waitReady()
	// The tunnel client starts after READY=1 and keeps trying.
	select {
	case <-h.dialer.dialed:
	case <-time.After(10 * time.Second):
		t.Fatal("no dial attempt after READY=1")
	}
	order := h.order.all()
	ready, dial := slices.Index(order, "notify READY=1"), slices.Index(order, "dial")
	if ready < 0 || dial < 0 || ready > dial {
		t.Fatalf("order = %v, want READY=1 before the first dial", order)
	}
	s := h.readStatus()
	if s.Tunnel.Connected {
		t.Error("status reports a connected tunnel")
	}
	h.stop()
}

func TestExpiredUpdateStopsBeforeReady(t *testing.T) {
	h := newHarness(t)
	h.seedIdentity(machineA)
	p := update.Pending{From: "1.2.2", To: "1.2.3", Deadline: time.Now().Add(-time.Second)}
	if err := fsutil.WriteJSONAtomic(h.l.PendingUpdateFile, p, 0o644); err != nil {
		t.Fatal(err)
	}
	if err := Run(context.Background(), h.l, h.cfg, "1.2.3", h.buildDeps()); err != nil {
		t.Fatalf("Run = %v, want a graceful exit", err)
	}
	states := h.notify.all()
	if !slices.Contains(states, "STOPPING=1") || slices.Contains(states, "READY=1") {
		t.Errorf("sd_notify states = %v, want STOPPING=1 without READY=1", states)
	}
	if cur, _ := update.LinkVersion(h.l.CurrentLink); cur != "1.2.2" {
		t.Errorf("current = %q, want the reverted 1.2.2", cur)
	}
	// The deadline is checked before the slow startup steps: a version that
	// hangs in them is still rolled back.
	if _, err := os.Stat(h.l.StateDB); !errors.Is(err, os.ErrNotExist) {
		t.Errorf("state.db opened before the expired update was reverted: %v", err)
	}
}

func TestConfirmerConditions(t *testing.T) {
	tests := []struct {
		name         string
		debugConfirm bool
		signals      []string
		want         bool
	}{
		{"nothing", false, nil, false},
		{"connected only", false, []string{"up"}, false},
		{"tunnel info only", false, []string{"info"}, false},
		{"connected then info", false, []string{"up", "info"}, true},
		{"info then connected", false, []string{"info", "up"}, true},
		{"debug info without flag", false, []string{"debug"}, false},
		{"debug info and connection without flag", false, []string{"up", "debug"}, false},
		{"debug info with flag", true, []string{"debug"}, true},
		{"flag without debug info", true, []string{"up"}, false},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			var calls atomic.Int32
			c := newConfirmer(tt.debugConfirm, func() { calls.Add(1) })
			ctx, cancel := context.WithCancel(context.Background())
			done := make(chan struct{})
			go func() { c.run(ctx); close(done) }()
			for _, s := range tt.signals {
				switch s {
				case "up":
					c.connected()
				case "info":
					c.tunnelInfo()
				case "debug":
					c.debugInfo()
				}
			}
			if tt.want {
				eventually(t, "Confirm", func() bool { return calls.Load() > 0 })
			} else {
				time.Sleep(50 * time.Millisecond)
				if n := calls.Load(); n != 0 {
					t.Errorf("Confirm called %d times, want 0", n)
				}
			}
			cancel()
			<-done
		})
	}
}

func TestIdentityFailedRetries(t *testing.T) {
	h := newHarness(t)
	if err := (&ident.File{MachineID: machineA}).Save(h.l.IdentityFile); err != nil {
		t.Fatal(err)
	}
	h.src.set(ident.Raw{Serial: "not-a-serial"})
	h.start()
	h.waitReady()

	eventually(t, "identity failed in status.json", func() bool {
		s, ok := h.tryStatus()
		return ok && s.Identity.State == "failed" && phaseState(s, "identity") == "failed"
	})
	time.Sleep(100 * time.Millisecond) // several retry periods
	if n := h.dialer.count(); n != 0 {
		t.Fatalf("dial attempts with a failed identity = %d, want 0", n)
	}

	h.src.set(rawFor(machineA))
	eventually(t, "a dial attempt after the identity became valid", func() bool { return h.dialer.count() > 0 })
	eventually(t, "identity ready in status.json", func() bool {
		s, ok := h.tryStatus()
		return ok && s.Identity.State == "ready" && phaseState(s, "identity") == "ready" && s.Identity.MachineID == machineA
	})
	h.stop()
}

func TestAgentStartedReason(t *testing.T) {
	h := newHarness(t)
	runOnce := func() string {
		t.Helper()
		h.start()
		h.waitReady()
		h.stop()
		evs := h.journal()
		for i := len(evs) - 1; i >= 0; i-- {
			if evs[i].GetType() == events.TypeAgentStarted {
				var p agentv1.AgentStarted
				if err := evs[i].GetPayload().UnmarshalTo(&p); err != nil {
					t.Fatal(err)
				}
				if p.GetVersion() != "1.2.3" || p.GetBootId() != h.bootID {
					t.Errorf("agent.started = %v, want version 1.2.3 boot %s", &p, h.bootID)
				}
				return p.GetReason()
			}
		}
		t.Fatal("no agent.started event")
		return ""
	}

	if got := runOnce(); got != reasonBoot {
		t.Errorf("first start: reason %q, want %q", got, reasonBoot)
	}
	if got := runOnce(); got != reasonRestart {
		t.Errorf("same boot: reason %q, want %q", got, reasonRestart)
	}
	h.bootID = bootTwo
	if got := runOnce(); got != reasonBoot {
		t.Errorf("new boot: reason %q, want %q", got, reasonBoot)
	}

	p := update.Pending{From: "1.2.2", To: "1.2.3", Deadline: time.Now().Add(time.Minute)}
	if err := fsutil.WriteJSONAtomic(h.l.PendingUpdateFile, p, 0o644); err != nil {
		t.Fatal(err)
	}
	if got := runOnce(); got != reasonUpdate {
		t.Errorf("pending update of this version: reason %q, want %q", got, reasonUpdate)
	}
	_ = os.Remove(h.l.PendingUpdateFile)

	rr := map[string]string{"from": "1.2.4", "to": "1.2.3", "error": "not connected"}
	if err := fsutil.WriteJSONAtomic(filepath.Join(h.l.StateDir, "rollback-result.json"), rr, 0o644); err != nil {
		t.Fatal(err)
	}
	if got := runOnce(); got != reasonRollback {
		t.Errorf("after a rollback: reason %q, want %q", got, reasonRollback)
	}
}

func TestStatusFileHasNoSecrets(t *testing.T) {
	h := newHarness(t)
	h.start()
	h.waitReady()
	var raw []byte
	eventually(t, "status.json with a ready identity", func() bool {
		s, ok := h.tryStatus()
		if !ok || s.Identity.State != "ready" || s.Tunnel.LastError == "" {
			return false
		}
		raw, _ = os.ReadFile(h.l.StatusFile)
		return true
	})
	h.stop()

	for name, enc := range map[string][]byte{
		"raw":       testBS,
		"base64url": []byte(base64.RawURLEncoding.EncodeToString(testBS)),
		"base64":    []byte(base64.StdEncoding.EncodeToString(testBS)),
		"hex":       []byte(hex.EncodeToString(testBS)),
	} {
		if bytes.Contains(raw, enc) {
			t.Errorf("status.json contains the boot secret (%s)", name)
		}
	}
	var m map[string]any
	if err := json.Unmarshal(raw, &m); err != nil {
		t.Fatal(err)
	}
	for _, k := range []string{"version", "pid", "tunnel", "identity", "readiness", "quiesce", "update", "log_dropped", "updated_at"} {
		if _, ok := m[k]; !ok {
			t.Errorf("status.json has no %q: %s", k, raw)
		}
	}
	tun, _ := m["tunnel"].(map[string]any)
	for _, k := range []string{"connected", "gateway", "conn_id", "epoch", "last_error", "since"} {
		if _, ok := tun[k]; !ok {
			t.Errorf("status.json tunnel has no %q: %s", k, raw)
		}
	}
	if le, _ := tun["last_error"].(string); le == "" {
		t.Errorf("tunnel.last_error is empty after failed dials: %s", raw)
	}
}

func TestDebugListenConfirmsUpdate(t *testing.T) {
	h := newHarness(t)
	dir, err := os.MkdirTemp("", "sbxdbg")
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = os.RemoveAll(dir) })
	sock := filepath.Join(dir, "a.sock")
	h.seedIdentity(machineA)
	p := update.Pending{From: "1.2.2", To: "1.2.3", Deadline: time.Now().Add(time.Minute)}
	if err := fsutil.WriteJSONAtomic(h.l.PendingUpdateFile, p, 0o644); err != nil {
		t.Fatal(err)
	}
	h.debugListen, h.debugConfirm = "unix:"+sock, true
	h.start()
	h.waitReady()

	fi, err := os.Stat(sock)
	if err != nil {
		t.Fatal(err)
	}
	if fi.Mode().Perm() != 0o600 {
		t.Errorf("socket mode = %v, want 0600", fi.Mode().Perm())
	}
	hc := &http.Client{Transport: &http.Transport{
		DialContext: func(ctx context.Context, _, _ string) (net.Conn, error) {
			var d net.Dialer
			return d.DialContext(ctx, "unix", sock)
		},
	}}
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()

	sys := agentv1connect.NewSystemClient(hc, "http://agent")
	info, err := sys.Info(ctx, connect.NewRequest(&agentv1.InfoRequest{}))
	if err != nil {
		t.Fatalf("System/Info over the debug socket: %v", err)
	}
	if info.Msg.GetVersion() != "1.2.3" || info.Msg.GetMachineId() != machineA {
		t.Errorf("System/Info = %v", info.Msg)
	}
	if _, err := os.Stat(h.l.PendingUpdateFile); err != nil {
		t.Fatalf("update confirmed before Control/Info: %v", err)
	}

	ctl := tunnelv1connect.NewControlClient(hc, "http://agent")
	res, err := ctl.Info(ctx, connect.NewRequest(&tunnelv1.InfoRequest{}))
	if err != nil {
		t.Fatalf("Control/Info over the debug socket: %v", err)
	}
	if !slices.Contains(res.Msg.GetCapabilities(), "system.activity.v1") || !slices.Contains(res.Msg.GetProtoPackages(), "sbx.agent.v1") {
		t.Errorf("Control/Info = %v", res.Msg)
	}
	eventually(t, "the pending update to be confirmed", func() bool {
		_, err := os.Stat(h.l.PendingUpdateFile)
		return os.IsNotExist(err)
	})
	h.stop()
	if _, err := os.Stat(sock); !os.IsNotExist(err) {
		t.Errorf("debug socket left after shutdown: %v", err)
	}
	var results []string
	for _, e := range h.journal() {
		if e.GetType() == events.TypeUpdateResult {
			var r agentv1.UpdateResult
			if err := e.GetPayload().UnmarshalTo(&r); err != nil {
				t.Fatal(err)
			}
			if r.GetOk() {
				results = append(results, "ok")
			}
		}
	}
	if len(results) != 1 {
		t.Errorf("update.result{ok} events = %d, want 1", len(results))
	}
}

func TestDebugInfoAloneDoesNotConfirm(t *testing.T) {
	h := newHarness(t)
	dir, err := os.MkdirTemp("", "sbxdbg")
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = os.RemoveAll(dir) })
	sock := filepath.Join(dir, "a.sock")
	h.seedIdentity(machineA)
	p := update.Pending{From: "1.2.2", To: "1.2.3", Deadline: time.Now().Add(time.Minute)}
	if err := fsutil.WriteJSONAtomic(h.l.PendingUpdateFile, p, 0o644); err != nil {
		t.Fatal(err)
	}
	h.debugListen = "unix:" + sock // without --debug-confirm
	h.start()
	h.waitReady()
	hc := &http.Client{Transport: &http.Transport{
		DialContext: func(ctx context.Context, _, _ string) (net.Conn, error) {
			var d net.Dialer
			return d.DialContext(ctx, "unix", sock)
		},
	}}
	ctl := tunnelv1connect.NewControlClient(hc, "http://agent")
	if _, err := ctl.Info(context.Background(), connect.NewRequest(&tunnelv1.InfoRequest{})); err != nil {
		t.Fatal(err)
	}
	time.Sleep(100 * time.Millisecond)
	if _, err := os.Stat(h.l.PendingUpdateFile); err != nil {
		t.Errorf("update confirmed without a tunnel and without --debug-confirm: %v", err)
	}
	h.stop()
}

// readStatus returns status.json, waiting for it to appear.
func (h *harness) readStatus() Status {
	h.t.Helper()
	var s Status
	eventually(h.t, "status.json", func() bool {
		var ok bool
		s, ok = h.tryStatus()
		return ok
	})
	return s
}

// tryStatus reads status.json if it exists.
func (h *harness) tryStatus() (Status, bool) {
	var s Status
	b, err := os.ReadFile(h.l.StatusFile)
	if err != nil || json.Unmarshal(b, &s) != nil {
		return Status{}, false
	}
	return s, true
}

// phaseState returns the state of phase name in s.
func phaseState(s Status, name string) string {
	for _, p := range s.Readiness.Phases {
		if p.Name == name {
			return p.State
		}
	}
	return ""
}

func TestStartupErrorFailsRun(t *testing.T) {
	h := newHarness(t)
	deps := h.buildDeps()
	deps.MountSecrets = func(string) error { return errors.New("test: mount refused") }
	err := Run(context.Background(), h.l, h.cfg, "1.2.3", deps)
	if err == nil || !strings.Contains(err.Error(), "mount refused") {
		t.Fatalf("Run = %v, want the mount error", err)
	}
	// The store was closed: it opens again.
	st, err := store.Open(h.l.StateDB, store.Options{})
	if err != nil {
		t.Fatalf("state.db still locked after a failed start: %v", err)
	}
	_ = st.Close()
}

// nopFreezer reports one freezable mount and freezes nothing.
type nopFreezer struct{}

func (nopFreezer) Mounts() ([]quiesce.Mount, error) {
	return []quiesce.Mount{{Path: "/", Source: "/dev/test", FSType: "ext4"}}, nil
}
func (nopFreezer) Freeze(string) error { return nil }
func (nopFreezer) Thaw(string) error   { return nil }

func TestShutdownFlushesBufferedOutcome(t *testing.T) {
	h := newHarness(t)
	h.seedIdentity(machineA)
	dir, err := os.MkdirTemp("", "sbxdbg")
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = os.RemoveAll(dir) })
	sock := filepath.Join(dir, "a.sock")
	h.debugListen = "unix:" + sock
	h.freezer = nopFreezer{}
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
	// The Quiesce outcome is produced while the store is frozen, so the
	// request cache buffers it in memory.
	qreq := connect.NewRequest(&agentv1.QuiesceRequest{})
	qreq.Header().Set(wire.HeaderRequestID, reqQuiesce)
	q, err := sys.Quiesce(ctx, qreq)
	if err != nil {
		t.Fatalf("Quiesce: %v", err)
	}
	treq := connect.NewRequest(&agentv1.ThawRequest{LeaseId: q.Msg.GetLeaseId()})
	treq.Header().Set(wire.HeaderRequestID, "0192f1a4-7c3e-7b2a-9d4f-000000000002")
	if _, err := sys.Thaw(ctx, treq); err != nil {
		t.Fatalf("Thaw: %v", err)
	}
	// Shut down right after the thaw: the buffered outcome must be durable.
	h.stop()

	st, err := store.Open(h.l.StateDB, store.Options{})
	if err != nil {
		t.Fatal(err)
	}
	defer func() { _ = st.Close() }()
	rec, ok, err := st.GetRequest(reqQuiesce)
	if err != nil || !ok {
		t.Fatalf("Quiesce outcome after shutdown: %v, found %v", err, ok)
	}
	if rec.Procedure != agentv1connect.SystemQuiesceProcedure {
		t.Errorf("stored procedure = %q", rec.Procedure)
	}
}

// TestShutdownThawsActiveLease: an agent stopped (reboot, poweroff) during
// a lease thaws the guest before it exits and reports quiesce.auto_thawed.
func TestShutdownThawsActiveLease(t *testing.T) {
	h := newHarness(t)
	h.seedIdentity(machineA)
	dir, err := os.MkdirTemp("", "sbxdbg")
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = os.RemoveAll(dir) })
	sock := filepath.Join(dir, "a.sock")
	h.debugListen = "unix:" + sock
	fz := &recFreezer{frozen: map[string]bool{}}
	h.freezer = fz
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
	qreq := connect.NewRequest(&agentv1.QuiesceRequest{})
	qreq.Header().Set(wire.HeaderRequestID, "0192f1a4-7c3e-7b2a-9d4f-000000000003")
	if _, err := sys.Quiesce(ctx, qreq); err != nil {
		t.Fatalf("Quiesce: %v", err)
	}
	if !fz.isFrozen("/") {
		t.Fatal("not frozen")
	}
	h.stop()
	if fz.isFrozen("/") {
		t.Error("still frozen after the shutdown")
	}
	if _, err := os.Stat(h.l.QuiesceFile); !errors.Is(err, os.ErrNotExist) {
		t.Errorf("lease file after the shutdown: %v", err)
	}
	if !slices.Contains(types(h.journal()), events.TypeQuiesceAutoThawed) {
		t.Error("no quiesce.auto_thawed in the journal")
	}
}

// The state and run directories are root 0700 (spec 4).
func TestStateDirsMode(t *testing.T) {
	h := newHarness(t)
	h.start()
	h.waitReady()
	h.stop()
	for _, dir := range []string{h.l.StateDir, h.l.RunDir} {
		fi, err := os.Stat(dir)
		if err != nil {
			t.Fatal(err)
		}
		if m := fi.Mode().Perm(); m != 0o700 {
			t.Errorf("%s mode = %o, want 700", dir, m)
		}
	}
}

// recFreezer reports one freezable mount and records its state.
type recFreezer struct {
	mu     sync.Mutex
	frozen map[string]bool
}

func (*recFreezer) Mounts() ([]quiesce.Mount, error) {
	return []quiesce.Mount{{Path: "/", Source: "/dev/test", FSType: "ext4"}}, nil
}

func (f *recFreezer) Freeze(p string) error {
	f.mu.Lock()
	defer f.mu.Unlock()
	f.frozen[p] = true
	return nil
}

func (f *recFreezer) Thaw(p string) error {
	f.mu.Lock()
	defer f.mu.Unlock()
	delete(f.frozen, p)
	return nil
}

func (f *recFreezer) isFrozen(p string) bool {
	f.mu.Lock()
	defer f.mu.Unlock()
	return f.frozen[p]
}

// reqQuiesce is the request id of the Quiesce call in
// TestShutdownFlushesBufferedOutcome.
const reqQuiesce = "0192f1a4-7c3e-7b2a-9d4f-000000000001"

func TestDebugEventsSubscribe(t *testing.T) {
	h := newHarness(t)
	h.seedIdentity(machineA)
	dir, err := os.MkdirTemp("", "sbxdbg")
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = os.RemoveAll(dir) })
	sock := filepath.Join(dir, "a.sock")
	h.debugListen = "unix:" + sock
	h.start()
	h.waitReady()

	hc := &http.Client{Transport: &http.Transport{
		DialContext: func(ctx context.Context, _, _ string) (net.Conn, error) {
			var d net.Dialer
			return d.DialContext(ctx, "unix", sock)
		},
	}}
	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()
	ev := tunnelv1connect.NewEventsClient(hc, "http://agent")
	stream, err := ev.Subscribe(ctx, connect.NewRequest(&tunnelv1.SubscribeRequest{AfterSeq: proto.Uint64(0)}))
	if err != nil {
		t.Fatalf("Events/Subscribe over the debug socket: %v", err)
	}
	var types []string
	for stream.Receive() {
		e := stream.Msg().GetEvent()
		if e == nil {
			continue
		}
		types = append(types, e.GetType())
		if e.GetType() == events.TypeAgentStarted {
			break
		}
	}
	_ = stream.Close()
	if !slices.Contains(types, events.TypeAgentStarted) {
		t.Fatalf("events = %v (%v), want agent.started", types, stream.Err())
	}
	// Ack is not served: the debug socket must not drop the gateway's events.
	if _, err := ev.Ack(ctx, connect.NewRequest(&tunnelv1.AckRequest{Seq: 1})); connect.CodeOf(err) != connect.CodeUnimplemented {
		t.Errorf("Events/Ack over the debug socket = %v, want unimplemented", err)
	}
}
