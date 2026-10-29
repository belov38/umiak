//go:build linux

package shim

import (
	"bytes"
	"context"
	"crypto/rand"
	"crypto/sha256"
	"errors"
	"fmt"
	"io/fs"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"sync"
	"syscall"
	"testing"
	"time"

	"github.com/belov38/boat-dev-clone/services/guest-agent/internal/fsutil"
	"github.com/belov38/boat-dev-clone/services/guest-agent/internal/paths"
	"github.com/belov38/boat-dev-clone/services/guest-agent/internal/shimproto"
)

// TestMain turns the test binary into the shim when SBX_SHIM_TEST=1, so the
// tests run the real Main in a separate process without root or cgroups.
func TestMain(m *testing.M) {
	if os.Getenv("SBX_SHIM_TEST") == "1" {
		os.Exit(Main(os.Args[1:]))
	}
	os.Exit(m.Run())
}

const testPath = "PATH=/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin"

// syncBuffer collects the shim's own log.
type syncBuffer struct {
	mu  sync.Mutex
	buf bytes.Buffer
}

func (b *syncBuffer) Write(p []byte) (int, error) {
	b.mu.Lock()
	defer b.mu.Unlock()
	return b.buf.Write(p)
}

func (b *syncBuffer) String() string {
	b.mu.Lock()
	defer b.mu.Unlock()
	return b.buf.String()
}

// harness is one shim process under test.
type harness struct {
	t      *testing.T
	layout paths.Layout
	id     string
	cmd    *exec.Cmd
	log    *syncBuffer
	done   chan struct{}
	err    error
}

// spec returns a spec for argv with the current credentials.
func spec(argv ...string) Spec {
	return Spec{
		Argv:         argv,
		Env:          []string{testPath, "HOME=/tmp", "LC_ALL=C"},
		UID:          uint32(os.Getuid()), //nolint:gosec // uid fits
		GID:          uint32(os.Getgid()), //nolint:gosec // gid fits
		AgentVersion: "test",
	}
}

// startShim writes s as the spec of a fresh command and starts the test
// binary as its shim.
func startShim(t *testing.T, s Spec) *harness {
	t.Helper()
	root := t.TempDir()
	l := paths.ForRoot(root)
	s.ID = "c1"
	for _, d := range []string{l.CmdSpecDir, l.CommandsDir} {
		if err := os.MkdirAll(d, 0o700); err != nil {
			t.Fatal(err)
		}
	}
	if err := fsutil.WriteJSONAtomic(l.CmdSpec(s.ID), s, 0o600); err != nil {
		t.Fatal(err)
	}
	h := &harness{t: t, layout: l, id: s.ID, log: &syncBuffer{}, done: make(chan struct{})}
	h.cmd = exec.CommandContext(context.Background(), os.Args[0], "--id", s.ID, "--layout-root", root, "--no-cgroup")
	// The race detector sleeps 1 s at exit by default.
	h.cmd.Env = append(os.Environ(), "SBX_SHIM_TEST=1", "GORACE=atexit_sleep_ms=0")
	h.cmd.Stdout = h.log
	h.cmd.Stderr = h.log
	if err := h.cmd.Start(); err != nil {
		t.Fatal(err)
	}
	go func() {
		h.err = h.cmd.Wait()
		close(h.done)
	}()
	t.Cleanup(func() {
		select {
		case <-h.done:
		default:
			_ = h.cmd.Process.Kill()
			<-h.done
		}
		if t.Failed() {
			t.Logf("shim log:\n%s", h.log.String())
		}
	})
	return h
}

func (h *harness) path(name string) string {
	return filepath.Join(h.layout.CommandDir(h.id), name)
}

func (h *harness) read(name string) string {
	h.t.Helper()
	b, err := os.ReadFile(h.path(name))
	if err != nil {
		h.t.Fatal(err)
	}
	return string(b)
}

// waitExitFile polls for exit.json.
func (h *harness) waitExitFile(timeout time.Duration) ExitFile {
	h.t.Helper()
	deadline := time.Now().Add(timeout)
	for {
		var e ExitFile
		err := fsutil.ReadJSON(h.path(ExitJSON), &e)
		if err == nil {
			return e
		}
		if !errors.Is(err, fs.ErrNotExist) {
			h.t.Fatalf("read exit.json: %v", err)
		}
		if time.Now().After(deadline) {
			h.t.Fatalf("no exit.json after %v", timeout)
		}
		time.Sleep(10 * time.Millisecond)
	}
}

// waitShim waits for the shim process and checks that it exited 0.
func (h *harness) waitShim(timeout time.Duration) {
	h.t.Helper()
	select {
	case <-h.done:
		if h.err != nil {
			h.t.Fatalf("shim exited with %v", h.err)
		}
	case <-time.After(timeout):
		h.t.Fatalf("shim still running after %v", timeout)
	}
}

