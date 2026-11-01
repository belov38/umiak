package process

import (
	"testing"

	"connectrpc.com/connect"

	agentv1 "github.com/belov38/umiak/libs/proto/umiak/agent/v1"

	"github.com/belov38/umiak/services/guest-agent/internal/events"
	"github.com/belov38/umiak/services/guest-agent/internal/shim"
	"github.com/belov38/umiak/services/guest-agent/internal/shimproto"
	"github.com/belov38/umiak/services/guest-agent/internal/supervisor"
)

// truncatedEvents returns the output.truncated payloads of the harness.
func truncatedEvents(h *harness) []*agentv1.OutputTruncated {
	var out []*agentv1.OutputTruncated
	for _, p := range h.rec.Of(events.TypeOutputTruncated) {
		out = append(out, p.(*agentv1.OutputTruncated))
	}
	return out
}

func TestOutputTruncatedFromExitFile(t *testing.T) {
	h := newHarness(t)
	h.fake.Script("c1", func(r *supervisor.FakeRun) {
		_ = r.Write(shim.StdoutFile, []byte("abc"))
		_ = r.ExitWith(shimproto.ExitFile{Code: 0, Reason: shimproto.ReasonNone, StdoutEnd: 3,
			OutputTruncated: shimproto.TruncatedDiskFull,
			DroppedBytes:    map[string]uint64{shim.StdoutFile: 100, shim.StderrFile: 7}})
	})
	stream, err := h.client.Run(h.ctx(), connect.NewRequest(&agentv1.RunRequest{CommandId: "c1", Spec: argvSpec("/bin/x")}))
	if err != nil {
		t.Fatal(err)
	}
	evs, err := collect(t, stream)
	if err != nil {
		t.Fatal(err)
	}
	last := evs[len(evs)-1].GetExit()
	if last.GetOutputTruncated() != "disk_full" || last.GetStdoutEnd() != 3 {
		t.Errorf("ExitEvent = %v, want output_truncated disk_full and stdout_end 3", last)
	}

	info := h.waitExited("c1")
	if info.GetOutputTruncated() != "disk_full" {
		t.Errorf("CommandInfo.output_truncated = %q", info.GetOutputTruncated())
	}
	ex := h.rec.Of(events.TypeCommandExited)
	if len(ex) != 1 || ex[0].(*agentv1.CommandExited).GetOutputTruncated() != "disk_full" {
		t.Errorf("command.exited = %v", ex)
	}
	got := truncatedEvents(h)
	if len(got) != 2 {
		t.Fatalf("output.truncated events = %v, want one per stream", got)
	}
	streams := map[agentv1.Stream]bool{}
	for _, e := range got {
		if e.GetCommandId() != "c1" || e.GetReason() != "disk_full" {
			t.Errorf("output.truncated = %v", e)
		}
		streams[e.GetStream()] = true
	}
	if !streams[agentv1.Stream_STREAM_STDOUT] || !streams[agentv1.Stream_STREAM_STDERR] {
		t.Errorf("streams = %v", streams)
	}
}

func TestOutputTruncatedFromStatusOnce(t *testing.T) {
	h := newHarness(t)
	h.start("c1", argvSpec("/bin/x"))
	h.waitRunning("c1")
	r := h.run("c1")
	r.SetDropped(shim.StderrFile, 42)

	// A new agent learns of the loss from the status of the running shim.
	h.restart("boot-1")
	eventually(t, "output.truncated from status", func() bool { return len(truncatedEvents(h)) == 1 })
	if e := truncatedEvents(h)[0]; e.GetStream() != agentv1.Stream_STREAM_STDERR || e.GetReason() != "disk_full" {
		t.Errorf("output.truncated = %v", e)
	}
	// The monitor emits before it writes the record (a crash repeats the
	// event instead of losing it), so the record may lag the event.
	eventually(t, "running CommandInfo.output_truncated", func() bool {
		return h.waitRunning("c1").GetOutputTruncated() == "disk_full"
	})
	// The agent being replaced may have seen the status too: at least once.
	before := len(truncatedEvents(h))

	// exit.json repeats the loss: no second event.
	if err := r.Exit(0); err != nil {
		t.Fatal(err)
	}
	info := h.waitExited("c1")
	if info.GetOutputTruncated() != "disk_full" {
		t.Errorf("exited CommandInfo.output_truncated = %q", info.GetOutputTruncated())
	}
	if got := truncatedEvents(h); len(got) != before {
		t.Errorf("output.truncated events = %v, want no new one from exit.json", got)
	}
}

func TestNoTruncationByDefault(t *testing.T) {
	h := newHarness(t)
	h.fake.Script("c1", func(r *supervisor.FakeRun) { _ = r.Exit(0) })
	h.start("c1", argvSpec("/bin/x"))
	if info := h.waitExited("c1"); info.GetOutputTruncated() != "" {
		t.Errorf("output_truncated = %q", info.GetOutputTruncated())
	}
	if got := truncatedEvents(h); len(got) != 0 {
		t.Errorf("output.truncated events = %v", got)
	}
}
