package supervisor

import (
	"bytes"
	"context"
	"errors"
	"os"
	"path/filepath"
	"strings"
	"syscall"
	"testing"
	"time"

	"github.com/belov38/umiak/services/guest-agent/internal/fsutil"
	"github.com/belov38/umiak/services/guest-agent/internal/paths"
	"github.com/belov38/umiak/services/guest-agent/internal/shim"
	"github.com/belov38/umiak/services/guest-agent/internal/shimproto"
)

// newTestFake returns a Fake over a layout in a short temporary root: darwin
// limits unix socket paths to 104 bytes, too few for t.TempDir().
func newTestFake(t *testing.T) (*Fake, paths.Layout) {
	t.Helper()
	root, err := os.MkdirTemp("", "sv")
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = os.RemoveAll(root) })
	l := paths.ForRoot(root)
	f := NewFake(l)
	t.Cleanup(func() { _ = f.Close() })
	return f, l
}

// writeSpec writes the spec file of id as the agent does before Launch.
func writeSpec(t *testing.T, l paths.Layout, s shim.Spec) {
	t.Helper()
	if err := os.MkdirAll(l.CmdSpecDir, 0o700); err != nil {
		t.Fatal(err)
	}
	if err := fsutil.WriteJSONAtomic(l.CmdSpec(s.ID), s, 0o600); err != nil {
		t.Fatal(err)
	}
}

func launch(t *testing.T, f *Fake, l paths.Layout, s shim.Spec) *FakeRun {
	t.Helper()
	writeSpec(t, l, s)
	if err := f.Launch(t.Context(), s.ID, "/usr/local/lib/umiak-agent/current/umiak-agent", nil); err != nil {
		t.Fatalf("Launch: %v", err)
	}
	r := f.Run(s.ID)
	if r == nil {
		t.Fatal("Run returned nil after Launch")
	}
	return r
}

func dialShim(t *testing.T, l paths.Layout, id string) *shimproto.Client {
	t.Helper()
	ctx, cancel := context.WithTimeout(t.Context(), 5*time.Second)
	defer cancel()
	c, err := shimproto.Dial(ctx, l.ShimSocket(id))
	if err != nil {
		t.Fatalf("Dial: %v", err)
	}
	t.Cleanup(func() { _ = c.Close() })
	return c
}

func readExit(t *testing.T, l paths.Layout, id string) shimproto.ExitFile {
	t.Helper()
	var e shimproto.ExitFile
	if err := fsutil.ReadJSON(filepath.Join(l.CommandDir(id), shim.ExitJSON), &e); err != nil {
		t.Fatalf("read exit.json: %v", err)
	}
	return e
}

func waitExited(t *testing.T, c *shimproto.Client) shimproto.ExitFile {
	t.Helper()
	select {
	case e := <-c.Exited():
		return e
	case <-time.After(5 * time.Second):
		t.Fatal("no exited push")
		return shimproto.ExitFile{}
	}
}

func waitState(t *testing.T, f *Fake, id string, want UnitState) {
	t.Helper()
	deadline := time.Now().Add(5 * time.Second)
	for {
		st, err := f.State(t.Context(), id)
		if err != nil {
			t.Fatal(err)
		}
		if st == want {
			return
		}
		if time.Now().After(deadline) {
			t.Fatalf("state = %v, want %v", st, want)
		}
		time.Sleep(5 * time.Millisecond)
	}
}

func isShimErr(err error, code string) bool {
	var pe *shimproto.Error
	return errors.As(err, &pe) && pe.Code == code
}

