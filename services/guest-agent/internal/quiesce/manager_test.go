package quiesce

import (
	"context"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"runtime"
	"slices"
	"strings"
	"testing"
	"time"

	"connectrpc.com/connect"

	agentv1 "github.com/belov38/boat-dev-clone/libs/proto/sbx/agent/v1"
	"github.com/belov38/boat-dev-clone/libs/tunnel/rpcconv"

	"github.com/belov38/boat-dev-clone/services/guest-agent/internal/docker"
	"github.com/belov38/boat-dev-clone/services/guest-agent/internal/errs"
	"github.com/belov38/boat-dev-clone/services/guest-agent/internal/events"
	"github.com/belov38/boat-dev-clone/services/guest-agent/internal/system"
)

var _ system.Quiescer = (*Manager)(nil)

// wantErr checks that err is a Connect error with code and detail and
// returns its message.
func wantErr(t *testing.T, err error, code connect.Code, detail string) string {
	t.Helper()
	var cerr *connect.Error
	if !errors.As(err, &cerr) {
		t.Fatalf("err = %v, want a connect error", err)
	}
	if cerr.Code() != code {
		t.Errorf("code = %v, want %v (%v)", cerr.Code(), code, err)
	}
	d, ok := rpcconv.Detail(cerr)
	if !ok || d.GetCode() != detail {
		t.Errorf("detail = %v, want %q", d, detail)
	}
	return cerr.Message()
}

// sortSpan sorts log[from:to] (parallel docker calls have no order).
func sortSpan(log []string, from, to int) []string {
	out := slices.Clone(log)
	slices.Sort(out[from:to])
	return out
}

// autoThawed returns the recorded quiesce.auto_thawed payloads.
func autoThawed(rec *events.Recorder) []*agentv1.QuiesceAutoThawed {
	var out []*agentv1.QuiesceAutoThawed
	for _, p := range rec.Of(events.TypeQuiesceAutoThawed) {
		out = append(out, p.(*agentv1.QuiesceAutoThawed))
	}
	return out
}

