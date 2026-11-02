package quiesce

import (
	"context"
	"fmt"
	"os"
	"slices"
	"testing"
	"time"

	"connectrpc.com/connect"

	"github.com/belov38/umiak/services/guest-agent/internal/errs"
)

// fakeSecrets is the claim manager's secret file store: it logs the wipe
// and the restore. inUse makes the wipe fail like a file held open.
type fakeSecrets struct {
	log    *recLog
	inUse  bool
	onWipe func() // runs after the wipe, if set
}

func (f *fakeSecrets) WipeSecretFiles() (bool, error) {
	f.log.add("secrets wipe")
	if f.onWipe != nil {
		f.onWipe()
	}
	if f.inUse {
		return false, fmt.Errorf("wipe key.pem: %w", errs.ErrSecretInUse)
	}
	return true, nil
}

func (f *fakeSecrets) RestoreSecretFiles() error {
	f.log.add("secrets restore")
	return nil
}

// newWindowsEnv is an env with the Windows quiesce: no filesystem freeze,
// wipe_secret_files honoured, a fake secret store.
func newWindowsEnv(t *testing.T) (*env, *fakeSecrets) {
	t.Helper()
	e := newEnv(t, nil)
	sec := &fakeSecrets{log: e.log}
	e.m.fsFreeze = false
	e.m.wipeSecrets = true
	e.m.SetSecrets(sec)
	return e, sec
}

func TestQuiesceWipeSecretFilesThenThawRestores(t *testing.T) {
	t.Run("thaw", func(t *testing.T) {
		e, _ := newWindowsEnv(t)
		e.addHook(t, "10-a.ps1", "", 0o755)
		ctx := context.Background()
		if _, err := e.m.Quiesce(ctx, 30000, false, false, true); err != nil {
			t.Fatalf("Quiesce: %v", err)
		}
		// The wipe comes after the hooks, which may close the files.
		want := []string{"watchdog start lease-1", "hook 10-a freeze", "secrets wipe"}
		if got := e.log.all(); !slices.Equal(got, want) {
			t.Errorf("quiesce order:\n got %q\nwant %q", got, want)
		}
		n := len(e.log.all())
		if _, err := e.m.Thaw(ctx, "lease-1"); err != nil {
			t.Fatalf("Thaw: %v", err)
		}
		wantThaw := []string{"secrets restore", "hook 10-a thaw", "watchdog stop lease-1"}
		if got := e.log.all()[n:]; !slices.Equal(got, wantThaw) {
			t.Errorf("thaw order:\n got %q\nwant %q", got, wantThaw)
		}
	})
	t.Run("lease expiry", func(t *testing.T) {
		e, _ := newWindowsEnv(t)
		if _, err := e.m.Quiesce(context.Background(), 200, false, false, true); err != nil {
			t.Fatalf("Quiesce: %v", err)
		}
		waitFor(t, "the restore at the deadline", func() bool { return e.log.has("secrets restore") })
		waitFor(t, "the lease to end", func() bool { return e.m.Status() == nil })
		if e.log.count("secrets restore") != 1 {
			t.Errorf("log = %q, want one restore", e.log.all())
		}
	})
	t.Run("watchdog thawed first", func(t *testing.T) {
		// The watchdog process cannot restore the files (they are in the
		// agent's memory): the agent does when it adopts the thaw.
		e, _ := newWindowsEnv(t)
		e.m.markerEvery = time.Hour
		if _, err := e.m.Quiesce(context.Background(), 60000, false, false, true); err != nil {
			t.Fatal(err)
		}
		s := steps{runHook: e.m.steps.runHook, log: testLog}
		if err := writeLease(e.l.QuiesceFile, &Lease{ID: "lease-1", Deadline: time.Now().Add(-2 * time.Second)}); err != nil {
			t.Fatal(err)
		}
		if code := runWatchdog(context.Background(), e.l, "lease-1", s, time.Now); code != 0 {
			t.Fatalf("watchdog exit %d", code)
		}
		if e.log.has("secrets restore") {
			t.Fatal("restored before the agent saw the thaw")
		}
		tr, err := e.m.Thaw(context.Background(), "lease-1")
		if err != nil || !tr.GetAutoThawed() {
			t.Fatalf("Thaw = %v, %v; want auto_thawed", tr, err)
		}
		if e.log.count("secrets restore") != 1 {
			t.Errorf("log = %q, want one restore", e.log.all())
		}
	})
	t.Run("ignored without support", func(t *testing.T) {
		// Linux: the secrets are on a tmpfs, the flag is accepted and
		// ignored.
		e, _ := newWindowsEnv(t)
		e.m.wipeSecrets = false
		if _, err := e.m.Quiesce(context.Background(), 30000, false, false, true); err != nil {
			t.Fatal(err)
		}
		if _, err := e.m.Thaw(context.Background(), "lease-1"); err != nil {
			t.Fatal(err)
		}
		if e.log.count("secrets ") != 0 {
			t.Errorf("log = %q, want no wipe", e.log.all())
		}
	})
	t.Run("not requested", func(t *testing.T) {
		e, _ := newWindowsEnv(t)
		if _, err := e.m.Quiesce(context.Background(), 30000, false, false, false); err != nil {
			t.Fatal(err)
		}
		if _, err := e.m.Thaw(context.Background(), "lease-1"); err != nil {
			t.Fatal(err)
		}
		if e.log.count("secrets ") != 0 {
			t.Errorf("log = %q, want no wipe", e.log.all())
		}
	})
}

