package system

import (
	"context"
	"errors"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"slices"
	"strings"
	"sync"
	"testing"
	"time"

	"connectrpc.com/connect"
	"google.golang.org/protobuf/encoding/prototext"
	"google.golang.org/protobuf/types/known/timestamppb"

	agentv1 "github.com/belov38/boat-dev-clone/libs/proto/sbx/agent/v1"
	"github.com/belov38/boat-dev-clone/libs/proto/sbx/agent/v1/agentv1connect"
	"github.com/belov38/boat-dev-clone/libs/tunnel/wire"

	"github.com/belov38/boat-dev-clone/services/guest-agent/internal/claim"
	"github.com/belov38/boat-dev-clone/services/guest-agent/internal/paths"
	"github.com/belov38/boat-dev-clone/services/guest-agent/internal/ports"
	"github.com/belov38/boat-dev-clone/services/guest-agent/internal/process"
	"github.com/belov38/boat-dev-clone/services/guest-agent/internal/readiness"
	"github.com/belov38/boat-dev-clone/services/guest-agent/internal/reqcache"
	"github.com/belov38/boat-dev-clone/services/guest-agent/internal/store"
)

const (
	secretEnvValue  = "env-secret-5c2e9a7d1f"
	secretFileValue = "file-secret-8b3f6e0a4d"
)

// staticInfo is a fixed InfoSource.
type staticInfo StaticInfo

func (s staticInfo) Static() StaticInfo { return StaticInfo(s) }

// fakeCounts is a settable Counts.
type fakeCounts struct {
	mu                      sync.Mutex
	running, ptys, attaches int
}

func (f *fakeCounts) Counts() (running, ptys, attaches int) {
	f.mu.Lock()
	defer f.mu.Unlock()
	return f.running, f.ptys, f.attaches
}

func (f *fakeCounts) set(running, ptys, attaches int) {
	f.mu.Lock()
	defer f.mu.Unlock()
	f.running, f.ptys, f.attaches = running, ptys, attaches
}

// fakeQuiescer records its calls and answers with fixed responses.
type fakeQuiescer struct {
	mu     sync.Mutex
	calls  []string
	thaw   *agentv1.ThawResponse
	status *agentv1.QuiesceStatus
}

func (f *fakeQuiescer) Quiesce(_ context.Context, leaseMs uint32, docker, fs bool) (*agentv1.QuiesceResponse, error) {
	f.mu.Lock()
	defer f.mu.Unlock()
	f.calls = append(f.calls, "quiesce "+formatBools(leaseMs, docker, fs))
	return &agentv1.QuiesceResponse{LeaseId: "lease-1"}, nil
}

func (f *fakeQuiescer) Thaw(_ context.Context, leaseID string) (*agentv1.ThawResponse, error) {
	f.mu.Lock()
	defer f.mu.Unlock()
	f.calls = append(f.calls, "thaw "+leaseID)
	return f.thaw, nil
}

func (f *fakeQuiescer) Status() *agentv1.QuiesceStatus { return f.status }

func formatBools(leaseMs uint32, docker, fs bool) string {
	return strings.Join([]string{
		(time.Duration(leaseMs) * time.Millisecond).String(),
		map[bool]string{true: "docker", false: "-"}[docker],
		map[bool]string{true: "fs", false: "-"}[fs],
	}, " ")
}

// fakeUpdater answers with fixed values.
type fakeUpdater struct {
	status *agentv1.UpdateStatus
	upload string
}

func (f *fakeUpdater) Apply(_ context.Context, uploadID string, _ bool) (*agentv1.ApplyUpdateResponse, error) {
	f.upload = uploadID
	return &agentv1.ApplyUpdateResponse{From: "1.0.0", To: "1.1.0"}, nil
}

func (f *fakeUpdater) Status() *agentv1.UpdateStatus { return f.status }

// fakeIdle is a fixed IdleSource.
type fakeIdle struct {
	since time.Time
	ok    bool
}

func (f fakeIdle) IdleSince() (time.Time, bool) { return f.since, f.ok }

