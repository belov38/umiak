package process

import (
	"context"
	"errors"
	"os"
	"sync/atomic"
	"testing"
	"time"

	"connectrpc.com/connect"

	agentv1 "github.com/belov38/boat-dev-clone/libs/proto/sbx/agent/v1"

	"github.com/belov38/boat-dev-clone/services/guest-agent/internal/errs"
	"github.com/belov38/boat-dev-clone/services/guest-agent/internal/events"
	"github.com/belov38/boat-dev-clone/services/guest-agent/internal/fsutil"
	"github.com/belov38/boat-dev-clone/services/guest-agent/internal/shimproto"
	"github.com/belov38/boat-dev-clone/services/guest-agent/internal/store"
	"github.com/belov38/boat-dev-clone/services/guest-agent/internal/supervisor"
)

// A Start that waited for the record lock while the holder failed and
// forgot the entry must work on a fresh, registered entry.
func TestStartAfterFailedConcurrentStart(t *testing.T) {
	h := newHarness(t)
	spec := argvSpec("/bin/cat")
	spec.Stdin = true
	h.st.SetFrozen(true)
	defer h.st.SetFrozen(false)

	first := make(chan error, 1)
	go func() {
		ctx, cancel := context.WithTimeout(t.Context(), 300*time.Millisecond)
		defer cancel()
		_, _, err := h.m.Start(ctx, "x", spec)
		first <- err
	}()
	time.Sleep(50 * time.Millisecond) // the first Start holds the lock
	second := make(chan error, 1)
	go func() {
		ctx, cancel := context.WithTimeout(t.Context(), 5*time.Second)
		defer cancel()
		_, _, err := h.m.Start(ctx, "x", spec)
		second <- err
	}()
	err := <-first
	wantCode(t, err, connect.CodeUnavailable, errs.Quiesced)
	h.st.SetFrozen(false)
	if err := <-second; err != nil {
		t.Fatalf("second Start: %v", err)
	}

	res, err := h.sendInput("x", "s1", 1, []byte("hi"), false)
	if err != nil || !res.GetApplied() {
		t.Fatalf("SendInput: %v %v", res, err)
	}
	if running, _, _ := h.m.Counts(); running != 1 {
		t.Fatalf("running = %d, want 1", running)
	}
	if n := len(h.fake.Launches()); n != 1 {
		t.Fatalf("launches = %d", n)
	}
}

// A handler waiting for a command's record lock gives up with its own
// deadline: quiesced while the store is frozen.
func TestRecordLockHonorsDeadline(t *testing.T) {
	h := newHarness(t)
	h.st.SetFrozen(true)
	defer h.st.SetFrozen(false)
	go func() {
		ctx, cancel := context.WithTimeout(t.Context(), 2*time.Second)
		defer cancel()
		_, _, _ = h.m.Start(ctx, "x", argvSpec("/bin/true"))
	}()
	time.Sleep(50 * time.Millisecond)
	ctx, cancel := context.WithTimeout(t.Context(), 200*time.Millisecond)
	defer cancel()
	start := time.Now()
	_, err := h.m.Remove(ctx, "x")
	wantCode(t, err, connect.CodeUnavailable, errs.Quiesced)
	if d := time.Since(start); d > time.Second {
		t.Fatalf("Remove waited %v", d)
	}
}

// failingSup fails Launch and freezes the store while it is armed, so the
// START_FAILED record cannot be written.
type failingSup struct {
	*supervisor.Fake
	st   *store.Store
	fail atomic.Bool
}

func (s *failingSup) Launch(ctx context.Context, id, shimPath string, extra []string) error {
	if s.fail.Load() {
		s.st.SetFrozen(true)
		return errors.New("dbus gone")
	}
	return s.Fake.Launch(ctx, id, shimPath, extra)
}

func TestStartFailedWriteEmitsNothing(t *testing.T) {
	var sup *failingSup
	h := newHarness(t, func(o *Options) {
		sup = &failingSup{Fake: o.Supervisor.(*supervisor.Fake), st: o.Store}
		sup.fail.Store(true)
		o.Supervisor = sup
	})
	defer h.st.SetFrozen(false)
	ctx, cancel := context.WithTimeout(t.Context(), 300*time.Millisecond)
	defer cancel()
	_, _, err := h.m.Start(ctx, "c1", argvSpec("/bin/true"))
	wantCode(t, err, connect.CodeUnavailable, errs.Quiesced)
	if n := len(h.rec.Of(events.TypeCommandExited)); n != 0 {
		t.Fatalf("command.exited emitted for an unwritten record: %d", n)
	}
	sup.fail.Store(false)
	h.st.SetFrozen(false)
	// The record is still STARTING without a trace: the retry launches.
	res := h.start("c1", argvSpec("/bin/true"))
	if res.GetCommand().GetState() != agentv1.CommandState_COMMAND_STATE_RUNNING {
		t.Fatalf("state %v", res.GetCommand().GetState())
	}
	if n := len(h.rec.Of(events.TypeCommandExited)); n != 0 {
		t.Fatalf("command.exited events = %d", n)
	}
}

