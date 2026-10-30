package update

import (
	"context"
	"crypto/ed25519"
	"errors"
	"os"
	"path/filepath"
	"runtime"
	"sync"
	"sync/atomic"
	"testing"
	"time"

	"connectrpc.com/connect"

	agentv1 "github.com/belov38/boat-dev-clone/libs/proto/sbx/agent/v1"

	"github.com/belov38/boat-dev-clone/services/guest-agent/internal/events"
	"github.com/belov38/boat-dev-clone/services/guest-agent/internal/fsutil"
	"github.com/belov38/boat-dev-clone/services/guest-agent/internal/paths"
	"github.com/belov38/boat-dev-clone/services/guest-agent/internal/system"
)

var _ system.Updater = (*Manager)(nil)

var testNow = time.Date(2026, 10, 30, 12, 0, 0, 0, time.UTC)

// applyEnv is a layout with v1 installed and active, an agent running v1
// and an upload "up" holding a package.
type applyEnv struct {
	l        paths.Layout
	priv     ed25519.PrivateKey
	m        *Manager
	rec      *events.Recorder
	exits    atomic.Int32
	mu       sync.Mutex
	selftest []string
	uploads  map[string]string
}

func newApplyEnv(t *testing.T, running string) *applyEnv {
	t.Helper()
	pub, priv := testKey(t)
	e := &applyEnv{l: paths.ForRoot(t.TempDir()), priv: priv, rec: &events.Recorder{}, uploads: map[string]string{}}
	installed(t, e.l, "v1", priv)
	setLinks(t, e.l, "v1", "")
	e.m = e.manager(t, running, pub)
	return e
}

func (e *applyEnv) manager(t *testing.T, running string, pub ed25519.PublicKey) *Manager {
	t.Helper()
	m, err := New(Options{
		Layout: e.l,
		Keys:   func() []ed25519.PublicKey { return []ed25519.PublicKey{pub} },
		Uploads: func(id string) (string, error) {
			p, ok := e.uploads[id]
			if !ok {
				return "", errors.New("upload not found")
			}
			return p, nil
		},
		SelfTest: func(_ context.Context, bin string) error {
			e.mu.Lock()
			defer e.mu.Unlock()
			e.selftest = append(e.selftest, bin)
			return nil
		},
		Exit:        func() { e.exits.Add(1) },
		Emit:        e.rec,
		Now:         func() time.Time { return testNow },
		Version:     running,
		ExitDelay:   time.Millisecond,
		ExitWaitMax: time.Hour, // Exit can only follow the end of the handler
	})
	if err != nil {
		t.Fatal(err)
	}
	return m
}

func mustPending(t *testing.T, l paths.Layout) Pending {
	t.Helper()
	var p Pending
	if err := fsutil.ReadJSON(l.PendingUpdateFile, &p); err != nil {
		t.Fatal(err)
	}
	return p
}

func waitFor(t *testing.T, cond func() bool) {
	t.Helper()
	deadline := time.Now().Add(3 * time.Second)
	for !cond() {
		if time.Now().After(deadline) {
			t.Fatal("condition not reached")
		}
		time.Sleep(5 * time.Millisecond)
	}
}