func TestQuiesceOrderAndRollback(t *testing.T) {
	t.Run("order", func(t *testing.T) {
		e := newEnv(t, nil)
		e.addHook(t, "20-b", "#!/bin/sh\n", 0o755)
		e.addHook(t, "10-a", "#!/bin/sh\n", 0o755)
		ctx := context.Background()
		before := time.Now()
		res, err := e.m.Quiesce(ctx, 30000, true, true, false)
		if err != nil {
			t.Fatalf("Quiesce: %v", err)
		}
		if res.GetLeaseId() != "lease-1" {
			t.Errorf("lease id = %q", res.GetLeaseId())
		}
		if d := res.GetDeadline().AsTime().Sub(before); d < 29*time.Second || d > 31*time.Second {
			t.Errorf("deadline in %v, want ~30s", d)
		}
		if !slices.Equal(res.GetPausedContainers(), []string{"c1", "c2"}) {
			t.Errorf("paused = %v", res.GetPausedContainers())
		}
		if !slices.Equal(res.GetFrozenMounts(), []string{"/data", "/"}) {
			t.Errorf("frozen = %v", res.GetFrozenMounts())
		}
		argv, ok := e.sv.Watchdog("lease-1")
		if want := []string{"/usr/local/bin/sbx-agent", "quiesce-watchdog", "--lease", "lease-1"}; !ok || !slices.Equal(argv, want) {
			t.Errorf("watchdog argv = %v, %v; want %v", argv, ok, want)
		}
		l, err := readLease(e.l.QuiesceFile)
		if err != nil || l == nil {
			t.Fatalf("lease file: %v, %v", l, err)
		}
		if l.ID != "lease-1" || !slices.Equal(l.Paused, []string{"c1", "c2"}) || !slices.Equal(l.Frozen, []string{"/data", "/"}) ||
			len(l.Hooks) != 2 || filepath.Base(l.Hooks[0]) != "10-a" || filepath.Base(l.Hooks[1]) != "20-b" {
			t.Errorf("lease = %+v", l)
		}
		want := []string{
			"watchdog start lease-1",
			"pause c1", "pause c2",
			"hook 10-a freeze", "hook 20-b freeze",
			"sync",
			"freeze /data store=true", "freeze / store=true",
		}
		if got := sortSpan(e.log.all(), 1, 3); !slices.Equal(got, want) {
			t.Errorf("quiesce order:\n got %q\nwant %q", got, want)
		}

		n := len(e.log.all())
		tr, err := e.m.Thaw(ctx, "lease-1")
		if err != nil {
			t.Fatalf("Thaw: %v", err)
		}
		if tr.GetAutoThawed() || tr.GetAlreadyThawed() {
			t.Errorf("Thaw = %v, want a plain thaw", tr)
		}
		wantThaw := []string{
			"thaw / store=true", "thaw /data store=true",
			"hook 20-b thaw", "hook 10-a thaw",
			"unpause c1", "unpause c2",
			"watchdog stop lease-1",
		}
		if got := sortSpan(e.log.all()[n:], 4, 6); !slices.Equal(got, wantThaw) {
			t.Errorf("thaw order:\n got %q\nwant %q", got, wantThaw)
		}
		if e.st.Frozen() || fileExists(e.l.QuiesceFile) || e.m.Status() != nil || len(e.dk.pausedIDs()) != 0 {
			t.Errorf("after thaw: store frozen %v, lease file %v, status %v, paused %v",
				e.st.Frozen(), fileExists(e.l.QuiesceFile), e.m.Status(), e.dk.pausedIDs())
		}
		if _, ok := e.sv.Watchdog("lease-1"); ok {
			t.Error("watchdog unit still running")
		}
		tr, err = e.m.Thaw(ctx, "lease-1")
		if err != nil || !tr.GetAlreadyThawed() || tr.GetAutoThawed() {
			t.Errorf("repeated Thaw = %v, %v; want already_thawed only", tr, err)
		}
		if len(autoThawed(e.rec)) != 0 {
			t.Errorf("events = %v, want none", e.rec.All())
		}
	})

	t.Run("rollback", func(t *testing.T) {
		e := newEnv(t, nil)
		e.dk.running = []string{"c1", "c2", "c3"}
		e.dk.failPause["c2"] = errors.New("boom")
		e.addHook(t, "10-a", "#!/bin/sh\n", 0o755)
		_, err := e.m.Quiesce(context.Background(), 30000, true, true, false)
		wantErr(t, err, connect.CodeInternal, errs.Internal)
		if !e.log.has("unpause c1") {
			t.Errorf("c1 not unpaused: %q", e.log.all())
		}
		if ids := e.dk.pausedIDs(); len(ids) != 0 {
			t.Errorf("still paused: %v", ids)
		}
		if n := e.log.count("freeze"); n != 0 {
			t.Errorf("froze %d mounts", n)
		}
		if n := e.log.count("hook"); n != 0 {
			t.Errorf("ran %d hooks", n)
		}
		if !e.log.has("watchdog stop lease-1") {
			t.Error("watchdog unit not stopped")
		}
		if e.st.Frozen() || fileExists(e.l.QuiesceFile) || e.m.Status() != nil {
			t.Errorf("after rollback: store frozen %v, lease file %v, status %v",
				e.st.Frozen(), fileExists(e.l.QuiesceFile), e.m.Status())
		}
		// A new lease works after the rollback.
		e.dk.failPause = map[string]error{}
		if _, err := e.m.Quiesce(context.Background(), 30000, true, true, false); err != nil {
			t.Fatalf("Quiesce after rollback: %v", err)
		}
	})

	t.Run("freeze failure", func(t *testing.T) {
		e := newEnv(t, nil)
		e.addHook(t, "10-a", "#!/bin/sh\n", 0o755)
		e.fz.mountErr = errors.New("no mountinfo")
		_, err := e.m.Quiesce(context.Background(), 30000, true, true, false)
		wantErr(t, err, connect.CodeInternal, errs.Internal)
		if !e.log.has("hook 10-a thaw") || len(e.dk.pausedIDs()) != 0 || e.st.Frozen() {
			t.Errorf("rollback incomplete: %q, paused %v, store frozen %v", e.log.all(), e.dk.pausedIDs(), e.st.Frozen())
		}
	})
}

