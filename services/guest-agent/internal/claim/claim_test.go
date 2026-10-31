package claim

import (
	"bytes"
	"context"
	"errors"
	"io/fs"
	"os"
	"path/filepath"
	"runtime"
	"slices"
	"strings"
	"sync"
	"testing"

	"connectrpc.com/connect"
	"google.golang.org/protobuf/proto"

	agentv1 "github.com/belov38/boat-dev-clone/libs/proto/sbx/agent/v1"
	"github.com/belov38/boat-dev-clone/libs/tunnel/rpcconv"

	"github.com/belov38/boat-dev-clone/services/guest-agent/internal/errs"
	"github.com/belov38/boat-dev-clone/services/guest-agent/internal/events"
	"github.com/belov38/boat-dev-clone/services/guest-agent/internal/paths"
	"github.com/belov38/boat-dev-clone/services/guest-agent/internal/process"
	"github.com/belov38/boat-dev-clone/services/guest-agent/internal/readiness"
	"github.com/belov38/boat-dev-clone/services/guest-agent/internal/store"
)

const (
	pending = agentv1.PhaseState_PHASE_STATE_PENDING
	ready   = agentv1.PhaseState_PHASE_STATE_READY

	secretEnvValue  = "env-secret-7f3a9c1e5b"
	secretFileValue = "file-secret-0d4e8b2a6c"
	templateCA      = "ssh-ed25519 AAAAtemplate template-ca\n"
)

type harness struct {
	t   *testing.T
	l   paths.Layout
	st  *store.Store
	tr  *readiness.Tracker
	rec *events.Recorder
	m   *Manager
	// mod adjusts the options of every Manager the harness builds.
	mod func(*Options)

	mu        sync.Mutex
	hostnames []string
}

func newHarness(t *testing.T) *harness {
	t.Helper()
	return newHarnessWith(t, nil)
}

// newHarnessWith is newHarness with mod applied to the Manager options.
func newHarnessWith(t *testing.T, mod func(*Options)) *harness {
	t.Helper()
	l := paths.ForRoot(t.TempDir())
	if err := os.MkdirAll(l.StateDir, 0o700); err != nil {
		t.Fatal(err)
	}
	st, err := store.Open(l.StateDB, store.Options{})
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = st.Close() })
	if err := os.MkdirAll(filepath.Dir(l.TemplateSSHCA), 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(l.TemplateSSHCA, []byte(templateCA), 0o644); err != nil {
		t.Fatal(err)
	}
	h := &harness{t: t, l: l, st: st, rec: &events.Recorder{}, mod: mod}
	h.tr = readiness.New([]string{"identity", "claim", "secrets"}, h.rec, nil)
	h.tr.Set(readiness.PhaseIdentity, ready, "")
	h.m = h.newManager()
	return h
}

// newManager builds and starts a Manager over the harness store and layout,
// as the agent does after a restart.
func (h *harness) newManager() *Manager {
	h.t.Helper()
	opts := Options{
		Store:       h.st,
		Layout:      h.l,
		Ready:       h.tr,
		Emit:        h.rec,
		DefaultUser: "user",
		Hostname: func(name string) error {
			h.mu.Lock()
			defer h.mu.Unlock()
			h.hostnames = append(h.hostnames, name)
			return nil
		},
		MountSecrets: func(dir string) error { return os.MkdirAll(dir, 0o755) },
		LookupUser: func(name string) (*process.User, error) {
			uid, gid := testUID()
			return &process.User{Name: name, UID: uid, GID: gid, Home: "/home/user"}, nil
		},
	}
	if h.mod != nil {
		h.mod(&opts)
	}
	m, err := New(opts)
	if err != nil {
		h.t.Fatal(err)
	}
	if err := m.Start(context.Background()); err != nil {
		h.t.Fatal(err)
	}
	return m
}

// testUID is the default user of the tests: uid/gid 1000 when the tests run
// as root (so ownership is observable), the current ids otherwise.
func testUID() (uid, gid uint32) {
	if os.Getuid() == 0 {
		return 1000, 1000
	}
	return uint32(os.Getuid()), uint32(os.Getgid())
}

func (h *harness) hostnameCalls() []string {
	h.mu.Lock()
	defer h.mu.Unlock()
	return slices.Clone(h.hostnames)
}

// wantHostnames is the hostname calls of claims for names: none where the
// claim does not set the hostname (Windows, appliesHostname).
func wantHostnames(names ...string) []string {
	if !appliesHostname {
		return nil
	}
	return names
}