func TestApplyFlow(t *testing.T) {
	e := newApplyEnv(t, "v1")
	e.uploads["up"] = packTest(t, "v2", e.priv)

	ctx, cancel := context.WithCancel(context.Background())
	res, err := e.m.Apply(ctx, "up", false)
	if err != nil {
		t.Fatal(err)
	}
	if res.GetFrom() != "v1" || res.GetTo() != "v2" {
		t.Errorf("response = %v", res)
	}
	p := mustPending(t, e.l)
	if p.From != "v1" || p.To != "v2" || !p.Deadline.Equal(testNow.Add(120*time.Second)) {
		t.Errorf("pending = %+v", p)
	}
	if cur, prev := linkTarget(t, e.l.CurrentLink), linkTarget(t, e.l.PreviousLink); cur != "v2" || prev != "v1" {
		t.Errorf("current, previous = %q, %q", cur, prev)
	}
	if want := filepath.Join(e.l.VersionsDir, "v2", BinaryName); len(e.selftest) != 1 || e.selftest[0] != want {
		t.Errorf("selftest = %v, want [%s]", e.selftest, want)
	}
	st := e.m.Status()
	if !st.GetPending() || st.GetFrom() != "v1" || st.GetTo() != "v2" || !st.GetDeadline().AsTime().Equal(p.Deadline) {
		t.Errorf("status = %v", st)
	}

	// A second Apply is refused: by the pending file, and by the switched
	// state even without it.
	e.uploads["up3"] = packTest(t, "v3", e.priv)
	if _, err := e.m.Apply(context.Background(), "up3", false); detailCode(err) != "update_in_progress" {
		t.Errorf("second apply: %v", err)
	}
	if err := os.Remove(e.l.PendingUpdateFile); err != nil {
		t.Fatal(err)
	}
	if _, err := e.m.Apply(context.Background(), "up3", false); detailCode(err) != "update_in_progress" {
		t.Errorf("apply after switch: %v", err)
	}
	// GC skips while the agent is about to exit into the new version.
	ageVersions(t, e.l)
	if err := e.m.GC(nil); err != nil {
		t.Fatal(err)
	}
	if _, err := os.Stat(filepath.Join(e.l.VersionsDir, "v2")); err != nil {
		t.Errorf("GC during apply: %v", err)
	}

	// Exit waits for the handler to return (request context done).
	if n := e.exits.Load(); n != 0 {
		t.Fatalf("exit called %d times before the handler returned", n)
	}
	cancel()
	waitFor(t, func() bool { return e.exits.Load() == 1 })
	e.m.exit()
	if n := e.exits.Load(); n != 1 {
		t.Errorf("exit called %d times", n)
	}
	if entries, _ := os.ReadDir(e.l.StagingDir); len(entries) != 0 {
		t.Errorf("staging not cleaned: %v", entries)
	}
}

func TestApplyBadVersion(t *testing.T) {
	e := newApplyEnv(t, "v1")
	e.uploads["up"] = packTest(t, "v2", e.priv)
	e.uploads["same"] = packTest(t, "v1", e.priv)
	if err := addBadVersion(e.l, "v2"); err != nil {
		t.Fatal(err)
	}

	_, err := e.m.Apply(context.Background(), "up", false)
	if connect.CodeOf(err) != connect.CodeFailedPrecondition || detailCode(err) != "bad_version" {
		t.Errorf("bad version: %v (%s)", err, detailCode(err))
	}
	if _, err := os.Stat(e.l.PendingUpdateFile); !os.IsNotExist(err) {
		t.Error("pending written for a bad version")
	}
	if cur := linkTarget(t, e.l.CurrentLink); cur != "v1" {
		t.Errorf("current = %q", cur)
	}

	_, err = e.m.Apply(context.Background(), "same", false)
	if connect.CodeOf(err) != connect.CodeInvalidArgument || detailCode(err) != "bad_version" {
		t.Errorf("same version: %v (%s)", err, detailCode(err))
	}

	if st := e.m.Status(); st.GetPending() || len(st.GetBadVersions()) != 1 || st.GetBadVersions()[0] != "v2" {
		t.Errorf("status = %v", st)
	}

	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	if _, err := e.m.Apply(ctx, "up", true); err != nil {
		t.Errorf("allow_bad_version: %v", err)
	}
}

func TestApplyInProgress(t *testing.T) {
	e := newApplyEnv(t, "v1")
	e.uploads["up"] = packTest(t, "v2", e.priv)
	if err := writePending(e.l, Pending{From: "v0", To: "v1", Deadline: testNow.Add(time.Minute)}); err != nil {
		t.Fatal(err)
	}
	_, err := e.m.Apply(context.Background(), "up", false)
	if connect.CodeOf(err) != connect.CodeFailedPrecondition || detailCode(err) != "update_in_progress" {
		t.Errorf("err = %v (%s)", err, detailCode(err))
	}
}

