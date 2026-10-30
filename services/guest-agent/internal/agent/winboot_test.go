package agent

import (
	"context"
	"encoding/json"
	"errors"
	"net"
	"net/http"
	"os"
	"os/user"
	"path/filepath"
	"slices"
	"strings"
	"sync/atomic"
	"testing"
	"time"

	"connectrpc.com/connect"
	"github.com/google/uuid"

	agentv1 "github.com/belov38/boat-dev-clone/libs/proto/sbx/agent/v1"
	"github.com/belov38/boat-dev-clone/libs/proto/sbx/agent/v1/agentv1connect"
	"github.com/belov38/boat-dev-clone/libs/tunnel/rpcconv"
	"github.com/belov38/boat-dev-clone/libs/tunnel/wire"

	"github.com/belov38/boat-dev-clone/services/guest-agent/internal/errs"
	"github.com/belov38/boat-dev-clone/services/guest-agent/internal/events"
	"github.com/belov38/boat-dev-clone/services/guest-agent/internal/fsutil"
	"github.com/belov38/boat-dev-clone/services/guest-agent/internal/ident"
	"github.com/belov38/boat-dev-clone/services/guest-agent/internal/readiness"
)

// winHarness is a harness with the Windows start: early.json and the local
// sockets in the layout, a FakeWinResetter whose computer name is in effect,
// a source with this boot's id and a StartSSH that counts its calls.
type winHarness struct {
	*harness
	r        *ident.FakeWinResetter
	sshCalls atomic.Int32
	setup    atomic.Bool // Windows Setup in progress
}

func newWinHarness(t *testing.T) *winHarness {
	t.Helper()
	h := &winHarness{harness: newHarness(t)}
	h.l.EarlyFile = filepath.Join(h.l.RunDir, "early.json")
	// macOS limits socket paths to 104 bytes: keep them out of TempDir.
	dir, err := os.MkdirTemp("", "sbxw")
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = os.RemoveAll(dir) })
	h.l.AdminSocket = filepath.Join(dir, "admin.sock")
	h.l.EnvSocket = filepath.Join(dir, "env.sock")
	raw := rawFor(machineA)
	raw.BootID = bootOne
	h.src.set(raw)
	h.r = &ident.FakeWinResetter{Active: ident.WindowsComputerName(machineA)}
	h.winBoot = &WinBoot{
		Resetter:        h.r,
		SetupInProgress: h.setup.Load,
		StartSSH: func(context.Context) error {
			h.sshCalls.Add(1)
			return nil
		},
		SetupPoll:  10 * time.Millisecond,
		EarlyWait:  50 * time.Millisecond,
		EarlyPoll:  10 * time.Millisecond,
		RebootWait: 50 * time.Millisecond,
	}
	return h
}

func (h *winHarness) writeEarly(bootID string) {
	h.t.Helper()
	if err := os.MkdirAll(h.l.RunDir, 0o755); err != nil {
		h.t.Fatal(err)
	}
	if err := fsutil.WriteJSONAtomic(h.l.EarlyFile, ident.EarlyMarker{BootID: bootID}, 0o644); err != nil {
		h.t.Fatal(err)
	}
}

func (h *winHarness) calls(name string) int {
	n := 0
	for _, c := range h.r.Calls {
		if m, _, _ := strings.Cut(c, " "); m == name {
			n++
		}
	}
	return n
}

// unixHTTP returns an HTTP client that dials the unix socket sock.
func unixHTTP(sock string) *http.Client {
	return &http.Client{Transport: &http.Transport{
		DialContext: func(ctx context.Context, _, _ string) (net.Conn, error) {
			var d net.Dialer
			return d.DialContext(ctx, "unix", sock)
		},
	}}
}

func TestWinBootWaitsForSetup(t *testing.T) {
	h := newWinHarness(t)
	h.seedIdentity(machineA)
	h.writeEarly(bootOne)
	h.setup.Store(true)
	h.start()
	time.Sleep(150 * time.Millisecond)
	select {
	case <-h.notify.ready:
		t.Fatal("READY=1 while windows setup is in progress")
	default:
	}
	if _, err := os.Stat(h.l.StateDB); !os.IsNotExist(err) {
		t.Errorf("state.db touched while windows setup is in progress: %v", err)
	}
	h.setup.Store(false)
	h.waitReady()
	h.stop()
}

func TestWinBootUsesScriptMarker(t *testing.T) {
	h := newWinHarness(t)
	h.seedIdentity(machineA)
	h.writeEarly(bootOne)
	h.winBoot.EarlyWait = time.Minute
	start := time.Now()
	h.start()
	h.waitReady()
	if d := time.Since(start); d > 5*time.Second {
		t.Errorf("READY after %v with early.json of this boot present", d)
	}
	if n := h.calls("WipeSecrets"); n != 0 {
		t.Errorf("the service ran the boot step although the script did: %v", h.r.Calls)
	}
	eventually(t, "sshd start", func() bool { return h.sshCalls.Load() == 1 })
	h.stop()
}