// claimEnvHas reports whether the non-secret claim env has key=value: in
// /etc/sbx/env on Linux. Windows has no such file (the env socket serves
// the EnvBuilder), so there the EnvBuilder is asked.
func (h *harness) claimEnvHas(key, value string) bool {
	h.t.Helper()
	if h.l.SbxEnvFile == "" {
		return slices.Contains(h.m.EnvBuilder().Build(testUser(), &agentv1.CommandSpec{}), key+"="+value)
	}
	return strings.Contains(h.read(h.l.SbxEnvFile), key+`="`+value+`"`+"\n")
}

// secretEnvFile returns the content of secrets/env, or "" where the
// secret env stays in memory (Windows): the file must not exist there.
func (h *harness) secretEnvFile() string {
	h.t.Helper()
	if secretEnvMemoryOnly {
		if _, err := os.Lstat(h.l.SecretsEnvFile); !errors.Is(err, fs.ErrNotExist) {
			h.t.Errorf("secrets/env exists with the secret env in memory (%v)", err)
		}
		return ""
	}
	return h.read(h.l.SecretsEnvFile)
}

func (h *harness) read(path string) string {
	h.t.Helper()
	b, err := os.ReadFile(path)
	if err != nil {
		h.t.Fatal(err)
	}
	return string(b)
}

func (h *harness) mode(path string) fs.FileMode {
	h.t.Helper()
	fi, err := os.Stat(path)
	if err != nil {
		h.t.Fatal(err)
	}
	return fi.Mode().Perm()
}

func fullRequest() *agentv1.ClaimRequest {
	return &agentv1.ClaimRequest{
		SandboxId:  "sbx_1",
		Hostname:   "my-box",
		PortDomain: "sbx.example.com",
		Env:        map[string]string{"FOO": "bar"},
		SecretEnv:  map[string]string{"TOKEN": secretEnvValue},
		SecretFiles: []*agentv1.SecretFile{{
			Name:     "key.pem",
			Content:  []byte(secretFileValue),
			LinkPath: testLinkPath,
		}},
		SshUserCaKeys:  []string{"ssh-ed25519 AAAAcurrent ca-1", "ssh-ed25519 AAAAnext ca-2"},
		Reason:         agentv1.ClaimReason_CLAIM_REASON_CLAIM,
		AuthorizedKeys: []string{"ssh-ed25519 AAAAuser user@laptop"},
	}
}

func wantDetail(t *testing.T, err error, code connect.Code, detail string) {
	t.Helper()
	var cerr *connect.Error
	if !errors.As(err, &cerr) {
		t.Fatalf("err = %v, want a connect error %v/%s", err, code, detail)
	}
	if cerr.Code() != code {
		t.Fatalf("code = %v (%v), want %v", cerr.Code(), err, code)
	}
	d, ok := rpcconv.Detail(cerr)
	if !ok || d.GetCode() != detail {
		t.Fatalf("detail = %v, want %s (%v)", d, detail, err)
	}
}

