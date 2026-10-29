package quiesce

import (
	"context"
	"errors"
	"fmt"
	"net/http"
	"os"
	"path/filepath"
	"slices"
	"strings"
	"sync"
	"syscall"
	"testing"
	"time"

	"github.com/belov38/boat-dev-clone/services/guest-agent/internal/docker"
	"github.com/belov38/boat-dev-clone/services/guest-agent/internal/events"
	"github.com/belov38/boat-dev-clone/services/guest-agent/internal/paths"
	"github.com/belov38/boat-dev-clone/services/guest-agent/internal/store"
	"github.com/belov38/boat-dev-clone/services/guest-agent/internal/supervisor"
)

// recLog records the actions of the fakes in order.
type recLog struct {
	mu    sync.Mutex
	items []string
}

func (r *recLog) add(format string, args ...any) {
	r.mu.Lock()
	defer r.mu.Unlock()
	r.items = append(r.items, fmt.Sprintf(format, args...))
}

func (r *recLog) all() []string {
	r.mu.Lock()
	defer r.mu.Unlock()
	return slices.Clone(r.items)
}

// has reports whether the log holds item.
func (r *recLog) has(item string) bool {
	return slices.Contains(r.all(), item)
}

// count counts the entries with prefix.
func (r *recLog) count(prefix string) int {
	n := 0
	for _, it := range r.all() {
		if strings.HasPrefix(it, prefix) {
			n++
		}
	}
	return n
}

// fakeFreezer simulates FIFREEZE semantics: freezing a frozen filesystem
// fails with EBUSY, thawing an unfrozen one with EINVAL. busy marks mounts
// frozen by someone else.
type fakeFreezer struct {
	log *recLog
	st  *store.Store // when set, the log shows whether the store was frozen

	mu       sync.Mutex
	mounts   []Mount
	frozen   map[string]bool
	busy     map[string]bool
	mountErr error
}

func newFakeFreezer(log *recLog, paths ...string) *fakeFreezer {
	f := &fakeFreezer{log: log, frozen: map[string]bool{}, busy: map[string]bool{}}
	for _, p := range paths {
		f.mounts = append(f.mounts, Mount{Path: p, Source: "/dev/x" + p, FSType: "ext4"})
	}
	return f
}

func (f *fakeFreezer) Mounts() ([]Mount, error) {
	f.mu.Lock()
	defer f.mu.Unlock()
	if f.mountErr != nil {
		return nil, f.mountErr
	}
	return slices.Clone(f.mounts), nil
}

func (f *fakeFreezer) note(op, p string) {
	if f.st != nil {
		f.log.add("%s %s store=%v", op, p, f.st.Frozen())
		return
	}
	f.log.add("%s %s", op, p)
}

func (f *fakeFreezer) Freeze(p string) error {
	f.note("freeze", p)
	f.mu.Lock()
	defer f.mu.Unlock()
	if f.frozen[p] || f.busy[p] {
		return &os.PathError{Op: "FIFREEZE", Path: p, Err: syscall.EBUSY}
	}
	f.frozen[p] = true
	return nil
}

func (f *fakeFreezer) Thaw(p string) error {
	f.note("thaw", p)
	f.mu.Lock()
	defer f.mu.Unlock()
	switch {
	case f.frozen[p]:
		delete(f.frozen, p)
	case f.busy[p]:
		delete(f.busy, p)
	default:
		return &os.PathError{Op: "FITHAW", Path: p, Err: syscall.EINVAL}
	}
	return nil
}

func (f *fakeFreezer) isFrozen(p string) bool {
	f.mu.Lock()
	defer f.mu.Unlock()
	return f.frozen[p] || f.busy[p]
}

// fakeDocker simulates the Docker daemon.
type fakeDocker struct {
	log *recLog

	mu        sync.Mutex
	running   []string
	paused    map[string]bool
	failPause map[string]error
	listErr   error
}

func newFakeDocker(log *recLog, running ...string) *fakeDocker {
	return &fakeDocker{log: log, running: running, paused: map[string]bool{}, failPause: map[string]error{}}
}

func (d *fakeDocker) Running(context.Context) ([]string, error) {
	d.mu.Lock()
	defer d.mu.Unlock()
	if d.listErr != nil {
		return nil, d.listErr
	}
	var out []string
	for _, id := range d.running {
		if !d.paused[id] {
			out = append(out, id)
		}
	}
	return out, nil
}