func TestFakeLaunchTwiceExists(t *testing.T) {
	f, l := newTestFake(t)
	spec := shim.Spec{ID: "c1", Argv: []string{"sleep", "60"}, AgentVersion: "v1"}
	r := launch(t, f, l, spec)

	writeSpec(t, l, spec)
	if err := f.Launch(t.Context(), "c1", "/bin/agent", nil); !errors.Is(err, ErrUnitExists) {
		t.Fatalf("second Launch = %v, want ErrUnitExists", err)
	}
	ls := f.Launches()
	if len(ls) != 2 {
		t.Fatalf("Launches = %d, want 2 (every call is recorded)", len(ls))
	}
	if got := strings.Join(ls[1].Argv, " "); got != "/bin/agent shim --id c1" {
		t.Fatalf("argv = %q", got)
	}

	var sf shim.ShimFile
	if err := fsutil.ReadJSON(filepath.Join(l.CommandDir("c1"), shim.ShimJSON), &sf); err != nil {
		t.Fatal(err)
	}
	if sf.State != shim.StateRunning || sf.Pid != r.Pid() || sf.AgentVersion != "v1" || sf.ShimProto != shimproto.Version {
		t.Fatalf("shim.json = %+v", sf)
	}
	if _, err := os.Stat(l.CmdSpec("c1")); err != nil {
		// The second spec stays: the refused Launch never started a shim.
		t.Fatalf("spec of the refused launch: %v", err)
	}

	// After the exit the unit is collected and the id can be launched again.
	if err := r.Exit(0); err != nil {
		t.Fatal(err)
	}
	waitState(t, f, "c1", UnitNotFound)
	if err := f.Launch(t.Context(), "c1", "/bin/agent", nil); err != nil {
		t.Fatalf("Launch after exit: %v", err)
	}
}

func TestFakeServesShimProto(t *testing.T) {
	f, l := newTestFake(t)
	r := launch(t, f, l, shim.Spec{ID: "c1", Argv: []string{"sleep", "60"}, Stdin: true})
	c := dialShim(t, l, "c1")
	ctx := t.Context()

	st, err := c.Status(ctx)
	if err != nil {
		t.Fatal(err)
	}
	if st.Pid != r.Pid() || st.State != shimproto.StateRunning || st.Exited {
		t.Fatalf("status = %+v", st)
	}

	if err := r.Write(shim.StdoutFile, []byte("hello\n")); err != nil {
		t.Fatal(err)
	}
	if ok, err := c.Input(ctx, "s1", 1, []byte("in"), false); err != nil || !ok {
		t.Fatalf("Input = %v, %v", ok, err)
	}
	if ok, err := c.Input(ctx, "s1", 1, []byte("in"), false); err != nil || ok {
		t.Fatalf("duplicate Input = %v, %v, want not applied", ok, err)
	}
	if err := c.Resize(ctx, 80, 24); !isShimErr(err, shimproto.CodeFailedPrecondition) {
		t.Fatalf("Resize without pty = %v", err)
	}
	if got := r.Inputs(); len(got) != 1 || string(got[0].Data) != "in" {
		t.Fatalf("inputs = %+v", got)
	}
	if st, _ := c.Status(ctx); st.LastSeq["s1"] != 1 {
		t.Fatalf("last_seq = %v", st.LastSeq)
	}

	if err := c.Kill(ctx, 1000, 0, shimproto.ReasonTimeout); err != nil {
		t.Fatal(err)
	}
	e := waitExited(t, c)
	if e.Status != shimproto.StatusKilled || e.Signal != "SIGTERM" || e.Code != 128+15 ||
		e.Reason != shimproto.ReasonTimeout || e.StdoutEnd != 6 {
		t.Fatalf("exited = %+v", e)
	}
	if k := r.Kills(); len(k) != 1 || k[0].GraceMs != 1000 || k[0].Reason != shimproto.ReasonTimeout {
		t.Fatalf("kills = %+v", k)
	}
	if got := readExit(t, l, "c1"); got.Reason != e.Reason || got.StdoutEnd != e.StdoutEnd {
		t.Fatalf("exit.json = %+v, push %+v", got, e)
	}
	// Without leftovers the shim ends: the socket closes, the unit goes away.
	select {
	case <-c.Done():
	case <-time.After(5 * time.Second):
		t.Fatal("connection not closed after exit")
	}
	waitState(t, f, "c1", UnitNotFound)
	if _, err := os.Stat(l.ShimSocket("c1")); !errors.Is(err, os.ErrNotExist) {
		t.Fatalf("socket after exit: %v", err)
	}
}