// serve starts the System handler of opts on a test server and returns a
// client for it.
func serve(t *testing.T, opts Options) agentv1connect.SystemClient {
	t.Helper()
	s, err := New(opts)
	if err != nil {
		t.Fatalf("New: %v", err)
	}
	mux := http.NewServeMux()
	path, h := s.ConnectHandler()
	mux.Handle(path, h)
	srv := httptest.NewServer(mux)
	t.Cleanup(srv.Close)
	return agentv1connect.NewSystemClient(srv.Client(), srv.URL)
}

// withID returns a request carrying Sbx-Request-Id.
func withID[T any](msg *T, id string) *connect.Request[T] {
	req := connect.NewRequest(msg)
	req.Header().Set(wire.HeaderRequestID, id)
	return req
}

// claimEnv is a real claim.Manager over a temporary layout.
type claimEnv struct {
	st *store.Store
	tr *readiness.Tracker
	m  *claim.Manager
}

func newClaimEnv(t *testing.T) *claimEnv {
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
	if err := os.WriteFile(l.TemplateSSHCA, []byte("ssh-ed25519 AAAAtemplate template-ca\n"), 0o644); err != nil {
		t.Fatal(err)
	}
	tr := readiness.New([]string{readiness.PhaseIdentity, readiness.PhaseClaim, readiness.PhaseSecrets}, nil, nil)
	tr.Set(readiness.PhaseAgent, agentv1.PhaseState_PHASE_STATE_READY, "")
	tr.Set(readiness.PhaseIdentity, agentv1.PhaseState_PHASE_STATE_READY, "")
	tr.Set(readiness.PhaseDocker, agentv1.PhaseState_PHASE_STATE_DISABLED, "")
	uid, gid := uint32(os.Getuid()), uint32(os.Getgid()) //nolint:gosec // test ids are small
	if os.Getuid() == 0 {
		uid, gid = 1000, 1000
	}
	m, err := claim.New(claim.Options{
		Store:        st,
		Layout:       l,
		Ready:        tr,
		DefaultUser:  "user",
		Hostname:     func(string) error { return nil },
		MountSecrets: func(dir string) error { return os.MkdirAll(dir, 0o755) },
		LookupUser: func(name string) (*process.User, error) {
			return &process.User{Name: name, UID: uid, GID: gid, Home: "/home/user"}, nil
		},
	})
	if err != nil {
		t.Fatal(err)
	}
	if err := m.Start(t.Context()); err != nil {
		t.Fatal(err)
	}
	return &claimEnv{st: st, tr: tr, m: m}
}

