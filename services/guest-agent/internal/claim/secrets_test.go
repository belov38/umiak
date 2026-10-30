package claim

import (
	"errors"
	"fmt"
	"io/fs"
	"os"
	"path/filepath"
	"runtime"
	"slices"
	"strings"
	"sync/atomic"
	"testing"
	"time"

	"connectrpc.com/connect"
	"google.golang.org/protobuf/proto"

	agentv1 "github.com/belov38/boat-dev-clone/libs/proto/sbx/agent/v1"

	"github.com/belov38/boat-dev-clone/services/guest-agent/internal/errs"
	"github.com/belov38/boat-dev-clone/services/guest-agent/internal/paths"
	"github.com/belov38/boat-dev-clone/services/guest-agent/internal/readiness"
	"github.com/belov38/boat-dev-clone/services/guest-agent/internal/store"
)

// twoFiles is fullRequest with a second secret file without a link.
func twoFiles() *agentv1.ClaimRequest {
	req := fullRequest()
	req.SecretFiles = append(req.SecretFiles, &agentv1.SecretFile{Name: "token", Content: []byte("tok-" + secretFileValue), Mode: 0o600})
	return req
}

func TestStartWaitsForPendingSecrets(t *testing.T) {
	timer := make(chan time.Time, 1)
	var asked atomic.Int64
	h := newHarnessWith(t, func(o *Options) {
		o.PendingSecretsWait = 30 * time.Second
		o.After = func(d time.Duration) <-chan time.Time {
			asked.Store(int64(d))
			return timer
		}
	})
	ctx := t.Context()
	if err := h.m.WaitSecrets(ctx); err != nil {
		t.Fatalf("WaitSecrets before the claim: %v", err)
	}
	if _, err := h.m.Claim(ctx, fullRequest()); err != nil {
		t.Fatal(err)
	}
	if err := h.m.WaitSecrets(ctx); err != nil {
		t.Fatalf("WaitSecrets with ready secrets: %v", err)
	}
	if asked.Load() != 0 {
		t.Fatal("a timer was started while the secrets were ready")
	}

	// Reboot: the secrets are pending until UpdateSecrets.
	if err := os.RemoveAll(h.l.SecretsMount); err != nil {
		t.Fatal(err)
	}
	m := h.newManager()
	done := make(chan error, 1)
	go func() { done <- m.WaitSecrets(ctx) }()
	time.Sleep(100 * time.Millisecond)
	select {
	case err := <-done:
		t.Fatalf("WaitSecrets returned before UpdateSecrets: %v", err)
	default:
	}
	req := fullRequest()
	if _, err := m.UpdateSecrets(ctx, &agentv1.UpdateSecretsRequest{SecretEnv: req.SecretEnv, SecretFiles: req.SecretFiles}); err != nil {
		t.Fatal(err)
	}
	select {
	case err := <-done:
		if err != nil {
			t.Fatalf("WaitSecrets after UpdateSecrets: %v", err)
		}
	case <-time.After(5 * time.Second):
		t.Fatal("WaitSecrets did not return after UpdateSecrets")
	}
	if got := time.Duration(asked.Load()); got != 30*time.Second {
		t.Errorf("wait = %v, want 30s", got)
	}

	// No UpdateSecrets within the wait.
	if _, err := m.PrepareStop(ctx); err != nil {
		t.Fatal(err)
	}
	go func() { done <- m.WaitSecrets(ctx) }()
	timer <- time.Time{}
	select {
	case err := <-done:
		wantDetail(t, err, connect.CodeUnavailable, errs.SecretsPending)
	case <-time.After(5 * time.Second):
		t.Fatal("WaitSecrets did not return when the wait ran out")
	}
}

func TestWaitSecretsDisabledByDefault(t *testing.T) {
	h := newHarness(t)
	ctx := t.Context()
	if _, err := h.m.Claim(ctx, fullRequest()); err != nil {
		t.Fatal(err)
	}
	if _, err := h.m.PrepareStop(ctx); err != nil {
		t.Fatal(err)
	}
	if st, _ := h.tr.State(readiness.PhaseSecrets); st != pending {
		t.Fatalf("secrets phase = %v, want pending", st)
	}
	if err := h.m.WaitSecrets(ctx); err != nil {
		t.Fatalf("WaitSecrets without PendingSecretsWait = %v, want nil", err)
	}
}