func TestClaimAppliesAll(t *testing.T) {
	h := newHarness(t)
	ctx := context.Background()

	resp, err := h.m.Claim(ctx, fullRequest())
	if err != nil {
		t.Fatal(err)
	}
	if !resp.GetReady() {
		t.Errorf("response not ready: %v", resp)
	}

	if got := h.hostnameCalls(); !slices.Equal(got, wantHostnames("my-box")) {
		t.Errorf("hostname calls = %v", got)
	}

	for _, kv := range [][2]string{
		{"FOO", "bar"},
		{"SBX", "1"},
		{"SBX_SANDBOX_ID", "sbx_1"},
		{"SBX_PORT_DOMAIN", "sbx.example.com"},
		{"__VITE_ADDITIONAL_SERVER_ALLOWED_HOSTS", ".sbx.example.com"},
	} {
		if !h.claimEnvHas(kv[0], kv[1]) {
			t.Errorf("claim env lacks %s=%s", kv[0], kv[1])
		}
	}
	if h.l.SbxEnvFile != "" && strings.Contains(h.read(h.l.SbxEnvFile), secretEnvValue) {
		t.Error("/etc/sbx/env contains a secret")
	}

	// Windows: the secret env stays in memory, the ACLs of the secret
	// store are checked by TestSecretFileACL and TestSecretDirACL.
	if got := h.secretEnvFile(); !secretEnvMemoryOnly && got != `TOKEN="`+secretEnvValue+`"`+"\n" {
		t.Errorf("secrets/env = %q", got)
	}
	file := filepath.Join(h.l.SecretFilesDir, "key.pem")
	if got := h.read(file); got != secretFileValue {
		t.Errorf("secret file = %q", got)
	}
	if runtime.GOOS != "windows" {
		for _, c := range []struct {
			path string
			mode fs.FileMode
		}{{h.l.SecretsEnvFile, 0o440}, {file, 0o440}, {h.l.SecretsDir, 0o750}} {
			if m := h.mode(c.path); m != c.mode {
				t.Errorf("%s mode = %o, want %o", filepath.Base(c.path), m, c.mode)
			}
		}
	}
	link, err := h.l.Rooted(testLinkPath)
	if err != nil {
		t.Fatal(err)
	}
	if target, err := os.Readlink(link); err != nil || target != file {
		t.Errorf("link_path -> %q (%v), want %q", target, err, file)
	}

	if got := h.read(h.l.SSHUserCA); got != "ssh-ed25519 AAAAcurrent ca-1\nssh-ed25519 AAAAnext ca-2\n" {
		t.Errorf("ssh ca = %q", got)
	}

	applied := h.rec.Of(events.TypeClaimApplied)
	if len(applied) != 1 || applied[0].(*agentv1.ClaimApplied).GetSandboxId() != "sbx_1" {
		t.Errorf("claim.applied events = %v", applied)
	}
	var claimReady bool
	for _, p := range h.rec.Of(events.TypeReadinessChanged) {
		ev := p.(*agentv1.ReadinessChanged)
		if ev.GetPhase() == readiness.PhaseClaim && ev.GetState() == ready {
			claimReady = true
		}
	}
	if !claimReady {
		t.Error("no readiness.changed claim=ready")
	}
	if st, _ := h.tr.State(readiness.PhaseSecrets); st != ready {
		t.Errorf("secrets phase = %v", st)
	}

	info := h.m.ClaimInfo()
	if info.GetSandboxId() != "sbx_1" || info.GetHostname() != "my-box" ||
		!slices.Equal(info.GetSecretEnvKeys(), []string{"TOKEN"}) ||
		!slices.Equal(info.GetSecretFileNames(), []string{"key.pem"}) {
		t.Errorf("claim info = %v", info)
	}

	// Empty CA list falls back to the template keys.
	if _, err := h.m.UpdateSshCa(ctx, &agentv1.UpdateSshCaRequest{}); err != nil {
		t.Fatal(err)
	}
	if got := h.read(h.l.SSHUserCA); got != templateCA {
		t.Errorf("ssh ca after empty update = %q, want template", got)
	}

	// No secret value reaches state.db.
	if err := h.st.Flush(ctx); err != nil {
		t.Fatal(err)
	}
	db, err := os.ReadFile(h.l.StateDB)
	if err != nil {
		t.Fatal(err)
	}
	for _, s := range []string{secretEnvValue, secretFileValue} {
		if bytes.Contains(db, []byte(s)) {
			t.Errorf("state.db contains secret %q", s)
		}
	}
	c, ok, err := h.st.GetClaim()
	if err != nil || !ok {
		t.Fatalf("GetClaim = %v %v", ok, err)
	}
	if c.SandboxID != "sbx_1" || c.SecretsDigest == "" || c.RequestHash == "" {
		t.Errorf("stored claim = %+v", c)
	}
}

func TestClaimReportsHostnameApplied(t *testing.T) {
	h := newHarness(t)
	ctx := context.Background()
	resp, err := h.m.Claim(ctx, fullRequest())
	if err != nil {
		t.Fatal(err)
	}
	if resp.HostnameApplied == nil || resp.GetHostnameApplied() != appliesHostname {
		t.Errorf("hostname_applied = %v, want %v", resp.HostnameApplied, appliesHostname)
	}
	// A replay is answered from the stored response.
	replay, err := h.m.Claim(ctx, fullRequest())
	if err != nil {
		t.Fatal(err)
	}
	if replay.HostnameApplied == nil || replay.GetHostnameApplied() != appliesHostname {
		t.Errorf("replayed hostname_applied = %v, want %v", replay.HostnameApplied, appliesHostname)
	}
}

func TestClaimReplaySameRequest(t *testing.T) {
	h := newHarness(t)
	ctx := context.Background()
	first, err := h.m.Claim(ctx, fullRequest())
	if err != nil {
		t.Fatal(err)
	}
	second, err := h.m.Claim(ctx, fullRequest())
	if err != nil {
		t.Fatal(err)
	}
	if !proto.Equal(first, second) {
		t.Errorf("replay = %v, want %v", second, first)
	}
	if got := h.hostnameCalls(); len(got) != len(wantHostnames("my-box")) {
		t.Errorf("hostname set %d times", len(got))
	}
	if n := len(h.rec.Of(events.TypeClaimApplied)); n != 1 {
		t.Errorf("claim.applied emitted %d times", n)
	}
}

