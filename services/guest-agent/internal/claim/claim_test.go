package claim

import (
	"bytes"
	"context"
	"errors"
	"io/fs"
	"os"
	"path/filepath"
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

	mu        sync.Mutex
	hostnames []string
}

func newHarness(t *testing.T) *harness {
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
	h := &harness{t: t, l: l, st: st, rec: &events.Recorder{}}
	h.tr = readiness.New([]string{"identity", "claim", "secrets"}, h.rec, nil)
	h.tr.Set(readiness.PhaseIdentity, ready, "")
	h.m = h.newManager()
	return h
}

// newManager builds and starts a Manager over the harness store and layout,
// as the agent does after a restart.
func (h *harness) newManager() *Manager {
	h.t.Helper()
	m, err := New(Options{
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
	})
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
			LinkPath: "/home/user/.config/key.pem",
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

	if got := h.hostnameCalls(); !slices.Equal(got, []string{"my-box"}) {
		t.Errorf("hostname calls = %v", got)
	}

	env := h.read(h.l.SbxEnvFile)
	for _, line := range []string{
		`FOO="bar"`,
		`SBX="1"`,
		`SBX_SANDBOX_ID="sbx_1"`,
		`SBX_PORT_DOMAIN="sbx.example.com"`,
		`__VITE_ADDITIONAL_SERVER_ALLOWED_HOSTS=".sbx.example.com"`,
	} {
		if !strings.Contains(env, line+"\n") {
			t.Errorf("/etc/sbx/env lacks %s:\n%s", line, env)
		}
	}
	if strings.Contains(env, secretEnvValue) {
		t.Error("/etc/sbx/env contains a secret")
	}

	if got := h.read(h.l.SecretsEnvFile); got != `TOKEN="`+secretEnvValue+`"`+"\n" {
		t.Errorf("secrets/env = %q", got)
	}
	if m := h.mode(h.l.SecretsEnvFile); m != 0o440 {
		t.Errorf("secrets/env mode = %o", m)
	}
	file := filepath.Join(h.l.SecretFilesDir, "key.pem")
	if got := h.read(file); got != secretFileValue {
		t.Errorf("secret file = %q", got)
	}
	if m := h.mode(file); m != 0o440 {
		t.Errorf("secret file mode = %o", m)
	}
	if m := h.mode(h.l.SecretsDir); m != 0o750 {
		t.Errorf("secrets dir mode = %o", m)
	}
	link, err := h.l.Rooted("/home/user/.config/key.pem")
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
	if got := h.hostnameCalls(); len(got) != 1 {
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

	if got := h.read(h.l.SbxEnvFile); !strings.Contains(got, `FOO="bar"`) {
		t.Errorf("env changed by a refused claim: %s", got)
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
		if got := h.read(h.l.SbxEnvFile); !strings.Contains(got, `FOO="new-`+reason.String()+`"`) {
			t.Errorf("%v: env not updated: %s", reason, got)
		}
		if got := h.read(h.l.SecretsEnvFile); got != `OTHER="v2"`+"\n" {
			t.Errorf("%v: secret env = %q", reason, got)
		}
		if _, err := os.Stat(filepath.Join(h.l.SecretFilesDir, "key.pem")); !errors.Is(err, fs.ErrNotExist) {
			t.Errorf("%v: removed secret file still present (%v)", reason, err)
		}
		link, _ := h.l.Rooted("/home/user/.config/key.pem")
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
	if got := h.hostnameCalls(); !slices.Equal(got, []string{"my-box"}) {
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
	for _, p := range []string{h.l.SecretsEnvFile, h.l.SbxEnvFile} {
		if got := h.read(p); got != "" {
			t.Errorf("%s = %q, want empty", p, got)
		}
	}
	if m := h.mode(h.l.CmdSpecDir); m != 0o700 {
		t.Errorf("cmd-spec mode = %o", m)
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
	m2 := h.newManager()
	if st, _ := h.tr.State(readiness.PhaseSecrets); st != ready {
		t.Errorf("secrets after restart = %v, want ready", st)
	}
	if env := m2.EnvBuilder().Build(testUser(), &agentv1.CommandSpec{}); !slices.Contains(env, "TOKEN="+secretEnvValue) {
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
	if err := h.m.PrepareStop(ctx); err != nil {
		t.Fatal(err)
	}
	if got := h.read(h.l.SecretsEnvFile); got != "" {
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
	if err := h.m.PrepareStop(ctx); err != nil {
		t.Fatal(err)
	}
}

func TestPrepareStopWithoutSecretsKeepsReady(t *testing.T) {
	h := newHarness(t)
	req := fullRequest()
	req.SecretEnv, req.SecretFiles = nil, nil
	if _, err := h.m.Claim(context.Background(), req); err != nil {
		t.Fatal(err)
	}
	if err := h.m.PrepareStop(context.Background()); err != nil {
		t.Fatal(err)
	}
	if st, _ := h.tr.State(readiness.PhaseSecrets); st != ready {
		t.Errorf("secrets phase = %v, want ready for an empty set", st)
	}
}

func TestHostnameWriter(t *testing.T) {
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
	h := newHarness(t)
	if _, err := h.m.Claim(context.Background(), fullRequest()); err != nil {
		t.Fatal(err)
	}
	if m := h.mode(h.l.SecretsStateFile); m != 0o600 {
		t.Errorf("secrets.json mode = %o, want 600", m)
	}
}

func TestLinkPathOccupied(t *testing.T) {
	const linkPath = "/home/user/.config/key.pem"
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
	home, _ := h.l.Rooted("/home/user")
	mustMkdir(t, home)
	req := fullRequest()
	req.SecretFiles = []*agentv1.SecretFile{
		{Name: "a", Content: []byte("1"), LinkPath: "/home/user/new/deep/a"},
		{Name: "b", Content: []byte("2"), LinkPath: "/opt/app/conf/b"},
	}
	if _, err := h.m.Claim(context.Background(), req); err != nil {
		t.Fatal(err)
	}
	inHome, _ := h.l.Rooted("/home/user/new/deep")
	outside, _ := h.l.Rooted("/opt/app")
	for _, d := range []string{inHome, outside} {
		if m := h.mode(d); m != 0o755 {
			t.Errorf("%s mode = %o", d, m)
		}
	}
	uid, _ := testUID()
	if got := ownerUID(t, inHome); got != uid {
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
	blocker, _ := h.l.Rooted("/blocker")
	mustWrite(t, blocker, "a file, not a directory")

	_, err := h.m.UpdateSecrets(ctx, &agentv1.UpdateSecretsRequest{
		SecretEnv:   map[string]string{"TOKEN": "new"},
		SecretFiles: []*agentv1.SecretFile{{Name: "key.pem", Content: []byte("changed"), LinkPath: "/blocker/key.pem"}},
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
	blocker, _ := h.l.Rooted("/blocker")
	mustWrite(t, blocker, "a file, not a directory")
	req := fullRequest()
	req.SecretFiles[0].LinkPath = "/blocker/key.pem"
	if _, err := h.m.Claim(ctx, req); err == nil {
		t.Fatal("claim succeeded with a blocked link_path")
	}
	entries, _ := os.ReadDir(h.l.SecretFilesDir)
	if len(entries) != 0 {
		t.Errorf("secret files left behind: %v", entries)
	}
	if got := h.read(h.l.SecretsEnvFile); got != "" {
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