func TestSecretEnvNotPersistedWhenDisabled(t *testing.T) {
	h := newHarnessWith(t, func(o *Options) { o.SecretEnvInMemory = true })
	ctx := t.Context()
	if _, err := os.Lstat(h.l.SecretsEnvFile); !errors.Is(err, fs.ErrNotExist) {
		t.Errorf("secrets/env created at Start (%v)", err)
	}
	if _, err := h.m.Claim(ctx, fullRequest()); err != nil {
		t.Fatal(err)
	}
	if _, err := os.Lstat(h.l.SecretsEnvFile); !errors.Is(err, fs.ErrNotExist) {
		t.Errorf("secrets/env written by the claim (%v)", err)
	}
	state := h.read(h.l.SecretsStateFile)
	if strings.Contains(state, secretEnvValue) || strings.Contains(state, `"env"`) {
		t.Errorf("secrets state holds the env: %s", state)
	}
	if !strings.Contains(state, "key.pem") {
		t.Errorf("secrets state lacks the file metas: %s", state)
	}
	if env := h.m.EnvBuilder().Build(testUser(), &agentv1.CommandSpec{}); !slices.Contains(env, "TOKEN="+secretEnvValue) {
		t.Errorf("secret env not served from memory: %v", env)
	}

	// Agent restart without a reboot: the files are intact, the env is gone.
	m2 := h.newManager()
	if st, _ := h.tr.State(readiness.PhaseSecrets); st != pending {
		t.Fatalf("secrets after restart = %v, want pending", st)
	}
	if env := m2.EnvBuilder().Build(testUser(), &agentv1.CommandSpec{}); slices.Contains(env, "TOKEN="+secretEnvValue) {
		t.Error("secret env present after restart")
	}
	req := fullRequest()
	if _, err := m2.UpdateSecrets(ctx, &agentv1.UpdateSecretsRequest{SecretEnv: req.SecretEnv, SecretFiles: req.SecretFiles}); err != nil {
		t.Fatal(err)
	}
	if st, _ := h.tr.State(readiness.PhaseSecrets); st != ready {
		t.Errorf("secrets after UpdateSecrets = %v", st)
	}

	// A failed update keeps the applied set: the files on disk and the env
	// in memory still match the digest.
	blocker, _ := h.l.Rooted("/blocker")
	mustWrite(t, blocker, "a file")
	_, err := m2.UpdateSecrets(ctx, &agentv1.UpdateSecretsRequest{
		SecretEnv:   req.SecretEnv,
		SecretFiles: []*agentv1.SecretFile{{Name: "other", Content: []byte("x"), LinkPath: "/blocker/x"}},
	})
	if err == nil {
		t.Fatal("UpdateSecrets succeeded with a blocked link_path")
	}
	if st, _ := h.tr.State(readiness.PhaseSecrets); st != pending {
		t.Errorf("secrets after a partial write = %v, want pending", st)
	}
}

func TestResyncKeepsMemoryEnv(t *testing.T) {
	h := newHarnessWith(t, func(o *Options) { o.SecretEnvInMemory = true })
	ctx := t.Context()
	if _, err := h.m.Claim(ctx, fullRequest()); err != nil {
		t.Fatal(err)
	}
	rec, _, err := h.st.GetClaim()
	if err != nil {
		t.Fatal(err)
	}
	// A failure after the secret files: resync finds the old set on disk.
	h.m.resyncSecrets(rec.SecretsDigest)
	if st, _ := h.tr.State(readiness.PhaseSecrets); st != ready {
		t.Errorf("secrets after resync = %v, want ready", st)
	}
	if env := h.m.EnvBuilder().Build(testUser(), &agentv1.CommandSpec{}); !slices.Contains(env, "TOKEN="+secretEnvValue) {
		t.Errorf("secret env dropped by resync: %v", env)
	}
}

