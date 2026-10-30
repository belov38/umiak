package process

import (
	"context"
	"encoding/json"
	"errors"
	"os"
	"slices"
	"strings"
	"sync/atomic"
	"testing"
	"time"

	"connectrpc.com/connect"

	agentv1 "github.com/belov38/boat-dev-clone/libs/proto/sbx/agent/v1"

	"github.com/belov38/boat-dev-clone/services/guest-agent/internal/errs"
	"github.com/belov38/boat-dev-clone/services/guest-agent/internal/events"
	"github.com/belov38/boat-dev-clone/services/guest-agent/internal/fsutil"
	"github.com/belov38/boat-dev-clone/services/guest-agent/internal/shim"
	"github.com/belov38/boat-dev-clone/services/guest-agent/internal/store"
	"github.com/belov38/boat-dev-clone/services/guest-agent/internal/supervisor"
)

func TestStartIdempotent(t *testing.T) {
	h := newHarness(t)
	spec := argvSpec("/bin/sleep", "100")
	spec.Env = map[string]string{"SECRET": "v1", "A": "x"}
	spec.Tags = map[string]string{"k": "v"}

	first := h.start("c1", spec)
	if !first.GetCreated() {
		t.Fatal("first Start: created = false")
	}
	info := first.GetCommand()
	if info.GetState() != agentv1.CommandState_COMMAND_STATE_RUNNING {
		t.Fatalf("state = %v, want RUNNING", info.GetState())
	}
	if info.GetPid() != int32(h.run("c1").Pid()) {
		t.Fatalf("pid = %d, want %d", info.GetPid(), h.run("c1").Pid())
	}
	if len(info.GetSpec().GetEnv()) != 0 {
		t.Fatalf("spec env not cleared: %v", info.GetSpec().GetEnv())
	}
	if !slices.Equal(info.GetEnvKeys(), []string{"A", "SECRET"}) {
		t.Fatalf("env_keys = %v", info.GetEnvKeys())
	}
	if info.GetAgentVersion() != "1.2.3" {
		t.Fatalf("agent_version = %q", info.GetAgentVersion())
	}

	second := h.start("c1", spec)
	if second.GetCreated() {
		t.Fatal("second Start: created = true")
	}
	if n := len(h.fake.Launches()); n != 1 {
		t.Fatalf("launches = %d, want 1", n)
	}

	// The shim got the resolved spec; the record on disk has no env values.
	ss := h.run("c1").Spec()
	if !slices.Equal(ss.Argv, []string{"/bin/sleep", "100"}) || !slices.Contains(ss.Env, "SECRET=v1") {
		t.Fatalf("shim spec argv %v env %v", ss.Argv, ss.Env)
	}
	rec, _, err := h.st.GetCommand("c1")
	if err != nil {
		t.Fatal(err)
	}
	if string(rec.Spec) == "" || strings.Contains(string(rec.Spec), "v1") {
		t.Fatalf("stored spec %s", rec.Spec)
	}
	if exists(h.layout.CmdSpec("c1")) {
		t.Fatal("cmd-spec file left behind")
	}
}

func TestStartOtherSpecAlreadyExists(t *testing.T) {
	h := newHarness(t)
	h.start("c1", argvSpec("/bin/true"))
	_, err := h.client.Start(h.ctx(), connect.NewRequest(&agentv1.StartRequest{CommandId: "c1", Spec: argvSpec("/bin/false")}))
	wantCode(t, err, connect.CodeAlreadyExists, errs.AlreadyExists)

	// Env values are part of the hash.
	s1 := argvSpec("/bin/true")
	s1.Env = map[string]string{"A": "1"}
	h.start("c2", s1)
	s2 := argvSpec("/bin/true")
	s2.Env = map[string]string{"A": "2"}
	_, err = h.client.Start(h.ctx(), connect.NewRequest(&agentv1.StartRequest{CommandId: "c2", Spec: s2}))
	wantCode(t, err, connect.CodeAlreadyExists, errs.AlreadyExists)
}

// putStarting stores a STARTING record for spec as a crashed agent would
// have left it.
func putStarting(t *testing.T, h *harness, id string, spec *agentv1.CommandSpec) {
	t.Helper()
	hash, err := specHash(spec)
	if err != nil {
		t.Fatal(err)
	}
	stored, keys, err := storedSpec(spec)
	if err != nil {
		t.Fatal(err)
	}
	err = h.st.PutCommand(t.Context(), &store.Command{ID: id, SpecHash: hash, Spec: stored, EnvKeys: keys,
		State: StateStarting, BootID: h.opts.BootID, CreatedAt: time.Now().UTC(), AgentVersion: "1.2.3",
		PTY: spec.GetPty() != nil})
	if err != nil {
		t.Fatal(err)
	}
}