func TestApplySelfTestFails(t *testing.T) {
	e := newApplyEnv(t, "v1")
	e.uploads["up"] = packTest(t, "v2", e.priv)
	e.m.opts.SelfTest = func(context.Context, string) error { return errors.New("schema 9 unsupported") }

	if _, err := e.m.Apply(context.Background(), "up", false); err == nil {
		t.Fatal("apply succeeded")
	}
	if _, err := os.Stat(e.l.PendingUpdateFile); !os.IsNotExist(err) {
		t.Error("pending written")
	}
	if cur := linkTarget(t, e.l.CurrentLink); cur != "v1" {
		t.Errorf("current = %q", cur)
	}
	if _, err := os.Stat(filepath.Join(e.l.VersionsDir, "v2")); !os.IsNotExist(err) {
		t.Errorf("failed version kept: %v", err)
	}
	if n := e.exits.Load(); n != 0 {
		t.Errorf("exit called %d times", n)
	}
}

func TestApplySelfTestFailsKeepsOldBuild(t *testing.T) {
	e := newApplyEnv(t, "v1")
	installed(t, e.l, "v2", e.priv)
	before, err := os.ReadFile(filepath.Join(e.l.VersionsDir, "v2", ManifestName))
	if err != nil {
		t.Fatal(err)
	}
	e.uploads["up"] = packBuild(t, "v2", runtime.GOOS, runtime.GOARCH, e.priv, "another build")
	e.m.opts.SelfTest = func(context.Context, string) error { return errors.New("broken") }
	if _, err := e.m.Apply(context.Background(), "up", false); err == nil {
		t.Fatal("apply succeeded")
	}
	after, err := os.ReadFile(filepath.Join(e.l.VersionsDir, "v2", ManifestName))
	if err != nil || string(after) != string(before) {
		t.Errorf("old build not restored: %v", err)
	}
	if entries, _ := filepath.Glob(filepath.Join(e.l.VersionsDir, ".*")); len(entries) != 0 {
		t.Errorf("leftovers: %v", entries)
	}
}

func TestApplyRejectsForeignSignature(t *testing.T) {
	e := newApplyEnv(t, "v1")
	_, other := testKey(t)
	e.uploads["up"] = packTest(t, "v2", other)
	_, err := e.m.Apply(context.Background(), "up", false)
	if detailCode(err) != "signature_invalid" {
		t.Errorf("err = %v (%s)", err, detailCode(err))
	}
}

func TestCheckPendingDeadlinePassed(t *testing.T) {
	e := newApplyEnv(t, "v1")
	installed(t, e.l, "v2", e.priv)
	setLinks(t, e.l, "v2", "v1")
	if err := writePending(e.l, Pending{From: "v1", To: "v2", Deadline: testNow.Add(-time.Second)}); err != nil {
		t.Fatal(err)
	}
	m := e.manager(t, "v2", e.priv.Public().(ed25519.PublicKey))
	if err := m.CheckPending(context.Background()); err != nil {
		t.Fatal(err)
	}
	if cur, prev := linkTarget(t, e.l.CurrentLink), linkTarget(t, e.l.PreviousLink); cur != "v1" || prev != "v1" {
		t.Errorf("current, previous = %q, %q; want v1, v1", cur, prev)
	}
	bad, err := readBadVersions(e.l)
	if err != nil || len(bad) != 1 || bad[0] != "v2" {
		t.Errorf("bad versions = %v, %v", bad, err)
	}
	if _, err := os.Stat(e.l.PendingUpdateFile); !os.IsNotExist(err) {
		t.Error("pending kept")
	}
	if n := e.exits.Load(); n != 1 {
		t.Errorf("exit called %d times", n)
	}
	if got := e.rec.Of(events.TypeUpdateResult); len(got) != 0 {
		t.Errorf("new version emitted %v", got)
	}

	// The old version reports the rollback on its next start.
	old := e.manager(t, "v1", e.priv.Public().(ed25519.PublicKey))
	if err := old.CheckPending(context.Background()); err != nil {
		t.Fatal(err)
	}
	got := e.rec.Of(events.TypeUpdateResult)
	if len(got) != 1 {
		t.Fatalf("update.result events = %v", got)
	}
	r := got[0].(*agentv1.UpdateResult)
	if r.GetFrom() != "v1" || r.GetTo() != "v2" || r.GetOk() || !r.GetRolledBack() || r.GetError() == "" {
		t.Errorf("update.result = %v", r)
	}
	if _, err := os.Stat(rollbackResultFile(e.l)); !os.IsNotExist(err) {
		t.Error("rollback marker kept")
	}
}