func TestWipeAndRestoreSecretFiles(t *testing.T) {
	h := newHarness(t)
	ctx := t.Context()
	if _, err := h.m.Claim(ctx, twoFiles()); err != nil {
		t.Fatal(err)
	}
	wiped, err := h.m.WipeSecretFiles()
	if err != nil || !wiped {
		t.Fatalf("WipeSecretFiles = %v, %v; want true, nil", wiped, err)
	}
	if entries, _ := os.ReadDir(h.l.SecretFilesDir); len(entries) != 0 {
		t.Errorf("files/ after wipe = %v", entries)
	}
	// Only the files go: the phase and the env stay.
	if st, _ := h.tr.State(readiness.PhaseSecrets); st != ready {
		t.Errorf("secrets phase after wipe = %v", st)
	}
	if env := h.m.EnvBuilder().Build(testUser(), &agentv1.CommandSpec{}); !slices.Contains(env, "TOKEN="+secretEnvValue) {
		t.Error("secret env lost by WipeSecretFiles")
	}
	if err := h.m.RestoreSecretFiles(); err != nil {
		t.Fatal(err)
	}
	if got := h.read(filepath.Join(h.l.SecretFilesDir, "key.pem")); got != secretFileValue {
		t.Errorf("restored key.pem = %q", got)
	}
	if got := h.read(filepath.Join(h.l.SecretFilesDir, "token")); got != "tok-"+secretFileValue {
		t.Errorf("restored token = %q", got)
	}
	link, _ := h.l.Rooted("/home/user/.config/key.pem")
	if got := h.read(link); got != secretFileValue {
		t.Errorf("link_path after restore = %q", got)
	}
	// The restored set still matches the digest after an agent restart.
	h.newManager()
	if st, _ := h.tr.State(readiness.PhaseSecrets); st != ready {
		t.Errorf("secrets after restart = %v, want ready", st)
	}
}

func TestRestoreWithoutSecretsIsNoop(t *testing.T) {
	h := newHarness(t)
	if err := h.m.RestoreSecretFiles(); err != nil {
		t.Fatalf("RestoreSecretFiles before the claim: %v", err)
	}
	ctx := t.Context()
	if _, err := h.m.Claim(ctx, fullRequest()); err != nil {
		t.Fatal(err)
	}
	if _, err := h.m.PrepareStop(ctx); err != nil {
		t.Fatal(err)
	}
	if err := h.m.RestoreSecretFiles(); err != nil {
		t.Fatalf("RestoreSecretFiles while pending: %v", err)
	}
	if entries, _ := os.ReadDir(h.l.SecretFilesDir); len(entries) != 0 {
		t.Errorf("files restored after PrepareStop: %v", entries)
	}
}

// inUse makes the Manager's secret file removal fail for name as a file
// held open without sharing would on Windows.
func inUse(m *Manager, name string) {
	m.removeFile = func(p string) error {
		if filepath.Base(p) == name {
			return fmt.Errorf("wipe %s: %w", p, ErrSecretInUse)
		}
		return os.RemoveAll(p)
	}
}

func TestWipeSecretFilesInUse(t *testing.T) {
	h := newHarness(t)
	if _, err := h.m.Claim(t.Context(), twoFiles()); err != nil {
		t.Fatal(err)
	}
	inUse(h.m, "key.pem")
	wiped, err := h.m.WipeSecretFiles()
	if wiped || !errors.Is(err, ErrSecretInUse) {
		t.Fatalf("WipeSecretFiles = %v, %v; want false, ErrSecretInUse", wiped, err)
	}
	// The other files are wiped anyway.
	if _, err := os.Lstat(filepath.Join(h.l.SecretFilesDir, "token")); !errors.Is(err, fs.ErrNotExist) {
		t.Errorf("token not wiped (%v)", err)
	}
}

func TestPrepareStopInUseReportsNotWiped(t *testing.T) {
	h := newHarness(t)
	ctx := t.Context()
	if _, err := h.m.Claim(ctx, twoFiles()); err != nil {
		t.Fatal(err)
	}
	inUse(h.m, "key.pem")
	wiped, err := h.m.PrepareStop(ctx)
	if err != nil || wiped {
		t.Fatalf("PrepareStop = %v, %v; want false, nil", wiped, err)
	}
	if _, err := os.Lstat(filepath.Join(h.l.SecretFilesDir, "token")); !errors.Is(err, fs.ErrNotExist) {
		t.Errorf("token not wiped (%v)", err)
	}
	if _, err := os.Stat(h.l.SecretsStateFile); !errors.Is(err, fs.ErrNotExist) {
		t.Errorf("secrets state file present (%v)", err)
	}
	if st, _ := h.tr.State(readiness.PhaseSecrets); st != pending {
		t.Errorf("secrets phase = %v, want pending", st)
	}
	// Once the file is released, a repeat wipes it.
	h.m.removeFile = removeSecretFile
	if wiped, err := h.m.PrepareStop(ctx); err != nil || !wiped {
		t.Fatalf("repeated PrepareStop = %v, %v; want true, nil", wiped, err)
	}
}

