package process

import (
	"bytes"
	"fmt"
	"runtime"
	"syscall"
	"testing"

	"connectrpc.com/connect"

	agentv1 "github.com/belov38/umiak/libs/proto/umiak/agent/v1"
	"github.com/belov38/umiak/libs/tunnel/rpcconv"

	"github.com/belov38/umiak/services/guest-agent/internal/errs"
	"github.com/belov38/umiak/services/guest-agent/internal/shim"
	"github.com/belov38/umiak/services/guest-agent/internal/shimproto"
	"github.com/belov38/umiak/services/guest-agent/internal/supervisor"
)

func (h *harness) sendInput(id, session string, seq uint64, data []byte, closeStdin bool) (*agentv1.SendInputResponse, error) {
	res, err := h.client.SendInput(h.ctx(), connect.NewRequest(&agentv1.SendInputRequest{
		CommandId: id, InputSessionId: session, Seq: seq, Data: data, CloseStdin: closeStdin}))
	if err != nil {
		return nil, err
	}
	return res.Msg, nil
}

func TestSendInput(t *testing.T) {
	h := newHarness(t)
	spec := argvSpec("/bin/cat")
	spec.Stdin = true
	h.start("c1", spec)

	res, err := h.sendInput("c1", "s1", 1, []byte("hi"), false)
	if err != nil || !res.GetApplied() {
		t.Fatalf("SendInput: %v %v", res, err)
	}
	res, err = h.sendInput("c1", "s1", 1, []byte("hi"), false)
	if err != nil || res.GetApplied() {
		t.Fatalf("duplicate SendInput: %v %v", res, err)
	}
	if _, err := h.sendInput("c1", "bad session!", 2, []byte("x"), false); err == nil {
		t.Fatal("bad session accepted")
	} else {
		wantCode(t, err, connect.CodeInvalidArgument, "")
	}
	_, err = h.sendInput("c1", "s1", 2, bytes.Repeat([]byte("x"), MaxInputBytes+1), false)
	wantCode(t, err, connect.CodeInvalidArgument, "")
	if _, err := h.sendInput("c1", "s1", 3, nil, true); err != nil {
		t.Fatal(err)
	}
	ins := h.run("c1").Inputs()
	if len(ins) != 2 || string(ins[0].Data) != "hi" || !ins[1].CloseStdin {
		t.Fatalf("inputs %+v", ins)
	}

	_, err = h.sendInput("nope", "s1", 1, []byte("x"), false)
	wantCode(t, err, connect.CodeNotFound, errs.CommandNotFound)
}

func TestSendInputAfterExit(t *testing.T) {
	h := newHarness(t)
	spec := argvSpec("/bin/cat")
	spec.Stdin = true
	h.start("c1", spec)
	if err := h.run("c1").Exit(0); err != nil {
		t.Fatal(err)
	}
	h.waitExited("c1")
	_, err := h.sendInput("c1", "s1", 1, []byte("late"), false)
	wantCode(t, err, connect.CodeFailedPrecondition, errs.CommandExited)
	_, err = h.client.Update(h.ctx(), connect.NewRequest(&agentv1.UpdateRequest{CommandId: "c1", Cols: 10, Rows: 10}))
	wantCode(t, err, connect.CodeFailedPrecondition, errs.CommandExited)
}

func TestUpdateResizesPTY(t *testing.T) {
	h := newHarness(t)
	h.start("c1", ptySpec())
	if _, err := h.client.Update(h.ctx(), connect.NewRequest(&agentv1.UpdateRequest{CommandId: "c1", Cols: 120, Rows: 50})); err != nil {
		t.Fatal(err)
	}
	if rs := h.run("c1").Resizes(); len(rs) != 1 || rs[0] != (supervisor.FakeResize{Cols: 120, Rows: 50}) {
		t.Fatalf("resizes %+v", rs)
	}
	_, err := h.client.Update(h.ctx(), connect.NewRequest(&agentv1.UpdateRequest{CommandId: "c1", Cols: 70000, Rows: 50}))
	wantCode(t, err, connect.CodeInvalidArgument, "")
}