func TestQuiesceAlready(t *testing.T) {
	e := newEnv(t, nil)
	ctx := context.Background()
	if _, err := e.m.Quiesce(ctx, 30000, true, true, false); err != nil {
		t.Fatal(err)
	}
	_, err := e.m.Quiesce(ctx, 30000, true, true, false)
	msg := wantErr(t, err, connect.CodeFailedPrecondition, errs.AlreadyQuiesced)
	if !strings.Contains(msg, "lease-1") {
		t.Errorf("message %q does not name the lease", msg)
	}
	if st := e.m.Status(); !st.GetActive() || st.GetLeaseId() != "lease-1" {
		t.Errorf("Status = %v", st)
	}
	if _, err := e.m.Thaw(ctx, "lease-1"); err != nil {
		t.Fatal(err)
	}
	if res, err := e.m.Quiesce(ctx, 30000, true, true, false); err != nil || res.GetLeaseId() != "lease-2" {
		t.Fatalf("Quiesce after Thaw = %v, %v", res, err)
	}
}

func TestQuiesceLeaseMs(t *testing.T) {
	e := newEnv(t, nil)
	_, err := e.m.Quiesce(context.Background(), MaxLeaseMs+1, true, true, false)
	wantErr(t, err, connect.CodeInvalidArgument, errs.InvalidArgument)
	before := time.Now()
	res, err := e.m.Quiesce(context.Background(), 0, false, false, false)
	if err != nil {
		t.Fatal(err)
	}
	if d := res.GetDeadline().AsTime().Sub(before); d < 29*time.Second || d > 31*time.Second {
		t.Errorf("default lease: deadline in %v", d)
	}
	if e.log.count("freeze") != 0 || e.log.count("pause") != 0 || e.st.Frozen() {
		t.Errorf("docker=false fs=false still acted: %q", e.log.all())
	}
}

func TestFrozenByOther(t *testing.T) {
	t.Run("first mount", func(t *testing.T) {
		e := newEnv(t, nil)
		e.fz.busy["/data"] = true
		_, err := e.m.Quiesce(context.Background(), 30000, true, true, false)
		wantErr(t, err, connect.CodeFailedPrecondition, errs.FrozenByOther)
		if e.log.count("thaw") != 0 {
			t.Errorf("thawed a mount: %q", e.log.all())
		}
		if !e.fz.isFrozen("/data") {
			t.Error("the foreign freeze was undone")
		}
		if len(e.dk.pausedIDs()) != 0 || e.st.Frozen() || fileExists(e.l.QuiesceFile) {
			t.Errorf("rollback incomplete: paused %v, store frozen %v", e.dk.pausedIDs(), e.st.Frozen())
		}
	})
	t.Run("second mount", func(t *testing.T) {
		e := newEnv(t, nil)
		e.fz.busy["/"] = true
		_, err := e.m.Quiesce(context.Background(), 30000, true, true, false)
		wantErr(t, err, connect.CodeFailedPrecondition, errs.FrozenByOther)
		if !e.log.has("thaw /data store=true") || e.log.has("thaw / store=true") || e.log.has("thaw / store=false") {
			t.Errorf("want only /data thawed: %q", e.log.all())
		}
		if !e.fz.isFrozen("/") || e.fz.isFrozen("/data") {
			t.Error("wrong mounts frozen after the rollback")
		}
		if e.st.Frozen() {
			t.Error("store still frozen")
		}
	})
}

func TestStoreFrozenDuringLease(t *testing.T) {
	e := newEnv(t, nil)
	ctx := context.Background()
	if _, err := e.m.Quiesce(ctx, 30000, true, true, false); err != nil {
		t.Fatal(err)
	}
	if !e.st.Frozen() {
		t.Fatal("store not frozen during the lease")
	}
	e.st.AppendEvent("test.during", nil)
	if _, err := e.m.Thaw(ctx, "lease-1"); err != nil {
		t.Fatal(err)
	}
	if e.st.Frozen() {
		t.Fatal("store frozen after Thaw")
	}
	evs, err := e.st.Journal().Read(ctx, 0, 10)
	if err != nil || len(evs) != 1 || evs[0].GetType() != "test.during" {
		t.Errorf("journal after thaw = %v, %v; want the buffered event", evs, err)
	}

	// Without fs the store stays writable.
	if _, err := e.m.Quiesce(ctx, 30000, true, false, false); err != nil {
		t.Fatal(err)
	}
	if e.st.Frozen() {
		t.Error("store frozen by a docker-only lease")
	}
}