func TestClaimOtherContentAlreadyClaimed(t *testing.T) {
	h := newHarness(t)
	ctx := context.Background()
	if _, err := h.m.Claim(ctx, fullRequest()); err != nil {
		t.Fatal(err)
	}

	other := fullRequest()
	other.Env["FOO"] = "changed"
	_, err := h.m.Claim(ctx, other)
	wantDetail(t, err, connect.CodeFailedPrecondition, errs.AlreadyClaimed)

	// RESUME for another sandbox is refused too.
	resume := fullRequest()
	resume.SandboxId = "sbx_2"
	resume.Reason = agentv1.ClaimReason_CLAIM_REASON_RESUME
	_, err = h.m.Claim(ctx, resume)
	wantDetail(t, err, connect.CodeFailedPrecondition, errs.AlreadyClaimed)

	if !h.claimEnvHas("FOO", "bar") {
		t.Error("env changed by a refused claim")
	}
}

func TestClaimResumeSameSandbox(t *testing.T) {
	h := newHarness(t)
	ctx := context.Background()
	if _, err := h.m.Claim(ctx, fullRequest()); err != nil {
		t.Fatal(err)
	}

	for _, reason := range []agentv1.ClaimReason{agentv1.ClaimReason_CLAIM_REASON_RESUME, agentv1.ClaimReason_CLAIM_REASON_RECOVER} {
		req := fullRequest()
		req.Reason = reason
		req.Hostname = "ignored-on-resume"
		req.Env = map[string]string{"FOO": "new-" + reason.String()}
		req.SecretEnv = map[string]string{"OTHER": "v2"}
		req.SecretFiles = nil
		req.SshUserCaKeys = []string{"ssh-ed25519 AAAArotated ca-3"}
		req.AuthorizedKeys = []string{"ssh-ed25519 AAAAnewuser " + reason.String()}
		resp, err := h.m.Claim(ctx, req)
		if err != nil {
			t.Fatalf("%v: %v", reason, err)
		}
		if !resp.GetReady() {
			t.Errorf("%v: not ready: %v", reason, resp)
		}
		if !h.claimEnvHas("FOO", "new-"+reason.String()) {
			t.Errorf("%v: env not updated", reason)
		}
		if got := h.secretEnvFile(); !secretEnvMemoryOnly && got != `OTHER="v2"`+"\n" {
			t.Errorf("%v: secret env = %q", reason, got)
		}
		if _, err := os.Stat(filepath.Join(h.l.SecretFilesDir, "key.pem")); !errors.Is(err, fs.ErrNotExist) {
			t.Errorf("%v: removed secret file still present (%v)", reason, err)
		}
		link, _ := h.l.Rooted(testLinkPath)
		if _, err := os.Lstat(link); !errors.Is(err, fs.ErrNotExist) {
			t.Errorf("%v: link of a removed secret file still present (%v)", reason, err)
		}
		if got := h.read(h.l.SSHUserCA); got != "ssh-ed25519 AAAArotated ca-3\n" {
			t.Errorf("%v: ca = %q", reason, got)
		}
		c, _, err := h.st.GetClaim()
		if err != nil {
			t.Fatal(err)
		}
		stored, err := decodeRequest(c.Request)
		if err != nil {
			t.Fatal(err)
		}
		if !slices.Equal(stored.GetAuthorizedKeys(), req.AuthorizedKeys) {
			t.Errorf("%v: stored authorized_keys = %v", reason, stored.GetAuthorizedKeys())
		}
	}
	if got := h.hostnameCalls(); !slices.Equal(got, wantHostnames("my-box")) {
		t.Errorf("hostname calls = %v", got)
	}
	if info := h.m.ClaimInfo(); info.GetHostname() != "my-box" || info.GetEnv()["FOO"] != "new-CLAIM_REASON_RECOVER" {
		t.Errorf("claim info after resume = %v", info)
	}
}

func TestClaimIdentityNotReady(t *testing.T) {
	h := newHarness(t)
	h.tr.Set(readiness.PhaseIdentity, pending, "")
	_, err := h.m.Claim(context.Background(), fullRequest())
	wantDetail(t, err, connect.CodeUnavailable, errs.IdentityNotReady)
	if _, ok, _ := h.st.GetClaim(); ok {
		t.Error("claim stored while identity was not ready")
	}
}