func TestFakeRequestErrors(t *testing.T) {
	f, l := newTestFake(t)
	r := launch(t, f, l, shim.Spec{ID: "p1", Argv: []string{"bash"}, PTY: &shim.PTYSpec{Cols: 80, Rows: 24}})
	c := dialShim(t, l, "p1")
	ctx := t.Context()

	tests := []struct {
		name string
		call func() error
		code string
	}{
		{"bad session", func() error { _, err := c.Input(ctx, "a b", 1, []byte("x"), false); return err }, shimproto.CodeInvalidArgument},
		{"close stdin on pty", func() error { _, err := c.Input(ctx, "s", 1, nil, true); return err }, shimproto.CodeFailedPrecondition},
		{"zero resize", func() error { return c.Resize(ctx, 0, 24) }, shimproto.CodeInvalidArgument},
		{"bad signal", func() error { return c.Signal(ctx, 99, false) }, shimproto.CodeInvalidArgument},
		{"bad kill reason", func() error { return c.Kill(ctx, 0, 0, "OOM") }, shimproto.CodeInvalidArgument},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			if err := tt.call(); !isShimErr(err, tt.code) {
				t.Fatalf("err = %v, want %s", err, tt.code)
			}
		})
	}

	if err := c.Resize(ctx, 100, 30); err != nil {
		t.Fatal(err)
	}
	if got := r.Resizes(); len(got) != 1 || got[0] != (FakeResize{Cols: 100, Rows: 30}) {
		t.Fatalf("resizes = %+v", got)
	}
	// SIGWINCH is recorded and does not end the command.
	if err := c.Signal(ctx, syscall.Signal(28), false); err != nil {
		t.Fatal(err)
	}
	if r.Exited() || len(r.Signals()) != 1 {
		t.Fatalf("exited %v, signals %+v", r.Exited(), r.Signals())
	}
}

func TestFakeExitWithLeftovers(t *testing.T) {
	f, l := newTestFake(t)
	r := launch(t, f, l, shim.Spec{ID: "c1", Argv: []string{"cat"}, Stdin: true})
	r.SetLeftovers(true) // keeps the shim and its socket after the exit
	c := dialShim(t, l, "c1")
	ctx := t.Context()

	if err := r.Exit(3); err != nil {
		t.Fatal(err)
	}
	if e := waitExited(t, c); e.Code != 3 || e.Status != shimproto.StatusExited || e.Reason != shimproto.ReasonNone {
		t.Fatalf("exited = %+v", e)
	}
	if _, err := c.Input(ctx, "s", 1, []byte("x"), false); !isShimErr(err, shimproto.CodeCommandExited) {
		t.Fatalf("Input after exit = %v", err)
	}
	st, err := c.Status(ctx)
	if err != nil {
		t.Fatal(err)
	}
	if !st.Exited || st.State != shimproto.StateExited || !st.Leftovers {
		t.Fatalf("status = %+v", st)
	}
	if s, _ := f.State(ctx, "c1"); s != UnitActive {
		t.Fatalf("state with leftovers = %v", s)
	}
	// Signal(SIGKILL) after the exit kills the leftovers and ends the shim.
	if err := c.Signal(ctx, syscall.SIGKILL, false); err != nil {
		t.Fatal(err)
	}
	waitState(t, f, "c1", UnitNotFound)
	if e := readExit(t, l, "c1"); e.Code != 3 {
		t.Fatalf("exit.json changed by the leftover kill: %+v", e)
	}
}

func TestFakeIgnoredKillEndsAfterGrace(t *testing.T) {
	f, l := newTestFake(t)
	f.Setup("c1", func(r *FakeRun) { r.IgnoreSignals() })
	r := launch(t, f, l, shim.Spec{ID: "c1", Argv: []string{"sleep", "60"}})
	c := dialShim(t, l, "c1")

	start := time.Now()
	if err := c.Kill(t.Context(), 100, syscall.SIGHUP, shimproto.ReasonPTYIdle); err != nil {
		t.Fatal(err)
	}
	e := waitExited(t, c)
	if time.Since(start) < 100*time.Millisecond {
		t.Fatal("killed before the grace")
	}
	if e.Signal != "SIGKILL" || e.Reason != shimproto.ReasonPTYIdle {
		t.Fatalf("exited = %+v", e)
	}
	if k := r.Kills(); len(k) != 1 || k[0].FirstSignal != syscall.SIGHUP {
		t.Fatalf("kills = %+v", k)
	}
}

func TestFakeScriptRunsAfterReady(t *testing.T) {
	f, l := newTestFake(t)
	done := make(chan struct{})
	f.Script("c1", func(r *FakeRun) {
		defer close(done)
		_ = r.Write(shim.StdoutFile, []byte("abc"))
		_ = r.Write(shim.StderrFile, []byte("de"))
		_ = r.Exit(0)
	})
	launch(t, f, l, shim.Spec{ID: "c1", Argv: []string{"true"}})
	<-done
	e := readExit(t, l, "c1")
	if e.StdoutEnd != 3 || e.StderrEnd != 2 || e.PtyEnd != 0 {
		t.Fatalf("exit = %+v", e)
	}
	out, err := os.ReadFile(filepath.Join(l.CommandDir("c1"), shim.StdoutFile))
	if err != nil || !bytes.Equal(out, []byte("abc")) {
		t.Fatalf("stdout = %q, %v", out, err)
	}
	waitState(t, f, "c1", UnitNotFound)
}

