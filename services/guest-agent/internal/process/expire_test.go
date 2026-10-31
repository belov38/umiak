package process

import (
	"os"
	"strings"
	"sync"
	"testing"
	"time"

	agentv1 "github.com/belov38/boat-dev-clone/libs/proto/sbx/agent/v1"

	"github.com/belov38/boat-dev-clone/services/guest-agent/internal/events"
	"github.com/belov38/boat-dev-clone/services/guest-agent/internal/shim"
	"github.com/belov38/boat-dev-clone/services/guest-agent/internal/store"
)

// fakeClock is a settable Options.Now.
type fakeClock struct {
	mu  sync.Mutex
	now time.Time
}

func (c *fakeClock) Now() time.Time {
	c.mu.Lock()
	defer c.mu.Unlock()
	return c.now
}

func (c *fakeClock) Add(d time.Duration) {
	c.mu.Lock()
	defer c.mu.Unlock()
	c.now = c.now.Add(d)
}

// putStartingAt stores an unlaunched STARTING record created at created,
// with the stale cmd-spec file a crashed agent may leave in /run.
func putStartingAt(t *testing.T, h *harness, id string, spec *agentv1.CommandSpec, created time.Time) {
	t.Helper()
	hash, err := specHash(spec)
	if err != nil {
		t.Fatal(err)
	}
	stored, keys, err := storedSpec(spec)
	if err != nil {
		t.Fatal(err)
	}
	err = h.st.PutCommand(t.Context(), &store.Command{ID: id, SpecHash: hash, Spec: stored, EnvKeys: keys,
		State: StateStarting, BootID: h.opts.BootID, CreatedAt: created.UTC(), AgentVersion: "1.2.3",
		PTY: spec.GetPty() != nil})
	if err != nil {
		t.Fatal(err)
	}
	if h.layout.CmdSpecDir == "" {
		return // Windows: the spec goes over the shim's stdin
	}
	if err := os.MkdirAll(h.layout.CmdSpecDir, 0o700); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(h.layout.CmdSpec(id), []byte(`{"id":"`+id+`"}`), 0o600); err != nil {
		t.Fatal(err)
	}
}

func wantExpired(t *testing.T, h *harness, id string) {
	t.Helper()
	info, err := h.get(id)
	if err != nil {
		t.Fatal(err)
	}
	if info.GetState() != agentv1.CommandState_COMMAND_STATE_EXITED ||
		info.GetExit().GetStatus() != agentv1.ExitStatus_EXIT_STATUS_EXITED ||
		info.GetExit().GetReason() != agentv1.ExitReason_EXIT_REASON_START_FAILED ||
		info.GetExit().GetCode() != 127 {
		t.Fatalf("state %v exit %v, want EXITED START_FAILED 127", info.GetState(), info.GetExit())
	}
	b, err := os.ReadFile(cmdFile(h.layout, id, shim.StderrFile))
	if err != nil {
		t.Fatal(err)
	}
	if !strings.Contains(string(b), "start was never retried within 24h") {
		t.Errorf("stderr = %q", b)
	}
	for _, s := range info.GetStreams() {
		if s.GetStream() == agentv1.Stream_STREAM_STDERR && s.GetEnd() != uint64(len(b)) {
			t.Errorf("stderr end %d, want %d", s.GetEnd(), len(b))
		}
	}
	if p := h.layout.CmdSpec(id); p != "" {
		if _, err := os.Stat(p); !os.IsNotExist(err) {
			t.Errorf("stale cmd-spec kept: %v", err)
		}
	}
	n := 0
	for _, p := range h.rec.Of(events.TypeCommandExited) {
		if ce := p.(*agentv1.CommandExited); ce.GetCommandId() == id {
			n++
			if ce.GetReason() != agentv1.ExitReason_EXIT_REASON_START_FAILED || ce.GetCode() != 127 {
				t.Errorf("command.exited = %v", ce)
			}
		}
	}
	if n != 1 {
		t.Errorf("command.exited events of %s = %d, want 1", id, n)
	}
}