func TestInfoFields(t *testing.T) {
	ce := newClaimEnv(t)
	boot := time.Date(2026, 10, 30, 8, 0, 0, 0, time.UTC)
	idleSince := time.Date(2026, 10, 30, 9, 0, 0, 0, time.UTC)
	deadline := time.Date(2026, 10, 30, 9, 30, 0, 0, time.UTC)
	client := serve(t, Options{
		Info: staticInfo{
			Version: "1.2.3", PreviousVersion: "1.2.2", OS: "linux", Arch: "amd64",
			Kernel: "6.8.0", BootID: "boot-1", MachineID: "mid-1", DefaultUser: "user",
			TunnelURL: "wss://gw.example/tunnel", TunnelURLSource: "smbios",
			BootTime: boot, SSHHostKeys: []string{"ssh-ed25519 AAAAhost host"},
		},
		Ready:          ce.tr,
		Claim:          ce.m,
		Quiesce:        &fakeQuiescer{status: &agentv1.QuiesceStatus{Active: true, LeaseId: "lease-9", Deadline: timestamppb.New(deadline)}},
		Update:         &fakeUpdater{status: &agentv1.UpdateStatus{BadVersions: []string{"0.9.0"}}},
		Idle:           fakeIdle{since: idleSince, ok: true},
		Hostname:       func() (string, error) { return "my-box", nil },
		HandlerOptions: reqcache.Interceptors(ce.st),
	})

	// Before the claim: claim phase pending, not ready, no claim info.
	res, err := client.Info(t.Context(), connect.NewRequest(&agentv1.InfoRequest{}))
	if err != nil {
		t.Fatalf("Info: %v", err)
	}
	if res.Msg.GetReady() || res.Msg.GetClaim() != nil || res.Msg.GetSandboxId() != "" {
		t.Fatalf("Info before claim = %v", res.Msg)
	}

	creq := &agentv1.ClaimRequest{
		SandboxId:     "sbx_1",
		Hostname:      "my-box",
		PortDomain:    "sbx.example.com",
		Env:           map[string]string{"FOO": "bar"},
		SecretEnv:     map[string]string{"TOKEN": secretEnvValue},
		SecretFiles:   []*agentv1.SecretFile{{Name: "key.pem", Content: []byte(secretFileValue)}},
		SshUserCaKeys: []string{"ssh-ed25519 AAAAcurrent ca-1"},
		Reason:        agentv1.ClaimReason_CLAIM_REASON_CLAIM,
	}
	// A mutating call without Sbx-Request-Id is rejected by the shared
	// interceptors.
	if _, err := client.Claim(t.Context(), connect.NewRequest(creq)); connect.CodeOf(err) != connect.CodeInvalidArgument {
		t.Fatalf("Claim without request id: %v", err)
	}
	cres, err := client.Claim(t.Context(), withID(creq, "0192f3a0-0000-7000-8000-000000000001"))
	if err != nil {
		t.Fatalf("Claim: %v", err)
	}
	if !cres.Msg.GetReady() {
		t.Fatalf("Claim response not ready: %v", cres.Msg)
	}
	if b, _ := prototext.Marshal(cres.Msg); strings.Contains(string(b), secretEnvValue) || strings.Contains(string(b), secretFileValue) {
		t.Fatalf("Claim response carries a secret: %s", b)
	}

	res, err = client.Info(t.Context(), connect.NewRequest(&agentv1.InfoRequest{}))
	if err != nil {
		t.Fatalf("Info: %v", err)
	}
	got := res.Msg
	checks := []struct {
		name string
		ok   bool
	}{
		{"version", got.GetVersion() == "1.2.3" && got.GetPreviousVersion() == "1.2.2"},
		{"os/arch/kernel", got.GetOs() == "linux" && got.GetArch() == "amd64" && got.GetKernel() == "6.8.0"},
		{"boot", got.GetBootId() == "boot-1" && got.GetBootTime().AsTime().Equal(boot)},
		{"machine_id", got.GetMachineId() == "mid-1"},
		{"hostname", got.GetHostname() == "my-box"},
		{"sandbox_id", got.GetSandboxId() == "sbx_1"},
		{"default_user", got.GetDefaultUser() == "user"},
		{"tunnel", got.GetTunnelUrl() == "wss://gw.example/tunnel" && got.GetTunnelUrlSource() == "smbios"},
		{"ssh_host_keys", slices.Equal(got.GetSshHostKeys(), []string{"ssh-ed25519 AAAAhost host"})},
		{"ready", got.GetReady()},
		{"readiness", len(got.GetReadiness()) == 5 && got.GetReadiness()[2].GetName() == readiness.PhaseClaim &&
			got.GetReadiness()[2].GetState() == agentv1.PhaseState_PHASE_STATE_READY},
		{"claim", got.GetClaim().GetSandboxId() == "sbx_1" && got.GetClaim().GetEnv()["FOO"] == "bar" &&
			slices.Equal(got.GetClaim().GetSecretEnvKeys(), []string{"TOKEN"}) &&
			slices.Equal(got.GetClaim().GetSecretFileNames(), []string{"key.pem"})},
		{"quiesce", got.GetQuiesce().GetActive() && got.GetQuiesce().GetLeaseId() == "lease-9"},
		{"update", slices.Equal(got.GetUpdate().GetBadVersions(), []string{"0.9.0"})},
		{"idle_since", got.GetIdleSince().AsTime().Equal(idleSince)},
	}
	for _, c := range checks {
		if !c.ok {
			t.Errorf("Info %s wrong: %v", c.name, got)
		}
	}
	if b, _ := prototext.Marshal(got); strings.Contains(string(b), secretEnvValue) || strings.Contains(string(b), secretFileValue) {
		t.Fatalf("Info carries a secret: %s", b)
	}

	// UpdateSecrets answers readiness only.
	ures, err := client.UpdateSecrets(t.Context(), withID(&agentv1.UpdateSecretsRequest{
		SecretEnv: map[string]string{"TOKEN": secretEnvValue + "-2"},
	}, "0192f3a0-0000-7000-8000-000000000002"))
	if err != nil {
		t.Fatalf("UpdateSecrets: %v", err)
	}
	if b, _ := prototext.Marshal(ures.Msg); strings.Contains(string(b), secretEnvValue) {
		t.Fatalf("UpdateSecrets response carries a secret: %s", b)
	}

	// PrepareStop is IDEMPOTENT: no request id needed; the secrets phase
	// becomes pending.
	for range 2 {
		if _, err := client.PrepareStop(t.Context(), connect.NewRequest(&agentv1.PrepareStopRequest{})); err != nil {
			t.Fatalf("PrepareStop: %v", err)
		}
	}
	if st, _ := ce.tr.State(readiness.PhaseSecrets); st != agentv1.PhaseState_PHASE_STATE_PENDING {
		t.Fatalf("secrets phase after PrepareStop = %v", st)
	}
}