func TestWinBootRunsEarlyInService(t *testing.T) {
	for _, tt := range []struct {
		name  string
		early string // early.json bootId, "-" for none
	}{
		{"no marker", "-"},
		{"marker of another boot", bootTwo},
		{"marker without boot id", ""},
	} {
		t.Run(tt.name, func(t *testing.T) {
			h := newWinHarness(t)
			if tt.early != "-" {
				h.writeEarly(tt.early)
			}
			h.start()
			h.waitReady()
			if !ident.EarlyDoneForBoot(h.l.EarlyFile, bootOne) {
				t.Error("early.json of this boot not written by the service")
			}
			if h.calls("WipeSecrets") == 0 || h.calls("SetMachineGUID") != 1 {
				t.Errorf("calls = %v, want the identity applied and the secrets wiped", h.r.Calls)
			}
			if h.calls("Reboot") != 0 {
				t.Errorf("rebooted: %v", h.r.Calls)
			}
			eventually(t, "sshd start", func() bool { return h.sshCalls.Load() == 1 })
			h.stop()
			if ty := types(h.journal()); len(ty) == 0 || ty[0] != events.TypeIdentityReset {
				t.Errorf("journal = %v, want identity.reset first", ty)
			}
		})
	}
}

func TestWinBootRebootPendingGates(t *testing.T) {
	h := newWinHarness(t)
	h.r.Active = "WIN-TEMPLATE" // the new name needs a reboot
	h.identityRetry = time.Minute
	h.start()
	h.waitReady()
	if h.calls("Reboot") != 1 {
		t.Fatalf("calls = %v, want one reboot", h.r.Calls)
	}
	if h.sshCalls.Load() != 0 {
		t.Error("sshd started without identity")
	}

	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	admin := unixHTTP(h.l.AdminSocket)
	info, err := agentv1connect.NewSystemClient(admin, "http://agent").Info(ctx, connect.NewRequest(&agentv1.InfoRequest{}))
	if err != nil {
		t.Fatal(err)
	}
	for _, p := range info.Msg.GetReadiness() {
		if p.GetName() == readiness.PhaseIdentity && p.GetState() == agentv1.PhaseState_PHASE_STATE_READY {
			t.Error("identity ready while the boot step waits for a reboot")
		}
	}
	// The admin socket starts commands of SYSTEM (root) anyway, not those
	// of another user.
	proc := agentv1connect.NewProcessClient(admin, "http://agent")
	start := &agentv1.StartRequest{CommandId: "admin-1", Spec: &agentv1.CommandSpec{User: "root", Cmd: &agentv1.CommandSpec_Argv{Argv: &agentv1.Argv{Args: []string{"true"}}}}}
	if _, err := proc.Start(ctx, connect.NewRequest(start)); err != nil {
		t.Errorf("Process/Start as root over the admin socket: %v", err)
	}
	start = &agentv1.StartRequest{CommandId: "admin-2", Spec: &agentv1.CommandSpec{User: currentUser(t), Cmd: &agentv1.CommandSpec_Argv{Argv: &agentv1.Argv{Args: []string{"true"}}}}}
	if _, err := proc.Start(ctx, connect.NewRequest(start)); detail(err) != errs.IdentityNotReady {
		t.Errorf("Process/Start as a user over the admin socket = %v, want identity_not_ready", err)
	}
	creq := connect.NewRequest(&agentv1.ClaimRequest{SandboxId: "sbx_1", Hostname: "box"})
	creq.Header().Set(wire.HeaderRequestID, uuid.NewString())
	if _, err := agentv1connect.NewSystemClient(admin, "http://agent").Claim(ctx, creq); detail(err) != errs.IdentityNotReady {
		t.Errorf("Claim = %v, want identity_not_ready", err)
	}
	ureq := connect.NewRequest(&agentv1.UpdateSecretsRequest{})
	ureq.Header().Set(wire.HeaderRequestID, uuid.NewString())
	if _, err := agentv1connect.NewSystemClient(admin, "http://agent").UpdateSecrets(ctx, ureq); detail(err) != errs.IdentityNotReady {
		t.Errorf("UpdateSecrets = %v, want identity_not_ready", err)
	}
	h.stop()
}