func TestShimOutdated(t *testing.T) {
	h := newHarness(t)
	h.fake.Setup("c1", func(r *supervisor.FakeRun) { r.SetShimVersions(shimproto.Version+1, shimproto.Version+1) })
	h.start("c1", argvSpec("/bin/cat"))
	eventually(t, "shim marked outdated", func() bool {
		_, err := h.sendInput("c1", "s1", 1, []byte("x"), false)
		d, ok := rpcconvDetail(err)
		return ok && d == errs.ShimOutdated
	})
	_, err := h.client.Kill(h.ctx(), connect.NewRequest(&agentv1.KillRequest{CommandId: "c1"}))
	wantCode(t, err, connect.CodeFailedPrecondition, errs.ShimOutdated)
	// Kill without grace still works through the cgroup.
	grace := uint32(0)
	if _, err := h.client.Kill(h.ctx(), connect.NewRequest(&agentv1.KillRequest{CommandId: "c1", GraceMs: &grace})); err != nil {
		t.Fatal(err)
	}
	if h.fake.CgroupKills("c1") != 1 {
		t.Fatal("no cgroup kill")
	}
	h.waitExited("c1")
}

func TestKillNoopOnExited(t *testing.T) {
	h := newHarness(t)
	h.start("c1", argvSpec("/bin/true"))
	if err := h.run("c1").Exit(0); err != nil {
		t.Fatal(err)
	}
	h.waitExited("c1")
	res, err := h.client.Kill(h.ctx(), connect.NewRequest(&agentv1.KillRequest{CommandId: "c1"}))
	if err != nil {
		t.Fatal(err)
	}
	if res.Msg.GetCommand().GetExit().GetCode() != 0 {
		t.Fatalf("info %v", res.Msg.GetCommand())
	}
	sres, err := h.client.Signal(h.ctx(), connect.NewRequest(&agentv1.SignalRequest{CommandId: "c1", Signal: "SIGKILL"}))
	if err != nil || sres.Msg.GetCommand().GetState() != agentv1.CommandState_COMMAND_STATE_EXITED {
		t.Fatalf("Signal: %v %v", sres, err)
	}
	if len(h.run("c1").Kills()) != 0 || len(h.run("c1").Signals()) != 0 || h.fake.CgroupKills("c1") != 0 {
		t.Fatal("exited command was signalled")
	}
}

func TestKillRunning(t *testing.T) {
	h := newHarness(t)
	h.start("c1", argvSpec("/bin/sleep", "100"))
	if _, err := h.client.Kill(h.ctx(), connect.NewRequest(&agentv1.KillRequest{CommandId: "c1"})); err != nil {
		t.Fatal(err)
	}
	ks := h.run("c1").Kills()
	if len(ks) != 1 || ks[0].GraceMs != DefaultKillGraceMs || ks[0].Reason != shimproto.ReasonSignal {
		t.Fatalf("kills %+v", ks)
	}
	info := h.waitExited("c1")
	if info.GetExit().GetStatus() != agentv1.ExitStatus_EXIT_STATUS_KILLED || info.GetExit().GetSignal() != "SIGTERM" {
		t.Fatalf("exit %v", info.GetExit())
	}
}

func TestKillLeftoversAfterExit(t *testing.T) {
	h := newHarness(t)
	h.fake.Setup("c1", func(r *supervisor.FakeRun) { r.SetLeftovers(true) })
	h.start("c1", argvSpec("/bin/sh"))
	if err := h.run("c1").Exit(0); err != nil {
		t.Fatal(err)
	}
	h.waitInfo("c1", "exited with leftovers", func(i *agentv1.CommandInfo) bool {
		return i.GetState() == agentv1.CommandState_COMMAND_STATE_EXITED && i.GetHasLeftovers()
	})
	running, _, _ := h.m.Counts()
	if running != 1 {
		t.Fatalf("running = %d, want 1 (leftovers)", running)
	}
	_, err := h.client.Remove(h.ctx(), connect.NewRequest(&agentv1.ProcessRemoveRequest{CommandId: "c1"}))
	wantCode(t, err, connect.CodeFailedPrecondition, errs.CommandRunning)

	if _, err := h.client.Signal(h.ctx(), connect.NewRequest(&agentv1.SignalRequest{CommandId: "c1", Signal: "KILL"})); err != nil {
		t.Fatal(err)
	}
	if ss := h.run("c1").Signals(); len(ss) != 1 || ss[0].Sig != sigKILL || !ss[0].Cgroup {
		t.Fatalf("signals %+v", ss)
	}
	h.waitInfo("c1", "leftovers gone", func(i *agentv1.CommandInfo) bool { return !i.GetHasLeftovers() })
	eventually(t, "running drops", func() bool {
		r, _, _ := h.m.Counts()
		return r == 0
	})
}