func TestQuiesceSecretsInUseRollsBack(t *testing.T) {
	e, sec := newWindowsEnv(t)
	sec.inUse = true
	e.addHook(t, "10-a.ps1", "", 0o755)
	_, err := e.m.Quiesce(context.Background(), 30000, false, false, true)
	wantErr(t, err, connect.CodeFailedPrecondition, errs.SecretsInUse)
	want := []string{
		"watchdog start lease-1", "hook 10-a freeze", "secrets wipe",
		"secrets restore", "hook 10-a thaw", "watchdog stop lease-1",
	}
	if got := e.log.all(); !slices.Equal(got, want) {
		t.Errorf("log:\n got %q\nwant %q", got, want)
	}
	if e.m.Status() != nil || fileExists(e.l.QuiesceFile) {
		t.Error("lease left after the rollback")
	}
	// The next lease works once the file is closed.
	sec.inUse = false
	if _, err := e.m.Quiesce(context.Background(), 30000, false, false, true); err != nil {
		t.Fatalf("Quiesce after the rollback: %v", err)
	}
}

func TestQuiesceFsUnsupportedOnWindows(t *testing.T) {
	e, _ := newWindowsEnv(t)
	_, err := e.m.Quiesce(context.Background(), 30000, false, true, false)
	wantErr(t, err, connect.CodeFailedPrecondition, errs.FsFreezeUnsupported)
	if got := e.log.all(); len(got) != 0 {
		t.Errorf("acted before refusing: %q", got)
	}
	if e.m.Status() != nil || fileExists(e.l.QuiesceFile) {
		t.Error("lease left")
	}
	// docker is ignored: no container is paused.
	res, err := e.m.Quiesce(context.Background(), 30000, true, false, false)
	if err != nil {
		t.Fatalf("Quiesce docker=true fs=false: %v", err)
	}
	if len(res.GetPausedContainers()) != 0 || e.log.count("pause ") != 0 || e.log.count("freeze ") != 0 {
		t.Errorf("paused or froze on Windows: %q", e.log.all())
	}
}