func TestClaimValidation(t *testing.T) {
	big := make([]byte, MaxSecretFileBytes+1)
	tests := []struct {
		name   string
		modify func(*agentv1.ClaimRequest)
	}{
		{"bad hostname", func(r *agentv1.ClaimRequest) { r.Hostname = "bad_host!" }},
		{"empty hostname", func(r *agentv1.ClaimRequest) { r.Hostname = "" }},
		{"long hostname", func(r *agentv1.ClaimRequest) { r.Hostname = strings.Repeat("a", 64) }},
		{"empty sandbox", func(r *agentv1.ClaimRequest) { r.SandboxId = "" }},
		{"file too big", func(r *agentv1.ClaimRequest) { r.SecretFiles[0].Content = big }},
		{"total too big", func(r *agentv1.ClaimRequest) {
			r.SecretFiles = nil
			for i := range 9 {
				r.SecretFiles = append(r.SecretFiles, &agentv1.SecretFile{
					Name: "f" + string(rune('0'+i)), Content: make([]byte, MaxSecretFileBytes),
				})
			}
		}},
		{"bad file name", func(r *agentv1.ClaimRequest) { r.SecretFiles[0].Name = "a/b" }},
		{"dot-dot file name", func(r *agentv1.ClaimRequest) { r.SecretFiles[0].Name = ".." }},
		{"long file name", func(r *agentv1.ClaimRequest) { r.SecretFiles[0].Name = strings.Repeat("a", 129) }},
		{"duplicate file", func(r *agentv1.ClaimRequest) {
			r.SecretFiles = append(r.SecretFiles, &agentv1.SecretFile{Name: "key.pem"})
		}},
		{"relative link", func(r *agentv1.ClaimRequest) { r.SecretFiles[0].LinkPath = "home/x" }},
		{"bad mode", func(r *agentv1.ClaimRequest) { r.SecretFiles[0].Mode = 0o4755 }},
		{"bad env key", func(r *agentv1.ClaimRequest) { r.Env["A=B"] = "x" }},
		{"nul in secret", func(r *agentv1.ClaimRequest) { r.SecretEnv["X"] = "a\x00b" }},
		{"bad ca key", func(r *agentv1.ClaimRequest) { r.SshUserCaKeys = []string{"a\nb"} }},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			h := newHarness(t)
			req := fullRequest()
			tt.modify(req)
			_, err := h.m.Claim(context.Background(), req)
			wantDetail(t, err, connect.CodeInvalidArgument, errs.InvalidArgument)
			if len(h.hostnameCalls()) != 0 {
				t.Error("hostname set for an invalid claim")
			}
		})
	}
}

func TestUpdatesBeforeClaim(t *testing.T) {
	h := newHarness(t)
	ctx := context.Background()
	_, err := h.m.UpdateEnv(ctx, &agentv1.UpdateEnvRequest{})
	wantDetail(t, err, connect.CodeFailedPrecondition, errs.NotClaimed)
	_, err = h.m.UpdateSecrets(ctx, &agentv1.UpdateSecretsRequest{})
	wantDetail(t, err, connect.CodeFailedPrecondition, errs.NotClaimed)
	_, err = h.m.UpdateSshCa(ctx, &agentv1.UpdateSshCaRequest{})
	wantDetail(t, err, connect.CodeFailedPrecondition, errs.NotClaimed)
}

func TestStartCreatesFiles(t *testing.T) {
	h := newHarness(t)
	// Windows has no /etc/sbx/env and no cmd-spec/, and keeps the secret
	// env in memory.
	if got := h.secretEnvFile(); got != "" {
		t.Errorf("secrets/env = %q, want empty", got)
	}
	if h.l.SbxEnvFile != "" {
		if got := h.read(h.l.SbxEnvFile); got != "" {
			t.Errorf("/etc/sbx/env = %q, want empty", got)
		}
	}
	if h.l.CmdSpecDir != "" {
		if m := h.mode(h.l.CmdSpecDir); m != 0o700 {
			t.Errorf("cmd-spec mode = %o", m)
		}
	}
	if st, _ := h.tr.State(readiness.PhaseClaim); st != pending {
		t.Errorf("claim phase before claim = %v", st)
	}
	if st, _ := h.tr.State(readiness.PhaseSecrets); st != ready {
		t.Errorf("secrets phase before claim = %v", st)
	}
	if h.m.ClaimInfo() != nil {
		t.Error("claim info before claim")
	}
}

