//go:build integration && linux

package supervisor

import (
	"context"
	"errors"
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"github.com/belov38/umiak/services/guest-agent/internal/fsutil"
	"github.com/belov38/umiak/services/guest-agent/internal/paths"
	"github.com/belov38/umiak/services/guest-agent/internal/shim"
	"github.com/belov38/umiak/services/guest-agent/internal/shimproto"
)

// These tests need root and systemd as PID 1 (the container of
// test/linux). UMIAK_AGENT_BIN points at the umiak-agent binary that runs the
// shim; by default the installed current/umiak-agent.

func agentBin(t *testing.T) string {
	t.Helper()
	bin := os.Getenv("UMIAK_AGENT_BIN")
	if bin == "" {
		bin = filepath.Join(paths.Default().CurrentLink, "umiak-agent")
	}
	if _, err := os.Stat(bin); err != nil {
		t.Fatalf("umiak-agent binary: %v (set UMIAK_AGENT_BIN)", err)
	}
	return bin
}

type itEnv struct {
	sv     Supervisor
	layout paths.Layout
	root   string
	bin    string
}

func newIT(t *testing.T) *itEnv {
	t.Helper()
	if os.Geteuid() != 0 {
		t.Fatal("integration tests need root")
	}
	sv, err := NewSystemd(context.Background(), DefaultSlice, DefaultCgroupRoot)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = sv.Close() })
	// Short root: unix socket paths are limited to 108 bytes.
	root, err := os.MkdirTemp("", "sv")
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = os.RemoveAll(root) })
	return &itEnv{sv: sv, layout: paths.ForRoot(root), root: root, bin: agentBin(t)}
}

func uniqueID(t *testing.T) string {
	return fmt.Sprintf("it-%s-%d", strings.ToLower(strings.TrimPrefix(t.Name(), "TestSystemd")), time.Now().UnixNano())
}

// launch writes the spec of a shell command and launches its shim.
func (e *itEnv) launch(t *testing.T, id, script string) {
	t.Helper()
	e.launchArgv(t, id, []string{"/bin/sh", "-c", script})
}

// launchArgv writes the spec of argv and launches its shim.
func (e *itEnv) launchArgv(t *testing.T, id string, argv []string) {
	t.Helper()
	spec := shim.Spec{
		ID:   id,
		Argv: argv,
		Env:  []string{"PATH=/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin"},
		Cwd:  "/",
	}
	if err := os.MkdirAll(e.layout.CmdSpecDir, 0o700); err != nil {
		t.Fatal(err)
	}
	if err := fsutil.WriteJSONAtomic(e.layout.CmdSpec(id), spec, 0o600); err != nil {
		t.Fatal(err)
	}
	ctx, cancel := context.WithTimeout(t.Context(), 30*time.Second)
	defer cancel()
	if err := e.sv.Launch(ctx, id, e.bin, []string{"--layout-root", e.root}); err != nil {
		t.Fatalf("Launch: %v", err)
	}
	t.Cleanup(func() { _ = e.sv.Stop(context.Background(), id) })
}

func (e *itEnv) waitExit(t *testing.T, id string) shimproto.ExitFile {
	t.Helper()
	path := filepath.Join(e.layout.CommandDir(id), shim.ExitJSON)
	deadline := time.Now().Add(20 * time.Second)
	for {
		var x shimproto.ExitFile
		err := fsutil.ReadJSON(path, &x)
		if err == nil {
			return x
		}
		if !errors.Is(err, os.ErrNotExist) || time.Now().After(deadline) {
			t.Fatalf("exit.json: %v", err)
		}
		time.Sleep(20 * time.Millisecond)
	}
}

func (e *itEnv) waitState(t *testing.T, id string, want UnitState) {
	t.Helper()
	deadline := time.Now().Add(20 * time.Second)
	for {
		st, err := e.sv.State(t.Context(), id)
		if err != nil {
			t.Fatal(err)
		}
		if st == want {
			return
		}
		if time.Now().After(deadline) {
			t.Fatalf("state of %s = %v, want %v", id, st, want)
		}
		time.Sleep(20 * time.Millisecond)
	}
}

func TestSystemdLaunchNotifyAndCgroup(t *testing.T) {
	e := newIT(t)
	id := uniqueID(t)
	e.launch(t, id, "cat /proc/self/cgroup; sleep 0.2")

	// READY=1 comes after the start: shim.json already has the pid.
	var sf shim.ShimFile
	if err := fsutil.ReadJSON(filepath.Join(e.layout.CommandDir(id), shim.ShimJSON), &sf); err != nil {
		t.Fatal(err)
	}
	if sf.State != shim.StateRunning || sf.Pid == 0 {
		t.Fatalf("shim.json after Launch = %+v", sf)
	}

	x := e.waitExit(t, id)
	if x.Status != shimproto.StatusExited || x.Code != 0 {
		t.Fatalf("exit = %+v", x)
	}
	out, err := os.ReadFile(filepath.Join(e.layout.CommandDir(id), shim.StdoutFile))
	if err != nil {
		t.Fatal(err)
	}
	cg := strings.TrimSpace(string(out))
	if want := "/" + UnitName(id) + "/payload"; !strings.HasPrefix(cg, "0::") || !strings.HasSuffix(cg, want) {
		t.Fatalf("cgroup = %q, want suffix %q", cg, want)
	}
	if !strings.Contains(cg, "/"+DefaultSlice+"/") {
		t.Fatalf("cgroup %q is not in %s", cg, DefaultSlice)
	}
	e.waitState(t, id, UnitNotFound)
}

