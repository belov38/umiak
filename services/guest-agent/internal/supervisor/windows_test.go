//go:build windows

package supervisor

import (
	"bufio"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"os/signal"
	"path/filepath"
	"strconv"
	"strings"
	"testing"
	"time"
	"unsafe"

	"golang.org/x/sys/windows"

	"github.com/belov38/umiak/services/guest-agent/internal/fsutil"
	"github.com/belov38/umiak/services/guest-agent/internal/paths"
	"github.com/belov38/umiak/services/guest-agent/internal/shim"
	"github.com/belov38/umiak/services/guest-agent/internal/shimproto"
	"github.com/belov38/umiak/services/guest-agent/internal/winproc"
)

// The test binary is also the shim (`<exe> shim --id ...`) and the command
// (helperEnv in the command's environment). These tests need
// SeCreatePermanentPrivilege (SYSTEM, Task 27) and skip without it.
const helperEnv = "UMIAK_SUP_HELPER"

func TestMain(m *testing.M) {
	if len(os.Args) > 1 && os.Args[1] == "shim" {
		os.Exit(shim.Run(os.Args[2:], os.Stderr))
	}
	switch os.Getenv(helperEnv) {
	case "":
		os.Exit(m.Run())
	case "sleep":
		// The default CTRL_BREAK action ends the process.
		time.Sleep(time.Minute)
		os.Exit(0)
	case "stubborn":
		// Survives CTRL_BREAK; only the job termination ends it.
		signal.Notify(make(chan os.Signal, 1), os.Interrupt)
		time.Sleep(time.Minute)
		os.Exit(0)
	case "short":
		time.Sleep(2 * time.Second)
		os.Exit(0)
	case "size":
		consoleSize()
	default:
		os.Exit(2)
	}
}

// consoleSize prints the console window size for every input line until
// "q".
func consoleSize() {
	out := windows.Handle(os.Stdout.Fd())
	sc := bufio.NewScanner(os.Stdin)
	for sc.Scan() {
		if strings.TrimSpace(sc.Text()) == "q" {
			os.Exit(0)
		}
		var info windows.ConsoleScreenBufferInfo
		if err := windows.GetConsoleScreenBufferInfo(out, &info); err != nil {
			fmt.Printf("error=%v\r\n", err)
			continue
		}
		w := info.Window
		fmt.Printf("size=%dx%d\r\n", w.Right-w.Left+1, w.Bottom-w.Top+1)
	}
	os.Exit(3)
}

func requirePermanentJobs(t *testing.T) {
	t.Helper()
	name := fmt.Sprintf("umiak-test-probe-%d-%d", os.Getpid(), time.Now().UnixNano())
	j, err := winproc.CreatePermanentJob(name)
	if errors.Is(err, winproc.ErrNoPermanentPrivilege) {
		t.Skip("needs SeCreatePermanentPrivilege (run as SYSTEM):", err)
	}
	if err != nil {
		t.Fatal(err)
	}
	_ = j.MakeTemporary()
	_ = j.Close()
}

// winEnv is a test: a short layout root (AF_UNIX paths are limited), the
// supervisor, the test binary and a fresh command id.
type winEnv struct {
	t    *testing.T
	root string
	l    paths.Layout
	sup  Supervisor
	exe  string
	id   string
}