func TestWinBootGateRefusesStartOutsideAdmin(t *testing.T) {
	h := newWinHarness(t)
	h.r.Active = "WIN-TEMPLATE"
	h.identityRetry = time.Minute
	dir, err := os.MkdirTemp("", "sbxd")
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = os.RemoveAll(dir) })
	h.debugListen = "unix:" + filepath.Join(dir, "d.sock")
	h.start()
	h.waitReady()
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	start := &agentv1.StartRequest{CommandId: "dbg-1", Spec: &agentv1.CommandSpec{User: currentUser(t), Cmd: &agentv1.CommandSpec_Argv{Argv: &agentv1.Argv{Args: []string{"true"}}}}}
	_, err = agentv1connect.NewProcessClient(unixHTTP(filepath.Join(dir, "d.sock")), "http://agent").Start(ctx, connect.NewRequest(start))
	if detail(err) != errs.IdentityNotReady {
		t.Errorf("Process/Start outside the admin socket = %v, want identity_not_ready", err)
	}
	h.stop()
}

func TestWinBootFailureRestartsToRepeat(t *testing.T) {
	h := newWinHarness(t)
	h.r.Errs = map[string]error{"SetMachineGUID": errors.New("registry denied")}
	h.start()
	h.waitReady()
	// IdentityRetry is 20 ms in the harness: the agent exits to repeat
	// the boot step.
	select {
	case err := <-h.done:
		if err != nil {
			t.Fatalf("Run = %v, want a graceful exit", err)
		}
		h.done = nil
	case <-time.After(10 * time.Second):
		t.Fatal("the agent did not exit to repeat the failed boot step")
	}
	if ident.EarlyDoneForBoot(h.l.EarlyFile, bootOne) {
		t.Error("early.json written although the boot step failed")
	}
}

func TestEnvSocketServesSessionEnv(t *testing.T) {
	h := newWinHarness(t)
	h.seedIdentity(machineA)
	h.writeEarly(bootOne)
	h.start()
	h.waitReady()
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	req := &agentv1.ClaimRequest{SandboxId: "sbx_1", Hostname: "box", Env: map[string]string{"FOO": "bar"}, SecretEnv: map[string]string{"TOKEN": "s3"}}
	creq := connect.NewRequest(req)
	creq.Header().Set(wire.HeaderRequestID, uuid.NewString())
	if _, err := agentv1connect.NewSystemClient(unixHTTP(h.l.AdminSocket), "http://agent").Claim(ctx, creq); err != nil {
		t.Fatal(err)
	}
	r, err := http.NewRequestWithContext(ctx, http.MethodGet, "http://agent"+EnvPath, nil)
	if err != nil {
		t.Fatal(err)
	}
	res, err := unixHTTP(h.l.EnvSocket).Do(r)
	if err != nil {
		t.Fatal(err)
	}
	defer func() { _ = res.Body.Close() }()
	var env EnvResponse
	if err := decodeJSON(res, &env); err != nil {
		t.Fatal(err)
	}
	for _, want := range []string{"SBX_SANDBOX_ID=sbx_1", "FOO=bar", "TOKEN=s3", "SBX_ENV_APPLIED=1"} {
		if !slices.Contains(env.Env, want) {
			t.Errorf("env %q has no %q", env.Env, want)
		}
	}
	if fi, err := os.Stat(h.l.EnvSocket); err != nil || fi.Mode().Perm() != 0o600 {
		t.Errorf("env socket: %v %v", fi, err)
	}
	h.stop()
	for _, p := range []string{h.l.AdminSocket, h.l.EnvSocket} {
		if _, err := os.Stat(p); !os.IsNotExist(err) {
			t.Errorf("%s left after shutdown: %v", p, err)
		}
	}
}

// detail returns the ErrorDetail code of err, or "".
func detail(err error) string {
	if d, ok := rpcconv.Detail(err); ok {
		return d.GetCode()
	}
	return ""
}

func decodeJSON(res *http.Response, v any) error {
	if res.StatusCode != http.StatusOK {
		return errors.New(res.Status)
	}
	return json.NewDecoder(res.Body).Decode(v)
}

// currentUser is the name of the user running the test (process.LookupUser
// resolves it).
func currentUser(t *testing.T) string {
	t.Helper()
	u, err := user.Current()
	if err != nil {
		t.Fatal(err)
	}
	return u.Username
}

// TestWinBootRunsEarlyRightAfterSetup: on the first boot of a clone the
// startup script ran during Windows Setup (and skipped); the service runs
// the boot step as soon as Setup completes, without the early.json wait.
func TestWinBootRunsEarlyRightAfterSetup(t *testing.T) {
	h := newWinHarness(t)
	h.winBoot.EarlyWait = time.Minute
	h.setup.Store(true)
	h.start()
	time.Sleep(50 * time.Millisecond)
	h.setup.Store(false)
	start := time.Now()
	h.waitReady()
	if d := time.Since(start); d > 5*time.Second {
		t.Errorf("READY %v after Windows Setup ended", d)
	}
	if !ident.EarlyDoneForBoot(h.l.EarlyFile, bootOne) {
		t.Error("the service did not run the boot step after Windows Setup")
	}
	h.stop()
}