func TestCheckPendingTargetByCurrentLink(t *testing.T) {
	e := newApplyEnv(t, "v1")
	installed(t, e.l, "v2", e.priv)
	setLinks(t, e.l, "v2", "v1")
	if err := writePending(e.l, Pending{From: "v1", To: "v2", Deadline: testNow.Add(-time.Second)}); err != nil {
		t.Fatal(err)
	}
	// A binary that reports "dev" but runs as current=v2 is the target.
	m := e.manager(t, "dev", e.priv.Public().(ed25519.PublicKey))
	if err := m.CheckPending(context.Background()); err != nil {
		t.Fatal(err)
	}
	if cur := linkTarget(t, e.l.CurrentLink); cur != "v1" {
		t.Errorf("current = %q, want v1 (rolled back)", cur)
	}
	if n := e.exits.Load(); n != 1 {
		t.Errorf("exit called %d times", n)
	}
	if got := e.rec.Of(events.TypeUpdateResult); len(got) != 0 {
		t.Errorf("target emitted %v", got)
	}
}

func TestCheckPendingTimerAndConfirm(t *testing.T) {
	for _, confirm := range []bool{false, true} {
		t.Run(map[bool]string{false: "deadline", true: "confirm"}[confirm], func(t *testing.T) {
			e := newApplyEnv(t, "v1")
			installed(t, e.l, "v2", e.priv)
			setLinks(t, e.l, "v2", "v1")
			if err := writePending(e.l, Pending{From: "v1", To: "v2", Deadline: testNow.Add(90 * time.Second)}); err != nil {
				t.Fatal(err)
			}
			m := e.manager(t, "v2", e.priv.Public().(ed25519.PublicKey))
			timers := &fakeTimers{}
			m.afterFunc = timers.afterFunc
			ctx, cancel := context.WithCancel(context.Background())
			defer cancel()
			if err := m.CheckPending(ctx); err != nil {
				t.Fatal(err)
			}
			if len(timers.all) != 1 || timers.all[0].d != 90*time.Second {
				t.Fatalf("timers = %+v", timers.all)
			}
			if n := e.exits.Load(); n != 0 {
				t.Fatalf("exit before deadline: %d", n)
			}
			if !confirm {
				timers.all[0].f()
				if n := e.exits.Load(); n != 1 {
					t.Errorf("exit called %d times", n)
				}
				if cur := linkTarget(t, e.l.CurrentLink); cur != "v1" {
					t.Errorf("current = %q", cur)
				}
				return
			}
			m.Confirm()
			m.Confirm() // idempotent
			if !timers.all[0].stopped {
				t.Error("timer not stopped by Confirm")
			}
			timers.all[0].f() // a timer that fired anyway does nothing
			if n := e.exits.Load(); n != 0 {
				t.Errorf("exit after confirm: %d", n)
			}
			if cur := linkTarget(t, e.l.CurrentLink); cur != "v2" {
				t.Errorf("current = %q", cur)
			}
			if _, err := os.Stat(e.l.PendingUpdateFile); !os.IsNotExist(err) {
				t.Error("pending kept after confirm")
			}
			got := e.rec.Of(events.TypeUpdateResult)
			if len(got) != 1 {
				t.Fatalf("update.result events = %v", got)
			}
			if r := got[0].(*agentv1.UpdateResult); r.GetFrom() != "v1" || r.GetTo() != "v2" || !r.GetOk() || r.GetRolledBack() {
				t.Errorf("update.result = %v", r)
			}
			if m.Status() != nil {
				t.Errorf("status = %v, want nil", m.Status())
			}
		})
	}
}