func newWinEnv(t *testing.T) *winEnv {
	t.Helper()
	requirePermanentJobs(t)
	root, err := os.MkdirTemp(os.Getenv("SystemDrive")+`\`, "umiakv")
	if err != nil {
		t.Fatal(err)
	}
	exe, err := os.Executable()
	if err != nil {
		t.Fatal(err)
	}
	e := &winEnv{t: t, root: root, l: paths.ForRoot(root), exe: exe,
		id: "t" + strconv.FormatInt(time.Now().UnixNano(), 36)}
	e.sup = e.newSup()
	t.Cleanup(func() {
		_ = e.sup.Stop(context.Background(), e.id)
		_ = e.sup.Close()
		waitFor(t, "shim gone", 20*time.Second, func() bool { return !winproc.ShimAlive(e.id) })
		_ = os.RemoveAll(root)
	})
	return e
}

func (e *winEnv) newSup() Supervisor {
	e.t.Helper()
	s, err := NewWindows(e.l)
	if err != nil {
		e.t.Fatal(err)
	}
	return s
}

// spec is a SYSTEM command running the test binary as helper mode.
func (e *winEnv) spec(mode string) shim.Spec {
	return shim.Spec{ID: e.id, Argv: []string{e.exe}, Env: append(os.Environ(), helperEnv+"="+mode),
		User: "SYSTEM", AgentVersion: "test"}
}

func (e *winEnv) launch(sup Supervisor, spec shim.Spec) error {
	e.t.Helper()
	data, err := json.Marshal(spec)
	if err != nil {
		e.t.Fatal(err)
	}
	ctx, cancel := context.WithTimeout(e.t.Context(), 30*time.Second)
	defer cancel()
	return sup.(SpecLauncher).LaunchSpec(ctx, spec.ID, e.exe, []string{"--layout-root", e.root}, data)
}

func (e *winEnv) mustLaunch(spec shim.Spec) {
	e.t.Helper()
	if err := e.launch(e.sup, spec); err != nil {
		log, _ := os.ReadFile(filepath.Join(e.l.CommandDir(e.id), shim.ShimLog))
		e.t.Fatalf("LaunchSpec: %v\nshim.log:\n%s", err, log)
	}
}

func (e *winEnv) state(sup Supervisor) UnitState {
	e.t.Helper()
	st, err := sup.State(e.t.Context(), e.id)
	if err != nil {
		e.t.Fatal(err)
	}
	return st
}

func (e *winEnv) waitState(sup Supervisor, want UnitState) {
	e.t.Helper()
	waitFor(e.t, "state "+want.String(), 20*time.Second, func() bool { return e.state(sup) == want })
}

func (e *winEnv) waitExit() shimproto.ExitFile {
	e.t.Helper()
	var ex shimproto.ExitFile
	path := filepath.Join(e.l.CommandDir(e.id), shim.ExitJSON)
	waitFor(e.t, "exit.json", 30*time.Second, func() bool { return fsutil.ReadJSON(path, &ex) == nil })
	return ex
}

func (e *winEnv) commandPid() uint32 {
	e.t.Helper()
	var sf shim.ShimFile
	if err := fsutil.ReadJSON(filepath.Join(e.l.CommandDir(e.id), shim.ShimJSON), &sf); err != nil || sf.Pid <= 0 {
		e.t.Fatalf("shim.json %+v, %v", sf, err)
	}
	return uint32(sf.Pid) //nolint:gosec // a Windows pid
}

func (e *winEnv) dial() *shimproto.Client {
	e.t.Helper()
	ctx, cancel := context.WithTimeout(e.t.Context(), 10*time.Second)
	defer cancel()
	c, err := shimproto.Dial(ctx, e.l.ShimSocket(e.id))
	if err != nil {
		e.t.Fatal(err)
	}
	e.t.Cleanup(func() { _ = c.Close() })
	return c
}

func waitFor(t *testing.T, what string, timeout time.Duration, cond func() bool) {
	t.Helper()
	deadline := time.Now().Add(timeout)
	for !cond() {
		if time.Now().After(deadline) {
			t.Fatalf("timeout waiting for %s", what)
		}
		time.Sleep(50 * time.Millisecond)
	}
}

// parentPid returns the parent process id of pid.
func parentPid(t *testing.T, pid uint32) uint32 {
	t.Helper()
	snap, err := windows.CreateToolhelp32Snapshot(windows.TH32CS_SNAPPROCESS, 0)
	if err != nil {
		t.Fatal(err)
	}
	defer windows.CloseHandle(snap) //nolint:errcheck // test
	var pe windows.ProcessEntry32
	pe.Size = uint32(unsafe.Sizeof(pe))
	for err = windows.Process32First(snap, &pe); err == nil; err = windows.Process32Next(snap, &pe) {
		if pe.ProcessID == pid {
			return pe.ParentProcessID
		}
	}
	t.Fatalf("process %d not found", pid)
	return 0
}

func TestShimRunsAndWritesExit(t *testing.T) {
	e := newWinEnv(t)
	spec := e.spec("")
	spec.Argv = []string{filepath.Join(os.Getenv("SystemRoot"), "System32", "cmd.exe"), "/d", "/c", "exit 3"}
	e.mustLaunch(spec)
	ex := e.waitExit()
	if ex.Status != shimproto.StatusExited || ex.Code != 3 || ex.Reason != shimproto.ReasonNone {
		t.Fatalf("exit = %+v", ex)
	}
	e.waitState(e.sup, UnitNotFound)
}

func TestShimSurvivesSupervisorRestart(t *testing.T) {
	e := newWinEnv(t)
	e.mustLaunch(e.spec("short"))
	if err := e.sup.Close(); err != nil {
		t.Fatal(err)
	}
	sup2 := e.newSup()
	defer sup2.Close() //nolint:errcheck // test
	if st := e.state(sup2); st != UnitActive {
		t.Fatalf("state after the restart = %v, want active", st)
	}
	// Keep the job object alive past the shim's end to see it empty.
	j, err := winproc.OpenJob(shim.JobName(e.id))
	if err != nil {
		t.Fatal(err)
	}
	if ex := e.waitExit(); ex.Code != 0 || ex.Status != shimproto.StatusExited {
		t.Fatalf("exit = %+v", ex)
	}
	e.waitState(sup2, UnitInactive)
	_ = j.Close()
	e.waitState(sup2, UnitNotFound)
}

func TestKillAfterShimDied(t *testing.T) {
	e := newWinEnv(t)
	e.mustLaunch(e.spec("sleep"))
	pid := e.commandPid()
	shimPid := parentPid(t, pid)
	h, err := windows.OpenProcess(windows.PROCESS_TERMINATE|windows.SYNCHRONIZE, false, shimPid)
	if err != nil {
		t.Fatal(err)
	}
	if err := windows.TerminateProcess(h, 1); err != nil {
		t.Fatal(err)
	}
	_, _ = windows.WaitForSingleObject(h, 10000)
	_ = windows.CloseHandle(h)
	waitFor(t, "shim mutex gone", 10*time.Second, func() bool { return !winproc.ShimAlive(e.id) })

	cmd, err := windows.OpenProcess(windows.SYNCHRONIZE, false, pid)
	if err != nil {
		t.Fatalf("command died with its shim: %v", err)
	}
	defer windows.CloseHandle(cmd) //nolint:errcheck // test
	if st := e.state(e.sup); st != UnitActive {
		t.Fatalf("state with the command alone = %v, want active", st)
	}
	if err := e.sup.KillCgroup(t.Context(), e.id); err != nil {
		t.Fatal(err)
	}
	if r, err := windows.WaitForSingleObject(cmd, 10000); err != nil || r != windows.WAIT_OBJECT_0 {
		t.Fatalf("command still runs after KillCgroup: %v, %v", r, err)
	}
	// The job outlived the shim: empty and permanent until Stop.
	e.waitState(e.sup, UnitInactive)
	if err := e.sup.Stop(t.Context(), e.id); err != nil {
		t.Fatal(err)
	}
	e.waitState(e.sup, UnitNotFound)
	if err := e.sup.KillCgroup(t.Context(), e.id); !errors.Is(err, ErrUnitNotFound) {
		t.Fatalf("KillCgroup without a job: %v", err)
	}
}

func TestShimPTYResize(t *testing.T) {
	e := newWinEnv(t)
	spec := e.spec("size")
	spec.PTY = &shim.PTYSpec{Cols: 80, Rows: 24}
	e.mustLaunch(spec)
	c := e.dial()
	ptyFile := filepath.Join(e.l.CommandDir(e.id), shim.PtyFile)
	seq := uint64(0)
	expect := func(want string) {
		t.Helper()
		waitFor(t, want, 20*time.Second, func() bool {
			seq++
			if _, err := c.Input(t.Context(), "s1", seq, []byte("\r"), false); err != nil {
				t.Fatal(err)
			}
			time.Sleep(200 * time.Millisecond)
			data, _ := os.ReadFile(ptyFile)
			return strings.Contains(string(data), want)
		})
	}
	expect("size=80x24")
	if err := c.Resize(t.Context(), 100, 30); err != nil {
		t.Fatal(err)
	}
	expect("size=100x30")
	// A duplicate seq is not applied again.
	if applied, err := c.Input(t.Context(), "s1", seq, []byte("x"), false); err != nil || applied {
		t.Fatalf("duplicate input: applied %v, %v", applied, err)
	}
	seq++
	if _, err := c.Input(t.Context(), "s1", seq, []byte("q\r"), false); err != nil {
		t.Fatal(err)
	}
	if ex := e.waitExit(); ex.Code != 0 || ex.PtyEnd == 0 {
		t.Fatalf("exit = %+v", ex)
	}
}

func TestRepeatedLaunchIsUnitExists(t *testing.T) {
	e := newWinEnv(t)
	spec := e.spec("sleep")
	e.mustLaunch(spec)
	if err := e.launch(e.sup, spec); !errors.Is(err, ErrUnitExists) {
		t.Fatalf("second launch while running: %v, want ErrUnitExists", err)
	}
	if err := e.sup.KillCgroup(t.Context(), e.id); err != nil {
		t.Fatal(err)
	}
	if ex := e.waitExit(); ex.Code != 1 {
		t.Fatalf("exit = %+v", ex)
	}
	e.waitState(e.sup, UnitNotFound)
	// The shim refuses a command whose shim.json exists.
	if err := e.launch(e.sup, spec); !errors.Is(err, ErrUnitExists) {
		t.Fatalf("launch after the end: %v, want ErrUnitExists", err)
	}
}

func TestKillCtrlBreakThenTerminate(t *testing.T) {
	for _, tt := range []struct {
		mode       string
		wantStatus string
		wantCode   int32
	}{
		// CTRL_BREAK ends it: STATUS_CONTROL_C_EXIT as a signed code.
		{"sleep", shimproto.StatusExited, -1073741510},
		// It ignores CTRL_BREAK: the job termination after the grace.
		{"stubborn", shimproto.StatusKilled, 1},
	} {
		t.Run(tt.mode, func(t *testing.T) {
			e := newWinEnv(t)
			e.mustLaunch(e.spec(tt.mode))
			c := e.dial()
			// Let the helper install its handler.
			time.Sleep(500 * time.Millisecond)
			if err := c.Kill(t.Context(), 1000, 0, shimproto.ReasonSignal); err != nil {
				t.Fatal(err)
			}
			ex := e.waitExit()
			if ex.Status != tt.wantStatus || ex.Code != tt.wantCode || ex.Reason != shimproto.ReasonSignal {
				t.Fatalf("exit = %+v", ex)
			}
		})
	}
}

func TestSignalUnsupported(t *testing.T) {
	e := newWinEnv(t)
	e.mustLaunch(e.spec("sleep"))
	c := e.dial()
	var perr *shimproto.Error
	if err := c.Signal(t.Context(), 10, false); !errors.As(err, &perr) || perr.Code != shimproto.CodeInvalidArgument {
		t.Fatalf("SIGUSR1: %v", err)
	}
	if err := c.Signal(t.Context(), 1, false); !errors.As(err, &perr) || perr.Code != shimproto.CodeInvalidArgument {
		t.Fatalf("SIGHUP without a pty: %v", err)
	}
	if err := c.Signal(t.Context(), 9, true); err != nil {
		t.Fatal(err)
	}
	if ex := e.waitExit(); ex.Status != shimproto.StatusKilled || ex.Code != 1 || ex.Reason != shimproto.ReasonSignal {
		t.Fatalf("exit = %+v", ex)
	}
}

func TestWatchdog(t *testing.T) {
	e := newWinEnv(t)
	lease := "l" + e.id
	argv := []string{e.exe}
	t.Setenv(helperEnv, "sleep")
	if err := e.sup.StartWatchdog(t.Context(), lease, argv); err != nil {
		t.Fatal(err)
	}
	if err := e.sup.StartWatchdog(t.Context(), lease, argv); !errors.Is(err, ErrUnitExists) {
		t.Fatalf("second watchdog: %v", err)
	}
	if err := e.sup.StopWatchdog(t.Context(), lease); err != nil {
		t.Fatal(err)
	}
	if err := e.sup.StopWatchdog(t.Context(), lease); err != nil {
		t.Fatalf("stop of a stopped watchdog: %v", err)
	}
}

// A shim that died after it created the job but before shim.json leaves an
// empty permanent job; the next launch reclaims it instead of failing with
// ErrUnitExists until a reboot.
func TestLaunchReclaimsOrphanJob(t *testing.T) {
	e := newWinEnv(t)
	j, err := winproc.CreatePermanentJob(shim.JobName(e.id))
	if err != nil {
		t.Fatal(err)
	}
	_ = j.Close()
	if st := e.state(e.sup); st != UnitInactive {
		t.Fatalf("state of the orphan job = %v, want inactive", st)
	}
	spec := e.spec("")
	spec.Argv = []string{filepath.Join(os.Getenv("SystemRoot"), "System32", "cmd.exe"), "/d", "/c", "exit 4"}
	e.mustLaunch(spec)
	if ex := e.waitExit(); ex.Code != 4 {
		t.Fatalf("exit = %+v", ex)
	}
}

// An empty job with a trace of a launch (shim.json) is not reclaimed.
func TestLaunchKeepsTracedJob(t *testing.T) {
	e := newWinEnv(t)
	j, err := winproc.CreatePermanentJob(shim.JobName(e.id))
	if err != nil {
		t.Fatal(err)
	}
	_ = j.Close()
	dir := e.l.CommandDir(e.id)
	if err := os.MkdirAll(dir, 0o700); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(dir, shim.ShimJSON), []byte(`{"state":"launching"}`), 0o600); err != nil {
		t.Fatal(err)
	}
	if err := e.launch(e.sup, e.spec("")); !errors.Is(err, ErrUnitExists) {
		t.Fatalf("launch over a traced job: %v, want ErrUnitExists", err)
	}
}
