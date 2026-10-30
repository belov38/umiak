package winproc

import (
	"bufio"
	"bytes"
	"context"
	"errors"
	"fmt"
	"io"
	"os"
	"os/exec"
	"path/filepath"
	"strconv"
	"strings"
	"sync"
	"syscall"
	"testing"
	"time"

	"golang.org/x/sys/windows"
)

// helperEnv makes the test binary act as a child process for the tests.
const (
	helperEnv    = "SBX_WINPROC_HELPER"
	helperPidEnv = "SBX_WINPROC_PID"
)

func TestMain(m *testing.M) {
	switch os.Getenv(helperEnv) {
	case "":
		os.Exit(m.Run())
	case "sleep":
		// No signal.Notify: CTRL_BREAK takes the default action and
		// ends the process.
		fmt.Println("ready")
		time.Sleep(time.Minute)
		os.Exit(0)
	case "ctrlbreak":
		// Runs detached (no console), like the shim.
		pid, err := strconv.ParseUint(os.Getenv(helperPidEnv), 10, 32)
		if err == nil {
			err = CtrlBreak(uint32(pid))
		}
		if err != nil {
			fmt.Println(err)
			os.Exit(1)
		}
		os.Exit(0)
	default:
		os.Exit(2)
	}
}

func uniqueName(t *testing.T, prefix string) string {
	t.Helper()
	return fmt.Sprintf("%s-%s-%d", prefix, strconv.FormatInt(time.Now().UnixNano(), 36), os.Getpid())
}

func cmdExe() string {
	return filepath.Join(os.Getenv("SystemRoot"), "System32", "cmd.exe")
}

// permanentJob creates a permanent job and removes it at the end of the test.
// It skips without SeCreatePermanentPrivilege (Task 27 runs these as SYSTEM).
func permanentJob(t *testing.T, name string) *Job {
	t.Helper()
	j, err := CreatePermanentJob(name)
	if errors.Is(err, ErrNoPermanentPrivilege) {
		t.Skip("needs SeCreatePermanentPrivilege (run as SYSTEM):", err)
	}
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { removeJob(name) })
	return j
}

// removeJob drops the permanence of a leftover test job.
func removeJob(name string) {
	j, err := OpenJob(name)
	if err != nil {
		return
	}
	_ = j.Terminate(1)
	_ = j.MakeTemporary()
	_ = j.Close()
}

// pipe returns a pipe whose read end is drained into a buffer; wait closes
// the parent's write end and returns everything read.
func pipe(t *testing.T) (w windows.Handle, wait func() string) {
	t.Helper()
	r, wf, err := os.Pipe()
	if err != nil {
		t.Fatal(err)
	}
	var buf bytes.Buffer
	done := make(chan struct{})
	go func() {
		_, _ = io.Copy(&buf, r)
		_ = r.Close()
		close(done)
	}()
	var once sync.Once
	closeW := func() { once.Do(func() { _ = wf.Close() }) }
	t.Cleanup(closeW)
	return windows.Handle(wf.Fd()), func() string {
		closeW()
		select {
		case <-done:
		case <-time.After(30 * time.Second):
			t.Fatal("pipe not drained")
		}
		return buf.String()
	}
}

func start(t *testing.T, o StartOptions) *Process {
	t.Helper()
	p, err := Start(o)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() {
		_ = windows.TerminateProcess(p.Handle(), 1)
		_ = p.Close()
	})
	return p
}

func wait(t *testing.T, p *Process, d time.Duration) uint32 {
	t.Helper()
	ctx, cancel := context.WithTimeout(context.Background(), d)
	defer cancel()
	code, err := p.Wait(ctx)
	if err != nil {
		t.Fatal(err)
	}
	return code
}

func TestOpenJobMissing(t *testing.T) {
	if _, err := OpenJob(uniqueName(t, "sbx-test-none")); !errors.Is(err, ErrJobNotFound) {
		t.Fatalf("OpenJob of a missing job: %v", err)
	}
}