func (h *harness) alive() bool {
	select {
	case <-h.done:
		return false
	default:
		return true
	}
}

// dial connects to the shim socket once it exists.
func (h *harness) dial() *shimproto.Client {
	h.t.Helper()
	deadline := time.Now().Add(10 * time.Second)
	for {
		ctx, cancel := context.WithTimeout(context.Background(), time.Second)
		c, err := shimproto.Dial(ctx, h.layout.ShimSocket(h.id))
		cancel()
		if err == nil {
			h.t.Cleanup(func() { _ = c.Close() })
			return c
		}
		if time.Now().After(deadline) {
			h.t.Fatalf("dial shim: %v", err)
		}
		time.Sleep(10 * time.Millisecond)
	}
}

// waitOutput polls the stream file until it contains want.
func (h *harness) waitOutput(name, want string, timeout time.Duration) {
	h.t.Helper()
	deadline := time.Now().Add(timeout)
	for {
		b, _ := os.ReadFile(h.path(name))
		if strings.Contains(string(b), want) {
			return
		}
		if time.Now().After(deadline) {
			h.t.Fatalf("%s = %q, want to contain %q", name, b, want)
		}
		time.Sleep(10 * time.Millisecond)
	}
}

func ctx(t *testing.T) context.Context {
	c, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	t.Cleanup(cancel)
	return c
}

func fileSize(t *testing.T, path string) int64 {
	t.Helper()
	fi, err := os.Stat(path)
	if err != nil {
		t.Fatal(err)
	}
	return fi.Size()
}

func TestShimStdoutStderrExact(t *testing.T) {
	const size = 1 << 20
	dir := t.TempDir()
	srcs := [2]string{filepath.Join(dir, "a"), filepath.Join(dir, "b")}
	var sums [2][32]byte
	for i, p := range srcs {
		data := make([]byte, size)
		_, _ = rand.Read(data)
		sums[i] = sha256.Sum256(data)
		if err := os.WriteFile(p, data, 0o644); err != nil {
			t.Fatal(err)
		}
	}
	h := startShim(t, spec("/bin/sh", "-c", `head -c 1048576 "$0"; head -c 1048576 "$1" >&2`, srcs[0], srcs[1]))
	e := h.waitExitFile(30 * time.Second)
	h.waitShim(10 * time.Second)

	if e.Status != shimproto.StatusExited || e.Code != 0 || e.Reason != shimproto.ReasonNone {
		t.Errorf("exit = %+v, want exited 0 NONE", e)
	}
	for i, name := range []string{StdoutFile, StderrFile} {
		b, err := os.ReadFile(h.path(name))
		if err != nil {
			t.Fatal(err)
		}
		if sha256.Sum256(b) != sums[i] {
			t.Errorf("%s: %d bytes, content differs from the source", name, len(b))
		}
	}
	if e.StdoutEnd != size || e.StderrEnd != size || e.PtyEnd != 0 {
		t.Errorf("ends = %d/%d/%d, want %d/%d/0", e.StdoutEnd, e.StderrEnd, e.PtyEnd, size, size)
	}
	for _, name := range []string{StdoutFile, StderrFile, ExitJSON, ShimJSON} {
		fi, err := os.Stat(h.path(name))
		if err != nil {
			t.Fatal(err)
		}
		if fi.Mode().Perm() != 0o600 {
			t.Errorf("%s mode = %v, want 0600", name, fi.Mode().Perm())
		}
	}
	var sf ShimFile
	if err := fsutil.ReadJSON(h.path(ShimJSON), &sf); err != nil {
		t.Fatal(err)
	}
	if sf.State != StateRunning || sf.Pid <= 0 || sf.StartedAt.IsZero() ||
		sf.AgentVersion != "test" || sf.ShimProto != shimproto.Version {
		t.Errorf("shim.json = %+v", sf)
	}
	if _, err := os.Stat(h.layout.CmdSpec(h.id)); !errors.Is(err, fs.ErrNotExist) {
		t.Errorf("spec file still exists: %v", err)
	}
}

func TestShimDevStderrReopen(t *testing.T) {
	h := startShim(t, spec("/bin/sh", "-c", `echo a; echo x >/dev/stderr; echo y >/dev/stdout`))
	e := h.waitExitFile(10 * time.Second)
	h.waitShim(10 * time.Second)
	if got := h.read(StdoutFile); got != "a\ny\n" {
		t.Errorf("stdout = %q, want %q", got, "a\ny\n")
	}
	if got := h.read(StderrFile); got != "x\n" {
		t.Errorf("stderr = %q, want %q", got, "x\n")
	}
	if e.Code != 0 || e.StdoutEnd != 4 || e.StderrEnd != 2 {
		t.Errorf("exit = %+v", e)
	}
}

