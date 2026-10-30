package harness_test

import (
	"bytes"
	"context"
	"fmt"
	"sync"
	"sync/atomic"
	"testing"
	"time"

	"connectrpc.com/connect"

	agentv1 "github.com/belov38/boat-dev-clone/libs/proto/sbx/agent/v1"

	"github.com/belov38/boat-dev-clone/services/guest-agent/internal/shim"
	"github.com/belov38/boat-dev-clone/services/guest-agent/internal/supervisor"
)

func argvSpec(args ...string) *agentv1.CommandSpec {
	return &agentv1.CommandSpec{Cmd: &agentv1.CommandSpec_Argv{Argv: &agentv1.Argv{Args: args}}}
}

// chunk is the i-th output chunk of a slow script: n bytes that differ
// from chunk to chunk.
func chunk(i, n int) []byte {
	return bytes.Repeat([]byte{byte('a' + i%26)}, n)
}

// slowScript writes count chunks of size bytes to stdout, one every pause,
// then exits with 0; afterExit, when set, runs right after the exit. want
// receives the whole output.
func slowScript(count, size int, pause time.Duration, afterExit func()) (func(*supervisor.FakeRun), []byte) {
	var want []byte
	for i := range count {
		want = append(want, chunk(i, size)...)
	}
	return func(r *supervisor.FakeRun) {
		for i := range count {
			if err := r.Write(shim.StdoutFile, chunk(i, size)); err != nil {
				return
			}
			time.Sleep(pause)
		}
		_ = r.Exit(0)
		if afterExit != nil {
			afterExit()
		}
	}, want
}

// reader attaches to a command through the gateway and resumes from its
// offsets after every broken stream until the exit event.
type reader struct {
	e         *env
	commandID string

	mu       sync.Mutex
	stdout   []byte
	exits    []*agentv1.ExitEvent
	attaches int
	errs     []error
	bytes    atomic.Int64
}

// run reads to the exit event.
func (r *reader) run(ctx context.Context) error {
	for {
		if err := ctx.Err(); err != nil {
			return fmt.Errorf("attach %s: %d attaches, errors %v: %w", r.commandID, r.attaches, r.errs, err)
		}
		done, err := r.attachOnce(ctx)
		if err != nil {
			r.mu.Lock()
			r.errs = append(r.errs, err)
			r.mu.Unlock()
		}
		if done {
			if err != nil {
				return fmt.Errorf("attach %s: %w", r.commandID, err)
			}
			return nil
		}
		if err != nil {
			if !retryable(err) {
				return fmt.Errorf("attach %s: %w", r.commandID, err)
			}
			time.Sleep(20 * time.Millisecond)
		}
	}
}

// attachOnce runs one Attach call from the current offset.
func (r *reader) attachOnce(ctx context.Context) (bool, error) {
	actx, cancel := context.WithCancel(ctx)
	defer cancel()
	r.mu.Lock()
	r.attaches++
	off := uint64(len(r.stdout))
	r.mu.Unlock()
	s, err := r.e.process().Attach(actx, connect.NewRequest(&agentv1.AttachRequest{CommandId: r.commandID, StdoutOffset: off}))
	if err != nil {
		return false, err
	}
	defer func() { _ = s.Close() }()
	for s.Receive() {
		switch ev := s.Msg().GetEvent().(type) {
		case *agentv1.AttachResponse_Data:
			d := ev.Data
			if d.GetStream() != agentv1.Stream_STREAM_STDOUT {
				return true, fmt.Errorf("data on stream %v", d.GetStream())
			}
			r.mu.Lock()
			if d.GetOffset() != uint64(len(r.stdout)) {
				r.mu.Unlock()
				return true, fmt.Errorf("data at offset %d, want %d", d.GetOffset(), len(r.stdout))
			}
			r.stdout = append(r.stdout, d.GetData()...)
			r.mu.Unlock()
			r.bytes.Add(int64(len(d.GetData())))
		case *agentv1.AttachResponse_Exit:
			r.mu.Lock()
			r.exits = append(r.exits, ev.Exit)
			r.mu.Unlock()
			return true, nil
		case *agentv1.AttachResponse_Truncated:
			return true, fmt.Errorf("unexpected truncated %v", ev.Truncated)
		}
	}
	if err := s.Err(); err != nil {
		return false, err
	}
	return false, connect.NewError(connect.CodeUnavailable, fmt.Errorf("stream ended without exit"))
}

// codes counts the attach errors by Connect code, for logs.
func (r *reader) codes() map[string]int {
	r.mu.Lock()
	defer r.mu.Unlock()
	out := map[string]int{}
	for _, err := range r.errs {
		out[connect.CodeOf(err).String()]++
	}
	return out
}

// goRun runs the reader in a goroutine.
func (r *reader) goRun(ctx context.Context) <-chan error {
	ch := make(chan error, 1)
	go func() { ch <- r.run(ctx) }()
	return ch
}

// check verifies the read output and the single exit event.
func (r *reader) check(t *testing.T, want []byte) {
	t.Helper()
	r.mu.Lock()
	defer r.mu.Unlock()
	if !bytes.Equal(r.stdout, want) {
		t.Errorf("stdout: %d bytes, want %d (equal prefix: %v)", len(r.stdout), len(want), bytes.HasPrefix(want, r.stdout))
	}
	if len(r.exits) != 1 {
		t.Fatalf("%d exit events, want 1", len(r.exits))
	}
	ex := r.exits[0]
	if ex.GetStatus() != agentv1.ExitStatus_EXIT_STATUS_EXITED || ex.GetCode() != 0 || ex.GetStdoutEnd() != uint64(len(want)) {
		t.Errorf("exit %v, want exited 0 at stdout_end %d", ex, len(want))
	}
}