func TestBadJobName(t *testing.T) {
	for _, n := range []string{"", `a\b`} {
		if _, err := CreatePermanentJob(n); err == nil || errors.Is(err, ErrNoPermanentPrivilege) {
			t.Errorf("CreatePermanentJob(%q) = %v", n, err)
		}
		if _, err := OpenJob(n); err == nil || errors.Is(err, ErrJobNotFound) {
			t.Errorf("OpenJob(%q) = %v", n, err)
		}
	}
}

func TestPermanentJobSurvivesHandleClose(t *testing.T) {
	name := uniqueName(t, "sbx-test-perm")
	j := permanentJob(t, name)
	if err := j.Close(); err != nil {
		t.Fatal(err)
	}
	j2, err := OpenJob(name)
	if err != nil {
		t.Fatalf("permanent job gone after its last handle closed: %v", err)
	}
	if n, err := j2.ActiveProcesses(); err != nil || n != 0 {
		t.Fatalf("ActiveProcesses = %d, %v", n, err)
	}
	if err := j2.MakeTemporary(); err != nil {
		t.Fatal(err)
	}
	if err := j2.Close(); err != nil {
		t.Fatal(err)
	}
	if _, err := OpenJob(name); !errors.Is(err, ErrJobNotFound) {
		t.Fatalf("temporary job still there after close: %v", err)
	}
}

func TestJobCollision(t *testing.T) {
	name := uniqueName(t, "sbx-test-coll")
	j := permanentJob(t, name)
	defer j.Close() //nolint:errcheck // test cleanup
	if _, err := CreatePermanentJob(name); !errors.Is(err, ErrJobExists) {
		t.Fatalf("second CreatePermanentJob = %v, want ErrJobExists", err)
	}
}

func TestStartInJobCountsProcesses(t *testing.T) {
	j, err := CreateJob("")
	if err != nil {
		t.Fatal(err)
	}
	defer j.Close() //nolint:errcheck // test cleanup
	out, read := pipe(t)
	p := start(t, StartOptions{
		Argv0Path:   cmdExe(),
		CommandLine: `cmd.exe /d /c ping -n 3 127.0.0.1`,
		Job:         j,
		Stdout:      out,
		Stderr:      out,
	})
	if p.Pid() == 0 {
		t.Fatal("pid 0")
	}
	if n, err := j.ActiveProcesses(); err != nil || n < 1 {
		t.Fatalf("ActiveProcesses after start = %d, %v", n, err)
	}
	if code := wait(t, p, time.Minute); code != 0 {
		t.Fatalf("exit code %d, output %q", code, read())
	}
	ctx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
	defer cancel()
	if err := j.WaitEmpty(ctx); err != nil {
		t.Fatal(err)
	}
	if n, err := j.ActiveProcesses(); err != nil || n != 0 {
		t.Fatalf("ActiveProcesses after exit = %d, %v", n, err)
	}
	if s := read(); !strings.Contains(s, "127.0.0.1") {
		t.Fatalf("output %q", s)
	}
}

func TestWaitEmptyCanceled(t *testing.T) {
	j, err := CreateJob("")
	if err != nil {
		t.Fatal(err)
	}
	defer j.Close() //nolint:errcheck // test cleanup
	p := start(t, StartOptions{
		Argv0Path:   cmdExe(),
		CommandLine: `cmd.exe /d /c ping -n 30 127.0.0.1`,
		Job:         j,
	})
	ctx, cancel := context.WithTimeout(context.Background(), 300*time.Millisecond)
	defer cancel()
	if err := j.WaitEmpty(ctx); !errors.Is(err, context.DeadlineExceeded) {
		t.Fatalf("WaitEmpty on a busy job = %v", err)
	}
	_ = j.Terminate(1)
	wait(t, p, 30*time.Second)
}