func TestShimExitAfterLastByte(t *testing.T) {
	const lines = 3000
	var want strings.Builder
	for i := range lines {
		fmt.Fprintf(&want, "line%d\n", i)
	}
	h := startShim(t, spec("/bin/sh", "-c",
		fmt.Sprintf(`i=0; while [ $i -lt %d ]; do echo line$i; echo e$i >&2; i=$((i+1)); done`, lines)))
	e := h.waitExitFile(30 * time.Second)
	// exit.json is on disk only after every byte the process wrote.
	if e.StdoutEnd != int64(want.Len()) {
		t.Errorf("stdoutEnd = %d, want %d", e.StdoutEnd, want.Len())
	}
	if got := fileSize(t, h.path(StdoutFile)); got < e.StdoutEnd {
		t.Errorf("stdout size %d < end %d at exit.json time", got, e.StdoutEnd)
	}
	h.waitShim(10 * time.Second)
	if got := h.read(StdoutFile); got != want.String() {
		t.Errorf("stdout differs: %d bytes, want %d", len(got), want.Len())
	}
	if got := fileSize(t, h.path(StderrFile)); got != e.StderrEnd {
		t.Errorf("stderr size %d != end %d", got, e.StderrEnd)
	}
}

func TestShimStartFailed(t *testing.T) {
	h := startShim(t, spec("/nonexistent"))
	e := h.waitExitFile(10 * time.Second)
	h.waitShim(10 * time.Second)
	if e.Status != shimproto.StatusExited || e.Code != 127 || e.Reason != shimproto.ReasonStartFailed {
		t.Errorf("exit = %+v, want exited 127 START_FAILED", e)
	}
	if e.StartFailed == "" {
		t.Error("startFailed is empty")
	}
	stderr := h.read(StderrFile)
	if !strings.Contains(stderr, "/nonexistent") {
		t.Errorf("stderr = %q, want the start error", stderr)
	}
	if e.StderrEnd != int64(len(stderr)) {
		t.Errorf("stderrEnd = %d, want %d", e.StderrEnd, len(stderr))
	}
}

func TestShimLeftovers(t *testing.T) {
	h := startShim(t, spec("/bin/sh", "-c", `sleep 30 & echo done`))
	e := h.waitExitFile(10 * time.Second)
	if e.Code != 0 || e.Status != shimproto.StatusExited {
		t.Errorf("exit = %+v", e)
	}
	if got := h.read(StdoutFile); got != "done\n" {
		t.Errorf("stdout = %q", got)
	}
	time.Sleep(300 * time.Millisecond)
	if !h.alive() {
		t.Fatal("shim exited while a leftover holds the pipes")
	}
	c := h.dial()
	st, err := c.Status(ctx(t))
	if err != nil {
		t.Fatal(err)
	}
	if !st.Exited || !st.Leftovers || st.State != shimproto.StateExited {
		t.Errorf("status = %+v, want exited with leftovers", st)
	}
	if _, err := c.Input(ctx(t), "s", 1, []byte("x"), false); !isCode(err, shimproto.CodeCommandExited) {
		t.Errorf("input after exit: err = %v, want %s", err, shimproto.CodeCommandExited)
	}
	if err := c.Signal(ctx(t), syscall.SIGKILL, false); err != nil {
		t.Fatalf("signal: %v", err)
	}
	h.waitShim(10 * time.Second)
	// The leftover's death does not rewrite exit.json.
	if e2 := h.waitExitFile(time.Second); e2 != e {
		t.Errorf("exit.json changed: %+v -> %+v", e, e2)
	}
}

func TestShimInputDedup(t *testing.T) {
	s := spec("/bin/cat")
	s.Stdin = true
	h := startShim(t, s)
	c := h.dial()
	steps := []struct {
		seq  uint64
		data string
		want bool
	}{
		{1, "a", true},
		{1, "a", false},
		{0, "z", false},
	}
	for _, st := range steps {
		applied, err := c.Input(ctx(t), "s1", st.seq, []byte(st.data), false)
		if err != nil || applied != st.want {
			t.Fatalf("input seq %d = %v, %v; want %v", st.seq, applied, err, st.want)
		}
	}
	st, err := c.Status(ctx(t))
	if err != nil || st.LastSeq["s1"] != 1 || st.State != shimproto.StateRunning || st.Pid <= 0 {
		t.Errorf("status = %+v, %v", st, err)
	}
	if err := c.Resize(ctx(t), 80, 24); !isCode(err, shimproto.CodeFailedPrecondition) {
		t.Errorf("resize without pty: err = %v", err)
	}
	if applied, err := c.Input(ctx(t), "s1", 2, nil, true); err != nil || !applied {
		t.Fatalf("close stdin = %v, %v", applied, err)
	}
	select {
	case e := <-c.Exited():
		if e.Code != 0 || e.StdoutEnd != 1 {
			t.Errorf("exited push = %+v", e)
		}
	case <-time.After(10 * time.Second):
		t.Fatal("no exited push")
	}
	h.waitShim(10 * time.Second)
	if got := h.read(StdoutFile); got != "a" {
		t.Errorf("stdout = %q, want %q", got, "a")
	}
}