// An operator who switched versions during the window (install-package
// --activate, rollback --to) removed or replaced pending-update.json: the
// timer must not revert from its stale copy.
func TestDeadlineRereadsPending(t *testing.T) {
	for _, tc := range []struct {
		name   string
		change func(t *testing.T, l paths.Layout)
	}{
		{"removed", func(t *testing.T, l paths.Layout) {
			if err := removePending(l); err != nil {
				t.Fatal(err)
			}
		}},
		{"replaced", func(t *testing.T, l paths.Layout) {
			if err := writePending(l, Pending{From: "v2", To: "v3", Deadline: testNow.Add(time.Minute)}); err != nil {
				t.Fatal(err)
			}
		}},
	} {
		t.Run(tc.name, func(t *testing.T) {
			e := newApplyEnv(t, "v1")
			installed(t, e.l, "v2", e.priv)
			setLinks(t, e.l, "v2", "v1")
			if err := writePending(e.l, Pending{From: "v1", To: "v2", Deadline: testNow.Add(90 * time.Second)}); err != nil {
				t.Fatal(err)
			}
			m := e.manager(t, "v2", e.priv.Public().(ed25519.PublicKey))
			timers := &fakeTimers{}
			m.afterFunc = timers.afterFunc
			if err := m.CheckPending(t.Context()); err != nil {
				t.Fatal(err)
			}
			tc.change(t, e.l)
			timers.all[0].f()
			if n := e.exits.Load(); n != 0 {
				t.Errorf("exit called %d times", n)
			}
			if cur := linkTarget(t, e.l.CurrentLink); cur != "v2" {
				t.Errorf("current = %q, want v2 (no revert)", cur)
			}
			if bad, _ := readBadVersions(e.l); len(bad) != 0 {
				t.Errorf("bad versions = %v", bad)
			}
		})
	}
}

// The start guard enforces the deadline before the slow startup steps.
func TestStartGuard(t *testing.T) {
	setup := func(t *testing.T, deadline time.Time) (*applyEnv, *atomic.Int32) {
		e := newApplyEnv(t, "v1")
		installed(t, e.l, "v2", e.priv)
		setLinks(t, e.l, "v2", "v1")
		if err := writePending(e.l, Pending{From: "v1", To: "v2", Deadline: deadline}); err != nil {
			t.Fatal(err)
		}
		return e, &atomic.Int32{}
	}
	now := func() time.Time { return testNow }
	t.Run("expired at start", func(t *testing.T) {
		e, exits := setup(t, testNow.Add(-time.Second))
		timers := &fakeTimers{}
		g := guardStart(e.l, "v2", now, func() { exits.Add(1) }, timers.afterFunc)
		if exits.Load() != 1 || len(timers.all) != 0 {
			t.Fatalf("exits %d, timers %d; want an immediate revert", exits.Load(), len(timers.all))
		}
		if cur := linkTarget(t, e.l.CurrentLink); cur != "v1" {
			t.Errorf("current = %q, want v1", cur)
		}
		if g.Stop() {
			t.Error("Stop = true after the revert")
		}
	})
	t.Run("deadline during the start", func(t *testing.T) {
		e, exits := setup(t, testNow.Add(90*time.Second))
		timers := &fakeTimers{}
		g := guardStart(e.l, "v2", now, func() { exits.Add(1) }, timers.afterFunc)
		if len(timers.all) != 1 || timers.all[0].d != 90*time.Second || exits.Load() != 0 {
			t.Fatalf("timers %+v, exits %d", timers.all, exits.Load())
		}
		timers.all[0].f() // the start hangs past the deadline
		if exits.Load() != 1 {
			t.Errorf("exits = %d, want 1", exits.Load())
		}
		if cur := linkTarget(t, e.l.CurrentLink); cur != "v1" {
			t.Errorf("current = %q, want v1", cur)
		}
		if g.Stop() {
			t.Error("Stop = true after the revert")
		}
	})
	t.Run("stopped before the deadline", func(t *testing.T) {
		e, exits := setup(t, testNow.Add(90*time.Second))
		timers := &fakeTimers{}
		g := guardStart(e.l, "v2", now, func() { exits.Add(1) }, timers.afterFunc)
		if !g.Stop() || !timers.all[0].stopped {
			t.Fatal("Stop did not disarm the guard")
		}
		timers.all[0].f()
		if exits.Load() != 0 || linkTarget(t, e.l.CurrentLink) != "v2" {
			t.Error("reverted after Stop")
		}
	})
	t.Run("not the target", func(t *testing.T) {
		e, exits := setup(t, testNow.Add(-time.Second))
		setLinks(t, e.l, "v1", "")
		timers := &fakeTimers{}
		g := guardStart(e.l, "v1", now, func() { exits.Add(1) }, timers.afterFunc)
		if exits.Load() != 0 || len(timers.all) != 0 || !g.Stop() {
			t.Errorf("exits %d, timers %d: the guard acted for another version", exits.Load(), len(timers.all))
		}
	})
	t.Run("pending changed meanwhile", func(t *testing.T) {
		e, exits := setup(t, testNow.Add(90*time.Second))
		timers := &fakeTimers{}
		guardStart(e.l, "v2", now, func() { exits.Add(1) }, timers.afterFunc)
		if err := removePending(e.l); err != nil {
			t.Fatal(err)
		}
		timers.all[0].f()
		if exits.Load() != 0 || linkTarget(t, e.l.CurrentLink) != "v2" {
			t.Error("reverted a pending update that is gone")
		}
	})
}

