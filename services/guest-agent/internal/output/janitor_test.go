package output_test

import (
	"context"
	"errors"
	"os"
	"path/filepath"
	"slices"
	"testing"
	"time"

	agentv1 "github.com/belov38/boat-dev-clone/libs/proto/sbx/agent/v1"
	"github.com/belov38/boat-dev-clone/services/guest-agent/internal/events"
	"github.com/belov38/boat-dev-clone/services/guest-agent/internal/output"
	"github.com/belov38/boat-dev-clone/services/guest-agent/internal/paths"
)

const (
	kib = 1 << 10
	mib = 1 << 20
	gib = 1 << 30
)

var testNow = time.Date(2026, 10, 30, 12, 0, 0, 0, time.UTC)

type janitorEnv struct {
	layout  paths.Layout
	cmds    []output.JanitorCommand
	removed []string
	rec     *events.Recorder
	free    uint64
	total   uint64
	j       *output.Janitor
}

func newJanitorEnv(t *testing.T) *janitorEnv {
	t.Helper()
	e := &janitorEnv{
		layout: paths.ForRoot(t.TempDir()),
		rec:    &events.Recorder{},
		total:  100 * gib,
		free:   90 * gib,
	}
	e.j = &output.Janitor{
		Layout:    e.layout,
		Store:     output.Default(),
		PerStream: 128 * mib,
		Total:     2 * gib,
		Fraction:  0.10,
		Commands:  func() []output.JanitorCommand { return e.cmds },
		Statfs:    func(string) (uint64, uint64, error) { return e.total, e.free, nil },
		Emit:      e.rec,
		Now:       func() time.Time { return testNow },
		RemoveRecord: func(id string) error {
			e.removed = append(e.removed, id)
			return nil
		},
	}
	return e
}

// add creates a command whose streams hold the given number of bytes.
func (e *janitorEnv) add(t *testing.T, id string, exited bool, endedAt time.Time, streams map[string]int) {
	t.Helper()
	dir := e.layout.CommandDir(id)
	if err := os.MkdirAll(dir, 0o755); err != nil {
		t.Fatal(err)
	}
	cmd := output.JanitorCommand{ID: id, Exited: exited, EndedAt: endedAt}
	for name, n := range streams {
		if err := os.WriteFile(filepath.Join(dir, name), randomData(n), 0o644); err != nil {
			t.Fatal(err)
		}
		cmd.Streams = append(cmd.Streams, name)
	}
	slices.Sort(cmd.Streams)
	e.cmds = append(e.cmds, cmd)
}

// held returns size and size - available_from of a command stream.
func (e *janitorEnv) held(t *testing.T, id, stream string) (size, held int64) {
	t.Helper()
	f, err := os.Open(filepath.Join(e.layout.CommandDir(id), stream))
	if err != nil {
		t.Fatal(err)
	}
	defer func() { _ = f.Close() }()
	fi, err := f.Stat()
	if err != nil {
		t.Fatal(err)
	}
	avail, err := output.Default().AvailableFrom(f, fi.Size())
	if err != nil {
		t.Fatal(err)
	}
	return fi.Size(), fi.Size() - avail
}

func TestJanitorPerStreamCap(t *testing.T) {
	e := newJanitorEnv(t)
	e.j.PerStream = 64 * kib
	e.add(t, "c1", false, time.Time{}, map[string]int{"stdout": 200 * kib, "stderr": 10 * kib})

	if err := e.j.RunOnce(context.Background()); err != nil {
		t.Fatal(err)
	}
	size, held := e.held(t, "c1", "stdout")
	if size != 200*kib {
		t.Fatalf("size = %d, want unchanged", size)
	}
	if held > 64*kib+4095 {
		t.Fatalf("held %d bytes, want <= %d", held, 64*kib+4095)
	}
	if held < 64*kib {
		t.Fatalf("held %d bytes, want at least the cap %d", held, 64*kib)
	}
	if _, held := e.held(t, "c1", "stderr"); held != 10*kib {
		t.Fatalf("small stream held %d, want untouched", held)
	}
}