func TestStartRetryAfterCrashNeverDoublesLaunch(t *testing.T) {
	t.Run("shim.json present, unit gone", func(t *testing.T) {
		h := newHarness(t)
		spec := argvSpec("/bin/sleep", "1")
		putStarting(t, h, "c1", spec)
		if err := os.MkdirAll(h.layout.CommandDir("c1"), 0o700); err != nil {
			t.Fatal(err)
		}
		if err := fsutil.WriteJSONAtomic(cmdFile(h.layout, "c1", shim.ShimJSON),
			shim.ShimFile{State: shim.StateLaunching, AgentVersion: "1.2.3", ShimProto: 1}, 0o600); err != nil {
			t.Fatal(err)
		}
		res := h.start("c1", spec)
		if res.GetCreated() {
			t.Fatal("created = true for an existing record")
		}
		if n := len(h.fake.Launches()); n != 0 {
			t.Fatalf("launches = %d, want 0", n)
		}
		info := h.waitExited("c1")
		if info.GetExit().GetStatus() != agentv1.ExitStatus_EXIT_STATUS_LOST ||
			info.GetExit().GetReason() != agentv1.ExitReason_EXIT_REASON_SHIM_LOST {
			t.Fatalf("exit = %v, want LOST/SHIM_LOST", info.GetExit())
		}
		if got := h.rec.Of(events.TypeCommandExited); len(got) != 1 {
			t.Fatalf("command.exited events = %d, want 1", len(got))
		}
	})
	t.Run("no shim.json, no unit", func(t *testing.T) {
		h := newHarness(t)
		spec := argvSpec("/bin/sleep", "1")
		putStarting(t, h, "c1", spec)
		res := h.start("c1", spec)
		if res.GetCommand().GetState() != agentv1.CommandState_COMMAND_STATE_RUNNING {
			t.Fatalf("state = %v, want RUNNING", res.GetCommand().GetState())
		}
		h.start("c1", spec)
		if n := len(h.fake.Launches()); n != 1 {
			t.Fatalf("launches = %d, want 1", n)
		}
	})
	t.Run("unit alive, shim.json not yet written", func(t *testing.T) {
		h := newHarness(t)
		spec := argvSpec("/bin/sleep", "1")
		putStarting(t, h, "c1", spec)
		h.fake.SetState("c1", supervisor.UnitActive)
		h.start("c1", spec)
		if n := len(h.fake.Launches()); n != 0 {
			t.Fatalf("launches = %d, want 0", n)
		}
	})
}

func TestStartTooMany(t *testing.T) {
	h := newHarness(t, func(o *Options) { o.Config.MaxRunningCommands = 1 })
	h.start("c1", argvSpec("/bin/sleep", "100"))
	_, err := h.client.Start(h.ctx(), connect.NewRequest(&agentv1.StartRequest{CommandId: "c2", Spec: argvSpec("/bin/true")}))
	wantCode(t, err, connect.CodeResourceExhausted, errs.TooManyCommands)
	// A repeat of the running command is still answered.
	if res := h.start("c1", argvSpec("/bin/sleep", "100")); res.GetCreated() {
		t.Fatal("repeat created = true")
	}
	if _, err := h.get("c2"); connect.CodeOf(err) != connect.CodeNotFound {
		t.Fatalf("refused command has a record: %v", err)
	}
	// Once c1 exits there is room again.
	if err := h.run("c1").Exit(0); err != nil {
		t.Fatal(err)
	}
	h.waitExited("c1")
	eventually(t, "room for c2", func() bool {
		_, err := h.client.Start(h.ctx(), connect.NewRequest(&agentv1.StartRequest{CommandId: "c2", Spec: argvSpec("/bin/true")}))
		return err == nil
	})
}

func TestStartUnknownUser(t *testing.T) {
	h := newHarness(t)
	spec := argvSpec("/bin/true")
	spec.User = "no-such-user-sbx-test"
	_, err := h.client.Start(h.ctx(), connect.NewRequest(&agentv1.StartRequest{CommandId: "c1", Spec: spec}))
	wantCode(t, err, connect.CodeInvalidArgument, errs.UserNotFound)
	if n := len(h.fake.Launches()); n != 0 {
		t.Fatalf("launches = %d", n)
	}
}