func TestSecretsPendingAfterReboot(t *testing.T) {
	h := newHarness(t)
	ctx := context.Background()
	if _, err := h.m.Claim(ctx, fullRequest()); err != nil {
		t.Fatal(err)
	}

	// Agent restart without reboot: tmpfs content matches the digest.
	// Where the secret env lives only in memory (Windows) it is gone and
	// the secrets are pending (TestSecretEnvNotPersistedWhenDisabled).
	m2 := h.newManager()
	if st, _ := h.tr.State(readiness.PhaseSecrets); st != ready && !secretEnvMemoryOnly {
		t.Errorf("secrets after restart = %v, want ready", st)
	}
	if env := m2.EnvBuilder().Build(testUser(), &agentv1.CommandSpec{}); !slices.Contains(env, "TOKEN="+secretEnvValue) && !secretEnvMemoryOnly {
		t.Errorf("secret env not restored from tmpfs: %v", env)
	}

	// Reboot: the tmpfs is empty.
	if err := os.RemoveAll(h.l.SecretsMount); err != nil {
		t.Fatal(err)
	}
	m3 := h.newManager()
	if st, _ := h.tr.State(readiness.PhaseSecrets); st != pending {
		t.Fatalf("secrets after reboot = %v, want pending", st)
	}
	if st, _ := h.tr.State(readiness.PhaseClaim); st != ready {
		t.Errorf("claim after reboot = %v, want ready", st)
	}
	if env := m3.EnvBuilder().Build(testUser(), &agentv1.CommandSpec{}); slices.Contains(env, "TOKEN="+secretEnvValue) {
		t.Error("secret env present after reboot")
	}
	if !slices.Contains(m3.EnvBuilder().Build(testUser(), &agentv1.CommandSpec{}), "FOO=bar") {
		t.Error("claim env lost after reboot")
	}

	req := fullRequest()
	resp, err := m3.UpdateSecrets(ctx, &agentv1.UpdateSecretsRequest{SecretEnv: req.SecretEnv, SecretFiles: req.SecretFiles})
	if err != nil {
		t.Fatal(err)
	}
	if !resp.GetReady() {
		t.Errorf("not ready after UpdateSecrets: %v", resp)
	}
	if st, _ := h.tr.State(readiness.PhaseSecrets); st != ready {
		t.Errorf("secrets after UpdateSecrets = %v", st)
	}
	if got := h.read(filepath.Join(h.l.SecretFilesDir, "key.pem")); got != secretFileValue {
		t.Errorf("secret file = %q", got)
	}
}

func TestPrepareStopWipes(t *testing.T) {
	h := newHarness(t)
	ctx := context.Background()
	if _, err := h.m.Claim(ctx, fullRequest()); err != nil {
		t.Fatal(err)
	}
	if wiped, err := h.m.PrepareStop(ctx); err != nil || !wiped {
		t.Fatalf("PrepareStop = %v, %v; want true, nil", wiped, err)
	}
	if got := h.secretEnvFile(); got != "" {
		t.Errorf("secrets/env = %q after PrepareStop", got)
	}
	entries, err := os.ReadDir(h.l.SecretFilesDir)
	if err != nil || len(entries) != 0 {
		t.Errorf("files/ = %v (%v), want empty", entries, err)
	}
	if _, err := os.Stat(h.l.SecretsStateFile); !errors.Is(err, fs.ErrNotExist) {
		t.Errorf("secrets state file present (%v)", err)
	}
	if st, _ := h.tr.State(readiness.PhaseSecrets); st != pending {
		t.Errorf("secrets phase = %v, want pending", st)
	}
	if env := h.m.EnvBuilder().Build(testUser(), &agentv1.CommandSpec{}); slices.Contains(env, "TOKEN="+secretEnvValue) {
		t.Error("secret env still served after PrepareStop")
	}
	// Idempotent.
	if wiped, err := h.m.PrepareStop(ctx); err != nil || !wiped {
		t.Fatalf("repeated PrepareStop = %v, %v; want true, nil", wiped, err)
	}
}

func TestPrepareStopWithoutSecretsKeepsReady(t *testing.T) {
	h := newHarness(t)
	req := fullRequest()
	req.SecretEnv, req.SecretFiles = nil, nil
	if _, err := h.m.Claim(context.Background(), req); err != nil {
		t.Fatal(err)
	}
	if _, err := h.m.PrepareStop(context.Background()); err != nil {
		t.Fatal(err)
	}
	if st, _ := h.tr.State(readiness.PhaseSecrets); st != ready {
		t.Errorf("secrets phase = %v, want ready for an empty set", st)
	}
}