func TestJanitorTotalDropsOldestExitedFirst(t *testing.T) {
	e := newJanitorEnv(t)
	e.j.Total = 250 * kib
	// Listed out of order on purpose: the oldest exit goes first.
	e.add(t, "newer", true, testNow.Add(-time.Hour), map[string]int{"stdout": 100 * kib})
	e.add(t, "older", true, testNow.Add(-2*time.Hour), map[string]int{"stdout": 100 * kib})
	e.add(t, "running", false, time.Time{}, map[string]int{"stdout": 100 * kib})

	if err := e.j.RunOnce(context.Background()); err != nil {
		t.Fatal(err)
	}
	if _, held := e.held(t, "older", "stdout"); held >= 4096 {
		t.Fatalf("older exited kept %d bytes, want it dropped", held)
	}
	if _, held := e.held(t, "newer", "stdout"); held != 100*kib {
		t.Fatalf("newer exited held %d, want untouched", held)
	}
	if _, held := e.held(t, "running", "stdout"); held != 100*kib {
		t.Fatalf("running held %d, want untouched", held)
	}
	if len(e.removed) != 0 {
		t.Fatalf("records removed: %v", e.removed)
	}
}

func TestJanitorTotalTrimsRunningAfterExited(t *testing.T) {
	e := newJanitorEnv(t)
	e.j.Total = 150 * kib
	e.add(t, "done", true, testNow.Add(-time.Hour), map[string]int{"stdout": 100 * kib})
	e.add(t, "running", false, time.Time{}, map[string]int{"stdout": 100 * kib})

	if err := e.j.RunOnce(context.Background()); err != nil {
		t.Fatal(err)
	}
	if _, held := e.held(t, "done", "stdout"); held >= 4096 {
		t.Fatalf("exited kept %d bytes, want it dropped", held)
	}
	// 200 KiB over a 150 KiB limit: dropping the exited log leaves 100 KiB,
	// which fits, so the running command keeps everything.
	if _, held := e.held(t, "running", "stdout"); held != 100*kib {
		t.Fatalf("running held %d, want untouched", held)
	}

	e = newJanitorEnv(t)
	e.j.Total = 50 * kib
	e.add(t, "done", true, testNow.Add(-time.Hour), map[string]int{"stdout": 100 * kib})
	e.add(t, "running", false, time.Time{}, map[string]int{"stdout": 100 * kib})
	if err := e.j.RunOnce(context.Background()); err != nil {
		t.Fatal(err)
	}
	if _, held := e.held(t, "running", "stdout"); held < 50*kib || held > 50*kib+4095 {
		t.Fatalf("running held %d, want trimmed to about 50 KiB", held)
	}
}

func TestJanitorTotalUsesFilesystemFraction(t *testing.T) {
	e := newJanitorEnv(t)
	e.j.Total = 10 * gib
	e.total = 1 * mib // 10% = ~100 KiB
	e.free = 1 * mib
	e.j.LowFreeBytes = 1
	e.j.LowFreeFraction = 0.0001
	e.add(t, "done", true, testNow.Add(-time.Hour), map[string]int{"stdout": 150 * kib})

	if err := e.j.RunOnce(context.Background()); err != nil {
		t.Fatal(err)
	}
	if _, held := e.held(t, "done", "stdout"); held >= 4096 {
		t.Fatalf("held %d, want dropped by the fraction limit", held)
	}
}