func TestFakeDieLosesShim(t *testing.T) {
	f, l := newTestFake(t)
	r := launch(t, f, l, shim.Spec{ID: "c1", Argv: []string{"sleep", "60"}})
	c := dialShim(t, l, "c1")
	r.Die()
	select {
	case <-c.Done():
	case <-time.After(5 * time.Second):
		t.Fatal("connection still open")
	}
	if s, _ := f.State(t.Context(), "c1"); s != UnitNotFound {
		t.Fatalf("state = %v", s)
	}
	if _, err := os.Stat(filepath.Join(l.CommandDir("c1"), shim.ExitJSON)); !errors.Is(err, os.ErrNotExist) {
		t.Fatalf("exit.json after shim death: %v", err)
	}
}

func TestFakeLaunchFailures(t *testing.T) {
	f, l := newTestFake(t)
	ctx := t.Context()

	// No spec: the shim cannot start, the unit fails before READY.
	if err := f.Launch(ctx, "nospec", "/bin/agent", nil); err == nil {
		t.Fatal("Launch without spec succeeded")
	}

	boom := errors.New("boom")
	f.FailLaunch("c1", boom)
	writeSpec(t, l, shim.Spec{ID: "c1", Argv: []string{"true"}})
	if err := f.Launch(ctx, "c1", "/bin/agent", nil); !errors.Is(err, boom) {
		t.Fatalf("Launch = %v, want boom", err)
	}
	if _, err := os.Stat(filepath.Join(l.CommandDir("c1"), shim.ShimJSON)); !errors.Is(err, os.ErrNotExist) {
		t.Fatalf("shim.json after failed launch: %v", err)
	}
	// The failure is one-shot.
	if err := f.Launch(ctx, "c1", "/bin/agent", nil); err != nil {
		t.Fatalf("second Launch: %v", err)
	}

	f.Setup("sf", func(r *FakeRun) { r.FailStart("exec: \"nope\": not found") })
	writeSpec(t, l, shim.Spec{ID: "sf", Argv: []string{"nope"}})
	if err := f.Launch(ctx, "sf", "/bin/agent", nil); err != nil {
		t.Fatalf("Launch with start failure: %v", err)
	}
	e := readExit(t, l, "sf")
	if e.Code != 127 || e.Reason != shimproto.ReasonStartFailed || e.StderrEnd == 0 {
		t.Fatalf("exit = %+v", e)
	}
	if s, _ := f.State(ctx, "sf"); s != UnitNotFound {
		t.Fatalf("state after start failure = %v", s)
	}

	if err := f.Launch(ctx, "bad/id", "/bin/agent", nil); err == nil {
		t.Fatal("Launch accepted an invalid id")
	}
}

func TestFakeShimOutdated(t *testing.T) {
	f, l := newTestFake(t)
	f.Setup("c1", func(r *FakeRun) { r.SetShimVersions(shimproto.Version+1, shimproto.Version+1) })
	launch(t, f, l, shim.Spec{ID: "c1", Argv: []string{"sleep", "60"}})
	_, err := shimproto.Dial(t.Context(), l.ShimSocket("c1"))
	if !isShimErr(err, shimproto.CodeShimOutdated) {
		t.Fatalf("Dial = %v, want shim_outdated", err)
	}
}

