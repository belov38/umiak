package process

import (
	"context"
	"errors"
	"net/http"
	"net/http/httptest"
	"os"
	"os/user"
	"path/filepath"
	"runtime"
	"slices"
	"strings"
	"testing"
	"time"

	"connectrpc.com/connect"

	agentv1 "github.com/belov38/boat-dev-clone/libs/proto/sbx/agent/v1"
	"github.com/belov38/boat-dev-clone/libs/proto/sbx/agent/v1/agentv1connect"
	"github.com/belov38/boat-dev-clone/libs/tunnel/rpcconv"

	"github.com/belov38/boat-dev-clone/services/guest-agent/internal/config"
	"github.com/belov38/boat-dev-clone/services/guest-agent/internal/events"
	"github.com/belov38/boat-dev-clone/services/guest-agent/internal/output"
	"github.com/belov38/boat-dev-clone/services/guest-agent/internal/paths"
	"github.com/belov38/boat-dev-clone/services/guest-agent/internal/reqcache"
	"github.com/belov38/boat-dev-clone/services/guest-agent/internal/store"
	"github.com/belov38/boat-dev-clone/services/guest-agent/internal/supervisor"
)

// stubEnv is the EnvBuilder of the tests: HOME, USER and the spec env.
type stubEnv struct{}

func (stubEnv) Build(u *User, spec *agentv1.CommandSpec) []string {
	env := []string{"HOME=" + u.Home, "USER=" + u.Name}
	for k, v := range spec.GetEnv() {
		env = append(env, k+"="+v)
	}
	slices.Sort(env)
	return env
}

// harness is a Manager over a fake supervisor, a real store in a short
// temporary root (darwin limits unix socket paths to 104 bytes) and a
// Connect client talking to its handler.
type harness struct {
	t      *testing.T
	layout paths.Layout
	st     *store.Store
	fake   *supervisor.Fake
	rec    *events.Recorder
	opts   Options
	m      *Manager
	client agentv1connect.ProcessClient
	srv    *httptest.Server
	user   string
}

func newHarness(t *testing.T, mods ...func(*Options)) *harness {
	t.Helper()
	root, err := os.MkdirTemp("", "pr")
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = os.RemoveAll(root) })
	l := paths.ForRoot(root)
	if err := os.MkdirAll(l.StateDir, 0o700); err != nil {
		t.Fatal(err)
	}
	st, err := store.Open(l.StateDB, store.Options{})
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = st.Close() })
	fake := supervisor.NewFake(l)
	t.Cleanup(func() { _ = fake.Close() })

	cfg := config.Defaults()
	cfg.DefaultUser = testUser(t)
	h := &harness{t: t, layout: l, st: st, fake: fake, rec: &events.Recorder{}, user: cfg.DefaultUser}
	h.opts = Options{
		Store:          st,
		Supervisor:     fake,
		Layout:         l,
		Config:         cfg,
		Emit:           h.rec,
		Env:            stubEnv{},
		ShimPath:       "/opt/sbx-agent/sbx-agent",
		AgentVersion:   "1.2.3",
		BootID:         "boot-1",
		Output:         output.Default(),
		PTYIdle:        time.Hour,
		PTYHangupGrace: 50 * time.Millisecond,
		Poll:           20 * time.Millisecond,
		Heartbeat:      5 * time.Second,
		DurableTimeout: 5 * time.Second,
		HandlerOptions: reqcache.Interceptors(st),
	}
	for _, mod := range mods {
		mod(&h.opts)
	}
	h.startManager(false)
	return h
}

// startManager creates a Manager from h.opts, optionally runs Recover, and
// serves it on a new test server.
func (h *harness) startManager(doRecover bool) {
	h.t.Helper()
	m, err := New(h.opts)
	if err != nil {
		h.t.Fatalf("New: %v", err)
	}
	if doRecover {
		if err := m.Recover(h.t.Context()); err != nil {
			h.t.Fatalf("Recover: %v", err)
		}
	}
	mux := http.NewServeMux()
	path, handler := m.Handler()
	mux.Handle(path, handler)
	srv := httptest.NewServer(mux)
	h.m, h.srv = m, srv
	h.client = agentv1connect.NewProcessClient(srv.Client(), srv.URL)
	h.t.Cleanup(func() {
		srv.Close()
		_ = m.Close()
	})
}

// restart closes the current Manager (the commands keep running in the fake)
// and starts a new one with bootID, running Recover.
func (h *harness) restart(bootID string) {
	h.t.Helper()
	h.srv.Close()
	if err := h.m.Close(); err != nil {
		h.t.Fatalf("Close: %v", err)
	}
	h.opts.BootID = bootID
	h.startManager(true)
}

// testUser is the account the commands of the tests run as: the current
// user, on Windows SYSTEM (the tests run as SYSTEM, and the agent knows only
// SYSTEM and user there; user.Current names SYSTEM WORKGROUP\<host>$).
func testUser(t *testing.T) string {
	t.Helper()
	if runtime.GOOS == "windows" {
		return "SYSTEM"
	}
	cu, err := user.Current()
	if err != nil {
		t.Fatal(err)
	}
	return cu.Username
}