func (d *fakeDocker) Paused(context.Context) ([]string, error) {
	d.mu.Lock()
	defer d.mu.Unlock()
	if d.listErr != nil {
		return nil, d.listErr
	}
	var out []string
	for id, p := range d.paused {
		if p {
			out = append(out, id)
		}
	}
	slices.Sort(out)
	return out, nil
}

func (d *fakeDocker) Pause(_ context.Context, id string) error {
	d.log.add("pause %s", id)
	d.mu.Lock()
	defer d.mu.Unlock()
	if err := d.failPause[id]; err != nil {
		return err
	}
	d.paused[id] = true
	return nil
}

func (d *fakeDocker) Unpause(_ context.Context, id string) error {
	d.log.add("unpause %s", id)
	d.mu.Lock()
	defer d.mu.Unlock()
	if !d.paused[id] {
		return &docker.APIError{Status: http.StatusConflict, Message: "Container " + id + " is not paused"}
	}
	delete(d.paused, id)
	return nil
}

func (d *fakeDocker) pausedIDs() []string {
	ids, _ := d.Paused(context.Background())
	return ids
}

// logSupervisor is supervisor.Fake (which checks the lease id) that logs
// the watchdog calls.
type logSupervisor struct {
	*supervisor.Fake
	log *recLog
}

func (s logSupervisor) StartWatchdog(ctx context.Context, id string, argv []string) error {
	s.log.add("watchdog start %s", id)
	return s.Fake.StartWatchdog(ctx, id, argv)
}

func (s logSupervisor) StopWatchdog(ctx context.Context, id string) error {
	s.log.add("watchdog stop %s", id)
	return s.Fake.StopWatchdog(ctx, id)
}

// env is a Manager with fakes on a temporary layout.
type env struct {
	m   *Manager
	l   paths.Layout
	log *recLog
	fz  *fakeFreezer
	dk  *fakeDocker
	sv  logSupervisor
	st  *store.Store
	rec *events.Recorder
}

// newEnv builds an env; mod may adjust the options before New.
func newEnv(t *testing.T, mod func(*Options)) *env {
	t.Helper()
	l := paths.ForRoot(t.TempDir())
	for _, d := range []string{l.StateDir, l.RunDir, l.QuiesceHooksDir} {
		if err := os.MkdirAll(d, 0o755); err != nil {
			t.Fatal(err)
		}
	}
	st, err := store.Open(l.StateDB, store.Options{})
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = st.Close() })
	log := &recLog{}
	e := &env{
		l:   l,
		log: log,
		fz:  newFakeFreezer(log, "/data", "/"),
		dk:  newFakeDocker(log, "c1", "c2"),
		sv:  logSupervisor{Fake: supervisor.NewFake(l), log: log},
		st:  st,
		rec: &events.Recorder{},
	}
	e.fz.st = st
	opts := Options{
		Layout:     l,
		Store:      st,
		Docker:     e.dk,
		Freezer:    e.fz,
		Supervisor: e.sv,
		Emit:       e.rec,
		Self:       "/usr/local/bin/sbx-agent",
	}
	if mod != nil {
		mod(&opts)
	}
	e.m = New(opts)
	n := 0
	var mu sync.Mutex
	e.m.newID = func() string {
		mu.Lock()
		defer mu.Unlock()
		n++
		return fmt.Sprintf("lease-%d", n)
	}
	e.m.syncFS = func() { log.add("sync") }
	e.m.steps.runHook = func(_ context.Context, p, arg string) error {
		log.add("hook %s %s", filepath.Base(p), arg)
		return nil
	}
	// Probes succeed at once unless a test replaces them.
	e.m.probeWrite = func() error { return nil }
	return e
}

// addHook creates an executable hook file in the hooks dir.
func (e *env) addHook(t *testing.T, name, body string, mode os.FileMode) string {
	t.Helper()
	p := filepath.Join(e.l.QuiesceHooksDir, name)
	if err := os.WriteFile(p, []byte(body), mode); err != nil {
		t.Fatal(err)
	}
	return p
}

// waitFor polls cond for up to 5 s.
func waitFor(t *testing.T, what string, cond func() bool) {
	t.Helper()
	deadline := time.Now().Add(5 * time.Second)
	for !cond() {
		if time.Now().After(deadline) {
			t.Fatalf("timed out waiting for %s", what)
		}
		time.Sleep(5 * time.Millisecond)
	}
}

// fileExists reports whether p exists.
func fileExists(p string) bool {
	_, err := os.Stat(p)
	return !errors.Is(err, os.ErrNotExist)
}