func TestStartInvalid(t *testing.T) {
	h := newHarness(t)
	tests := []struct {
		name string
		id   string
		spec *agentv1.CommandSpec
	}{
		{"no spec", "c1", nil},
		{"empty argv", "c1", argvSpec()},
		{"empty program", "c1", argvSpec("")},
		{"no cmd", "c1", &agentv1.CommandSpec{}},
		{"bad id", "a/b", argvSpec("/bin/true")},
		{"empty id", "", argvSpec("/bin/true")},
		{"dot id", "..", argvSpec("/bin/true")},
		{"bad env key", "c1", &agentv1.CommandSpec{Cmd: &agentv1.CommandSpec_Shell{Shell: "true"}, Env: map[string]string{"A=B": "x"}}},
		{"pty too wide", "c1", &agentv1.CommandSpec{Cmd: &agentv1.CommandSpec_Shell{Shell: "true"}, Pty: &agentv1.Pty{Cols: 70000, Rows: 1}}},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			_, err := h.client.Start(h.ctx(), connect.NewRequest(&agentv1.StartRequest{CommandId: tt.id, Spec: tt.spec}))
			wantCode(t, err, connect.CodeInvalidArgument, "")
		})
	}
}

func TestStartShellAndCwd(t *testing.T) {
	h := newHarness(t)
	home := mustUser(t, h.user).Home

	spec := &agentv1.CommandSpec{Cmd: &agentv1.CommandSpec_Shell{Shell: "echo hi"}, Cwd: "work"}
	h.start("c1", spec)
	ss := h.run("c1").Spec()
	if !slices.Equal(ss.Argv, []string{"/bin/bash", "-lc", "echo hi"}) || ss.Cwd != home+"/work" {
		t.Fatalf("argv %v cwd %q", ss.Argv, ss.Cwd)
	}

	login := false
	spec = &agentv1.CommandSpec{Cmd: &agentv1.CommandSpec_Shell{Shell: "echo hi"}, Login: &login, Cwd: "/tmp",
		OnExit: agentv1.OnExit_ON_EXIT_KILL_LEFTOVERS, TimeoutMs: 1500, Stdin: true}
	h.start("c2", spec)
	ss = h.run("c2").Spec()
	if !slices.Equal(ss.Argv, []string{"/bin/bash", "-c", "echo hi"}) || ss.Cwd != "/tmp" {
		t.Fatalf("argv %v cwd %q", ss.Argv, ss.Cwd)
	}
	if !ss.KillLeftovers || ss.TimeoutMs != 1500 || !ss.Stdin || ss.AgentVersion != "1.2.3" {
		t.Fatalf("shim spec %+v", ss)
	}

	h.start("c3", argvSpec("ls"))
	if got := h.run("c3").Spec().Cwd; got != home {
		t.Fatalf("default cwd %q, want %q", got, home)
	}

	p := ptySpec()
	p.Pty = &agentv1.Pty{Cols: 100, Rows: 40, Term: "vt100"}
	h.start("c4", p)
	if got := h.run("c4").Spec().PTY; got == nil || got.Cols != 100 || got.Rows != 40 || got.Term != "vt100" {
		t.Fatalf("pty spec %+v", got)
	}
}

func mustUser(t *testing.T, name string) *User {
	t.Helper()
	u, err := LookupUser(name)
	if err != nil {
		t.Fatal(err)
	}
	return u
}

func TestStartFailedCommand(t *testing.T) {
	h := newHarness(t)
	h.fake.Setup("c1", func(r *supervisor.FakeRun) { r.FailStart("no such file") })
	res := h.start("c1", argvSpec("/nope"))
	info := res.GetCommand()
	if info.GetState() != agentv1.CommandState_COMMAND_STATE_EXITED {
		t.Fatalf("state = %v, want EXITED", info.GetState())
	}
	if e := info.GetExit(); e.GetCode() != 127 || e.GetReason() != agentv1.ExitReason_EXIT_REASON_START_FAILED ||
		e.GetStatus() != agentv1.ExitStatus_EXIT_STATUS_EXITED {
		t.Fatalf("exit = %v", e)
	}
	evs, err := collect(t, mustAttach(t, h, &agentv1.AttachRequest{CommandId: "c1"}))
	if err != nil {
		t.Fatal(err)
	}
	if got := dataOf(t, evs, agentv1.Stream_STREAM_STDERR, 0); !strings.Contains(got, "no such file") {
		t.Fatalf("stderr %q", got)
	}
}