func waitReader(t *testing.T, ch <-chan error) {
	t.Helper()
	select {
	case err := <-ch:
		if err != nil {
			t.Fatal(err)
		}
	case <-time.After(2 * waitTimeout):
		t.Fatal("reader did not finish")
	}
}

func TestHarnessRunThroughGateway(t *testing.T) {
	e := newEnv(t)
	e.sup.Script("run-1", func(r *supervisor.FakeRun) {
		_ = r.Write(shim.StdoutFile, []byte("hello\n"))
		_ = r.Write(shim.StderrFile, []byte("oops\n"))
		_ = r.Write(shim.StdoutFile, []byte("world\n"))
		_ = r.Exit(3)
	})
	s, err := e.process().Run(ctx(t), connect.NewRequest(&agentv1.RunRequest{CommandId: "run-1", Spec: argvSpec("/bin/x")}))
	if err != nil {
		t.Fatal(err)
	}
	defer func() { _ = s.Close() }()
	var (
		kinds          []string
		stdout, stderr []byte
		exit           *agentv1.ExitEvent
	)
	for s.Receive() {
		switch ev := s.Msg().GetEvent().(type) {
		case *agentv1.AttachResponse_Started:
			kinds = append(kinds, "started")
			if ev.Started.GetCommandId() != "run-1" {
				t.Errorf("started %v", ev.Started)
			}
		case *agentv1.AttachResponse_Data:
			if len(kinds) == 0 || kinds[len(kinds)-1] != "data" {
				kinds = append(kinds, "data")
			}
			switch ev.Data.GetStream() {
			case agentv1.Stream_STREAM_STDOUT:
				stdout = append(stdout, ev.Data.GetData()...)
			case agentv1.Stream_STREAM_STDERR:
				stderr = append(stderr, ev.Data.GetData()...)
			}
		case *agentv1.AttachResponse_Exit:
			kinds = append(kinds, "exit")
			exit = ev.Exit
		}
	}
	if err := s.Err(); err != nil {
		t.Fatalf("Run stream: %v", err)
	}
	if want := []string{"started", "data", "exit"}; fmt.Sprint(kinds) != fmt.Sprint(want) {
		t.Errorf("events %v, want %v", kinds, want)
	}
	if string(stdout) != "hello\nworld\n" || string(stderr) != "oops\n" {
		t.Errorf("stdout %q stderr %q", stdout, stderr)
	}
	if exit.GetStatus() != agentv1.ExitStatus_EXIT_STATUS_EXITED || exit.GetCode() != 3 ||
		exit.GetStdoutEnd() != 12 || exit.GetStderrEnd() != 5 {
		t.Errorf("exit %v", exit)
	}
}

func TestHarnessAttachAcrossCut(t *testing.T) {
	e := newEnv(t)
	// A second cut lands right after the exit, while the exit is being
	// recorded and its event delivered.
	script, want := slowScript(60, 1024, 25*time.Millisecond, e.cut)
	e.sup.Script("cut-1", script)
	if _, err := e.process().Start(ctx(t), connect.NewRequest(&agentv1.StartRequest{CommandId: "cut-1", Spec: argvSpec("/bin/x")})); err != nil {
		t.Fatal(err)
	}
	r := &reader{e: e, commandID: "cut-1"}
	done := r.goRun(ctx(t))
	eventually(t, "10 KiB read", func() bool { return r.bytes.Load() >= 10<<10 })
	e.cut()
	waitReader(t, done)
	r.check(t, want)
	if r.attaches < 2 {
		t.Errorf("%d attaches: the cut did not break the stream", r.attaches)
	}
	t.Logf("%d attaches, errors by code %v", r.attaches, r.codes())
	e.checkExitedOnce(t, "cut-1")
}

func TestHarnessAttachAcrossAgentRestart(t *testing.T) {
	e := newEnv(t)
	script, want := slowScript(60, 1024, 25*time.Millisecond, nil)
	e.sup.Script("restart-1", script)
	if _, err := e.process().Start(ctx(t), connect.NewRequest(&agentv1.StartRequest{CommandId: "restart-1", Spec: argvSpec("/bin/x")})); err != nil {
		t.Fatal(err)
	}
	r := &reader{e: e, commandID: "restart-1"}
	done := r.goRun(ctx(t))
	eventually(t, "10 KiB read", func() bool { return r.bytes.Load() >= 10<<10 })
	e.restartAgent()
	waitReader(t, done)
	r.check(t, want)
	if r.attaches < 2 {
		t.Errorf("%d attaches: the restart did not break the stream", r.attaches)
	}
	t.Logf("%d attaches, errors by code %v", r.attaches, r.codes())
	e.checkExitedOnce(t, "restart-1")
}

func TestHarnessStartRequiresNoRequestID(t *testing.T) {
	e := newEnv(t)
	e.sup.Script("start-1", func(r *supervisor.FakeRun) { _ = r.Exit(0) })
	req := &agentv1.StartRequest{CommandId: "start-1", Spec: argvSpec("/bin/x")}
	res, err := e.process().Start(ctx(t), connect.NewRequest(req))
	if err != nil {
		t.Fatalf("Start without Sbx-Request-Id: %v", err)
	}
	if !res.Msg.GetCreated() || res.Msg.GetCommand().GetCommandId() != "start-1" {
		t.Fatalf("Start = %v", res.Msg)
	}
	res, err = e.process().Start(ctx(t), connect.NewRequest(req))
	if err != nil {
		t.Fatalf("repeated Start: %v", err)
	}
	if res.Msg.GetCreated() {
		t.Error("repeated Start created the command again")
	}
}