func TestSystemdUnitExists(t *testing.T) {
	e := newIT(t)
	id := uniqueID(t)
	e.launch(t, id, "sleep 30")
	if st, err := e.sv.State(t.Context(), id); err != nil || st != UnitActive {
		t.Fatalf("State = %v, %v", st, err)
	}
	out, err := exec.CommandContext(t.Context(), "systemctl", "show", UnitName(id), "--property",
		"Type,NotifyAccess,Slice,Delegate,KillMode,CollectMode,Environment").Output()
	if err != nil {
		t.Fatal(err)
	}
	for _, want := range []string{"Type=notify", "NotifyAccess=main", "Slice=" + DefaultSlice, "Delegate=yes",
		"KillMode=control-group", "CollectMode=inactive-or-failed", "Environment=GOGC=50 GOMEMLIMIT=6MiB"} {
		if !strings.Contains(string(out), want+"\n") {
			t.Errorf("unit properties lack %q:\n%s", want, out)
		}
	}
	err = e.sv.Launch(t.Context(), id, e.bin, []string{"--layout-root", e.root})
	if !errors.Is(err, ErrUnitExists) {
		t.Fatalf("second Launch = %v, want ErrUnitExists", err)
	}
	if err := e.sv.Stop(t.Context(), id); err != nil {
		t.Fatal(err)
	}
	e.waitState(t, id, UnitNotFound)
	if err := e.sv.Stop(t.Context(), id); err != nil {
		t.Fatalf("Stop of a gone unit = %v", err)
	}
}

func TestSystemdKillCgroup(t *testing.T) {
	e := newIT(t)
	id := uniqueID(t)
	e.launch(t, id, "sleep 60 & sleep 60")
	if err := e.sv.KillCgroup(t.Context(), id); err != nil {
		t.Fatal(err)
	}
	x := e.waitExit(t, id)
	if x.Status != shimproto.StatusKilled || x.Signal != "SIGKILL" {
		t.Fatalf("exit = %+v", x)
	}
	// The leftover died too, so the shim ends and the unit is collected.
	e.waitState(t, id, UnitNotFound)
	if err := e.sv.KillCgroup(t.Context(), id); !errors.Is(err, ErrUnitNotFound) {
		t.Fatalf("KillCgroup of a gone unit = %v", err)
	}
}

func TestSystemdLaunchStartFailed(t *testing.T) {
	e := newIT(t)
	id := uniqueID(t)
	// The shim records the start failure and sends READY=1: Launch succeeds.
	e.launchArgv(t, id, []string{"/nonexistent/umiak-no-such-binary"})
	x := e.waitExit(t, id)
	if x.Code != 127 || x.Reason != shimproto.ReasonStartFailed || x.StartFailed == "" {
		t.Fatalf("exit = %+v", x)
	}
	stderr, err := os.ReadFile(filepath.Join(e.layout.CommandDir(id), shim.StderrFile))
	if err != nil {
		t.Fatal(err)
	}
	if !strings.Contains(string(stderr), "cannot start command") || x.StderrEnd != int64(len(stderr)) {
		t.Fatalf("stderr = %q, exit = %+v", stderr, x)
	}
	e.waitState(t, id, UnitNotFound)
}

func TestSystemdLaunchFailsWithoutSpec(t *testing.T) {
	e := newIT(t)
	id := uniqueID(t)
	ctx, cancel := context.WithTimeout(t.Context(), 30*time.Second)
	defer cancel()
	// No spec: the shim exits 1 before READY=1, the start job fails.
	err := e.sv.Launch(ctx, id, e.bin, []string{"--layout-root", e.root})
	if err == nil || errors.Is(err, ErrUnitExists) {
		t.Fatalf("Launch without spec = %v", err)
	}
	t.Logf("Launch without spec: %v", err)
	e.waitState(t, id, UnitNotFound)
}

func TestSystemdWatchdog(t *testing.T) {
	e := newIT(t)
	lease := uniqueID(t)
	argv := []string{"/bin/sleep", "30"}
	if err := e.sv.StartWatchdog(t.Context(), lease, argv); err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = e.sv.StopWatchdog(context.Background(), lease) })
	if err := e.sv.StartWatchdog(t.Context(), lease, argv); !errors.Is(err, ErrUnitExists) {
		t.Fatalf("second StartWatchdog = %v", err)
	}
	if err := e.sv.StopWatchdog(t.Context(), lease); err != nil {
		t.Fatal(err)
	}
	if err := e.sv.StopWatchdog(t.Context(), lease); err != nil {
		t.Fatalf("StopWatchdog of a gone unit = %v", err)
	}
	// The name is free again once the stopped unit is collected.
	if err := e.sv.StartWatchdog(t.Context(), lease, argv); err != nil {
		t.Fatalf("StartWatchdog after stop: %v", err)
	}
}