// TestWindowsHookList: on Windows the hooks are the *.ps1 files of the
// hooks dir in name order; the exec bit does not matter.
func TestWindowsHookList(t *testing.T) {
	e := newEnv(t, nil)
	e.addHook(t, "20-b.PS1", "", 0o644)
	e.addHook(t, "10-a.ps1", "", 0o644)
	e.addHook(t, "30-c.sh", "", 0o755)
	e.addHook(t, ".hidden.ps1", "", 0o644)
	if err := os.Mkdir(e.l.QuiesceHooksDir+"/40-d.ps1", 0o755); err != nil {
		t.Fatal(err)
	}
	got, err := listHooksMatching(e.l.QuiesceHooksDir, isPS1Hook)
	if err != nil {
		t.Fatal(err)
	}
	var names []string
	for _, p := range got {
		names = append(names, p[len(e.l.QuiesceHooksDir)+1:])
	}
	if want := []string{"10-a.ps1", "20-b.PS1"}; !slices.Equal(names, want) {
		t.Errorf("hooks = %q, want %q", names, want)
	}
	argv := ps1HookArgv(`C:\Windows`, `C:\ProgramData\umiak-agent\quiesce.d\10-a.ps1`, hookFreeze)
	want := []string{`C:\Windows\System32\WindowsPowerShell\v1.0\powershell.exe`, "-NoProfile", "-NonInteractive",
		"-ExecutionPolicy", "Bypass", "-File", `C:\ProgramData\umiak-agent\quiesce.d\10-a.ps1`, "freeze"}
	if !slices.Equal(argv, want) {
		t.Errorf("argv = %q, want %q", argv, want)
	}
	if argv := ps1HookArgv("", "h.ps1", hookThaw); argv[0] != "powershell.exe" {
		t.Errorf("argv without SystemRoot = %q", argv)
	}
}

// TestWindowsWatchdog: the Windows watchdog has no freezer and no Docker;
// it runs the thaw hooks and drops its expired lease, leaving the secret
// files to the agent. One that outlived an agent restart finds its lease
// gone or replaced and does nothing.
func TestWindowsWatchdog(t *testing.T) {
	t.Run("expired lease", func(t *testing.T) {
		e, _ := newWindowsEnv(t)
		s := steps{runHook: e.m.steps.runHook, log: testLog}
		lease := &Lease{ID: "w-1", Deadline: time.Now().Add(-2 * time.Second), Hooks: []string{"/hooks/10-a.ps1"}, SecretsWiped: true}
		if err := writeLease(e.l.QuiesceFile, lease); err != nil {
			t.Fatal(err)
		}
		if code := runWatchdog(context.Background(), e.l, "w-1", s, time.Now); code != 0 {
			t.Fatalf("exit %d", code)
		}
		if want := []string{"hook 10-a thaw"}; !slices.Equal(e.log.all(), want) {
			t.Errorf("log = %q, want %q", e.log.all(), want)
		}
		if fileExists(e.l.QuiesceFile) || fileExists(claimPath(e.l)) {
			t.Error("lease left")
		}
		if _, ok := readMarker(e.l.QuiesceThawedDir, "w-1", time.Now()); !ok {
			t.Error("no marker")
		}
	})
	t.Run("after an agent restart", func(t *testing.T) {
		e, _ := newWindowsEnv(t)
		s := steps{runHook: e.m.steps.runHook, log: testLog}
		// The new agent thawed the old lease at start and took a new one.
		if _, err := e.m.Quiesce(context.Background(), 60000, false, false, true); err != nil {
			t.Fatal(err)
		}
		n := len(e.log.all())
		if code := runWatchdog(context.Background(), e.l, "old-lease", s, time.Now); code != 0 {
			t.Fatalf("exit %d", code)
		}
		if got := e.log.all()[n:]; len(got) != 0 {
			t.Errorf("stale watchdog acted: %q", got)
		}
		if l, err := readLease(e.l.QuiesceFile); err != nil || l == nil || l.ID != "lease-1" {
			t.Errorf("lease file = %+v, %v; want the current lease", l, err)
		}
	})
}