func TestStartLaunchErrorRecordsStartFailed(t *testing.T) {
	h := newHarness(t)
	h.fake.FailLaunch("c1", errors.New("dbus gone"))
	res := h.start("c1", argvSpec("/bin/true"))
	if e := res.GetCommand().GetExit(); e.GetReason() != agentv1.ExitReason_EXIT_REASON_START_FAILED || e.GetCode() != 127 {
		t.Fatalf("exit = %v", e)
	}
	if exists(h.layout.CmdSpec("c1")) {
		t.Fatal("cmd-spec file left behind")
	}
}

func TestStartWhileFrozen(t *testing.T) {
	h := newHarness(t)
	h.st.SetFrozen(true)
	defer h.st.SetFrozen(false)
	ctx, cancel := context.WithTimeout(t.Context(), 100*time.Millisecond)
	defer cancel()
	_, _, err := h.m.Start(ctx, "c1", argvSpec("/bin/true"))
	wantCode(t, err, connect.CodeUnavailable, errs.Quiesced)
	// Over the wire the agent answers a little before the caller's deadline.
	ctx, cancel = context.WithTimeout(t.Context(), 2*time.Second)
	defer cancel()
	_, err = h.client.Start(ctx, connect.NewRequest(&agentv1.StartRequest{CommandId: "c1", Spec: argvSpec("/bin/true")}))
	wantCode(t, err, connect.CodeUnavailable, errs.Quiesced)
	if n := len(h.fake.Launches()); n != 0 {
		t.Fatalf("launches = %d", n)
	}
	h.st.SetFrozen(false)
	// The refused start left no trace: a retry runs it.
	if res := h.start("c1", argvSpec("/bin/true")); !res.GetCreated() {
		t.Fatal("retry after thaw: created = false")
	}
}

func TestRunStartedThenDataThenExit(t *testing.T) {
	h := newHarness(t)
	h.fake.Script("c1", func(r *supervisor.FakeRun) {
		for _, s := range []string{"one\n", "two\n", "three\n"} {
			_ = r.Write(shim.StdoutFile, []byte(s))
			time.Sleep(20 * time.Millisecond)
		}
		_ = r.Write(shim.StderrFile, []byte("err"))
		_ = r.Exit(0)
	})
	stream, err := h.client.Run(h.ctx(), connect.NewRequest(&agentv1.RunRequest{CommandId: "c1", Spec: argvSpec("/bin/x")}))
	if err != nil {
		t.Fatal(err)
	}
	evs, err := collect(t, stream)
	if err != nil {
		t.Fatal(err)
	}
	if len(evs) < 3 {
		t.Fatalf("events %v", evs)
	}
	if s := evs[0].GetStarted(); s == nil || s.GetCommandId() != "c1" || s.GetCommand().GetCommandId() != "c1" {
		t.Fatalf("first event %v, want started", evs[0])
	}
	if got := dataOf(t, evs, agentv1.Stream_STREAM_STDOUT, 0); got != "one\ntwo\nthree\n" {
		t.Fatalf("stdout %q", got)
	}
	if got := dataOf(t, evs, agentv1.Stream_STREAM_STDERR, 0); got != "err" {
		t.Fatalf("stderr %q", got)
	}
	last := evs[len(evs)-1].GetExit()
	if last == nil {
		t.Fatalf("last event %v, want exit", evs[len(evs)-1])
	}
	if last.GetStatus() != agentv1.ExitStatus_EXIT_STATUS_EXITED || last.GetCode() != 0 ||
		last.GetStdoutEnd() != 14 || last.GetStderrEnd() != 3 || last.GetReason() != agentv1.ExitReason_EXIT_REASON_NONE {
		t.Fatalf("exit %v", last)
	}
	for _, ev := range evs[1 : len(evs)-1] {
		if ev.GetStarted() != nil || ev.GetExit() != nil {
			t.Fatalf("unexpected event in the middle: %v", ev)
		}
	}
	got := h.rec.Of(events.TypeCommandExited)
	if len(got) != 1 {
		t.Fatalf("command.exited = %d events", len(got))
	}
	if ce := got[0].(*agentv1.CommandExited); ce.GetCommandId() != "c1" || ce.GetStdoutEnd() != 14 {
		t.Fatalf("command.exited %v", ce)
	}
}