func TestWipeSecretsDir(t *testing.T) {
	h := newHarness(t)
	if _, err := h.m.Claim(t.Context(), twoFiles()); err != nil {
		t.Fatal(err)
	}
	if err := WipeSecretsDir(h.l); err != nil {
		t.Fatal(err)
	}
	if entries, _ := os.ReadDir(h.l.SecretFilesDir); len(entries) != 0 {
		t.Errorf("files/ = %v", entries)
	}
	for _, p := range []string{h.l.SecretsStateFile, h.l.SecretsEnvFile} {
		if _, err := os.Lstat(p); !errors.Is(err, fs.ErrNotExist) {
			t.Errorf("%s present (%v)", p, err)
		}
	}
	// Nothing to wipe is fine too.
	if err := WipeSecretsDir(paths.ForRoot(t.TempDir())); err != nil {
		t.Errorf("WipeSecretsDir of a missing dir: %v", err)
	}
}

func TestClaimHostnameNotApplied(t *testing.T) {
	h := newHarnessWith(t, func(o *Options) { o.Hostname = nil })
	ctx := t.Context()
	resp, err := h.m.Claim(ctx, fullRequest())
	if err != nil {
		t.Fatal(err)
	}
	if resp.HostnameApplied == nil || resp.GetHostnameApplied() {
		t.Errorf("hostname_applied = %v, want false", resp.HostnameApplied)
	}
	replay, err := h.m.Claim(ctx, fullRequest())
	if err != nil {
		t.Fatal(err)
	}
	if replay.HostnameApplied == nil || replay.GetHostnameApplied() {
		t.Errorf("replayed hostname_applied = %v, want false", replay.HostnameApplied)
	}
}

func TestStoredResponseWithoutHostnameField(t *testing.T) {
	h := newHarness(t)
	old, err := proto.Marshal(&agentv1.ClaimResponse{Ready: true})
	if err != nil {
		t.Fatal(err)
	}
	resp := h.m.storedResponse(&store.Claim{Response: old})
	if resp.HostnameApplied == nil || resp.GetHostnameApplied() != appliesHostname {
		t.Errorf("hostname_applied of an old response = %v, want %v", resp.HostnameApplied, appliesHostname)
	}
	stored, err := proto.Marshal(&agentv1.ClaimResponse{Ready: true, HostnameApplied: proto.Bool(false)})
	if err != nil {
		t.Fatal(err)
	}
	if resp := h.m.storedResponse(&store.Claim{Response: stored}); resp.GetHostnameApplied() {
		t.Error("a stored hostname_applied=false was overridden")
	}
}

func TestValidateSecretsLinkPath(t *testing.T) {
	ok, bad := unixLinkPaths()
	if runtime.GOOS == "windows" {
		ok, bad = windowsLinkPaths()
	}
	for _, p := range ok {
		if err := validateSecrets(nil, []*agentv1.SecretFile{{Name: "a", LinkPath: p}}); err != nil {
			t.Errorf("%q: %v", p, err)
		}
	}
	for _, p := range bad {
		if err := validateSecrets(nil, []*agentv1.SecretFile{{Name: "a", LinkPath: p}}); err == nil {
			t.Errorf("%q accepted", p)
		}
	}
}

func unixLinkPaths() (ok, bad []string) {
	return []string{"/home/user/.config/key.pem", "/etc/x"},
		[]string{"relative", "/", "/a/../b", `C:\x`}
}

func windowsLinkPaths() (ok, bad []string) {
	return []string{`C:\Users\user\.config\key.pem`, "C:/Users/user/key", `d:\x`},
		[]string{"relative", `C:\`, `C:x`, `\x`, `\\server\share\x`, `\\?\C:\x`, `C:\a\..\b`, "/home/user/x"}
}