func TestJanitorDiskLowOnceThenOK(t *testing.T) {
	e := newJanitorEnv(t)
	e.add(t, "c1", false, time.Time{}, map[string]int{"stdout": 32 * kib})

	run := func() {
		t.Helper()
		if err := e.j.RunOnce(context.Background()); err != nil {
			t.Fatal(err)
		}
	}
	run() // healthy
	if n := len(e.rec.All()); n != 0 {
		t.Fatalf("events on healthy disk: %v", e.rec.All())
	}

	e.free = 512 * mib // below 1 GiB
	run()
	run()
	run()
	low := e.rec.Of(events.TypeDiskLow)
	if len(low) != 1 {
		t.Fatalf("disk.low events = %d, want 1", len(low))
	}
	p := low[0].(*agentv1.DiskThreshold)
	if p.GetMount() != e.layout.StateDir || p.GetFreeBytes() != 512*mib {
		t.Fatalf("disk.low payload = %v", p)
	}
	if n := len(e.rec.Of(events.TypeDiskOK)); n != 0 {
		t.Fatalf("disk.ok before recovery: %d", n)
	}

	e.free = 50 * gib
	run()
	run()
	if n := len(e.rec.Of(events.TypeDiskOK)); n != 1 {
		t.Fatalf("disk.ok events = %d, want 1", n)
	}
	if n := len(e.rec.Of(events.TypeDiskLow)); n != 1 {
		t.Fatalf("disk.low events = %d after recovery, want 1", n)
	}
}

func TestJanitorDiskLowFraction(t *testing.T) {
	e := newJanitorEnv(t)
	e.total = 100 * gib
	e.free = 4 * gib // above 1 GiB, below 5%
	if err := e.j.RunOnce(context.Background()); err != nil {
		t.Fatal(err)
	}
	if n := len(e.rec.Of(events.TypeDiskLow)); n != 1 {
		t.Fatalf("disk.low events = %d, want 1", n)
	}
}

func TestJanitorDiskLowLowersStreamCap(t *testing.T) {
	e := newJanitorEnv(t)
	e.free = 100 * mib
	e.j.LowPerStream = 32 * kib
	e.add(t, "c1", false, time.Time{}, map[string]int{"stdout": 100 * kib})

	if err := e.j.RunOnce(context.Background()); err != nil {
		t.Fatal(err)
	}
	if _, held := e.held(t, "c1", "stdout"); held > 32*kib+4095 {
		t.Fatalf("held %d, want <= %d", held, 32*kib+4095)
	}

	e.free = 50 * gib
	e.add(t, "c2", false, time.Time{}, map[string]int{"stdout": 100 * kib})
	if err := e.j.RunOnce(context.Background()); err != nil {
		t.Fatal(err)
	}
	if _, held := e.held(t, "c2", "stdout"); held != 100*kib {
		t.Fatalf("held %d after recovery, want untouched", held)
	}
}

func TestJanitorRecordRetention(t *testing.T) {
	e := newJanitorEnv(t)
	e.add(t, "old-exited", true, testNow.Add(-8*24*time.Hour), map[string]int{"stdout": kib})
	e.add(t, "fresh-exited", true, testNow.Add(-24*time.Hour), map[string]int{"stdout": kib})
	e.add(t, "running", false, time.Time{}, map[string]int{"stdout": kib})

	if err := e.j.RunOnce(context.Background()); err != nil {
		t.Fatal(err)
	}
	if !slices.Equal(e.removed, []string{"old-exited"}) {
		t.Fatalf("removed = %v, want [old-exited]", e.removed)
	}
	if _, err := os.Stat(e.layout.CommandDir("old-exited")); !errors.Is(err, os.ErrNotExist) {
		t.Fatalf("log dir of removed record: %v", err)
	}
	if _, err := os.Stat(e.layout.CommandDir("fresh-exited")); err != nil {
		t.Fatal(err)
	}
}

func TestJanitorRecordZeroEndedAtNotExpired(t *testing.T) {
	e := newJanitorEnv(t)
	e.add(t, "no-end-time", true, time.Time{}, map[string]int{"stdout": kib})

	if err := e.j.RunOnce(context.Background()); err != nil {
		t.Fatal(err)
	}
	if len(e.removed) != 0 {
		t.Fatalf("removed = %v, want none", e.removed)
	}
	if _, err := os.Stat(e.layout.CommandDir("no-end-time")); err != nil {
		t.Fatal(err)
	}
}