// The uploaded package in staging/ is removed after Apply, also after a
// failure; a package elsewhere is left alone.
func TestApplyRemovesStagedPackage(t *testing.T) {
	stagePkg := func(t *testing.T, e *applyEnv, version, name string) string {
		t.Helper()
		data, err := os.ReadFile(packTest(t, version, e.priv))
		if err != nil {
			t.Fatal(err)
		}
		if err := os.MkdirAll(e.l.StagingDir, 0o700); err != nil {
			t.Fatal(err)
		}
		p := filepath.Join(e.l.StagingDir, name)
		if err := os.WriteFile(p, data, 0o600); err != nil {
			t.Fatal(err)
		}
		return p
	}
	t.Run("success", func(t *testing.T) {
		e := newApplyEnv(t, "v1")
		pkg := stagePkg(t, e, "v2", "sbx-agent-v2.tar")
		e.uploads["up"] = pkg
		ctx, cancel := context.WithCancel(context.Background())
		defer cancel()
		if _, err := e.m.Apply(ctx, "up", false); err != nil {
			t.Fatal(err)
		}
		if _, err := os.Stat(pkg); !os.IsNotExist(err) {
			t.Errorf("staged package kept: %v", err)
		}
	})
	t.Run("failure", func(t *testing.T) {
		e := newApplyEnv(t, "v1")
		pkg := stagePkg(t, e, "v2", "sbx-agent-v2.tar")
		e.uploads["up"] = pkg
		e.m.opts.SelfTest = func(context.Context, string) error { return errors.New("schema 9 unsupported") }
		if _, err := e.m.Apply(context.Background(), "up", false); err == nil {
			t.Fatal("apply succeeded")
		}
		if _, err := os.Stat(pkg); !os.IsNotExist(err) {
			t.Errorf("staged package kept: %v", err)
		}
	})
	t.Run("outside staging", func(t *testing.T) {
		e := newApplyEnv(t, "v1")
		pkg := packTest(t, "v2", e.priv)
		e.uploads["up"] = pkg
		ctx, cancel := context.WithCancel(context.Background())
		defer cancel()
		if _, err := e.m.Apply(ctx, "up", false); err != nil {
			t.Fatal(err)
		}
		if _, err := os.Stat(pkg); err != nil {
			t.Errorf("package outside staging removed: %v", err)
		}
	})
}
