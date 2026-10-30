package shim

import (
	"bytes"
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"strconv"
	"strings"
	"testing"
	"time"

	"github.com/belov38/boat-dev-clone/services/guest-agent/internal/fsutil"
	"github.com/belov38/boat-dev-clone/services/guest-agent/internal/paths"
	"github.com/belov38/boat-dev-clone/services/guest-agent/internal/shimproto"
	"github.com/belov38/boat-dev-clone/services/guest-agent/internal/winproc"
)

// These tests run the shim in the test process. They need
// SeCreatePermanentPrivilege (SYSTEM, Task 27) and skip without it.

func requirePermanentJobs(t *testing.T) {
	t.Helper()
	name := fmt.Sprintf("sbx-test-probe-%d-%d", os.Getpid(), time.Now().UnixNano())
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

// shortRoot is a layout root short enough for AF_UNIX socket paths.
func shortRoot(t *testing.T) string {
	t.Helper()
	root, err := os.MkdirTemp(os.Getenv("SystemDrive")+`\`, "sbxs")
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = os.RemoveAll(root) })
	return root
}

func uniqueID(t *testing.T) string {
	t.Helper()
	return "t" + strconv.FormatInt(time.Now().UnixNano(), 36)
}

func cmdExe() string {
	return filepath.Join(os.Getenv("SystemRoot"), "System32", "cmd.exe")
}

// runShim runs the shim for spec to its end and returns its exit code and
// the line it printed.
func runShim(t *testing.T, root string, spec Spec) (int, string) {
	t.Helper()
	data, err := json.Marshal(spec)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() {
		if j, err := winproc.OpenJob(JobName(spec.ID)); err == nil {
			_ = j.Terminate(1)
			_ = j.MakeTemporary()
			_ = j.Close()
		}
	})
	var out, log bytes.Buffer
	code := run([]string{"--id", spec.ID, "--layout-root", root}, bytes.NewReader(data), &out, &log)
	t.Logf("shim log:\n%s", log.String())
	return code, out.String()
}

func readExit(t *testing.T, l paths.Layout, id string) ExitFile {
	t.Helper()
	var e ExitFile
	if err := fsutil.ReadJSON(filepath.Join(l.CommandDir(id), ExitJSON), &e); err != nil {
		t.Fatalf("exit.json: %v", err)
	}
	return e
}

func TestShimRunsAndWritesExit(t *testing.T) {
	requirePermanentJobs(t)
	root := shortRoot(t)
	id := uniqueID(t)
	spec := Spec{ID: id, Argv: []string{cmdExe(), "/d", "/c", "echo out& echo err 1>&2& exit 3"},
		Env: os.Environ(), User: "SYSTEM", AgentVersion: "test"}
	code, line := runShim(t, root, spec)
	if code != 0 || line != ReadyLine+"\n" {
		t.Fatalf("shim = %d, %q", code, line)
	}
	l := paths.ForRoot(root)
	e := readExit(t, l, id)
	if e.Status != shimproto.StatusExited || e.Code != 3 || e.Reason != shimproto.ReasonNone {
		t.Fatalf("exit = %+v", e)
	}
	stdout, _ := os.ReadFile(filepath.Join(l.CommandDir(id), StdoutFile))
	stderr, _ := os.ReadFile(filepath.Join(l.CommandDir(id), StderrFile))
	if strings.TrimSpace(string(stdout)) != "out" || strings.TrimSpace(string(stderr)) != "err" {
		t.Fatalf("stdout %q stderr %q", stdout, stderr)
	}
	if e.StdoutEnd != int64(len(stdout)) || e.StderrEnd != int64(len(stderr)) {
		t.Fatalf("ends %d/%d, files %d/%d", e.StdoutEnd, e.StderrEnd, len(stdout), len(stderr))
	}
	var sf ShimFile
	if err := fsutil.ReadJSON(filepath.Join(l.CommandDir(id), ShimJSON), &sf); err != nil || sf.State != StateRunning || sf.Pid == 0 {
		t.Fatalf("shim.json %+v, %v", sf, err)
	}
	// The job is gone: it was made temporary and closed.
	if _, err := winproc.OpenJob(JobName(id)); !errors.Is(err, winproc.ErrJobNotFound) {
		t.Fatalf("job after the end: %v", err)
	}
	if winproc.ShimAlive(id) {
		t.Fatal("shim mutex after the end")
	}

	// A second run of the same command refuses to start it again.
	code, line = runShim(t, root, spec)
	if code != exitAlreadyStarted || !strings.HasPrefix(line, FailPrefix+FailAlreadyStarted) {
		t.Fatalf("second shim = %d, %q", code, line)
	}
}

func TestShimStdin(t *testing.T) {
	requirePermanentJobs(t)
	root := shortRoot(t)
	id := uniqueID(t)
	// Without a stdin pipe the command reads NUL.
	spec := Spec{ID: id, Argv: []string{cmdExe(), "/d", "/c", "findstr x & exit 0"}, Env: os.Environ(), User: "SYSTEM"}
	if code, line := runShim(t, root, spec); code != 0 || line != ReadyLine+"\n" {
		t.Fatalf("shim = %d, %q", code, line)
	}
	if e := readExit(t, paths.ForRoot(root), id); e.Code != 0 {
		t.Fatalf("exit = %+v", e)
	}
}

func TestShimStartFailed(t *testing.T) {
	requirePermanentJobs(t)
	root := shortRoot(t)
	l := paths.ForRoot(root)
	bin := t.TempDir()
	if err := os.WriteFile(filepath.Join(bin, "tool.cmd"), []byte("@echo off\r\n"), 0o644); err != nil {
		t.Fatal(err)
	}
	env := append(os.Environ(), "PATH="+bin)
	for _, tt := range []struct {
		name string
		argv []string
		want string
	}{
		{"missing program", []string{"sbx-no-such-program"}, "program not found"},
		{"unsafe batch args", []string{"tool", "%PATH%"}, "batch file safely"},
	} {
		t.Run(tt.name, func(t *testing.T) {
			id := uniqueID(t)
			code, line := runShim(t, root, Spec{ID: id, Argv: tt.argv, Env: env, User: "SYSTEM"})
			if code != 0 || line != ReadyLine+"\n" {
				t.Fatalf("shim = %d, %q", code, line)
			}
			e := readExit(t, l, id)
			if e.Code != 127 || e.Reason != shimproto.ReasonStartFailed || !strings.Contains(e.StartFailed, tt.want) {
				t.Fatalf("exit = %+v", e)
			}
			stderr, _ := os.ReadFile(filepath.Join(l.CommandDir(id), StderrFile))
			if !strings.Contains(string(stderr), "cannot start command") {
				t.Fatalf("stderr %q", stderr)
			}
			if _, err := winproc.OpenJob(JobName(id)); !errors.Is(err, winproc.ErrJobNotFound) {
				t.Fatalf("job after a failed start: %v", err)
			}
		})
	}
}

func TestShimScriptFile(t *testing.T) {
	requirePermanentJobs(t)
	root := shortRoot(t)
	l := paths.ForRoot(root)
	id := uniqueID(t)
	// cmd.exe runs the script file the shim wrote and is deleted after.
	script := filepath.Join(l.CommandDir(id), "script.ps1")
	spec := Spec{ID: id, Argv: []string{cmdExe(), "/d", "/c", "type " + script + " & exit 0"}, Env: os.Environ(),
		User: "SYSTEM", Script: "Write-Output 'from the script'"}
	if code, _ := runShim(t, root, spec); code != 0 {
		t.Fatalf("shim = %d", code)
	}
	stdout, _ := os.ReadFile(filepath.Join(l.CommandDir(id), StdoutFile))
	if !strings.Contains(string(stdout), "from the script") {
		t.Fatalf("stdout %q", stdout)
	}
	if _, err := os.Stat(script); !os.IsNotExist(err) {
		t.Fatalf("script left behind: %v", err)
	}
}

func TestShimTimeout(t *testing.T) {
	requirePermanentJobs(t)
	root := shortRoot(t)
	id := uniqueID(t)
	// The in-process shim cannot deliver CTRL_BREAK (the test process has a
	// console); the job termination after the grace ends the command.
	spec := Spec{ID: id, Argv: []string{cmdExe(), "/d", "/c", "ping -n 60 127.0.0.1 >NUL"}, Env: os.Environ(),
		User: "SYSTEM", TimeoutMs: 300, KillGraceMs: 300}
	start := time.Now()
	if code, _ := runShim(t, root, spec); code != 0 {
		t.Fatalf("shim = %d", code)
	}
	if d := time.Since(start); d > 20*time.Second {
		t.Fatalf("timeout took %v", d)
	}
	e := readExit(t, paths.ForRoot(root), id)
	if e.Reason != shimproto.ReasonTimeout {
		t.Fatalf("exit = %+v", e)
	}
}