func TestShimPTYResizeAndEcho(t *testing.T) {
	s := spec("/bin/sh")
	s.PTY = &PTYSpec{Cols: 80, Rows: 24}
	h := startShim(t, s)
	c := h.dial()
	if err := c.Resize(ctx(t), 100, 40); err != nil {
		t.Fatalf("resize: %v", err)
	}
	if _, err := c.Input(ctx(t), "p", 1, []byte("stty size; echo TERM=$TERM\n"), false); err != nil {
		t.Fatal(err)
	}
	h.waitOutput(PtyFile, "40 100", 10*time.Second)
	h.waitOutput(PtyFile, "TERM="+DefaultTerm, 10*time.Second)
	if _, err := c.Input(ctx(t), "p", 2, nil, true); !isCode(err, shimproto.CodeFailedPrecondition) {
		t.Errorf("close_stdin on pty: err = %v", err)
	}
	if _, err := c.Input(ctx(t), "p", 3, []byte("exit 3\n"), false); err != nil {
		t.Fatal(err)
	}
	e := h.waitExitFile(10 * time.Second)
	h.waitShim(10 * time.Second)
	if e.Code != 3 || e.PtyEnd != fileSize(t, h.path(PtyFile)) || e.StdoutEnd != 0 {
		t.Errorf("exit = %+v", e)
	}
	if _, err := os.Stat(h.path(StdoutFile)); !errors.Is(err, fs.ErrNotExist) {
		t.Errorf("pty command has a stdout file: %v", err)
	}
}

func TestShimTimeout(t *testing.T) {
	s := spec("/bin/sleep", "30")
	s.TimeoutMs = 200
	h := startShim(t, s)
	start := time.Now()
	e := h.waitExitFile(10 * time.Second)
	h.waitShim(10 * time.Second)
	if e.Status != shimproto.StatusKilled || e.Reason != shimproto.ReasonTimeout ||
		e.Signal != "SIGTERM" || e.Code != 128+int32(syscall.SIGTERM) {
		t.Errorf("exit = %+v, want killed by SIGTERM, TIMEOUT", e)
	}
	if d := time.Since(start); d > 5*time.Second {
		t.Errorf("timeout took %v", d)
	}
}

func TestShimKillGrace(t *testing.T) {
	h := startShim(t, spec("/bin/sh", "-c", `trap 'echo term; exit 0' TERM; echo ready; while :; do sleep 0.05; done`))
	c := h.dial()
	h.waitOutput(StdoutFile, "ready", 10*time.Second)
	start := time.Now()
	if err := c.Kill(ctx(t), 5000, 0, shimproto.ReasonSignal); err != nil {
		t.Fatal(err)
	}
	e := h.waitExitFile(10 * time.Second)
	if d := time.Since(start); d > 4*time.Second {
		t.Errorf("exit after %v, want within grace", d)
	}
	h.waitShim(10 * time.Second)
	if e.Status != shimproto.StatusExited || e.Code != 0 || e.Reason != shimproto.ReasonSignal {
		t.Errorf("exit = %+v, want exited 0 SIGNAL", e)
	}
	if got := h.read(StdoutFile); got != "ready\nterm\n" {
		t.Errorf("stdout = %q", got)
	}
}

func TestShimKillAfterGrace(t *testing.T) {
	h := startShim(t, spec("/bin/sh", "-c", `trap '' TERM; echo ready; while :; do sleep 0.05; done`))
	c := h.dial()
	h.waitOutput(StdoutFile, "ready", 10*time.Second)
	if err := c.Kill(ctx(t), 200, syscall.SIGTERM, shimproto.ReasonSignal); err != nil {
		t.Fatal(err)
	}
	e := h.waitExitFile(10 * time.Second)
	h.waitShim(10 * time.Second)
	if e.Status != shimproto.StatusKilled || e.Signal != "SIGKILL" || e.Reason != shimproto.ReasonSignal {
		t.Errorf("exit = %+v, want killed by SIGKILL after grace", e)
	}
}

func isCode(err error, code string) bool {
	var pe *shimproto.Error
	return errors.As(err, &pe) && pe.Code == code
}
