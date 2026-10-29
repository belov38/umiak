package quiesce

import (
	"context"
	"errors"
	"os"
	"testing"
	"time"
)

func TestWatchdog(t *testing.T) {
	newSteps := func(e *env) steps {
		return steps{freezer: e.fz, docker: e.dk, runHook: e.m.steps.runHook, log: testLog}
	}
	t.Run("expired lease", func(t *testing.T) {
		e := newEnv(t, nil)
		e.fz.st = nil
		e.fz.frozen["/data"] = true
		e.fz.frozen["/"] = true
		e.dk.paused["c1"] = true
		lease := &Lease{ID: "w-1", Deadline: time.Now().Add(-2 * time.Second),
			Paused: []string{"c1"}, Frozen: []string{"/data", "/"}, Hooks: []string{"/hooks/10-a"}}
		if err := writeLease(e.l.QuiesceFile, lease); err != nil {
			t.Fatal(err)
		}
		if code := runWatchdog(context.Background(), e.l, "w-1", newSteps(e), time.Now); code != 0 {
			t.Fatalf("exit %d", code)
		}
		want := []string{"thaw /", "thaw /data", "hook 10-a thaw", "unpause c1"}
		if got := e.log.all(); len(got) != len(want) {
			t.Errorf("log = %q, want %q", got, want)
		} else {
			for i := range want {
				if got[i] != want[i] {
					t.Errorf("log = %q, want %q", got, want)
					break
				}
			}
		}
		mk, ok := readMarker(e.l.QuiesceThawedDir, "w-1", time.Now())
		if !ok || mk.By != ByWatchdog || mk.Reported || len(mk.Hooks) != 1 || mk.Hooks[0] != "/hooks/10-a" {
			t.Errorf("marker = %+v, %v; want unreported watchdog marker with the thawed hook", mk, ok)
		}
		if fileExists(e.l.QuiesceFile) || fileExists(claimPath(e.l)) {
			t.Error("lease file or claim left")
		}
	})
	t.Run("waits for the deadline", func(t *testing.T) {
		e := newEnv(t, nil)
		deadline := time.Now().Add(-watchdogGrace + 50*time.Millisecond)
		if err := writeLease(e.l.QuiesceFile, &Lease{ID: "w-2", Deadline: deadline}); err != nil {
			t.Fatal(err)
		}
		if code := runWatchdog(context.Background(), e.l, "w-2", newSteps(e), time.Now); code != 0 {
			t.Fatalf("exit %d", code)
		}
		if wake := deadline.Add(watchdogGrace); time.Now().Before(wake) {
			t.Errorf("returned before deadline + grace (%v)", wake)
		}
		if _, ok := readMarker(e.l.QuiesceThawedDir, "w-2", time.Now()); !ok {
			t.Error("no marker")
		}
	})
	t.Run("lease ended", func(t *testing.T) {
		e := newEnv(t, nil)
		if code := runWatchdog(context.Background(), e.l, "w-3", newSteps(e), time.Now); code != 0 {
			t.Fatalf("missing lease: exit %d", code)
		}
		if err := writeLease(e.l.QuiesceFile, &Lease{ID: "other", Deadline: time.Now()}); err != nil {
			t.Fatal(err)
		}
		if code := runWatchdog(context.Background(), e.l, "w-3", newSteps(e), time.Now); code != 0 {
			t.Fatalf("other lease: exit %d", code)
		}
		if _, err := os.Stat(markerPath(e.l.QuiesceThawedDir, "w-3")); !errors.Is(err, os.ErrNotExist) {
			t.Error("marker written for an ended lease")
		}
		if len(e.log.all()) != 0 {
			t.Errorf("acted: %q", e.log.all())
		}
	})
	t.Run("lease thawed while waiting", func(t *testing.T) {
		e := newEnv(t, nil)
		if err := writeLease(e.l.QuiesceFile, &Lease{ID: "w-4", Deadline: time.Now().Add(-watchdogGrace + 100*time.Millisecond)}); err != nil {
			t.Fatal(err)
		}
		go func() {
			time.Sleep(20 * time.Millisecond)
			_ = removeLease(e.l.QuiesceFile)
		}()
		if code := runWatchdog(context.Background(), e.l, "w-4", newSteps(e), time.Now); code != 0 {
			t.Fatalf("exit %d", code)
		}
		if _, ok := readMarker(e.l.QuiesceThawedDir, "w-4", time.Now()); ok {
			t.Error("marker written for a lease the agent thawed")
		}
	})
	t.Run("invalid id", func(t *testing.T) {
		e := newEnv(t, nil)
		if code := runWatchdog(context.Background(), e.l, "../x", newSteps(e), time.Now); code != 2 {
			t.Errorf("exit %d, want 2", code)
		}
	})
}

func TestForceThaw(t *testing.T) {
	e := newEnv(t, nil)
	e.fz.st = nil
	e.fz.busy["/"] = true
	e.fz.frozen["/x"] = true // only named in the lease file
	e.dk.paused["c1"] = true
	e.dk.paused["c2"] = true
	if err := writeLease(e.l.QuiesceFile, &Lease{ID: "f-1", Frozen: []string{"/x"}}); err != nil {
		t.Fatal(err)
	}
	if err := ForceThaw(e.l, e.fz, e.dk); err != nil {
		t.Fatalf("ForceThaw: %v", err)
	}
	for _, p := range []string{"/", "/data", "/x"} {
		if e.fz.isFrozen(p) {
			t.Errorf("%s still frozen", p)
		}
	}
	if ids := e.dk.pausedIDs(); len(ids) != 0 {
		t.Errorf("still paused: %v", ids)
	}
	if !fileExists(e.l.QuiesceFile) {
		t.Error("ForceThaw removed the lease file")
	}
	e.fz.mountErr = errors.New("no mountinfo")
	if err := ForceThaw(e.l, e.fz, nil); err == nil {
		t.Error("ForceThaw hid the mounts error")
	}
}
