package process

import (
	"os"
	"testing"
	"time"

	agentv1 "github.com/belov38/boat-dev-clone/libs/proto/sbx/agent/v1"

	"github.com/belov38/boat-dev-clone/services/guest-agent/internal/events"
	"github.com/belov38/boat-dev-clone/services/guest-agent/internal/fsutil"
	"github.com/belov38/boat-dev-clone/services/guest-agent/internal/shim"
	"github.com/belov38/boat-dev-clone/services/guest-agent/internal/shimproto"
	"github.com/belov38/boat-dev-clone/services/guest-agent/internal/store"
)

// putRunning stores a RUNNING record as a previous agent left it.
func putRunning(t *testing.T, h *harness, id, bootID string, spec *agentv1.CommandSpec) {
	t.Helper()
	hash, err := specHash(spec)
	if err != nil {
		t.Fatal(err)
	}
	stored, keys, err := storedSpec(spec)
	if err != nil {
		t.Fatal(err)
	}
	now := time.Now().UTC()
	err = h.st.PutCommand(t.Context(), &store.Command{ID: id, SpecHash: hash, Spec: stored, EnvKeys: keys,
		State: StateRunning, Pid: 4242, BootID: bootID, CreatedAt: now, StartedAt: now,
		PTY: spec.GetPty() != nil, AgentVersion: "1.0.0"})
	if err != nil {
		t.Fatal(err)
	}
	if err := os.MkdirAll(h.layout.CommandDir(id), 0o700); err != nil {
		t.Fatal(err)
	}
	streams := []string{shim.StdoutFile, shim.StderrFile}
	if spec.GetPty() != nil {
		streams = []string{shim.PtyFile}
	}
	for _, s := range streams {
		if err := os.WriteFile(cmdFile(h.layout, id, s), []byte("old"), 0o600); err != nil {
			t.Fatal(err)
		}
	}
	if err := fsutil.WriteJSONAtomic(cmdFile(h.layout, id, shim.ShimJSON),
		shim.ShimFile{State: shim.StateRunning, AgentVersion: "1.0.0", ShimProto: 1, Pid: 4242}, 0o600); err != nil {
		t.Fatal(err)
	}
}

func TestRecoverRebootMarksLost(t *testing.T) {
	h := newHarness(t)
	putRunning(t, h, "c1", "boot-0", argvSpec("/bin/sleep", "100"))
	putRunning(t, h, "c2", "boot-0", ptySpec())
	putRunning(t, h, "c3", "boot-0", argvSpec("/bin/true"))
	// c3 finished before the reboot, but the agent never recorded it.
	if err := fsutil.WriteJSONAtomic(cmdFile(h.layout, "c3", shim.ExitJSON),
		shimproto.ExitFile{Status: shimproto.StatusExited, Code: 4, Reason: shimproto.ReasonNone, StdoutEnd: 3, StderrEnd: 3,
			EndedAt: time.Now().UTC()}, 0o600); err != nil {
		t.Fatal(err)
	}
	h.restart("boot-1")

	for _, id := range []string{"c1", "c2"} {
		info, err := h.get(id)
		if err != nil {
			t.Fatal(err)
		}
		e := info.GetExit()
		if info.GetState() != agentv1.CommandState_COMMAND_STATE_EXITED ||
			e.GetStatus() != agentv1.ExitStatus_EXIT_STATUS_LOST || e.GetReason() != agentv1.ExitReason_EXIT_REASON_REBOOT {
			t.Fatalf("%s: state %v exit %v, want EXITED LOST/REBOOT", id, info.GetState(), e)
		}
	}
	info, err := h.get("c3")
	if err != nil {
		t.Fatal(err)
	}
	if info.GetExit().GetCode() != 4 || info.GetExit().GetStatus() != agentv1.ExitStatus_EXIT_STATUS_EXITED {
		t.Fatalf("c3 exit %v", info.GetExit())
	}

	exited := h.rec.Of(events.TypeCommandExited)
	if len(exited) != 3 {
		t.Fatalf("command.exited events = %d, want 3", len(exited))
	}
	reboot := 0
	for _, p := range exited {
		ce := p.(*agentv1.CommandExited)
		if ce.GetReason() == agentv1.ExitReason_EXIT_REASON_REBOOT {
			reboot++
			if ce.GetStdoutEnd()+ce.GetPtyEnd() != 3 {
				t.Fatalf("lost command ends %v, want current sizes", ce)
			}
		}
	}
	if reboot != 2 {
		t.Fatalf("REBOOT events = %d, want 2", reboot)
	}
	closed := h.rec.Of(events.TypePtyClosed)
	if len(closed) != 1 || closed[0].(*agentv1.PtyClosed).GetCommandId() != "c2" {
		t.Fatalf("pty.closed events %v", closed)
	}

	// Attach to a lost command ends with its exit after the retained output.
	evs, err := collect(t, mustAttach(t, h, &agentv1.AttachRequest{CommandId: "c1"}))
	if err != nil {
		t.Fatal(err)
	}
	if dataOf(t, evs, agentv1.Stream_STREAM_STDOUT, 0) != "old" || evs[len(evs)-1].GetExit() == nil {
		t.Fatalf("events %v", evs)
	}
}