func TestDockerNotRunning(t *testing.T) {
	e := newEnv(t, nil)
	e.dk.listErr = fmt.Errorf("%w: dial unix: no such file", docker.ErrNoDaemon)
	res, err := e.m.Quiesce(context.Background(), 30000, true, true, false)
	if err != nil {
		t.Fatalf("Quiesce without a docker daemon: %v", err)
	}
	if len(res.GetPausedContainers()) != 0 || len(res.GetFrozenMounts()) != 2 {
		t.Errorf("res = %v", res)
	}
}

func TestAutoThawTimer(t *testing.T) {
	e := newEnv(t, nil)
	ctx := context.Background()
	// 1 s, not less: under a loaded full-suite run Quiesce itself can take longer
	// than a shorter lease.
	if _, err := e.m.Quiesce(ctx, 1000, true, true, false); err != nil {
		t.Fatal(err)
	}
	waitFor(t, "auto thaw", func() bool { return len(autoThawed(e.rec)) > 0 })
	evs := autoThawed(e.rec)
	if len(evs) != 1 || evs[0].GetLeaseId() != "lease-1" || evs[0].GetBy() != ByWatchdog {
		t.Fatalf("events = %v", evs)
	}
	if e.fz.isFrozen("/") || e.fz.isFrozen("/data") || len(e.dk.pausedIDs()) != 0 || e.st.Frozen() {
		t.Errorf("not thawed: %q", e.log.all())
	}
	if e.m.Status() != nil || fileExists(e.l.QuiesceFile) {
		t.Error("lease still active")
	}
	if _, ok := e.sv.Watchdog("lease-1"); ok {
		t.Error("watchdog unit still running")
	}
	mk, ok := readMarker(e.l.QuiesceThawedDir, "lease-1", time.Now())
	if !ok || mk.By != ByWatchdog || !mk.Reported {
		t.Errorf("marker = %+v, %v", mk, ok)
	}
	for range 2 {
		tr, err := e.m.Thaw(ctx, "lease-1")
		if err != nil {
			t.Fatal(err)
		}
		if !tr.GetAutoThawed() || !tr.GetAlreadyThawed() || !tr.GetAutoThawedAt().AsTime().Equal(evs[0].GetAt().AsTime()) {
			t.Errorf("Thaw = %v, want auto_thawed at %v", tr, evs[0].GetAt().AsTime())
		}
	}
	if n := len(autoThawed(e.rec)); n != 1 {
		t.Errorf("%d events, want 1", n)
	}
}