// TestStartupLeaseWithWipedSecrets: a lease left by an agent that died
// after the wipe is thawed at start; the files cannot be restored (the
// secrets were in the old process) and come back with UpdateSecrets.
func TestStartupLeaseWithWipedSecrets(t *testing.T) {
	e, _ := newWindowsEnv(t)
	e.m.SetSecrets(nil)
	if err := writeLease(e.l.QuiesceFile, &Lease{ID: "old", Deadline: time.Now().Add(time.Minute), Hooks: []string{"/hooks/10-a.ps1"}, SecretsWiped: true}); err != nil {
		t.Fatal(err)
	}
	e.m.Startup(context.Background())
	if want := []string{"hook 10-a thaw", "watchdog stop old"}; !slices.Equal(e.log.all(), want) {
		t.Errorf("log = %q, want %q", e.log.all(), want)
	}
	if fileExists(e.l.QuiesceFile) {
		t.Error("lease left")
	}
	if evs := autoThawed(e.rec); len(evs) != 1 || evs[0].GetBy() != ByAgentStart {
		t.Errorf("events = %v", evs)
	}
}

// TestQuiesceWipeWithoutSecretStore: a wipe requested before the claim
// manager is set fails instead of handing out a lease without the wipe.
func TestQuiesceWipeWithoutSecretStore(t *testing.T) {
	e, _ := newWindowsEnv(t)
	e.m.SetSecrets(nil)
	_, err := e.m.Quiesce(context.Background(), 30000, false, false, true)
	wantErr(t, err, connect.CodeUnavailable, errs.Internal)
	if e.m.Status() != nil || fileExists(e.l.QuiesceFile) || len(e.log.all()) != 0 {
		t.Errorf("lease started: %q", e.log.all())
	}
	// Without the wipe a lease is fine.
	if _, err := e.m.Quiesce(context.Background(), 30000, false, false, false); err != nil {
		t.Fatal(err)
	}
}

// TestWatchdogFiresAfterWipe: the watchdog unit takes the lease right after
// the wipe; the Quiesce fails with lease_expired and its rollback restores
// the files (the unit cannot).
func TestWatchdogFiresAfterWipe(t *testing.T) {
	e, sec := newWindowsEnv(t)
	e.addHook(t, "10-a.ps1", "", 0o755)
	unit := steps{log: testLog, runHook: func(_ context.Context, p, arg string) error {
		e.log.add("unit hook %s %s", hookLabel(p), arg)
		return nil
	}}
	sec.onWipe = func() {
		runWatchdog(context.Background(), e.l, "lease-1", unit, func() time.Time { return time.Now().Add(time.Hour) })
	}
	_, err := e.m.Quiesce(context.Background(), 30000, false, false, true)
	wantErr(t, err, connect.CodeAborted, errs.LeaseExpired)
	want := []string{
		"watchdog start lease-1", "hook 10-a freeze", "secrets wipe",
		"unit hook 10-a thaw", "secrets restore", "watchdog stop lease-1",
	}
	if got := e.log.all(); !slices.Equal(got, want) {
		t.Errorf("log:\n got %q\nwant %q", got, want)
	}
	if e.m.Status() != nil || fileExists(e.l.QuiesceFile) || fileExists(claimPath(e.l)) {
		t.Error("lease not cleaned up")
	}
}

// TestCutoffAfterWipe: the freeze budget runs out during the wipe; the
// check after it rolls back with quiesce_timeout and restores the files.
func TestCutoffAfterWipe(t *testing.T) {
	e, sec := newWindowsEnv(t)
	e.m.freezeBudget = 50 * time.Millisecond
	sec.onWipe = func() { time.Sleep(100 * time.Millisecond) }
	_, err := e.m.Quiesce(context.Background(), 30000, false, false, true)
	wantErr(t, err, connect.CodeDeadlineExceeded, errs.QuiesceTimeout)
	want := []string{"watchdog start lease-1", "secrets wipe", "secrets restore", "watchdog stop lease-1"}
	if got := e.log.all(); !slices.Equal(got, want) {
		t.Errorf("log:\n got %q\nwant %q", got, want)
	}
	if e.m.Status() != nil || fileExists(e.l.QuiesceFile) {
		t.Error("lease left")
	}
}
