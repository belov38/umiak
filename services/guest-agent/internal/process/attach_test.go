package process

import (
	"bytes"
	"os"
	"testing"
	"time"

	"connectrpc.com/connect"

	agentv1 "github.com/belov38/umiak/libs/proto/umiak/agent/v1"

	"github.com/belov38/umiak/services/guest-agent/internal/errs"
	"github.com/belov38/umiak/services/guest-agent/internal/fsutil"
	"github.com/belov38/umiak/services/guest-agent/internal/output"
	"github.com/belov38/umiak/services/guest-agent/internal/shim"
	"github.com/belov38/umiak/services/guest-agent/internal/shimproto"
	"github.com/belov38/umiak/services/guest-agent/internal/supervisor"
)

func mustAttach(t *testing.T, h *harness, req *agentv1.AttachRequest) *connect.ServerStreamForClient[agentv1.AttachResponse] {
	t.Helper()
	s, err := h.client.Attach(h.ctx(), connect.NewRequest(req))
	if err != nil {
		t.Fatal(err)
	}
	return s
}

func TestAttachExitAfterAllBytes(t *testing.T) {
	h := newHarness(t, func(o *Options) { o.Poll = time.Second }) // wake-ups come from fsnotify
	h.fake.Script("c1", func(r *supervisor.FakeRun) {
		_ = r.Write(shim.StdoutFile, []byte("abc"))
		_ = r.ExitWith(shimproto.ExitFile{Status: shimproto.StatusExited, Code: 0, Reason: shimproto.ReasonNone, StdoutEnd: 6})
		time.Sleep(100 * time.Millisecond)
		_ = r.Write(shim.StdoutFile, []byte("def"))
	})
	h.start("c1", argvSpec("/bin/x"))
	start := time.Now()
	evs, err := collect(t, mustAttach(t, h, &agentv1.AttachRequest{CommandId: "c1"}))
	if err != nil {
		t.Fatal(err)
	}
	if got := dataOf(t, evs, agentv1.Stream_STREAM_STDOUT, 0); got != "abcdef" {
		t.Fatalf("stdout %q", got)
	}
	last := evs[len(evs)-1].GetExit()
	if last == nil || last.GetStdoutEnd() != 6 {
		t.Fatalf("last event %v, want exit with stdout_end 6", evs[len(evs)-1])
	}
	if time.Since(start) > 900*time.Millisecond {
		t.Fatalf("attach took %v: fsnotify wake-up did not work", time.Since(start))
	}
}

func TestAttachTailBytes(t *testing.T) {
	h := newHarness(t)
	h.fake.Script("c1", func(r *supervisor.FakeRun) {
		_ = r.Write(shim.StdoutFile, bytes.Repeat([]byte("a"), 90))
		_ = r.Write(shim.StdoutFile, []byte("0123456789"))
		_ = r.Write(shim.StderrFile, []byte("xy"))
		_ = r.Exit(0)
	})
	h.start("c1", argvSpec("/bin/x"))
	h.waitExited("c1")
	follow := false
	evs, err := collect(t, mustAttach(t, h, &agentv1.AttachRequest{CommandId: "c1", TailBytes: 10, Follow: &follow}))
	if err != nil {
		t.Fatal(err)
	}
	if got := dataOf(t, evs, agentv1.Stream_STREAM_STDOUT, 90); got != "0123456789" {
		t.Fatalf("stdout tail %q", got)
	}
	if got := dataOf(t, evs, agentv1.Stream_STREAM_STDERR, 0); got != "xy" {
		t.Fatalf("stderr tail %q", got)
	}
	if evs[len(evs)-1].GetExit() == nil {
		t.Fatal("no exit event")
	}
}

func TestAttachFollowFalse(t *testing.T) {
	h := newHarness(t)
	h.start("c1", argvSpec("/bin/x"))
	r := h.run("c1")
	if err := r.Write(shim.StdoutFile, []byte("partial")); err != nil {
		t.Fatal(err)
	}
	follow := false
	evs, err := collect(t, mustAttach(t, h, &agentv1.AttachRequest{CommandId: "c1", Follow: &follow}))
	if err != nil {
		t.Fatal(err)
	}
	if got := dataOf(t, evs, agentv1.Stream_STREAM_STDOUT, 0); got != "partial" {
		t.Fatalf("stdout %q", got)
	}
	for _, ev := range evs {
		if ev.GetExit() != nil {
			t.Fatal("exit event for a running command")
		}
	}

	if err := r.Exit(1); err != nil {
		t.Fatal(err)
	}
	h.waitExited("c1")
	evs, err = collect(t, mustAttach(t, h, &agentv1.AttachRequest{CommandId: "c1", StdoutOffset: 7, Follow: &follow}))
	if err != nil {
		t.Fatal(err)
	}
	if len(evs) != 1 || evs[0].GetExit().GetCode() != 1 {
		t.Fatalf("events %v, want only exit", evs)
	}
}