func TestRecoverExpiresUnretriedStarting(t *testing.T) {
	clock := &fakeClock{now: time.Date(2026, 10, 30, 12, 0, 0, 0, time.UTC)}
	h := newHarness(t, func(o *Options) { o.Now = clock.Now })
	spec := argvSpec("/bin/sleep", "1")
	putStartingAt(t, h, "old", spec, clock.Now().Add(-24*time.Hour-time.Second))
	putStartingAt(t, h, "young", spec, clock.Now().Add(-23*time.Hour))
	h.restart("boot-1")

	wantExpired(t, h, "old")
	if info, _ := h.get("young"); info.GetState() != agentv1.CommandState_COMMAND_STATE_STARTING {
		t.Errorf("young record: state %v, want STARTING", info.GetState())
	}
	if len(h.fake.Launches()) != 0 {
		t.Errorf("launches = %v", h.fake.Launches())
	}
}

func TestJanitorExpiresUnretriedStarting(t *testing.T) {
	clock := &fakeClock{now: time.Date(2026, 10, 30, 12, 0, 0, 0, time.UTC)}
	h := newHarness(t, func(o *Options) { o.Now = clock.Now })
	spec := argvSpec("/bin/sleep", "1")
	putStartingAt(t, h, "c1", spec, clock.Now())
	h.restart("boot-1")
	if info, _ := h.get("c1"); info.GetState() != agentv1.CommandState_COMMAND_STATE_STARTING {
		t.Fatalf("state %v, want STARTING", info.GetState())
	}

	clock.Add(23 * time.Hour)
	h.m.JanitorCommands()
	if info, _ := h.get("c1"); info.GetState() != agentv1.CommandState_COMMAND_STATE_STARTING {
		t.Fatalf("expired before the TTL: state %v", info.GetState())
	}

	clock.Add(time.Hour + time.Second)
	cmds := h.m.JanitorCommands()
	wantExpired(t, h, "c1")
	if len(cmds) != 1 || !cmds[0].Exited {
		t.Errorf("janitor commands = %+v, want c1 exited", cmds)
	}
}

func TestStartingTTLOption(t *testing.T) {
	clock := &fakeClock{now: time.Date(2026, 10, 30, 12, 0, 0, 0, time.UTC)}
	h := newHarness(t, func(o *Options) { o.Now = clock.Now; o.StartingTTL = time.Hour })
	putStartingAt(t, h, "c1", argvSpec("/bin/sleep", "1"), clock.Now().Add(-2*time.Hour))
	h.restart("boot-1")
	info, _ := h.get("c1")
	if info.GetExit().GetReason() != agentv1.ExitReason_EXIT_REASON_START_FAILED {
		t.Fatalf("exit %v, want START_FAILED", info.GetExit())
	}
	b, _ := os.ReadFile(cmdFile(h.layout, "c1", shim.StderrFile))
	if !strings.Contains(string(b), "start was never retried within 1h") {
		t.Errorf("stderr = %q", b)
	}
}

// Without a cmd-spec directory (Windows) the expiry removes no spec file: in
// particular not a file named like the command in the working directory.
func TestExpireWithoutCmdSpecDir(t *testing.T) {
	clock := &fakeClock{now: time.Date(2026, 10, 30, 12, 0, 0, 0, time.UTC)}
	h := newHarness(t, func(o *Options) { o.Now = clock.Now; o.Layout.CmdSpecDir = "" })
	h.layout.CmdSpecDir = ""
	t.Chdir(t.TempDir())
	if err := os.WriteFile("old", []byte("keep"), 0o600); err != nil {
		t.Fatal(err)
	}
	putStartingAt(t, h, "old", argvSpec("/bin/sleep", "1"), clock.Now().Add(-24*time.Hour-time.Second))
	h.restart("boot-1")
	wantExpired(t, h, "old")
	if _, err := os.Stat("old"); err != nil {
		t.Errorf("a file named like the command in the working directory: %v", err)
	}
}