func TestPrepareStopReportsWiped(t *testing.T) {
	ce := newClaimEnv(t)
	client := serve(t, Options{Info: staticInfo{}, Ready: ce.tr, Claim: ce.m, HandlerOptions: reqcache.Interceptors(ce.st)})
	res, err := client.PrepareStop(t.Context(), connect.NewRequest(&agentv1.PrepareStopRequest{}))
	if err != nil {
		t.Fatalf("PrepareStop: %v", err)
	}
	if !res.Msg.GetSecretFilesWiped() {
		t.Fatalf("PrepareStop = %v, want secret_files_wiped", res.Msg)
	}
}

func TestInfoWithoutOptionalSources(t *testing.T) {
	tr := readiness.New(nil, nil, nil)
	client := serve(t, Options{Info: staticInfo{Version: "1.0.0"}, Ready: tr})
	res, err := client.Info(t.Context(), connect.NewRequest(&agentv1.InfoRequest{}))
	if err != nil {
		t.Fatalf("Info: %v", err)
	}
	if res.Msg.GetVersion() != "1.0.0" || res.Msg.GetClaim() != nil || res.Msg.GetIdleSince() != nil ||
		res.Msg.GetQuiesce() != nil || res.Msg.GetUpdate() != nil || res.Msg.GetHostname() == "" {
		t.Fatalf("Info = %v", res.Msg)
	}
}

func TestActivityRPC(t *testing.T) {
	counts := &fakeCounts{}
	counts.set(3, 1, 2)
	var tcp ports.Counter
	tcp.Inc()
	tcp.Inc()
	tcp.Inc()
	tcp.Inc()
	client := serve(t, Options{Info: staticInfo{}, Ready: readiness.New(nil, nil, nil), Proc: counts, TCP: &tcp})
	res, err := client.Activity(t.Context(), connect.NewRequest(&agentv1.ActivityRequest{}))
	if err != nil {
		t.Fatalf("Activity: %v", err)
	}
	m := res.Msg
	if m.GetRunningCommands() != 3 || m.GetOpenPtys() != 1 || m.GetAttachStreams() != 2 || m.GetTcpStreams() != 4 {
		t.Fatalf("Activity = %v", m)
	}

	// Without sources every counter is zero.
	client = serve(t, Options{Info: staticInfo{}, Ready: readiness.New(nil, nil, nil)})
	res, err = client.Activity(t.Context(), connect.NewRequest(&agentv1.ActivityRequest{}))
	if err != nil {
		t.Fatalf("Activity: %v", err)
	}
	if m := res.Msg; m.GetRunningCommands()+m.GetOpenPtys()+m.GetAttachStreams()+m.GetTcpStreams() != 0 {
		t.Fatalf("Activity without sources = %v", m)
	}
}