func TestAttachTruncated(t *testing.T) {
	h := newHarness(t)
	// The hole is 64 KiB: the punch granularity on Windows (a multiple of 4 KiB on Linux).
	const hole = 64 << 10
	payload := bytes.Repeat([]byte("0123456789abcdef"), 8192) // 128 KiB
	h.fake.Script("c1", func(r *supervisor.FakeRun) {
		_ = r.Write(shim.StdoutFile, payload)
		_ = r.Exit(0)
	})
	h.start("c1", argvSpec("/bin/x"))
	h.waitExited("c1")
	f, err := os.OpenFile(cmdFile(h.layout, "c1", shim.StdoutFile), os.O_RDWR, 0)
	if err != nil {
		t.Fatal(err)
	}
	if err := output.Default().PunchFront(f, hole); err != nil {
		t.Fatal(err)
	}
	_ = f.Close()

	evs, err := collect(t, mustAttach(t, h, &agentv1.AttachRequest{CommandId: "c1"}))
	if err != nil {
		t.Fatal(err)
	}
	tr := evs[0].GetTruncated()
	if tr == nil || tr.GetStream() != agentv1.Stream_STREAM_STDOUT || tr.GetAvailableFrom() != hole {
		t.Fatalf("first event %v, want truncated at %d", evs[0], hole)
	}
	if got := dataOf(t, evs, agentv1.Stream_STREAM_STDOUT, hole); got != string(payload[hole:]) {
		t.Fatalf("data after truncation: %d bytes", len(got))
	}
	info, err := h.get("c1")
	if err != nil {
		t.Fatal(err)
	}
	for _, s := range info.GetStreams() {
		if s.GetStream() == agentv1.Stream_STREAM_STDOUT &&
			(s.GetAvailableFrom() != hole || s.GetSize() != uint64(len(payload)) || s.GetEnd() != uint64(len(payload))) {
			t.Fatalf("stdout stream info %v", s)
		}
	}
}

func TestAttachHeartbeat(t *testing.T) {
	h := newHarness(t, func(o *Options) { o.Heartbeat = 50 * time.Millisecond })
	h.start("c1", argvSpec("/bin/x"))
	s := mustAttach(t, h, &agentv1.AttachRequest{CommandId: "c1"})
	if !s.Receive() {
		t.Fatal(s.Err())
	}
	if s.Msg().GetHeartbeat() == nil {
		t.Fatalf("first event %v, want heartbeat", s.Msg())
	}
	_ = s.Close()
}

func TestAttachPTYAndCounts(t *testing.T) {
	h := newHarness(t)
	h.start("c1", ptySpec())
	r := h.run("c1")
	if err := r.Write(shim.PtyFile, []byte("$ ")); err != nil {
		t.Fatal(err)
	}
	s := mustAttach(t, h, &agentv1.AttachRequest{CommandId: "c1"})
	if !s.Receive() {
		t.Fatal(s.Err())
	}
	d := s.Msg().GetData()
	if d.GetStream() != agentv1.Stream_STREAM_PTY || string(d.GetData()) != "$ " {
		t.Fatalf("event %v", s.Msg())
	}
	eventually(t, "attach counted", func() bool {
		running, ptys, attaches := h.m.Counts()
		return running == 1 && ptys == 1 && attaches == 1
	})
	info, err := h.get("c1")
	if err != nil {
		t.Fatal(err)
	}
	if info.GetAttachedClients() != 1 || len(info.GetStreams()) != 1 {
		t.Fatalf("info %v", info)
	}
	_ = s.Close()
	eventually(t, "attach released", func() bool {
		_, _, attaches := h.m.Counts()
		return attaches == 0
	})
	if err := r.Exit(0); err != nil {
		t.Fatal(err)
	}
	h.waitExited("c1")
	eventually(t, "counts drop", func() bool {
		running, ptys, _ := h.m.Counts()
		return running == 0 && ptys == 0
	})
}

func TestAttachUnknownCommand(t *testing.T) {
	h := newHarness(t)
	_, err := collect(t, mustAttach(t, h, &agentv1.AttachRequest{CommandId: "nope"}))
	wantCode(t, err, connect.CodeNotFound, errs.CommandNotFound)
}

func TestAttachExitHasEndedAt(t *testing.T) {
	h := newHarness(t)
	h.fake.Script("c1", func(r *supervisor.FakeRun) { _ = r.Exit(0) })
	h.start("c1", ptySpec())
	evs, err := collect(t, mustAttach(t, h, &agentv1.AttachRequest{CommandId: "c1"}))
	if err != nil {
		t.Fatal(err)
	}
	e := evs[len(evs)-1].GetExit()
	if e == nil || e.GetEndedAt() == nil || e.GetPtyEnd() != 0 {
		t.Fatalf("exit %v", e)
	}
}

// Between the shim writing exit.json and the agent recording the exit, the
// record is still RUNNING: attach must not deliver leftover output past the
// stream end of exit.json.
func TestAttachStopsAtExitJSONEndWhileRunning(t *testing.T) {
	h := newHarness(t)
	h.start("c1", argvSpec("/bin/x"))
	h.waitRunning("c1")
	r := h.run("c1")
	if err := r.Write(shim.StdoutFile, []byte("abc")); err != nil {
		t.Fatal(err)
	}
	// exit.json as the shim writes it; the fake does not push the exit, so
	// the record stays RUNNING.
	if err := fsutil.WriteJSONAtomic(cmdFile(h.layout, "c1", shim.ExitJSON),
		shimproto.ExitFile{Status: shimproto.StatusExited, Reason: shimproto.ReasonNone, StdoutEnd: 3, EndedAt: time.Now().UTC()}, 0o600); err != nil {
		t.Fatal(err)
	}
	if err := r.Write(shim.StdoutFile, []byte("leftover")); err != nil {
		t.Fatal(err)
	}
	follow := false
	evs, err := collect(t, mustAttach(t, h, &agentv1.AttachRequest{CommandId: "c1", Follow: &follow}))
	if err != nil {
		t.Fatal(err)
	}
	if got := dataOf(t, evs, agentv1.Stream_STREAM_STDOUT, 0); got != "abc" {
		t.Fatalf("stdout %q, want %q", got, "abc")
	}
}