func TestSignal(t *testing.T) {
	h := newHarness(t)
	h.fake.Setup("c1", func(r *supervisor.FakeRun) { r.IgnoreSignals() })
	h.start("c1", argvSpec("/bin/sleep", "100"))
	// Windows delivers only INT, TERM, KILL and HUP of a pty (S9 spec 12.6).
	last, lastNum, bads := "SIGUSR1", syscall.Signal(10), []string{"", "SIGNOPE", "0", "65", "-1"}
	if runtime.GOOS == "windows" {
		last, lastNum, bads = "SIGTERM", 15, append(bads, "SIGUSR1")
	}
	for _, s := range []string{"SIGINT", "INT", "2", last} {
		if _, err := h.client.Signal(h.ctx(), connect.NewRequest(&agentv1.SignalRequest{CommandId: "c1", Signal: s})); err != nil {
			t.Fatalf("Signal %s: %v", s, err)
		}
	}
	ss := h.run("c1").Signals()
	if len(ss) != 4 || ss[0].Sig != 2 || ss[2].Sig != 2 || ss[3].Sig != lastNum || ss[0].Cgroup {
		t.Fatalf("signals %+v", ss)
	}
	for _, bad := range bads {
		_, err := h.client.Signal(h.ctx(), connect.NewRequest(&agentv1.SignalRequest{CommandId: "c1", Signal: bad}))
		wantCode(t, err, connect.CodeInvalidArgument, "")
	}
}

func TestListPaging(t *testing.T) {
	h := newHarness(t)
	for i := range 5 {
		spec := argvSpec("/bin/sleep", "100")
		if i%2 == 0 {
			spec.Tags = map[string]string{"group": "even"}
		}
		h.start(fmt.Sprintf("c%d", i), spec)
	}
	if err := h.run("c4").Exit(0); err != nil {
		t.Fatal(err)
	}
	h.waitExited("c4")

	var ids []string
	token := ""
	pages := 0
	for {
		res, err := h.client.List(h.ctx(), connect.NewRequest(&agentv1.ProcessListRequest{PageSize: 2, PageToken: token}))
		if err != nil {
			t.Fatal(err)
		}
		pages++
		for _, c := range res.Msg.GetCommands() {
			ids = append(ids, c.GetCommandId())
		}
		token = res.Msg.GetNextPageToken()
		if token == "" {
			break
		}
	}
	if fmt.Sprint(ids) != "[c0 c1 c2 c3 c4]" || pages != 3 {
		t.Fatalf("ids %v in %d pages", ids, pages)
	}

	res, err := h.client.List(h.ctx(), connect.NewRequest(&agentv1.ProcessListRequest{Tags: map[string]string{"group": "even"}}))
	if err != nil {
		t.Fatal(err)
	}
	if got := idsOf(res.Msg.GetCommands()); fmt.Sprint(got) != "[c0 c2 c4]" {
		t.Fatalf("tag filter %v", got)
	}
	res, err = h.client.List(h.ctx(), connect.NewRequest(&agentv1.ProcessListRequest{State: agentv1.CommandState_COMMAND_STATE_EXITED}))
	if err != nil {
		t.Fatal(err)
	}
	if got := idsOf(res.Msg.GetCommands()); fmt.Sprint(got) != "[c4]" {
		t.Fatalf("state filter %v", got)
	}
	_, err = h.client.List(h.ctx(), connect.NewRequest(&agentv1.ProcessListRequest{PageSize: 1001}))
	if err != nil {
		t.Fatalf("page size above the max must be clamped: %v", err)
	}
}

func idsOf(cs []*agentv1.CommandInfo) []string {
	out := make([]string, 0, len(cs))
	for _, c := range cs {
		out = append(out, c.GetCommandId())
	}
	return out
}

func TestRemoveRunningRefused(t *testing.T) {
	h := newHarness(t)
	h.start("c1", argvSpec("/bin/sleep", "100"))
	_, err := h.client.Remove(h.ctx(), connect.NewRequest(&agentv1.ProcessRemoveRequest{CommandId: "c1"}))
	wantCode(t, err, connect.CodeFailedPrecondition, errs.CommandRunning)

	if err := h.run("c1").Write(shim.StdoutFile, []byte("x")); err != nil {
		t.Fatal(err)
	}
	if err := h.run("c1").Exit(0); err != nil {
		t.Fatal(err)
	}
	h.waitExited("c1")
	res, err := h.client.Remove(h.ctx(), connect.NewRequest(&agentv1.ProcessRemoveRequest{CommandId: "c1"}))
	if err != nil || !res.Msg.GetRemoved() {
		t.Fatalf("Remove: %v %v", res, err)
	}
	if exists(h.layout.CommandDir("c1")) {
		t.Fatal("command dir left behind")
	}
	if _, err := h.get("c1"); connect.CodeOf(err) != connect.CodeNotFound {
		t.Fatalf("Get after Remove: %v", err)
	}
	res, err = h.client.Remove(h.ctx(), connect.NewRequest(&agentv1.ProcessRemoveRequest{CommandId: "c1"}))
	if err != nil || res.Msg.GetRemoved() {
		t.Fatalf("repeated Remove: %v %v", res, err)
	}
}