func TestThawDelegates(t *testing.T) {
	at := time.Date(2026, 10, 30, 10, 0, 0, 0, time.UTC)
	q := &fakeQuiescer{thaw: &agentv1.ThawResponse{AutoThawed: true, AutoThawedAt: timestamppb.New(at)}}
	tr := readiness.New(nil, nil, nil)
	st := openStore(t)
	client := serve(t, Options{Info: staticInfo{}, Ready: tr, Quiesce: q, HandlerOptions: reqcache.Interceptors(st)})

	res, err := client.Thaw(t.Context(), withID(&agentv1.ThawRequest{LeaseId: "lease-1"}, "0192f3a0-0000-7000-8000-000000000003"))
	if err != nil {
		t.Fatalf("Thaw: %v", err)
	}
	if !res.Msg.GetAutoThawed() || !res.Msg.GetAutoThawedAt().AsTime().Equal(at) {
		t.Fatalf("Thaw = %v", res.Msg)
	}
	// A repeat with the same request id is answered from the cache.
	if _, err := client.Thaw(t.Context(), withID(&agentv1.ThawRequest{LeaseId: "lease-1"}, "0192f3a0-0000-7000-8000-000000000003")); err != nil {
		t.Fatalf("Thaw repeat: %v", err)
	}
	q.mu.Lock()
	calls := slices.Clone(q.calls)
	q.mu.Unlock()
	if !slices.Equal(calls, []string{"thaw lease-1"}) {
		t.Fatalf("quiescer calls = %q", calls)
	}
}

func TestQuiesceDefaults(t *testing.T) {
	tests := []struct {
		name string
		req  *agentv1.QuiesceRequest
		want string
	}{
		{"unset", &agentv1.QuiesceRequest{}, "30s docker fs"},
		{"explicit", &agentv1.QuiesceRequest{LeaseMs: new(uint32(5000)), Docker: new(false), Fs: new(true)}, "5s - fs"},
		{"max", &agentv1.QuiesceRequest{LeaseMs: new(uint32(120000)), Docker: new(true), Fs: new(false)}, "2m0s docker -"},
	}
	for _, tc := range tests {
		t.Run(tc.name, func(t *testing.T) {
			q := &fakeQuiescer{}
			client := serve(t, Options{Info: staticInfo{}, Ready: readiness.New(nil, nil, nil), Quiesce: q})
			if _, err := client.Quiesce(t.Context(), connect.NewRequest(tc.req)); err != nil {
				t.Fatalf("Quiesce: %v", err)
			}
			if want := []string{"quiesce " + tc.want}; !slices.Equal(q.calls, want) {
				t.Fatalf("calls = %q, want %q", q.calls, want)
			}
		})
	}
}

func TestQuiesceLeaseRange(t *testing.T) {
	for _, ms := range []uint32{0, 120001} {
		q := &fakeQuiescer{}
		client := serve(t, Options{Info: staticInfo{}, Ready: readiness.New(nil, nil, nil), Quiesce: q})
		_, err := client.Quiesce(t.Context(), connect.NewRequest(&agentv1.QuiesceRequest{LeaseMs: new(ms)}))
		if connect.CodeOf(err) != connect.CodeInvalidArgument {
			t.Fatalf("Quiesce lease_ms=%d: %v", ms, err)
		}
		if len(q.calls) != 0 {
			t.Fatalf("quiescer called for lease_ms=%d", ms)
		}
	}
}

func TestUnimplementedWithoutDelegates(t *testing.T) {
	client := serve(t, Options{Info: staticInfo{}, Ready: readiness.New(nil, nil, nil)})
	ctx := t.Context()
	calls := map[string]func() error{
		"Quiesce": func() error {
			_, err := client.Quiesce(ctx, connect.NewRequest(&agentv1.QuiesceRequest{}))
			return err
		},
		"Thaw": func() error {
			_, err := client.Thaw(ctx, connect.NewRequest(&agentv1.ThawRequest{}))
			return err
		},
		"ApplyUpdate": func() error {
			_, err := client.ApplyUpdate(ctx, connect.NewRequest(&agentv1.ApplyUpdateRequest{}))
			return err
		},
		"Metrics": func() error {
			_, err := client.Metrics(ctx, connect.NewRequest(&agentv1.MetricsRequest{}))
			return err
		},
		"Claim": func() error {
			_, err := client.Claim(ctx, connect.NewRequest(&agentv1.ClaimRequest{}))
			return err
		},
	}
	for name, call := range calls {
		if err := call(); connect.CodeOf(err) != connect.CodeUnimplemented {
			t.Errorf("%s: %v", name, err)
		}
	}
}