func TestHostnameWriter(t *testing.T) {
	if !appliesHostname {
		t.Skip("the claim does not set the hostname on this OS (TestClaimDoesNotApplyHostnameOnWindows)")
	}
	l := paths.ForRoot(t.TempDir())
	if err := os.MkdirAll(filepath.Dir(l.HostsFile), 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(l.HostsFile, []byte("127.0.0.1 localhost\n"), 0o644); err != nil {
		t.Fatal(err)
	}
	var set []string
	w := HostnameWriter(l, func(name string) error { set = append(set, name); return nil })
	if err := w("box-1"); err != nil {
		t.Fatal(err)
	}
	if !slices.Equal(set, []string{"box-1"}) {
		t.Errorf("set = %v", set)
	}
	if b, _ := os.ReadFile(l.HostnameFile); string(b) != "box-1\n" {
		t.Errorf("hostname file = %q", b)
	}
	if b, _ := os.ReadFile(l.HostsFile); !strings.Contains(string(b), "127.0.1.1 box-1\n") || !strings.HasPrefix(string(b), "127.0.0.1 localhost\n") {
		t.Errorf("hosts = %q", b)
	}
}

func TestSecretsStateFileMode(t *testing.T) {
	h := newHarnessWith(t, stateFileMod)
	if _, err := h.m.Claim(context.Background(), fullRequest()); err != nil {
		t.Fatal(err)
	}
	wantRootOnly(t, h.l.SecretsStateFile)
}

func TestLinkPathOccupied(t *testing.T) {
	const linkPath = testLinkPath
	tests := []struct {
		name    string
		noLink  bool // link_path stays as it is
		prepare func(t *testing.T, link, target string)
		check   func(t *testing.T, link string)
	}{
		{
			name: "regular file moved aside",
			prepare: func(t *testing.T, link, _ string) {
				mustWrite(t, link, "user data")
			},
			check: func(t *testing.T, link string) {
				if b, err := os.ReadFile(link + ".sbx-orig"); err != nil || string(b) != "user data" {
					t.Errorf("aside = %q (%v)", b, err)
				}
			},
		},
		{
			name: "second aside name when taken",
			prepare: func(t *testing.T, link, _ string) {
				mustWrite(t, link, "new")
				mustWrite(t, link+".sbx-orig", "old")
			},
			check: func(t *testing.T, link string) {
				if b, _ := os.ReadFile(link + ".sbx-orig"); string(b) != "old" {
					t.Errorf("first aside changed: %q", b)
				}
				m, _ := filepath.Glob(link + ".sbx-orig.*")
				if len(m) != 1 {
					t.Fatalf("aside files = %v", m)
				}
				if b, _ := os.ReadFile(m[0]); string(b) != "new" {
					t.Errorf("second aside = %q", b)
				}
			},
		},
		{
			name:   "directory kept, link skipped",
			noLink: true,
			prepare: func(t *testing.T, link, _ string) {
				mustWrite(t, filepath.Join(link, "inner"), "x")
			},
			check: func(t *testing.T, link string) {
				if b, err := os.ReadFile(filepath.Join(link, "inner")); err != nil || string(b) != "x" {
					t.Errorf("dir content = %q (%v)", b, err)
				}
				if _, err := os.Lstat(link + ".sbx-orig"); !errors.Is(err, fs.ErrNotExist) {
					t.Errorf("directory moved aside (%v)", err)
				}
			},
		},
		{
			name: "other symlink replaced",
			prepare: func(t *testing.T, link, _ string) {
				mustMkdir(t, filepath.Dir(link))
				if err := os.Symlink("/elsewhere", link); err != nil {
					t.Fatal(err)
				}
			},
			check: func(t *testing.T, link string) {
				if _, err := os.Lstat(link + ".sbx-orig"); !errors.Is(err, fs.ErrNotExist) {
					t.Errorf("symlink moved aside (%v)", err)
				}
			},
		},
		{
			name: "correct symlink kept",
			prepare: func(t *testing.T, link, target string) {
				mustMkdir(t, filepath.Dir(link))
				if err := os.Symlink(target, link); err != nil {
					t.Fatal(err)
				}
			},
			check: func(t *testing.T, link string) {
				if _, err := os.Lstat(link + ".sbx-orig"); !errors.Is(err, fs.ErrNotExist) {
					t.Errorf("symlink moved aside (%v)", err)
				}
			},
		},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			h := newHarness(t)
			link, err := h.l.Rooted(linkPath)
			if err != nil {
				t.Fatal(err)
			}
			target := filepath.Join(h.l.SecretFilesDir, "key.pem")
			tt.prepare(t, link, target)
			before, _ := os.Lstat(link)
			if _, err := h.m.Claim(context.Background(), fullRequest()); err != nil {
				t.Fatal(err)
			}
			if got, err := os.Readlink(link); !tt.noLink && (err != nil || got != target) {
				t.Fatalf("link -> %q (%v), want %q", got, err, target)
			}
			if tt.name == "correct symlink kept" {
				after, _ := os.Lstat(link)
				if !os.SameFile(before, after) {
					t.Error("correct symlink was recreated")
				}
			}
			tt.check(t, link)
		})
	}
}