func TestRunRepeatAttachesFromStart(t *testing.T) {
	h := newHarness(t)
	h.fake.Script("c1", func(r *supervisor.FakeRun) {
		_ = r.Write(shim.StdoutFile, []byte("hello"))
		_ = r.Exit(3)
	})
	for range 2 {
		stream, err := h.client.Run(h.ctx(), connect.NewRequest(&agentv1.RunRequest{CommandId: "c1", Spec: argvSpec("/bin/x")}))
		if err != nil {
			t.Fatal(err)
		}
		evs, err := collect(t, stream)
		if err != nil {
			t.Fatal(err)
		}
		if got := dataOf(t, evs, agentv1.Stream_STREAM_STDOUT, 0); got != "hello" {
			t.Fatalf("stdout %q", got)
		}
		if e := evs[len(evs)-1].GetExit(); e.GetCode() != 3 {
			t.Fatalf("exit %v", e)
		}
	}
	if n := len(h.fake.Launches()); n != 1 {
		t.Fatalf("launches = %d", n)
	}
}

// Kill of a STARTING record that was never launched ends it as
// KILLED/SIGNAL; a later Start retry must not launch it.
func TestKillUnlaunchedStarting(t *testing.T) {
	h := newHarness(t)
	spec := argvSpec("/bin/sleep", "100")
	putStarting(t, h, "c1", spec)
	h.restart("boot-1")
	grace := uint32(0)
	res, err := h.client.Kill(h.ctx(), connect.NewRequest(&agentv1.KillRequest{CommandId: "c1", GraceMs: &grace}))
	if err != nil {
		t.Fatal(err)
	}
	info := res.Msg.GetCommand()
	if e := info.GetExit(); info.GetState() != agentv1.CommandState_COMMAND_STATE_EXITED ||
		e.GetStatus() != agentv1.ExitStatus_EXIT_STATUS_KILLED || e.GetReason() != agentv1.ExitReason_EXIT_REASON_SIGNAL {
		t.Fatalf("state %v exit %v, want EXITED KILLED/SIGNAL", info.GetState(), e)
	}
	if got := h.rec.Of(events.TypeCommandExited); len(got) != 1 {
		t.Fatalf("command.exited events = %d, want 1", len(got))
	}
	if st := h.start("c1", spec).GetCommand().GetState(); st != agentv1.CommandState_COMMAND_STATE_EXITED {
		t.Fatalf("retry: state %v, want EXITED", st)
	}
	if n := len(h.fake.Launches()); n != 0 {
		t.Fatalf("launches = %d, want 0", n)
	}
}

// The retry of a kept STARTING record takes a slot like a new command.
func TestStartRetryRespectsLimit(t *testing.T) {
	h := newHarness(t, func(o *Options) { o.Config.MaxRunningCommands = 1 })
	spec := argvSpec("/bin/sleep", "1")
	putStarting(t, h, "c1", spec)
	h.restart("boot-1")
	h.start("c2", argvSpec("/bin/sleep", "100"))
	_, err := h.client.Start(h.ctx(), connect.NewRequest(&agentv1.StartRequest{CommandId: "c1", Spec: spec}))
	wantCode(t, err, connect.CodeResourceExhausted, errs.TooManyCommands)
	info, err := h.get("c1")
	if err != nil {
		t.Fatal(err)
	}
	if info.GetState() != agentv1.CommandState_COMMAND_STATE_STARTING {
		t.Fatalf("state %v, want STARTING", info.GetState())
	}
	if err := h.run("c2").Exit(0); err != nil {
		t.Fatal(err)
	}
	h.waitExited("c2")
	// The record is EXITED a moment before the slot is free.
	eventually(t, "slot of c2 freed", func() bool {
		running, _, _ := h.m.Counts()
		return running == 0
	})
	if st := h.start("c1", spec).GetCommand().GetState(); st != agentv1.CommandState_COMMAND_STATE_RUNNING {
		t.Fatalf("retry after the slot freed: state %v, want RUNNING", st)
	}
}