func TestApplyUpdateDelegates(t *testing.T) {
	u := &fakeUpdater{}
	client := serve(t, Options{Info: staticInfo{}, Ready: readiness.New(nil, nil, nil), Update: u})
	res, err := client.ApplyUpdate(t.Context(), connect.NewRequest(&agentv1.ApplyUpdateRequest{UploadId: "up-1"}))
	if err != nil {
		t.Fatalf("ApplyUpdate: %v", err)
	}
	if res.Msg.GetFrom() != "1.0.0" || res.Msg.GetTo() != "1.1.0" || u.upload != "up-1" {
		t.Fatalf("ApplyUpdate = %v, upload %q", res.Msg, u.upload)
	}
}

// fakeMetrics is a fixed MetricsSource.
type fakeMetrics struct{ err error }

func (f fakeMetrics) Collect(context.Context) (*agentv1.MetricsResponse, error) {
	if f.err != nil {
		return nil, f.err
	}
	return &agentv1.MetricsResponse{Cpu: &agentv1.Cpu{Cores: 4}, Processes: 120}, nil
}

func TestMetricsRPC(t *testing.T) {
	counts := &fakeCounts{}
	counts.set(2, 0, 5)
	var tcp ports.Counter
	tcp.Inc()
	client := serve(t, Options{Info: staticInfo{}, Ready: readiness.New(nil, nil, nil), Metrics: fakeMetrics{}, Proc: counts, TCP: &tcp})
	res, err := client.Metrics(t.Context(), connect.NewRequest(&agentv1.MetricsRequest{}))
	if err != nil {
		t.Fatalf("Metrics: %v", err)
	}
	m := res.Msg
	if m.GetCpu().GetCores() != 4 || m.GetProcesses() != 120 || m.GetRunningCommands() != 2 ||
		m.GetAttachStreams() != 5 || m.GetTcpStreams() != 1 {
		t.Fatalf("Metrics = %v", m)
	}

	client = serve(t, Options{Info: staticInfo{}, Ready: readiness.New(nil, nil, nil), Metrics: fakeMetrics{err: errors.New("boom")}})
	if _, err := client.Metrics(t.Context(), connect.NewRequest(&agentv1.MetricsRequest{})); connect.CodeOf(err) != connect.CodeInternal {
		t.Fatalf("Metrics error: %v", err)
	}
}

// fakePorts is a fixed port list.
type fakePorts []*agentv1.Port

func (f fakePorts) List() []*agentv1.Port { return f }

func TestListPortsRPC(t *testing.T) {
	client := serve(t, Options{Info: staticInfo{}, Ready: readiness.New(nil, nil, nil), Ports: fakePorts{{Port: 8080}, {Port: 3000}}})
	res, err := client.ListPorts(t.Context(), connect.NewRequest(&agentv1.ListPortsRequest{}))
	if err != nil {
		t.Fatalf("ListPorts: %v", err)
	}
	if len(res.Msg.GetPorts()) != 2 || res.Msg.GetPorts()[0].GetPort() != 8080 {
		t.Fatalf("ListPorts = %v", res.Msg)
	}
}

func TestNewRequiresInfoAndReady(t *testing.T) {
	if _, err := New(Options{Ready: readiness.New(nil, nil, nil)}); err == nil {
		t.Fatal("New without Info succeeded")
	}
	if _, err := New(Options{Info: staticInfo{}}); err == nil {
		t.Fatal("New without Ready succeeded")
	}
}

func openStore(t *testing.T) *store.Store {
	t.Helper()
	st, err := store.Open(filepath.Join(t.TempDir(), "state.db"), store.Options{})
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = st.Close() })
	return st
}

// The agent's components satisfy the interfaces of Options.
var (
	_ Claimer    = (*claim.Manager)(nil)
	_ Readiness  = (*readiness.Tracker)(nil)
	_ PortLister = (*ports.Scanner)(nil)
	_ Counts     = (*process.Manager)(nil)
	_ IdleSource = (*IdleLoop)(nil)
)