func TestWatchdogMarkerAdopted(t *testing.T) {
	t.Run("poll", func(t *testing.T) {
		e := newEnv(t, nil)
		e.m.markerEvery = 10 * time.Millisecond
		hook := e.addHook(t, "10-a", "#!/bin/sh\n", 0o755)
		if _, err := e.m.Quiesce(context.Background(), 60000, true, true, false); err != nil {
			t.Fatal(err)
		}
		// The unit ran the hook's thaw; the agent must not run it again.
		at := time.Now().Add(-time.Second).UTC()
		if err := writeMarker(e.l.QuiesceThawedDir, marker{LeaseID: "lease-1", At: at, By: ByWatchdog, Hooks: []string{hook}}); err != nil {
			t.Fatal(err)
		}
		waitFor(t, "adoption", func() bool {
			mk, _ := readMarker(e.l.QuiesceThawedDir, "lease-1", time.Now())
			return e.m.Status() == nil && mk.Reported
		})
		if e.st.Frozen() {
			t.Error("store still frozen")
		}
		evs := autoThawed(e.rec)
		if len(evs) != 1 || evs[0].GetBy() != ByWatchdog || !evs[0].GetAt().AsTime().Equal(at) {
			t.Errorf("events = %v", evs)
		}
		if mk, ok := readMarker(e.l.QuiesceThawedDir, "lease-1", time.Now()); !ok || !mk.Reported {
			t.Errorf("marker = %+v, %v; want reported", mk, ok)
		}
		// FITHAW and unpause are repeated from the in-memory lease (the
		// fake unit above thawed nothing), the hook thaw is not.
		if e.fz.isFrozen("/") || e.fz.isFrozen("/data") || len(e.dk.pausedIDs()) != 0 {
			t.Errorf("left frozen or paused: %q", e.log.all())
		}
		if e.log.count("hook 10-a thaw") != 0 {
			t.Errorf("the agent ran the hook thaw again: %q", e.log.all())
		}
	})
	t.Run("thaw first", func(t *testing.T) {
		e := newEnv(t, nil)
		e.m.markerEvery = time.Hour
		if _, err := e.m.Quiesce(context.Background(), 60000, true, true, false); err != nil {
			t.Fatal(err)
		}
		at := time.Now().UTC()
		if err := writeMarker(e.l.QuiesceThawedDir, marker{LeaseID: "lease-1", At: at, By: ByWatchdog}); err != nil {
			t.Fatal(err)
		}
		tr, err := e.m.Thaw(context.Background(), "lease-1")
		if err != nil {
			t.Fatal(err)
		}
		if !tr.GetAutoThawed() || !tr.GetAlreadyThawed() || !tr.GetAutoThawedAt().AsTime().Equal(at) {
			t.Errorf("Thaw = %v", tr)
		}
		if e.st.Frozen() || e.m.Status() != nil || len(autoThawed(e.rec)) != 1 {
			t.Errorf("store frozen %v, status %v, events %v", e.st.Frozen(), e.m.Status(), e.rec.All())
		}
	})
}

func TestThawUnknownLease(t *testing.T) {
	e := newEnv(t, nil)
	for _, id := range []string{"nope", "", "../x", "lease-1"} {
		tr, err := e.m.Thaw(context.Background(), id)
		if err != nil || !tr.GetAlreadyThawed() || tr.GetAutoThawed() {
			t.Errorf("Thaw(%q) = %v, %v", id, tr, err)
		}
	}
	// An expired marker no longer answers.
	old := time.Now().Add(-MarkerTTL - time.Minute)
	if err := writeMarker(e.l.QuiesceThawedDir, marker{LeaseID: "old", At: old, By: ByWatchdog, Reported: true}); err != nil {
		t.Fatal(err)
	}
	if tr, _ := e.m.Thaw(context.Background(), "old"); tr.GetAutoThawed() {
		t.Error("expired marker answered")
	}
}

func TestStartupThawsLease(t *testing.T) {
	e := newEnv(t, func(o *Options) { o.Emit = nil; o.Store = nil })
	e.fz.st = nil
	hook := e.addHook(t, "10-a", "#!/bin/sh\n", 0o755)
	e.fz.frozen["/data"] = true
	e.dk.paused["c9"] = true
	if err := writeLease(e.l.QuiesceFile, &Lease{
		ID: "old-1", Deadline: time.Now().Add(time.Minute),
		Paused: []string{"c9"}, Frozen: []string{"/data"}, Hooks: []string{hook},
	}); err != nil {
		t.Fatal(err)
	}
	e.m.Startup(context.Background())
	for _, want := range []string{"thaw /data", "hook 10-a thaw", "unpause c9", "watchdog stop old-1"} {
		if !e.log.has(want) {
			t.Errorf("missing %q in %q", want, e.log.all())
		}
	}
	if e.fz.isFrozen("/data") || len(e.dk.pausedIDs()) != 0 || fileExists(e.l.QuiesceFile) {
		t.Error("lease not undone")
	}
	if len(e.rec.All()) != 0 {
		t.Fatal("event emitted before an emitter was set")
	}
	e.m.SetStore(e.st, e.rec)
	evs := autoThawed(e.rec)
	if len(evs) != 1 || evs[0].GetLeaseId() != "old-1" || evs[0].GetBy() != ByAgentStart {
		t.Errorf("events = %v", evs)
	}
	tr, err := e.m.Thaw(context.Background(), "old-1")
	if err != nil || !tr.GetAutoThawed() {
		t.Errorf("Thaw(old-1) = %v, %v; want auto_thawed", tr, err)
	}
}