func TestJanitorRefusesUnsafeIDs(t *testing.T) {
	e := newJanitorEnv(t)
	e.j.MaxRecords = 1
	old := testNow.Add(-30 * 24 * time.Hour)
	e.add(t, "keep", false, time.Time{}, map[string]int{"stdout": kib})
	for _, id := range []string{"", ".", "..", "../escape", "a/b"} {
		e.cmds = append(e.cmds, output.JanitorCommand{ID: id, Exited: true, EndedAt: old})
	}
	outside := filepath.Join(filepath.Dir(e.layout.CommandsDir), "escape")
	if err := os.MkdirAll(outside, 0o755); err != nil {
		t.Fatal(err)
	}

	err := e.j.RunOnce(context.Background())
	if err == nil {
		t.Fatal("RunOnce returned nil, want an error for invalid ids")
	}
	if len(e.removed) != 0 {
		t.Fatalf("RemoveRecord called for %v", e.removed)
	}
	for _, p := range []string{e.layout.CommandDir("keep"), outside} {
		if _, err := os.Stat(p); err != nil {
			t.Fatalf("%s was removed: %v", p, err)
		}
	}
}

func TestJanitorRecordRetentionRunningNeverRemoved(t *testing.T) {
	e := newJanitorEnv(t)
	e.j.MaxRecords = 1
	e.add(t, "running-1", false, time.Time{}, map[string]int{"stdout": kib})
	e.add(t, "running-2", false, time.Time{}, map[string]int{"stdout": kib})
	// A running command with a stale EndedAt must still be kept.
	e.cmds[0].EndedAt = testNow.Add(-30 * 24 * time.Hour)

	if err := e.j.RunOnce(context.Background()); err != nil {
		t.Fatal(err)
	}
	if len(e.removed) != 0 {
		t.Fatalf("removed = %v, want none", e.removed)
	}
}

func TestJanitorRecordRetentionMaxRecords(t *testing.T) {
	e := newJanitorEnv(t)
	e.j.MaxRecords = 2
	e.add(t, "e3", true, testNow.Add(-3*time.Hour), map[string]int{"stdout": kib})
	e.add(t, "e1", true, testNow.Add(-1*time.Hour), map[string]int{"stdout": kib})
	e.add(t, "e2", true, testNow.Add(-2*time.Hour), map[string]int{"stdout": kib})
	e.add(t, "run", false, time.Time{}, map[string]int{"stdout": kib})

	if err := e.j.RunOnce(context.Background()); err != nil {
		t.Fatal(err)
	}
	// 4 records, limit 2: the two oldest exited go.
	slices.Sort(e.removed)
	if !slices.Equal(e.removed, []string{"e2", "e3"}) {
		t.Fatalf("removed = %v, want [e2 e3]", e.removed)
	}
}

func TestJanitorMissingFilesAreSkipped(t *testing.T) {
	e := newJanitorEnv(t)
	e.cmds = []output.JanitorCommand{{ID: "ghost", Streams: []string{"stdout", "pty"}}}
	if err := e.j.RunOnce(context.Background()); err != nil {
		t.Fatal(err)
	}
}

func TestJanitorRunStopsOnCancel(t *testing.T) {
	e := newJanitorEnv(t)
	calls := make(chan struct{}, 16)
	e.j.Commands = func() []output.JanitorCommand {
		select {
		case calls <- struct{}{}:
		default:
		}
		return nil
	}
	ctx, cancel := context.WithCancel(context.Background())
	done := make(chan struct{})
	go func() {
		e.j.Run(ctx, 5*time.Millisecond)
		close(done)
	}()
	select {
	case <-calls:
	case <-time.After(5 * time.Second):
		t.Fatal("Run never ran the janitor")
	}
	cancel()
	select {
	case <-done:
	case <-time.After(5 * time.Second):
		t.Fatal("Run did not stop after cancel")
	}
}