func TestJanitorHooks(t *testing.T) {
	h := newHarness(t)
	h.start("c1", argvSpec("/bin/true"))
	h.start("c2", ptySpec())
	if err := h.run("c1").Exit(0); err != nil {
		t.Fatal(err)
	}
	h.waitExited("c1")
	jc := h.m.JanitorCommands()
	if len(jc) != 2 || jc[0].ID != "c1" || !jc[0].Exited || jc[0].EndedAt.IsZero() ||
		fmt.Sprint(jc[0].Streams) != "[stdout stderr]" || jc[1].Exited || fmt.Sprint(jc[1].Streams) != "[pty]" {
		t.Fatalf("janitor commands %+v", jc)
	}
	if err := h.m.RemoveRecord("c2"); err == nil {
		t.Fatal("RemoveRecord of a running command succeeded")
	}
	if err := h.m.RemoveRecord("c1"); err != nil {
		t.Fatal(err)
	}
	if _, err := h.get("c1"); connect.CodeOf(err) != connect.CodeNotFound {
		t.Fatalf("Get after RemoveRecord: %v", err)
	}
	// The log directory goes under the record lock, together with the
	// record: a new command with the same id cannot lose its logs.
	if exists(h.layout.CommandDir("c1")) {
		t.Fatal("log dir of c1 still exists after RemoveRecord")
	}
}

func rpcconvDetail(err error) (string, bool) {
	d, ok := rpcconv.Detail(err)
	return d.GetCode(), ok
}

func TestUnsupportedSignalWindowsTable(t *testing.T) {
	tests := []struct {
		goos string
		sig  int
		pty  bool
		ok   bool
	}{
		{"windows", 2, false, true},  // SIGINT: CTRL_BREAK
		{"windows", 15, false, true}, // SIGTERM: CTRL_BREAK
		{"windows", 9, false, true},  // SIGKILL: TerminateJobObject
		{"windows", 2, true, true},   // SIGINT: 0x03 to the ConPTY
		{"windows", 15, true, true},
		{"windows", 9, true, true},
		{"windows", 1, true, true},   // SIGHUP: ClosePseudoConsole
		{"windows", 1, false, false}, // SIGHUP without a PTY
		{"windows", 10, false, false},
		{"windows", 10, true, false},
		{"windows", 3, false, false},
		{"windows", 19, true, false},
		{"windows", 28, true, false},
		{"linux", 1, false, true},
		{"linux", 10, false, true},
		{"linux", 28, true, true},
		{"linux", 64, false, true},
	}
	for _, tt := range tests {
		err := signalSupported(tt.goos, tt.sig, tt.pty)
		if tt.ok {
			if err != nil {
				t.Errorf("%s sig %d pty %v: %v", tt.goos, tt.sig, tt.pty, err)
			}
			continue
		}
		wantCode(t, err, connect.CodeInvalidArgument, errs.UnsupportedSignal)
	}
}

// Remove and the janitor stop what is left of the unit: on Windows the
// empty permanent job of a dead shim, which would block a new Start.
func TestRemoveStopsUnit(t *testing.T) {
	h := newHarness(t)
	h.start("c1", argvSpec("/bin/true"))
	h.start("c2", argvSpec("/bin/true"))
	_, err := h.client.Remove(h.ctx(), connect.NewRequest(&agentv1.ProcessRemoveRequest{CommandId: "c1"}))
	wantCode(t, err, connect.CodeFailedPrecondition, errs.CommandRunning)
	if s := h.fake.Stops(); len(s) != 0 {
		t.Fatalf("stops after a refused Remove: %v", s)
	}
	for _, id := range []string{"c1", "c2"} {
		if err := h.run(id).Exit(0); err != nil {
			t.Fatal(err)
		}
		h.waitExited(id)
	}
	if _, err := h.client.Remove(h.ctx(), connect.NewRequest(&agentv1.ProcessRemoveRequest{CommandId: "c1"})); err != nil {
		t.Fatal(err)
	}
	if err := h.m.RemoveRecord("c2"); err != nil {
		t.Fatal(err)
	}
	if s := h.fake.Stops(); fmt.Sprint(s) != "[c1 c2]" {
		t.Fatalf("stops = %v, want [c1 c2]", s)
	}
}