func TestFakeKillCgroupAndStop(t *testing.T) {
	f, l := newTestFake(t)
	ctx := t.Context()
	if err := f.KillCgroup(ctx, "none"); !errors.Is(err, ErrUnitNotFound) {
		t.Fatalf("KillCgroup without unit = %v", err)
	}

	r := launch(t, f, l, shim.Spec{ID: "c1", Argv: []string{"sleep", "60"}})
	if err := f.KillCgroup(ctx, "c1"); err != nil {
		t.Fatal(err)
	}
	if e := readExit(t, l, "c1"); e.Signal != "SIGKILL" || e.Status != shimproto.StatusKilled {
		t.Fatalf("exit = %+v", e)
	}
	waitState(t, f, "c1", UnitNotFound)
	if !r.Exited() || f.CgroupKills("c1") != 1 {
		t.Fatalf("exited %v, cgroup kills %d", r.Exited(), f.CgroupKills("c1"))
	}

	launch(t, f, l, shim.Spec{ID: "c2", Argv: []string{"sleep", "60"}})
	if err := f.Stop(ctx, "c2"); err != nil {
		t.Fatal(err)
	}
	waitState(t, f, "c2", UnitNotFound)
	if err := f.Stop(ctx, "c2"); err != nil {
		t.Fatalf("Stop of a gone unit = %v", err)
	}

	f.SetState("c3", UnitActive)
	writeSpec(t, l, shim.Spec{ID: "c3", Argv: []string{"true"}})
	if err := f.Launch(ctx, "c3", "/bin/agent", nil); !errors.Is(err, ErrUnitExists) {
		t.Fatalf("Launch over a set state = %v", err)
	}
	f.SetState("c3", UnitNotFound)
	if s, _ := f.State(ctx, "c3"); s != UnitNotFound {
		t.Fatalf("state = %v", s)
	}
}

func TestFakeWatchdog(t *testing.T) {
	f, _ := newTestFake(t)
	ctx := t.Context()
	argv := []string{"/bin/agent", "quiesce-watchdog", "--lease", "l1"}
	if err := f.StartWatchdog(ctx, "l1", argv); err != nil {
		t.Fatal(err)
	}
	if err := f.StartWatchdog(ctx, "l1", argv); !errors.Is(err, ErrUnitExists) {
		t.Fatalf("second StartWatchdog = %v", err)
	}
	if got, ok := f.Watchdog("l1"); !ok || len(got) != 4 {
		t.Fatalf("Watchdog = %v, %v", got, ok)
	}
	if err := f.StopWatchdog(ctx, "l1"); err != nil {
		t.Fatal(err)
	}
	if _, ok := f.Watchdog("l1"); ok {
		t.Fatal("watchdog still active")
	}
	if err := f.StopWatchdog(ctx, "l1"); err != nil {
		t.Fatalf("StopWatchdog twice = %v", err)
	}
	boom := errors.New("boom")
	f.FailWatchdog(boom)
	if err := f.StartWatchdog(ctx, "l2", argv); !errors.Is(err, boom) {
		t.Fatalf("StartWatchdog = %v, want boom", err)
	}
}

func TestCheckCommandID(t *testing.T) {
	longest := string(bytes.Repeat([]byte("a"), maxUnitName-len("umiak-cmd-.service")))
	tests := []struct {
		id string
		ok bool
	}{
		{"cmd-01HZY:abc_1.2", true},
		{longest, true},
		{longest + "a", false},
		{"", false},
		{"a/b", false},
		{"a b", false},
		{`a\x2d`, false},
		{".", false},
		{"..", false},
		{"...", true},
	}
	for _, tt := range tests {
		if err := checkCommandID(tt.id); (err == nil) != tt.ok {
			t.Errorf("checkCommandID(%q) = %v, want ok=%v", tt.id, err, tt.ok)
		}
	}
}

func TestFakeExitWithKeepsEndsAndLateWrites(t *testing.T) {
	f, l := newTestFake(t)
	r := launch(t, f, l, shim.Spec{ID: "c1", Argv: []string{"true"}})
	if err := r.Write(shim.StdoutFile, []byte("ab")); err != nil {
		t.Fatal(err)
	}
	if err := r.ExitWith(shimproto.ExitFile{Code: 0, Reason: shimproto.ReasonNone, StdoutEnd: 5}); err != nil {
		t.Fatal(err)
	}
	waitState(t, f, "c1", UnitNotFound)
	// Output reaching the file after exit.json, beyond the old size.
	if err := r.Write(shim.StdoutFile, []byte("cde")); err != nil {
		t.Fatal(err)
	}
	e := readExit(t, l, "c1")
	if e.StdoutEnd != 5 || e.Status != shimproto.StatusExited || e.EndedAt.IsZero() {
		t.Fatalf("exit = %+v", e)
	}
	if err := r.Write(shim.PtyFile, []byte("x")); err == nil {
		t.Fatal("Write to a missing stream succeeded")
	}
	if err := r.Exit(1); err == nil {
		t.Fatal("second exit succeeded")
	}
}

