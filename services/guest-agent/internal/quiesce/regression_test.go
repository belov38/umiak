package quiesce

import (
	"context"
	"os"
	"path/filepath"
	"slices"
	"sync"
	"testing"
	"time"

	"connectrpc.com/connect"

	"github.com/belov38/boat-dev-clone/services/guest-agent/internal/errs"
)

// TestProbeStaleGenAfterOwnLease: a probe hangs on a foreign freeze, a
// Quiesce in between fails with frozen_by_other; the foreign freeze must
// still be thawed by the probe loop afterwards.
func TestProbeStaleGenAfterOwnLease(t *testing.T) {
	e := newEnv(t, func(o *Options) {
		o.ProbeEvery = 10 * time.Millisecond
		o.ProbeTimeout = 50 * time.Millisecond
	})
	e.fz.st = nil
	e.fz.busy["/"] = true
	release := make(chan struct{})
	defer close(release)
	e.m.probeWrite = func() error {
		<-release
		return nil
	}
	e.m.startProbe() // hangs on the foreign freeze
	_, err := e.m.Quiesce(context.Background(), 30000, false, true, false)
	wantErr(t, err, connect.CodeFailedPrecondition, errs.FrozenByOther)

	ctx, cancel := context.WithCancel(context.Background())
	done := make(chan struct{})
	go func() {
		defer close(done)
		e.m.RunProbe(ctx)
	}()
	waitFor(t, "foreign thaw", func() bool { return !e.fz.isFrozen("/") })
	cancel()
	<-done
	if evs := autoThawed(e.rec); len(evs) != 1 || evs[0].GetBy() != ByForeign {
		t.Errorf("events = %v", evs)
	}
}

// TestWatchdogMidQuiesce: the watchdog unit fires while a freeze hook of a
// Quiesce is still running. The Quiesce must fail with lease_expired and
// leave nothing frozen or paused, and no hook may get thaw twice.
func TestWatchdogMidQuiesce(t *testing.T) {
	e := newEnv(t, nil)
	e.fz.st = nil
	e.addHook(t, "a", "#!/bin/sh\n", 0o755)
	e.addHook(t, "b", "#!/bin/sh\n", 0o755)
	unit := steps{freezer: e.fz, docker: e.dk, log: testLog,
		runHook: func(_ context.Context, p, arg string) error {
			e.log.add("unit hook %s %s", filepath.Base(p), arg)
			return nil
		}}
	e.m.steps.runHook = func(ctx context.Context, p, arg string) error {
		e.log.add("hook %s %s", filepath.Base(p), arg)
		if arg == hookFreeze && filepath.Base(p) == "a" {
			// The unit wakes while hook a runs (its clock is past the
			// deadline).
			runWatchdog(ctx, e.l, "lease-1", unit, func() time.Time { return time.Now().Add(time.Hour) })
		}
		return nil
	}
	_, err := e.m.Quiesce(context.Background(), 30000, true, true, false)
	wantErr(t, err, connect.CodeAborted, errs.LeaseExpired)
	if e.fz.isFrozen("/") || e.fz.isFrozen("/data") || len(e.dk.pausedIDs()) != 0 {
		t.Errorf("left frozen or paused: %q", e.log.all())
	}
	if n := e.log.count("freeze /"); n != 0 {
		t.Errorf("froze after the unit fired: %q", e.log.all())
	}
	if e.log.has("hook b freeze") {
		t.Errorf("ran a hook after the unit fired: %q", e.log.all())
	}
	// Hook a: thaw once, by the unit.
	if e.log.count("unit hook a thaw") != 1 || e.log.count("hook a thaw") != 0 {
		t.Errorf("hook a thaw: %q", e.log.all())
	}
	if e.m.Status() != nil || fileExists(e.l.QuiesceFile) || fileExists(claimPath(e.l)) {
		t.Error("lease not cleaned up")
	}
	// The lease was never handed out: no event, the marker is silenced.
	if len(autoThawed(e.rec)) != 0 {
		t.Errorf("events = %v", e.rec.All())
	}
	if mk, ok := readMarker(e.l.QuiesceThawedDir, "lease-1", time.Now()); !ok || !mk.Reported {
		t.Errorf("marker = %+v, %v", mk, ok)
	}
}