func TestTerminateJobKillsGrandchildren(t *testing.T) {
	j, err := CreateJob("")
	if err != nil {
		t.Fatal(err)
	}
	defer j.Close() //nolint:errcheck // test cleanup
	r, w, err := os.Pipe()
	if err != nil {
		t.Fatal(err)
	}
	defer r.Close() //nolint:errcheck // test cleanup
	p := start(t, StartOptions{
		Argv0Path:   cmdExe(),
		CommandLine: `cmd.exe /d /c ping -n 60 127.0.0.1`,
		Job:         j,
		Stdout:      windows.Handle(w.Fd()),
	})
	_ = w.Close()
	// ping.exe, the grandchild of the test, prints the address first.
	br := bufio.NewReader(r)
	for {
		line, err := br.ReadString('\n')
		if err != nil {
			t.Fatalf("no ping output: %v", err)
		}
		if strings.Contains(line, "127.0.0.1") {
			break
		}
	}
	if err := j.Terminate(7); err != nil {
		t.Fatal(err)
	}
	ctx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
	defer cancel()
	if err := j.WaitEmpty(ctx); err != nil {
		t.Fatal(err)
	}
	if code := wait(t, p, 30*time.Second); code != 7 {
		t.Fatalf("exit code %d, want 7", code)
	}
	// EOF: no process holds the pipe any more, ping.exe included.
	eof := make(chan error, 1)
	go func() {
		_, err := io.Copy(io.Discard, br)
		eof <- err
	}()
	select {
	case err := <-eof:
		if err != nil {
			t.Fatal(err)
		}
	case <-time.After(30 * time.Second):
		t.Fatal("stdout pipe still open: a grandchild survived TerminateJobObject")
	}
}

func TestStartPipesAndExitCode(t *testing.T) {
	out, readOut := pipe(t)
	errw, readErr := pipe(t)
	p := start(t, StartOptions{
		Argv0Path:   cmdExe(),
		CommandLine: `cmd.exe /d /c echo out&echo err>&2&exit 3`,
		Stdout:      out,
		Stderr:      errw,
	})
	if code := wait(t, p, 30*time.Second); code != 3 {
		t.Fatalf("exit code %d, want 3", code)
	}
	if s := readOut(); strings.TrimSpace(s) != "out" {
		t.Errorf("stdout %q", s)
	}
	if s := readErr(); strings.TrimSpace(s) != "err" {
		t.Errorf("stderr %q", s)
	}
}

func TestStartEnvAndDir(t *testing.T) {
	dir := t.TempDir()
	out, read := pipe(t)
	p := start(t, StartOptions{
		Argv0Path:   cmdExe(),
		CommandLine: `cmd.exe /d /c echo %SBX_T%&cd`,
		Env:         []string{"SystemRoot=" + os.Getenv("SystemRoot"), "SBX_T=hello"},
		Dir:         dir,
		Stdout:      out,
	})
	if code := wait(t, p, 30*time.Second); code != 0 {
		t.Fatalf("exit code %d", code)
	}
	lines := strings.Split(strings.TrimSpace(strings.ReplaceAll(read(), "\r", "")), "\n")
	if len(lines) != 2 || lines[0] != "hello" || !strings.EqualFold(lines[1], dir) {
		t.Fatalf("output %q, want [hello %s]", lines, dir)
	}
}

func TestStartRejectsPTYWithStdHandles(t *testing.T) {
	pty, err := NewPseudoConsole(80, 25)
	if err != nil {
		t.Fatal(err)
	}
	defer pty.Out.Close() //nolint:errcheck // test cleanup
	defer pty.Close()     //nolint:errcheck // test cleanup
	out, _ := pipe(t)
	if _, err := Start(StartOptions{
		Argv0Path: cmdExe(), CommandLine: `cmd.exe /c exit 0`,
		PseudoConsole: pty.Handle(), Stdout: out,
	}); err == nil {
		t.Fatal("Start with a pseudo console and std handles succeeded")
	}
}