func TestStartupUnreadableLease(t *testing.T) {
	e := newEnv(t, nil)
	e.fz.frozen["/"] = true
	e.dk.paused["c1"] = true
	if err := os.WriteFile(e.l.QuiesceFile, []byte("{bad"), 0o600); err != nil {
		t.Fatal(err)
	}
	e.m.Startup(context.Background())
	if e.fz.isFrozen("/") || len(e.dk.pausedIDs()) != 0 || fileExists(e.l.QuiesceFile) {
		t.Errorf("not thawed: %q", e.log.all())
	}
	if evs := autoThawed(e.rec); len(evs) != 1 || evs[0].GetBy() != ByAgentStart {
		t.Errorf("events = %v", evs)
	}
}

func TestStartupReportsWatchdogMarkers(t *testing.T) {
	e := newEnv(t, nil)
	now := time.Now().UTC()
	for _, mk := range []marker{
		{LeaseID: "w1", At: now.Add(-time.Minute), By: ByWatchdog},
		{LeaseID: "w2", At: now.Add(-time.Minute), By: ByWatchdog, Reported: true},
	} {
		if err := writeMarker(e.l.QuiesceThawedDir, mk); err != nil {
			t.Fatal(err)
		}
	}
	e.m.Startup(context.Background())
	evs := autoThawed(e.rec)
	if len(evs) != 1 || evs[0].GetLeaseId() != "w1" || evs[0].GetBy() != ByWatchdog {
		t.Errorf("events = %v", evs)
	}
	if mk, ok := readMarker(e.l.QuiesceThawedDir, "w1", time.Now()); !ok || !mk.Reported {
		t.Errorf("w1 marker = %+v, %v", mk, ok)
	}
	if e.log.count("thaw") != 0 {
		t.Errorf("Startup without a lease thawed: %q", e.log.all())
	}
	// A second start reports nothing again.
	e.m.Startup(context.Background())
	if n := len(autoThawed(e.rec)); n != 1 {
		t.Errorf("%d events after the second start", n)
	}
}

func TestHooksOrder(t *testing.T) {
	if runtime.GOOS == "windows" {
		t.Skip("shell hooks")
	}
	e := newEnv(t, nil)
	e.m.steps.runHook = execHook
	// Real shell hooks: keep a loaded machine from hitting the budget.
	e.m.freezeBudget = time.Minute
	out := filepath.Join(t.TempDir(), "hooks.log")
	script := func(name string) string {
		return fmt.Sprintf("#!/bin/sh\necho \"%s $1\" >> '%s'\n", name, out)
	}
	e.addHook(t, "20-b", script("b"), 0o755)
	e.addHook(t, "10-a", script("a"), 0o755)
	e.addHook(t, "30-c", script("c"), 0o644)  // not executable
	e.addHook(t, ".40-d", script("d"), 0o755) // hidden
	ctx := context.Background()
	if _, err := e.m.Quiesce(ctx, 30000, false, false, false); err != nil {
		t.Fatal(err)
	}
	if _, err := e.m.Thaw(ctx, "lease-1"); err != nil {
		t.Fatal(err)
	}
	data, err := os.ReadFile(out)
	if err != nil {
		t.Fatal(err)
	}
	if got, want := string(data), "a freeze\nb freeze\nb thaw\na thaw\n"; got != want {
		t.Errorf("hooks ran:\n%s\nwant:\n%s", got, want)
	}

	// A failing freeze hook rolls back, including its own thaw.
	e.addHook(t, "15-fail", fmt.Sprintf("#!/bin/sh\necho \"fail $1\" >> '%s'\n[ \"$1\" = thaw ]\n", out), 0o755)
	if err := os.Remove(out); err != nil {
		t.Fatal(err)
	}
	if _, err := e.m.Quiesce(ctx, 30000, false, false, false); err == nil {
		t.Fatal("Quiesce with a failing hook succeeded")
	}
	data, _ = os.ReadFile(out)
	if got, want := string(data), "a freeze\nfail freeze\nfail thaw\na thaw\n"; got != want {
		t.Errorf("hooks ran:\n%s\nwant:\n%s", got, want)
	}
}
