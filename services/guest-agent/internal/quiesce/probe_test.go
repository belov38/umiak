package quiesce

import (
	"context"
	"os"
	"path/filepath"
	"testing"
	"time"
)

func TestProbeForeignFreeze(t *testing.T) {
	e := newEnv(t, func(o *Options) {
		o.ProbeEvery = 10 * time.Millisecond
		o.ProbeTimeout = 50 * time.Millisecond
	})
	e.fz.st = nil
	e.fz.busy["/"] = true // frozen by QGA, say
	release := make(chan struct{})
	e.m.probeWrite = func() error {
		<-release
		return nil
	}
	ctx, cancel := context.WithCancel(context.Background())
	done := make(chan struct{})
	go func() {
		defer close(done)
		e.m.RunProbe(ctx)
	}()
	waitFor(t, "foreign thaw", func() bool { return len(autoThawed(e.rec)) > 0 })
	close(release)
	cancel()
	<-done
	evs := autoThawed(e.rec)
	if len(evs) != 1 || evs[0].GetBy() != ByForeign || evs[0].GetLeaseId() != "" {
		t.Errorf("events = %v", evs)
	}
	if e.fz.isFrozen("/") {
		t.Error("/ still frozen")
	}
	if !e.log.has("thaw /") || !e.log.has("thaw /data") {
		t.Errorf("not every mount thawed: %q", e.log.all())
	}
}

func TestProbeIgnoresOwnLease(t *testing.T) {
	e := newEnv(t, func(o *Options) { o.ProbeTimeout = 20 * time.Millisecond })
	block := make(chan struct{})
	defer close(block)
	e.m.probeWrite = func() error {
		<-block
		return nil
	}
	ctx := context.Background()
	if _, err := e.m.Quiesce(ctx, 30000, false, true, false); err != nil {
		t.Fatal(err)
	}
	n := len(e.log.all())
	// No probe while the agent's own lease is active.
	e.m.probeAndThaw(ctx)
	if len(e.log.all()) != n {
		t.Errorf("probe acted during the own lease: %q", e.log.all()[n:])
	}
	if _, err := e.m.Thaw(ctx, "lease-1"); err != nil {
		t.Fatal(err)
	}
	// A probe that started before a lease came and went may have hung on
	// the agent's own freeze: no foreign thaw for it.
	_, gen := e.m.startProbe()
	if _, err := e.m.Quiesce(ctx, 30000, false, false, false); err != nil {
		t.Fatal(err)
	}
	if _, err := e.m.Thaw(ctx, "lease-2"); err != nil {
		t.Fatal(err)
	}
	n = len(e.log.all())
	e.m.thawForeign(gen)
	if len(e.log.all()) != n || len(autoThawed(e.rec)) != 0 {
		t.Errorf("foreign thaw after an own lease: %q", e.log.all()[n:])
	}
}

func TestProbeNothingFrozen(t *testing.T) {
	e := newEnv(t, func(o *Options) { o.ProbeTimeout = 20 * time.Millisecond })
	block := make(chan struct{})
	defer close(block)
	e.m.probeWrite = func() error {
		<-block
		return nil
	}
	e.m.probeAndThaw(context.Background())
	if e.log.count("thaw") != 2 {
		t.Errorf("want FITHAW on every mount: %q", e.log.all())
	}
	if len(autoThawed(e.rec)) != 0 {
		t.Error("foreign event without a frozen filesystem")
	}
}

func TestWriteProbe(t *testing.T) {
	dir := filepath.Join(t.TempDir(), "state")
	if err := writeProbe(dir); err != nil {
		t.Fatal(err)
	}
	if _, err := os.Stat(filepath.Join(dir, probeFile)); err != nil {
		t.Error(err)
	}
}

func TestPruneMarkers(t *testing.T) {
	dir := t.TempDir()
	now := time.Now()
	if err := writeMarker(dir, marker{LeaseID: "old", At: now.Add(-2 * MarkerTTL), By: ByWatchdog}); err != nil {
		t.Fatal(err)
	}
	if err := writeMarker(dir, marker{LeaseID: "new", At: now, By: ByWatchdog}); err != nil {
		t.Fatal(err)
	}
	if fileExists(markerPath(dir, "old")) || !fileExists(markerPath(dir, "new")) {
		t.Error("writeMarker did not prune the expired marker only")
	}
	if got := listMarkers(dir, now); len(got) != 1 || got[0].LeaseID != "new" {
		t.Errorf("listMarkers = %+v", got)
	}
}