func TestRecoverShimLost(t *testing.T) {
	h := newHarness(t)
	putRunning(t, h, "c1", "boot-1", argvSpec("/bin/sleep", "100"))
	h.restart("boot-1")
	info, err := h.get("c1")
	if err != nil {
		t.Fatal(err)
	}
	if e := info.GetExit(); e.GetStatus() != agentv1.ExitStatus_EXIT_STATUS_LOST || e.GetReason() != agentv1.ExitReason_EXIT_REASON_SHIM_LOST {
		t.Fatalf("exit %v, want LOST/SHIM_LOST", e)
	}
	if len(h.rec.Of(events.TypeCommandExited)) != 1 {
		t.Fatal("no command.exited")
	}
}

func TestRecoverReconnectsLiveShim(t *testing.T) {
	h := newHarness(t)
	h.start("c1", argvSpec("/bin/sleep", "100"))
	h.start("c2", argvSpec("/bin/sleep", "100"))
	h.restart("boot-1")
	if n := len(h.fake.Launches()); n != 2 {
		t.Fatalf("launches = %d", n)
	}
	running := h.waitRunning("c1")
	if running.GetPid() != int32(h.run("c1").Pid()) {
		t.Fatalf("pid %d", running.GetPid())
	}
	eventually(t, "running count after recover", func() bool {
		r, _, _ := h.m.Counts()
		return r == 2
	})

	// The new agent sees the exit through the reconnected socket.
	if err := h.run("c1").Exit(7); err != nil {
		t.Fatal(err)
	}
	info := h.waitExited("c1")
	if info.GetExit().GetCode() != 7 {
		t.Fatalf("exit %v", info.GetExit())
	}

	// A shim that dies while the agent is down ends as SHIM_LOST.
	h.srv.Close()
	if err := h.m.Close(); err != nil {
		t.Fatal(err)
	}
	h.run("c2").Die()
	h.startManager(true)
	info, err := h.get("c2")
	if err != nil {
		t.Fatal(err)
	}
	if info.GetExit().GetReason() != agentv1.ExitReason_EXIT_REASON_SHIM_LOST {
		t.Fatalf("c2 exit %v", info.GetExit())
	}
}

func TestShimDiesWhileMonitored(t *testing.T) {
	h := newHarness(t)
	h.start("c1", argvSpec("/bin/sleep", "100"))
	h.run("c1").Die()
	info := h.waitExited("c1")
	if info.GetExit().GetReason() != agentv1.ExitReason_EXIT_REASON_SHIM_LOST {
		t.Fatalf("exit %v", info.GetExit())
	}
}

func TestRecoverRestoresPTYIdle(t *testing.T) {
	h := newHarness(t, func(o *Options) { o.PTYIdle = 150 * time.Millisecond })
	h.start("c1", ptySpec())
	// Detached long ago according to the record: the new agent hangs up at once.
	rec, _, err := h.st.GetCommand("c1")
	if err != nil {
		t.Fatal(err)
	}
	h.srv.Close()
	if err := h.m.Close(); err != nil {
		t.Fatal(err)
	}
	old := time.Now().Add(-time.Hour).UTC()
	rec.PTYDetachedAt = &old
	if err := h.st.PutCommand(t.Context(), rec); err != nil {
		t.Fatal(err)
	}
	h.startManager(true)
	eventually(t, "pty idle kill after recover", func() bool { return len(h.run("c1").Kills()) > 0 })
	k := h.run("c1").Kills()[0]
	if k.Reason != shimproto.ReasonPTYIdle || k.FirstSignal != sigHUP {
		t.Fatalf("kill %+v", k)
	}
}