func argvSpec(args ...string) *agentv1.CommandSpec {
	return &agentv1.CommandSpec{Cmd: &agentv1.CommandSpec_Argv{Argv: &agentv1.Argv{Args: args}}}
}

func ptySpec() *agentv1.CommandSpec {
	s := argvSpec("/bin/bash")
	s.Pty = &agentv1.Pty{Cols: 80, Rows: 24}
	return s
}

func (h *harness) ctx() context.Context {
	ctx, cancel := context.WithTimeout(h.t.Context(), 10*time.Second)
	h.t.Cleanup(cancel)
	return ctx
}

func (h *harness) start(id string, spec *agentv1.CommandSpec) *agentv1.StartResponse {
	h.t.Helper()
	res, err := h.client.Start(h.ctx(), connect.NewRequest(&agentv1.StartRequest{CommandId: id, Spec: spec}))
	if err != nil {
		h.t.Fatalf("Start %s: %v", id, err)
	}
	return res.Msg
}

func (h *harness) get(id string) (*agentv1.CommandInfo, error) {
	res, err := h.client.Get(h.ctx(), connect.NewRequest(&agentv1.GetRequest{CommandId: id}))
	if err != nil {
		return nil, err
	}
	return res.Msg.GetCommand(), nil
}

// run returns the fake run of id.
func (h *harness) run(id string) *supervisor.FakeRun {
	h.t.Helper()
	r := h.fake.Run(id)
	if r == nil {
		h.t.Fatalf("command %s was never launched", id)
	}
	return r
}

// waitInfo polls Get until cond holds.
func (h *harness) waitInfo(id string, what string, cond func(*agentv1.CommandInfo) bool) *agentv1.CommandInfo {
	h.t.Helper()
	deadline := time.Now().Add(5 * time.Second)
	for {
		info, err := h.get(id)
		if err == nil && cond(info) {
			return info
		}
		if time.Now().After(deadline) {
			h.t.Fatalf("command %s: timeout waiting for %s; last info %v, err %v", id, what, info, err)
		}
		time.Sleep(10 * time.Millisecond)
	}
}

func (h *harness) waitExited(id string) *agentv1.CommandInfo {
	h.t.Helper()
	return h.waitInfo(id, "EXITED", func(i *agentv1.CommandInfo) bool {
		return i.GetState() == agentv1.CommandState_COMMAND_STATE_EXITED
	})
}

func (h *harness) waitRunning(id string) *agentv1.CommandInfo {
	h.t.Helper()
	return h.waitInfo(id, "RUNNING", func(i *agentv1.CommandInfo) bool {
		return i.GetState() == agentv1.CommandState_COMMAND_STATE_RUNNING
	})
}

// eventually polls cond for up to 5 s.
func eventually(t *testing.T, what string, cond func() bool) {
	t.Helper()
	deadline := time.Now().Add(5 * time.Second)
	for !cond() {
		if time.Now().After(deadline) {
			t.Fatalf("timeout waiting for %s", what)
		}
		time.Sleep(10 * time.Millisecond)
	}
}

// collect reads a server stream to its end.
func collect(t *testing.T, s *connect.ServerStreamForClient[agentv1.AttachResponse]) ([]*agentv1.AttachResponse, error) {
	t.Helper()
	var out []*agentv1.AttachResponse
	for s.Receive() {
		out = append(out, s.Msg())
	}
	return out, s.Err()
}

// wantCode asserts the Connect code and the ErrorDetail code of err.
func wantCode(t *testing.T, err error, code connect.Code, detail string) {
	t.Helper()
	if err == nil {
		t.Fatalf("want %v/%s, got nil error", code, detail)
	}
	if got := connect.CodeOf(err); got != code {
		t.Fatalf("code = %v, want %v (err %v)", got, code, err)
	}
	if detail == "" {
		return
	}
	d, ok := rpcconv.Detail(err)
	if !ok || d.GetCode() != detail {
		t.Fatalf("detail = %v, want %s (err %v)", d, detail, err)
	}
}

// dataOf concatenates the data events of stream s and checks their offsets
// are contiguous from start.
func dataOf(t *testing.T, evs []*agentv1.AttachResponse, s agentv1.Stream, start uint64) string {
	t.Helper()
	var b strings.Builder
	next := start
	for _, ev := range evs {
		d := ev.GetData()
		if d == nil || d.GetStream() != s {
			continue
		}
		if d.GetOffset() != next {
			t.Fatalf("%v data at offset %d, want %d", s, d.GetOffset(), next)
		}
		b.Write(d.GetData())
		next += uint64(len(d.GetData()))
	}
	return b.String()
}

func exists(path string) bool {
	_, err := os.Stat(path)
	return !errors.Is(err, os.ErrNotExist)
}

func cmdFile(l paths.Layout, id, name string) string {
	return filepath.Join(l.CommandDir(id), name)
}