// A supervisor that takes the spec with the launch (Windows) gets the
// resolved spec as JSON; nothing is written under CmdSpecDir.
func TestStartUsesSpecLauncher(t *testing.T) {
	h := newHarness(t, func(o *Options) {
		o.Supervisor = supervisor.FakeSpecLauncher{Fake: o.Supervisor.(*supervisor.Fake)}
	})
	spec := argvSpec("/bin/sleep", "100")
	spec.Env = map[string]string{"SECRET": "v1"}
	if st := h.start("c1", spec).GetCommand().GetState(); st != agentv1.CommandState_COMMAND_STATE_RUNNING {
		t.Fatalf("state %v, want RUNNING", st)
	}
	ls := h.fake.Launches()
	if len(ls) != 1 || len(ls[0].Spec) == 0 {
		t.Fatalf("launches %+v, want one with the spec bytes", ls)
	}
	var ss shim.Spec
	if err := json.Unmarshal(ls[0].Spec, &ss); err != nil {
		t.Fatal(err)
	}
	if ss.ID != "c1" || !slices.Equal(ss.Argv, []string{"/bin/sleep", "100"}) || !slices.Contains(ss.Env, "SECRET=v1") {
		t.Fatalf("spec %+v", ss)
	}
	if ss.User != h.user {
		t.Fatalf("spec user %q, want %q", ss.User, h.user)
	}
	if !slices.Equal(h.run("c1").Spec().Argv, ss.Argv) {
		t.Fatalf("fake shim got argv %v", h.run("c1").Spec().Argv)
	}
	if exists(h.layout.CmdSpecDir) {
		t.Fatalf("%s created with a spec launcher", h.layout.CmdSpecDir)
	}
}

// Decision 2: no agent has the desktop helper yet (S10).
func TestStartDesktopNotReady(t *testing.T) {
	h := newHarness(t)
	spec := argvSpec("/bin/true")
	spec.Desktop = true
	_, err := h.client.Start(h.ctx(), connect.NewRequest(&agentv1.StartRequest{CommandId: "c1", Spec: spec}))
	wantCode(t, err, connect.CodeFailedPrecondition, errs.DesktopNotReady)
	if n := len(h.fake.Launches()); n != 0 {
		t.Fatalf("launches = %d, want 0", n)
	}
	if _, err := h.get("c1"); connect.CodeOf(err) != connect.CodeNotFound {
		t.Fatalf("Get after a refused Start: %v", err)
	}
}

// A colon names an alternate data stream on Windows: such an id never
// reaches the shim there.
func TestCommandIDForOS(t *testing.T) {
	for _, tt := range []struct {
		goos, id string
		ok       bool
	}{
		{"windows", "c1", true},
		{"windows", "a.b-c_d", true},
		{"windows", "a:b", false},
		{"windows", ":", false},
		{"linux", "a:b", true},
		{"darwin", "a:b", true},
	} {
		err := checkIDForOS(tt.goos, tt.id)
		if tt.ok {
			if err != nil {
				t.Errorf("%s %q: %v", tt.goos, tt.id, err)
			}
			continue
		}
		wantCode(t, err, connect.CodeInvalidArgument, errs.InvalidArgument)
	}
}

func TestStartWaitsForSecrets(t *testing.T) {
	var calls atomic.Int32
	var pendingSecrets atomic.Bool
	pendingSecrets.Store(true)
	h := newHarness(t, func(o *Options) {
		o.WaitSecrets = func(context.Context) error {
			calls.Add(1)
			if pendingSecrets.Load() {
				return errs.New(connect.CodeUnavailable, errs.SecretsPending, "secrets pending")
			}
			return nil
		}
	})
	spec := argvSpec("/bin/sleep", "100")
	_, err := h.client.Start(h.ctx(), connect.NewRequest(&agentv1.StartRequest{CommandId: "c1", Spec: spec}))
	wantCode(t, err, connect.CodeUnavailable, errs.SecretsPending)
	if _, err := h.get("c1"); connect.CodeOf(err) != connect.CodeNotFound {
		t.Fatalf("refused command has a record: %v", err)
	}
	if n := len(h.fake.Launches()); n != 0 {
		t.Fatalf("launches = %d, want 0", n)
	}

	pendingSecrets.Store(false)
	if res := h.start("c1", spec); !res.GetCreated() {
		t.Fatal("created = false after the secrets arrived")
	}

	// A repeat of an existing command answers without waiting.
	pendingSecrets.Store(true)
	before := calls.Load()
	if res := h.start("c1", spec); res.GetCreated() {
		t.Fatal("repeat created = true")
	}
	if calls.Load() != before {
		t.Error("a repeat of an existing command waited for the secrets")
	}
}