// TestQuiesceStopsAtDeadline: a Quiesce whose steps reach the lease deadline
// rolls back with lease_expired instead of freezing past it.
func TestQuiesceStopsAtDeadline(t *testing.T) {
	e := newEnv(t, nil)
	e.addHook(t, "10-a", "#!/bin/sh\n", 0o755)
	e.addHook(t, "20-b", "#!/bin/sh\n", 0o755)
	e.m.steps.runHook = func(_ context.Context, p, arg string) error {
		e.log.add("hook %s %s", filepath.Base(p), arg)
		if arg == hookFreeze {
			time.Sleep(150 * time.Millisecond)
		}
		return nil
	}
	_, err := e.m.Quiesce(context.Background(), 100, true, true, false)
	wantErr(t, err, connect.CodeAborted, errs.LeaseExpired)
	if e.log.has("hook 20-b freeze") || e.log.count("freeze /") != 0 {
		t.Errorf("continued past the deadline: %q", e.log.all())
	}
	if !e.log.has("hook 10-a thaw") || len(e.dk.pausedIDs()) != 0 || e.st.Frozen() {
		t.Errorf("rollback incomplete: %q", e.log.all())
	}
	time.Sleep(50 * time.Millisecond) // the timer fires on an ended lease
	if len(autoThawed(e.rec)) != 0 {
		t.Errorf("events = %v", e.rec.All())
	}
}

// TestQuiesceBudget: the freeze steps are capped by the freeze budget when
// the lease is longer.
func TestQuiesceBudget(t *testing.T) {
	e := newEnv(t, nil)
	e.m.freezeBudget = 50 * time.Millisecond
	e.addHook(t, "10-a", "#!/bin/sh\n", 0o755)
	e.m.steps.runHook = func(ctx context.Context, p, arg string) error {
		e.log.add("hook %s %s", filepath.Base(p), arg)
		if arg == hookFreeze {
			<-ctx.Done() // a hook that only stops when killed
			return ctx.Err()
		}
		return nil
	}
	start := time.Now()
	_, err := e.m.Quiesce(context.Background(), 30000, true, true, false)
	wantErr(t, err, connect.CodeDeadlineExceeded, errs.QuiesceTimeout)
	if d := time.Since(start); d > 2*time.Second {
		t.Errorf("Quiesce took %v", d)
	}
	if e.log.count("freeze /") != 0 || !e.log.has("hook 10-a thaw") || e.st.Frozen() {
		t.Errorf("rollback incomplete: %q", e.log.all())
	}
}

// slowSupervisor delays StartWatchdog, like a busy systemd.
type slowSupervisor struct {
	Supervisor
	delay time.Duration
}

func (s slowSupervisor) StartWatchdog(ctx context.Context, id string, argv []string) error {
	time.Sleep(s.delay)
	return s.Supervisor.StartWatchdog(ctx, id, argv)
}

// TestQuiesceBudgetIncludesWatchdogStart: the freeze budget counts from
// before the watchdog unit start, so a slow systemd eats into it.
func TestQuiesceBudgetIncludesWatchdogStart(t *testing.T) {
	e := newEnv(t, func(o *Options) {
		o.Supervisor = slowSupervisor{Supervisor: o.Supervisor, delay: 150 * time.Millisecond}
	})
	e.m.freezeBudget = 100 * time.Millisecond
	_, err := e.m.Quiesce(context.Background(), 30000, true, true, false)
	wantErr(t, err, connect.CodeDeadlineExceeded, errs.QuiesceTimeout)
	if e.log.count("freeze /") != 0 || e.st.Frozen() {
		t.Errorf("froze past the budget: %q", e.log.all())
	}
}

// blockingStore is a store whose SetFrozen(true) waits for gate, like the
// real store with a commit hanging on a foreign freeze.
type blockingStore struct {
	gate chan struct{}

	mu     sync.Mutex
	frozen bool
	calls  []bool
}

func (s *blockingStore) SetFrozen(f bool) {
	if f {
		<-s.gate
	}
	s.mu.Lock()
	defer s.mu.Unlock()
	s.frozen = f
	s.calls = append(s.calls, f)
}

func (s *blockingStore) Flush(context.Context) error { return nil }

func (s *blockingStore) state() (bool, []bool) {
	s.mu.Lock()
	defer s.mu.Unlock()
	return s.frozen, slices.Clone(s.calls)
}

// TestLateStoreFreezeUndone: a store freeze that timed out lands later,
// while another lease that did not freeze the store is active; it must be
// undone.
func TestLateStoreFreezeUndone(t *testing.T) {
	e := newEnv(t, nil)
	bs := &blockingStore{gate: make(chan struct{})}
	e.m.st = bs
	e.m.storeFreezeTimeout = 30 * time.Millisecond
	ctx := context.Background()
	_, err := e.m.Quiesce(ctx, 30000, false, true, false)
	wantErr(t, err, connect.CodeUnavailable, errs.StoreBusy)
	if e.log.count("freeze /") != 0 {
		t.Errorf("froze with a busy store: %q", e.log.all())
	}
	// A docker-only lease is active when the late freeze lands.
	if _, err := e.m.Quiesce(ctx, 30000, true, false, false); err != nil {
		t.Fatal(err)
	}
	close(bs.gate)
	waitFor(t, "late freeze undone", func() bool {
		frozen, calls := bs.state()
		return !frozen && len(calls) == 2
	})
	if _, err := e.m.Thaw(ctx, "lease-2"); err != nil {
		t.Fatal(err)
	}
	if frozen, calls := bs.state(); frozen {
		t.Errorf("store frozen after the thaw: %v", calls)
	}
}