func TestFakeKillGraceReachesLeftovers(t *testing.T) {
	tests := []struct {
		name    string
		graceMs uint32
	}{
		{"grace 0", 0},
		{"grace 300ms", 300},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			f, l := newTestFake(t)
			r := launch(t, f, l, shim.Spec{ID: "c1", Argv: []string{"sh", "-c", "sleep 60 & sleep 60"}})
			r.SetLeftovers(true)
			c := dialShim(t, l, "c1")
			start := time.Now()
			if err := c.Kill(t.Context(), tt.graceMs, 0, ""); err != nil {
				t.Fatal(err)
			}
			// SIGTERM ends the main process at once.
			if e := waitExited(t, c); e.Signal != "SIGTERM" || e.Reason != shimproto.ReasonSignal {
				t.Fatalf("exited = %+v", e)
			}
			if tt.graceMs > 0 {
				if s, _ := f.State(t.Context(), "c1"); s != UnitActive {
					t.Fatalf("state before the grace = %v, want leftovers alive", s)
				}
			}
			// The hard kill at the grace kills the leftovers; the shim ends.
			waitState(t, f, "c1", UnitNotFound)
			if d := time.Since(start); d < time.Duration(tt.graceMs)*time.Millisecond {
				t.Fatalf("leftovers killed after %v, before the grace", d)
			}
			if e := readExit(t, l, "c1"); e.Signal != "SIGTERM" {
				t.Fatalf("exit.json changed by the leftover kill: %+v", e)
			}
		})
	}
}

func TestFakeGraceOutlivesNaturalExit(t *testing.T) {
	f, l := newTestFake(t)
	f.Setup("c1", func(r *FakeRun) { r.IgnoreSignals() })
	r := launch(t, f, l, shim.Spec{ID: "c1", Argv: []string{"sleep", "60"}})
	r.SetLeftovers(true)
	c := dialShim(t, l, "c1")
	if err := c.Kill(t.Context(), 200, 0, shimproto.ReasonTimeout); err != nil {
		t.Fatal(err)
	}
	// The main process handles SIGTERM and exits on its own.
	if err := r.Exit(0); err != nil {
		t.Fatal(err)
	}
	if e := waitExited(t, c); e.Code != 0 || e.Reason != shimproto.ReasonTimeout {
		t.Fatalf("exited = %+v", e)
	}
	waitState(t, f, "c1", UnitNotFound)
}

func TestFakeKillKeepsEarliestDeadline(t *testing.T) {
	tests := []struct {
		name  string
		first uint32
		then  uint32
	}{
		{"later then earlier", 60000, 10},
		{"earlier then later", 10, 60000},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			f, l := newTestFake(t)
			f.Setup("c1", func(r *FakeRun) { r.IgnoreSignals() })
			launch(t, f, l, shim.Spec{ID: "c1", Argv: []string{"sleep", "60"}})
			c := dialShim(t, l, "c1")
			ctx := t.Context()
			if err := c.Kill(ctx, tt.first, 0, ""); err != nil {
				t.Fatal(err)
			}
			if err := c.Kill(ctx, tt.then, 0, ""); err != nil && !errors.Is(err, shimproto.ErrClosed) {
				t.Fatal(err)
			}
			e := waitExited(t, c)
			if e.Signal != "SIGKILL" || e.Reason != shimproto.ReasonSignal {
				t.Fatalf("exited = %+v", e)
			}
		})
	}
}

func TestFakeRejectsInvalidIDs(t *testing.T) {
	f, _ := newTestFake(t)
	ctx := t.Context()
	for _, id := range []string{"", ".", "..", "a/b"} {
		if _, err := f.State(ctx, id); err == nil {
			t.Errorf("State(%q) accepted", id)
		}
		if err := f.Stop(ctx, id); err == nil {
			t.Errorf("Stop(%q) accepted", id)
		}
		if err := f.KillCgroup(ctx, id); err == nil || errors.Is(err, ErrUnitNotFound) {
			t.Errorf("KillCgroup(%q) = %v", id, err)
		}
		if err := f.StopWatchdog(ctx, id); err == nil {
			t.Errorf("StopWatchdog(%q) accepted", id)
		}
		if err := f.StartWatchdog(ctx, id, []string{"/bin/true"}); err == nil {
			t.Errorf("StartWatchdog(%q) accepted", id)
		}
	}
	if err := f.StartWatchdog(ctx, "l1", nil); err == nil {
		t.Error("StartWatchdog with empty argv accepted")
	}
}