func TestLinkPathParentsOwnership(t *testing.T) {
	h := newHarness(t)
	home, _ := h.l.Rooted(testPath("/home/user"))
	mustMkdir(t, home)
	req := fullRequest()
	req.SecretFiles = []*agentv1.SecretFile{
		{Name: "a", Content: []byte("1"), LinkPath: testPath("/home/user/new/deep/a")},
		{Name: "b", Content: []byte("2"), LinkPath: testPath("/opt/app/conf/b")},
	}
	if _, err := h.m.Claim(context.Background(), req); err != nil {
		t.Fatal(err)
	}
	inHome, _ := h.l.Rooted(testPath("/home/user/new/deep"))
	outside, _ := h.l.Rooted(testPath("/opt/app"))
	for _, d := range []string{inHome, outside} {
		if fi, err := os.Stat(d); err != nil || !fi.IsDir() {
			t.Errorf("%s: %v %v", d, fi, err)
		} else if m := fi.Mode().Perm(); m != 0o755 && runtime.GOOS != "windows" {
			t.Errorf("%s mode = %o", d, m)
		}
	}
	got := ownerUID(t, inHome)
	if uid, _ := testUID(); got != uid {
		t.Errorf("dir in home owned by %d, want %d", got, uid)
	}
	if os.Getuid() != 0 {
		t.Skip("ownership outside home is only observable as root")
	}
	for _, d := range []string{outside, filepath.Dir(outside)} {
		if got := ownerUID(t, d); got != 0 {
			t.Errorf("%s owned by %d, want root", d, got)
		}
	}
}

func TestUpdateSecretsPartialFailure(t *testing.T) {
	h := newHarness(t)
	ctx := context.Background()
	if _, err := h.m.Claim(ctx, fullRequest()); err != nil {
		t.Fatal(err)
	}
	blocker, _ := h.l.Rooted(testPath("/blocker"))
	mustWrite(t, blocker, "a file, not a directory")

	_, err := h.m.UpdateSecrets(ctx, &agentv1.UpdateSecretsRequest{
		SecretEnv:   map[string]string{"TOKEN": "new"},
		SecretFiles: []*agentv1.SecretFile{{Name: "key.pem", Content: []byte("changed"), LinkPath: testPath("/blocker/key.pem")}},
	})
	if err == nil {
		t.Fatal("UpdateSecrets succeeded with a blocked link_path")
	}
	if st, _ := h.tr.State(readiness.PhaseSecrets); st != pending {
		t.Errorf("secrets phase after a partial write = %v, want pending", st)
	}
	if env := h.m.EnvBuilder().Build(testUser(), &agentv1.CommandSpec{}); slices.Contains(env, "TOKEN="+secretEnvValue) {
		t.Error("stale secret env still served after a partial write")
	}
}

func TestFailedFirstClaimLeavesNoSecrets(t *testing.T) {
	h := newHarness(t)
	ctx := context.Background()
	blocker, _ := h.l.Rooted(testPath("/blocker"))
	mustWrite(t, blocker, "a file, not a directory")
	req := fullRequest()
	req.SecretFiles[0].LinkPath = testPath("/blocker/key.pem")
	if _, err := h.m.Claim(ctx, req); err == nil {
		t.Fatal("claim succeeded with a blocked link_path")
	}
	entries, _ := os.ReadDir(h.l.SecretFilesDir)
	if len(entries) != 0 {
		t.Errorf("secret files left behind: %v", entries)
	}
	if got := h.secretEnvFile(); got != "" {
		t.Errorf("secrets/env = %q", got)
	}
	if st, _ := h.tr.State(readiness.PhaseSecrets); st != ready {
		t.Errorf("secrets phase = %v, want ready (unclaimed)", st)
	}
	if _, ok, _ := h.st.GetClaim(); ok {
		t.Error("failed claim stored")
	}
	if _, err := h.m.Claim(ctx, fullRequest()); err != nil {
		t.Fatalf("claim after a failed claim: %v", err)
	}
}

func mustWrite(t *testing.T, path, data string) {
	t.Helper()
	mustMkdir(t, filepath.Dir(path))
	if err := os.WriteFile(path, []byte(data), 0o644); err != nil {
		t.Fatal(err)
	}
}

func mustMkdir(t *testing.T, dir string) {
	t.Helper()
	if err := os.MkdirAll(dir, 0o755); err != nil {
		t.Fatal(err)
	}
}