// TestThawWaitsForUnitMarker: a Thaw that finds the lease file claimed by
// the watchdog unit (thaw in progress) waits for its marker and reports
// auto_thawed.
func TestThawWaitsForUnitMarker(t *testing.T) {
	t.Run("marker arrives", func(t *testing.T) {
		e := newEnv(t, nil)
		e.m.markerEvery = time.Hour
		if _, err := e.m.Quiesce(context.Background(), 60000, true, true, false); err != nil {
			t.Fatal(err)
		}
		if err := os.Rename(e.l.QuiesceFile, claimPath(e.l)); err != nil {
			t.Fatal(err)
		}
		at := time.Now().UTC()
		go func() {
			time.Sleep(100 * time.Millisecond)
			_ = writeMarker(e.l.QuiesceThawedDir, marker{LeaseID: "lease-1", At: at, By: ByWatchdog})
			_ = removeLease(claimPath(e.l))
		}()
		tr, err := e.m.Thaw(context.Background(), "lease-1")
		if err != nil {
			t.Fatal(err)
		}
		if !tr.GetAutoThawed() || !tr.GetAlreadyThawed() || !tr.GetAutoThawedAt().AsTime().Equal(at) {
			t.Errorf("Thaw = %v, want auto_thawed at %v", tr, at)
		}
		if evs := autoThawed(e.rec); len(evs) != 1 || evs[0].GetBy() != ByWatchdog {
			t.Errorf("events = %v", evs)
		}
		if e.st.Frozen() || e.fz.isFrozen("/") || e.m.Status() != nil {
			t.Error("not thawed")
		}
	})
	t.Run("unit died", func(t *testing.T) {
		e := newEnv(t, nil)
		e.m.markerEvery = time.Hour
		e.m.unitMarkerWait = 50 * time.Millisecond
		if _, err := e.m.Quiesce(context.Background(), 60000, true, true, false); err != nil {
			t.Fatal(err)
		}
		if err := os.Rename(e.l.QuiesceFile, claimPath(e.l)); err != nil {
			t.Fatal(err)
		}
		tr, err := e.m.Thaw(context.Background(), "lease-1")
		if err != nil || tr.GetAutoThawed() || tr.GetAlreadyThawed() {
			t.Fatalf("Thaw = %v, %v; want a plain thaw", tr, err)
		}
		if e.fz.isFrozen("/") || e.fz.isFrozen("/data") || e.st.Frozen() {
			t.Error("not thawed")
		}
		// The claim of the killed unit goes with the lease: the next
		// start must not thaw it again and report auto_thawed.
		if fileExists(claimPath(e.l)) {
			t.Fatal("claim of the stopped watchdog unit left behind")
		}
		e.m.Startup(context.Background())
		if evs := autoThawed(e.rec); len(evs) != 0 {
			t.Errorf("events after restart = %v, want none", evs)
		}
	})
	t.Run("claim of another lease kept", func(t *testing.T) {
		e := newEnv(t, nil)
		e.m.markerEvery = time.Hour
		if _, err := e.m.Quiesce(context.Background(), 60000, false, false, false); err != nil {
			t.Fatal(err)
		}
		if err := writeLease(claimPath(e.l), &Lease{ID: "other", Deadline: time.Now()}); err != nil {
			t.Fatal(err)
		}
		if _, err := e.m.Thaw(context.Background(), "lease-1"); err != nil {
			t.Fatal(err)
		}
		if l, err := readLease(claimPath(e.l)); err != nil || l == nil || l.ID != "other" {
			t.Fatalf("claim of another lease = %+v, %v; want kept", l, err)
		}
	})
}

// TestWatchdogNeverClobbersNewLease: the watchdog compares the lease id
// before it claims the file, so a lease the agent started after the old
// one ended stays in place.
func TestWatchdogNeverClobbersNewLease(t *testing.T) {
	e := newEnv(t, nil)
	if err := writeLease(e.l.QuiesceFile, &Lease{ID: "old", Deadline: time.Now().Add(-watchdogGrace + 100*time.Millisecond)}); err != nil {
		t.Fatal(err)
	}
	// While the watchdog sleeps, the agent ends "old" and starts "new".
	go func() {
		time.Sleep(20 * time.Millisecond)
		_ = writeLease(e.l.QuiesceFile, &Lease{ID: "new", Deadline: time.Now().Add(time.Hour)})
	}()
	s := steps{freezer: e.fz, docker: e.dk, runHook: e.m.steps.runHook, log: testLog}
	if code := runWatchdog(context.Background(), e.l, "old", s, time.Now); code != 0 {
		t.Fatalf("exit %d", code)
	}
	if l, err := readLease(e.l.QuiesceFile); err != nil || l == nil || l.ID != "new" {
		t.Fatalf("lease file = %+v, %v; want the new lease", l, err)
	}
	if fileExists(claimPath(e.l)) {
		t.Error("claim left")
	}
	if len(e.log.all()) != 0 {
		t.Errorf("acted on the new lease: %q", e.log.all())
	}
}