// The retry of a STARTING PTY record whose unit was launched before the
// crash arms the idle timer through the monitor path.
func TestPTYIdleArmedOnRetryPath(t *testing.T) {
	h := newHarness(t, func(o *Options) { o.PTYIdle = 100 * time.Millisecond })
	spec := ptySpec()
	putStarting(t, h, "c1", spec)
	ss, err := h.m.shimSpec("c1", spec)
	if err != nil {
		t.Fatal(err)
	}
	if err := os.MkdirAll(h.layout.CmdSpecDir, 0o700); err != nil {
		t.Fatal(err)
	}
	if err := fsutil.WriteJSONAtomic(h.layout.CmdSpec("c1"), ss, 0o600); err != nil {
		t.Fatal(err)
	}
	if err := h.fake.Launch(t.Context(), "c1", h.opts.ShimPath, nil); err != nil {
		t.Fatal(err)
	}
	h.start("c1", spec)
	if n := len(h.fake.Launches()); n != 1 {
		t.Fatalf("launches = %d", n)
	}
	eventually(t, "idle kill", func() bool { return len(h.run("c1").Kills()) > 0 })
	if k := h.run("c1").Kills()[0]; k.Reason != shimproto.ReasonPTYIdle {
		t.Fatalf("kill %+v", k)
	}
}

// A never attached PTY keeps counting from its creation across a restart.
func TestRecoverNeverAttachedPTY(t *testing.T) {
	h := newHarness(t, func(o *Options) { o.PTYIdle = 400 * time.Millisecond })
	h.start("c1", ptySpec())
	rec, _, err := h.st.GetCommand("c1")
	if err != nil {
		t.Fatal(err)
	}
	if rec.PTYDetachedAt == nil || !rec.PTYDetachedAt.Equal(rec.CreatedAt) {
		t.Fatalf("pty_detached_at %v, created_at %v", rec.PTYDetachedAt, rec.CreatedAt)
	}
	h.srv.Close()
	if err := h.m.Close(); err != nil {
		t.Fatal(err)
	}
	time.Sleep(450 * time.Millisecond)
	start := time.Now()
	h.startManager(true)
	eventually(t, "idle kill after restart", func() bool { return len(h.run("c1").Kills()) > 0 })
	if d := time.Since(start); d > 300*time.Millisecond {
		t.Fatalf("idle kill %v after restart, want at once", d)
	}
}

// A record of an older agent without pty_detached_at gets the recovery time
// persisted.
func TestRecoverPersistsDetachTime(t *testing.T) {
	h := newHarness(t)
	h.start("c1", ptySpec())
	h.srv.Close()
	if err := h.m.Close(); err != nil {
		t.Fatal(err)
	}
	rec, _, err := h.st.GetCommand("c1")
	if err != nil {
		t.Fatal(err)
	}
	rec.PTYDetachedAt = nil
	if err := h.st.PutCommand(t.Context(), rec); err != nil {
		t.Fatal(err)
	}
	h.startManager(true)
	eventually(t, "detach time persisted", func() bool {
		r, _, _ := h.st.GetCommand("c1")
		return r != nil && r.PTYDetachedAt != nil
	})
}

// Kill of a live unit whose shim cannot be reached must not skip the grace.
func TestKillUnreachableShim(t *testing.T) {
	h := newHarness(t)
	putRunning(t, h, "c1", "boot-1", argvSpec("/bin/sleep", "100"))
	h.fake.SetState("c1", supervisor.UnitActive) // a unit without a socket
	h.restart("boot-1")
	grace := uint32(5000)
	_, err := h.client.Kill(h.ctx(), connect.NewRequest(&agentv1.KillRequest{CommandId: "c1", GraceMs: &grace}))
	wantCode(t, err, connect.CodeUnavailable, errs.ShimUnavailable)
	// Without a grace there is nothing to wait for: the agent kills the
	// cgroup itself.
	grace = 0
	if _, err := h.client.Kill(h.ctx(), connect.NewRequest(&agentv1.KillRequest{CommandId: "c1", GraceMs: &grace})); err != nil {
		t.Fatal(err)
	}
	if n := h.fake.CgroupKills("c1"); n != 1 {
		t.Fatalf("cgroup kills = %d, want 1", n)
	}
	// Once the unit is gone the command is lost; Kill is then a no-op.
	h.fake.ClearState("c1")
	h.waitExited("c1")
	if _, err := h.client.Kill(h.ctx(), connect.NewRequest(&agentv1.KillRequest{CommandId: "c1"})); err != nil {
		t.Fatal(err)
	}
}

// Recover reconnects to the shim of an exited command whose leftovers still
// run (its socket is there) and reports them again.
func TestRecoverExitedWithLeftovers(t *testing.T) {
	h := newHarness(t)
	h.fake.Setup("c1", func(r *supervisor.FakeRun) { r.SetLeftovers(true) })
	h.start("c1", argvSpec("/bin/sh"))
	if err := h.run("c1").Exit(0); err != nil {
		t.Fatal(err)
	}
	h.waitInfo("c1", "leftovers", func(i *agentv1.CommandInfo) bool { return i.GetHasLeftovers() })
	h.restart("boot-1")
	h.waitInfo("c1", "leftovers after restart", func(i *agentv1.CommandInfo) bool { return i.GetHasLeftovers() })
	if running, _, _ := h.m.Counts(); running != 1 {
		t.Fatalf("running = %d", running)
	}
}