func TestConPTYEcho(t *testing.T) {
	pty, err := NewPseudoConsole(80, 25)
	if err != nil {
		t.Fatal(err)
	}
	var buf bytes.Buffer
	done := make(chan struct{})
	go func() {
		_, _ = io.Copy(&buf, pty.Out)
		close(done)
	}()
	p := start(t, StartOptions{
		Argv0Path:     cmdExe(),
		CommandLine:   `cmd.exe /d /c echo hi`,
		PseudoConsole: pty.Handle(),
	})
	if code := wait(t, p, 30*time.Second); code != 0 {
		t.Fatalf("exit code %d", code)
	}
	if err := pty.Resize(100, 30); err != nil {
		t.Fatal(err)
	}
	if err := pty.Close(); err != nil {
		t.Fatal(err)
	}
	select {
	case <-done:
	case <-time.After(30 * time.Second):
		t.Fatal("pseudo console output did not reach EOF after Close")
	}
	_ = pty.Out.Close()
	if !strings.Contains(buf.String(), "hi") {
		t.Fatalf("pty output %q", buf.String())
	}
}

func TestPseudoConsoleBadSize(t *testing.T) {
	if _, err := NewPseudoConsole(0, 25); err == nil {
		t.Fatal("NewPseudoConsole(0, 25) succeeded")
	}
}

// The plan names this TestCtrlBreakStopsPing, but ping.exe treats
// CTRL_BREAK as "print statistics and continue"; a Go child without a
// handler takes the default action and exits. CtrlBreak runs in a detached
// helper, as in the shim: the test process may have a console of its own.
func TestCtrlBreakStopsProcess(t *testing.T) {
	exe, err := os.Executable()
	if err != nil {
		t.Fatal(err)
	}
	r, w, err := os.Pipe()
	if err != nil {
		t.Fatal(err)
	}
	defer r.Close() //nolint:errcheck // test cleanup
	p := start(t, StartOptions{
		Argv0Path:       exe,
		CommandLine:     windows.EscapeArg(exe),
		Env:             append(os.Environ(), helperEnv+"=sleep"),
		Stdout:          windows.Handle(w.Fd()),
		NewProcessGroup: true,
	})
	_ = w.Close()
	line, err := bufio.NewReader(r).ReadString('\n')
	if err != nil || strings.TrimSpace(line) != "ready" {
		t.Fatalf("helper: %q, %v", line, err)
	}
	ctx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
	defer cancel()
	cmd := exec.CommandContext(ctx, exe)
	cmd.Env = append(os.Environ(), helperEnv+"=ctrlbreak", helperPidEnv+"="+strconv.FormatUint(uint64(p.Pid()), 10))
	cmd.SysProcAttr = &syscall.SysProcAttr{CreationFlags: windows.DETACHED_PROCESS}
	if out, err := cmd.CombinedOutput(); err != nil {
		t.Fatalf("CtrlBreak: %v: %s", err, out)
	}
	code, err := p.Wait(ctx)
	if err != nil {
		t.Fatalf("process still running after CTRL_BREAK: %v", err)
	}
	if code == 0 {
		t.Fatal("exit code 0 after CTRL_BREAK")
	}
}

func TestShimMutex(t *testing.T) {
	id := uniqueName(t, "test")
	if ShimAlive(id) {
		t.Fatal("ShimAlive before ShimMutex")
	}
	release, err := ShimMutex(id)
	if errors.Is(err, windows.ERROR_ACCESS_DENIED) {
		t.Skip("cannot create Global objects:", err)
	}
	if err != nil {
		t.Fatal(err)
	}
	if !ShimAlive(id) {
		t.Fatal("ShimAlive = false while held")
	}
	if _, err := ShimMutex(id); !errors.Is(err, ErrShimExists) {
		t.Fatalf("second ShimMutex = %v, want ErrShimExists", err)
	}
	if !ShimAlive(id) {
		t.Fatal("failed second ShimMutex dropped the first")
	}
	release()
	release()
	if ShimAlive(id) {
		t.Fatal("ShimAlive after release")
	}
}