// TestStartupClaimedLease: a watchdog unit that died while thawing leaves
// its claim; the agent thaws it at start.
func TestStartupClaimedLease(t *testing.T) {
	e := newEnv(t, nil)
	e.fz.st = nil
	e.fz.frozen["/data"] = true
	if err := writeLease(claimPath(e.l), &Lease{ID: "old-2", Deadline: time.Now(), Frozen: []string{"/data"}}); err != nil {
		t.Fatal(err)
	}
	e.m.Startup(context.Background())
	if e.fz.isFrozen("/data") || fileExists(claimPath(e.l)) {
		t.Errorf("claimed lease not thawed: %q", e.log.all())
	}
	if evs := autoThawed(e.rec); len(evs) != 1 || evs[0].GetLeaseId() != "old-2" || evs[0].GetBy() != ByAgentStart {
		t.Errorf("events = %v", evs)
	}
}

// TestStartupUnreadableLeaseNothingFrozen: an unreadable lease with nothing
// frozen or paused yields no event.
func TestStartupUnreadableLeaseNothingFrozen(t *testing.T) {
	e := newEnv(t, nil)
	if err := os.WriteFile(e.l.QuiesceFile, []byte("{bad"), 0o600); err != nil {
		t.Fatal(err)
	}
	e.m.Startup(context.Background())
	if fileExists(e.l.QuiesceFile) {
		t.Error("lease file left")
	}
	if len(autoThawed(e.rec)) != 0 {
		t.Errorf("events = %v", e.rec.All())
	}
}

// leaseCheckSupervisor records whether the lease file still existed when
// the watchdog unit was stopped.
type leaseCheckSupervisor struct {
	Supervisor
	path string
	seen *[]bool
}

func (s leaseCheckSupervisor) StopWatchdog(ctx context.Context, id string) error {
	*s.seen = append(*s.seen, fileExists(s.path))
	return s.Supervisor.StopWatchdog(ctx, id)
}

// TestReleaseRemovesLeaseBeforeStoppingWatchdog: the watchdog unit thaws
// on its stop signal while the lease file is there, so a normal thaw
// removes the file first: the unit then finds nothing to do.
func TestReleaseRemovesLeaseBeforeStoppingWatchdog(t *testing.T) {
	var seen []bool
	e := newEnv(t, func(o *Options) {
		o.Supervisor = leaseCheckSupervisor{Supervisor: o.Supervisor, path: o.Layout.QuiesceFile, seen: &seen}
	})
	e.m.markerEvery = time.Hour
	if _, err := e.m.Quiesce(context.Background(), 60000, true, true, false); err != nil {
		t.Fatal(err)
	}
	if _, err := e.m.Thaw(context.Background(), "lease-1"); err != nil {
		t.Fatal(err)
	}
	if len(seen) != 1 || seen[0] {
		t.Fatalf("lease file present at the watchdog stop: %v", seen)
	}
}

// TestShutdownThawsActiveLease: an agent that stops with an active lease
// thaws it, leaves a marker for a later Thaw and reports the event.
func TestShutdownThawsActiveLease(t *testing.T) {
	e := newEnv(t, nil)
	e.m.markerEvery = time.Hour
	if _, err := e.m.Quiesce(context.Background(), 60000, true, true, false); err != nil {
		t.Fatal(err)
	}
	e.m.AutoThaw(ByAgentStop)
	if e.fz.isFrozen("/") || e.st.Frozen() || len(e.dk.pausedIDs()) != 0 || e.m.Status() != nil {
		t.Errorf("not thawed: %q", e.log.all())
	}
	if fileExists(e.l.QuiesceFile) {
		t.Error("lease file left")
	}
	if evs := autoThawed(e.rec); len(evs) != 1 || evs[0].GetBy() != ByAgentStop {
		t.Errorf("events = %v", evs)
	}
	tr, err := e.m.Thaw(context.Background(), "lease-1")
	if err != nil || !tr.GetAutoThawed() {
		t.Errorf("Thaw after the shutdown thaw = %v, %v; want auto_thawed", tr, err)
	}
}
