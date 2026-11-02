package process_test

import (
	"bytes"
	"context"
	"errors"
	"fmt"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	"connectrpc.com/connect"
	"github.com/google/uuid"
	"google.golang.org/protobuf/types/known/durationpb"

	"github.com/belov38/umiak/libs/tunnel/tunneltest/process"
	testingv1 "github.com/belov38/umiak/libs/tunnel/tunneltest/testpb/umiak/testing/v1"
	"github.com/belov38/umiak/libs/tunnel/tunneltest/testpb/umiak/testing/v1/testingv1connect"
	"github.com/belov38/umiak/libs/tunnel/wire"
)

const waitTimeout = 10 * time.Second

func newClient(t *testing.T, opts process.Options) (*process.Store, testingv1connect.ProcessClient) {
	t.Helper()
	st := process.NewStore(opts)
	t.Cleanup(st.Close)
	mux := http.NewServeMux()
	mux.Handle(st.Handler())
	srv := httptest.NewServer(mux)
	t.Cleanup(srv.Close)
	return st, testingv1connect.NewProcessClient(srv.Client(), srv.URL)
}

func spec(lines, lineBytes uint32, interval time.Duration, code int32) *testingv1.CommandSpec {
	return &testingv1.CommandSpec{Lines: lines, LineBytes: lineBytes, Interval: durationpb.New(interval), ExitCode: code}
}

func start(t *testing.T, c testingv1connect.ProcessClient, id string, sp *testingv1.CommandSpec) bool {
	t.Helper()
	resp, err := c.Start(context.Background(), connect.NewRequest(&testingv1.StartRequest{CommandId: id, Spec: sp}))
	if err != nil {
		t.Fatalf("Start(%s): %v", id, err)
	}
	return resp.Msg.GetCreated()
}

// collected is everything one Attach stream returned.
type collected struct {
	out        [2][]byte
	events     []*testingv1.AttachResponse
	exit       *testingv1.ExitEvent
	heartbeats int
	truncated  []*testingv1.TruncatedEvent
	started    string
	maxChunk   int
}

func streamIndex(s testingv1.Stream) int {
	if s == testingv1.Stream_STREAM_STDERR {
		return 1
	}
	return 0
}

// drain reads a stream to its end and checks the offsets are contiguous from off.
func drain(t *testing.T, recv func() bool, msg func() *testingv1.AttachResponse, errf func() error, off [2]uint64) collected {
	t.Helper()
	var c collected
	for recv() {
		m := msg()
		c.events = append(c.events, m)
		switch ev := m.GetEvent().(type) {
		case *testingv1.AttachResponse_Data:
			i := streamIndex(ev.Data.GetStream())
			if ev.Data.GetOffset() != off[i] {
				t.Fatalf("data offset %d on stream %d, want %d", ev.Data.GetOffset(), i, off[i])
			}
			c.out[i] = append(c.out[i], ev.Data.GetData()...)
			off[i] += uint64(len(ev.Data.GetData()))
			c.maxChunk = max(c.maxChunk, len(ev.Data.GetData()))
		case *testingv1.AttachResponse_Exit:
			if c.exit != nil {
				t.Fatal("two exit events")
			}
			c.exit = ev.Exit
		case *testingv1.AttachResponse_Heartbeat:
			c.heartbeats++
		case *testingv1.AttachResponse_Truncated:
			c.truncated = append(c.truncated, ev.Truncated)
			off[streamIndex(ev.Truncated.GetStream())] = ev.Truncated.GetAvailableFrom()
		case *testingv1.AttachResponse_Started:
			c.started = ev.Started.GetCommandId()
		}
	}
	if err := errf(); err != nil {
		t.Fatalf("stream error: %v", err)
	}
	return c
}

func attach(t *testing.T, c testingv1connect.ProcessClient, id string, off [2]uint64) collected {
	t.Helper()
	ctx, cancel := context.WithTimeout(context.Background(), waitTimeout)
	defer cancel()
	s, err := c.Attach(ctx, connect.NewRequest(&testingv1.AttachRequest{CommandId: id, StdoutOffset: off[0], StderrOffset: off[1]}))
	if err != nil {
		t.Fatal(err)
	}
	defer func() { _ = s.Close() }()
	return drain(t, s.Receive, s.Msg, s.Err, off)
}

func TestExpectedFormat(t *testing.T) {
	stdout, stderr := process.Expected(spec(4, 32, 0, 0))
	pad := strings.Repeat(".", 31-len("stdout 0 "))
	wantOut := "stdout 0 " + pad + "\nstdout 2 " + pad + "\n"
	wantErr := "stderr 1 " + pad + "\nstderr 3 " + pad + "\n"
	if len(pad) != 22 {
		t.Fatalf("pad %d", len(pad))
	}
	if string(stdout) != wantOut || string(stderr) != wantErr {
		t.Fatalf("Expected = %q / %q", stdout, stderr)
	}
	// line_bytes 0 means 64.
	stdout, _ = process.Expected(spec(1, 0, 0, 0))
	if len(stdout) != 64 || !strings.HasPrefix(string(stdout), "stdout 0 ...") || stdout[63] != '\n' {
		t.Fatalf("default line = %q", stdout)
	}
}

func TestStartIdempotent(t *testing.T) {
	st, c := newClient(t, process.Options{})
	sp := spec(10, 32, 0, 3)
	if !start(t, c, "cmd-1", sp) {
		t.Fatal("first Start: created = false")
	}
	if start(t, c, "cmd-1", spec(10, 32, 0, 3)) {
		t.Fatal("repeated Start with the same spec: created = true")
	}
	_, err := c.Start(context.Background(), connect.NewRequest(&testingv1.StartRequest{CommandId: "cmd-1", Spec: spec(11, 32, 0, 3)}))
	if connect.CodeOf(err) != connect.CodeAlreadyExists {
		t.Fatalf("Start with another spec: %v, want already_exists", err)
	}
	if n := st.Starts("cmd-1"); n != 1 {
		t.Fatalf("Starts = %d, want 1", n)
	}
	// Three calls reached the double; one started the work.
	if n := st.Invocations("cmd-1"); n != 3 {
		t.Fatalf("Invocations = %d, want 3", n)
	}
	for _, bad := range []*testingv1.StartRequest{
		{CommandId: "", Spec: sp},
		{CommandId: "x"},
		{CommandId: "y", Spec: spec(1, 16, 0, 0)},
	} {
		if _, err := c.Start(context.Background(), connect.NewRequest(bad)); connect.CodeOf(err) != connect.CodeInvalidArgument {
			t.Fatalf("Start(%v): %v, want invalid_argument", bad, err)
		}
	}
}

func TestAttachFullAndResume(t *testing.T) {
	st, c := newClient(t, process.Options{})
	sp := spec(200, 1000, 0, 42)
	start(t, c, "cmd", sp)
	wantOut, wantErr := process.Expected(sp)

	got := attach(t, c, "cmd", [2]uint64{})
	if !bytes.Equal(got.out[0], wantOut) || !bytes.Equal(got.out[1], wantErr) {
		t.Fatalf("output differs: %d/%d bytes, want %d/%d", len(got.out[0]), len(got.out[1]), len(wantOut), len(wantErr))
	}
	if got.maxChunk > 64<<10 {
		t.Fatalf("chunk of %d bytes, want <= 64 KiB", got.maxChunk)
	}
	ex := got.exit
	if ex == nil || ex.GetStatus() != testingv1.ExitStatus_EXIT_STATUS_EXITED || ex.GetCode() != 42 ||
		ex.GetStdoutEnd() != uint64(len(wantOut)) || ex.GetStderrEnd() != uint64(len(wantErr)) {
		t.Fatalf("exit = %v", ex)
	}
	if _, last := got.events[len(got.events)-1].GetEvent().(*testingv1.AttachResponse_Exit); !last {
		t.Fatal("exit is not the last event")
	}

	// Resume from independent offsets returns exactly the rest.
	off := [2]uint64{12345, 777}
	got = attach(t, c, "cmd", off)
	if !bytes.Equal(got.out[0], wantOut[off[0]:]) || !bytes.Equal(got.out[1], wantErr[off[1]:]) {
		t.Fatal("resumed output differs")
	}
	if got.exit.GetCode() != 42 {
		t.Fatalf("resumed exit = %v", got.exit)
	}
	if st.SentBytes("cmd") != uint64(len(wantOut)+len(wantErr))+(uint64(len(wantOut))-off[0])+(uint64(len(wantErr))-off[1]) {
		t.Fatalf("SentBytes = %d", st.SentBytes("cmd"))
	}
}

func TestAttachWaitsForDataAndExitComesLast(t *testing.T) {
	_, c := newClient(t, process.Options{})
	sp := spec(20, 64, 20*time.Millisecond, 7)
	start(t, c, "slow", sp)
	wantOut, wantErr := process.Expected(sp)
	// An offset beyond the current end waits for data instead of failing.
	off := [2]uint64{uint64(len(wantOut)) - 64, uint64(len(wantErr)) - 64}
	t0 := time.Now()
	got := attach(t, c, "slow", off)
	if time.Since(t0) < 200*time.Millisecond {
		t.Fatalf("attach returned after %v, before the command could finish", time.Since(t0))
	}
	if !bytes.Equal(got.out[0], wantOut[off[0]:]) || !bytes.Equal(got.out[1], wantErr[off[1]:]) {
		t.Fatalf("tail differs: %q %q", got.out[0], got.out[1])
	}
	if got.exit.GetCode() != 7 {
		t.Fatalf("exit = %v", got.exit)
	}
}

func TestHeartbeatAfterSilence(t *testing.T) {
	_, c := newClient(t, process.Options{HeartbeatAfter: 50 * time.Millisecond})
	start(t, c, "quiet", spec(2, 32, 400*time.Millisecond, 0))
	got := attach(t, c, "quiet", [2]uint64{})
	if got.heartbeats < 3 {
		t.Fatalf("heartbeats = %d, want >= 3 during 400ms of silence", got.heartbeats)
	}
}

func TestTruncatedWhenRetentionDropped(t *testing.T) {
	st, c := newClient(t, process.Options{RetainBytes: 1000})
	sp := spec(100, 100, 0, 0)
	start(t, c, "big", sp)
	wantOut, wantErr := process.Expected(sp)
	select {
	case <-st.Done("big"):
	case <-time.After(waitTimeout):
		t.Fatal("command did not exit")
	}
	if o, e := st.Produced("big"); o != 5000 || e != 5000 {
		t.Fatalf("Produced = %d/%d, want 5000/5000", o, e)
	}
	got := attach(t, c, "big", [2]uint64{})
	if len(got.truncated) != 2 {
		t.Fatalf("truncated events = %v, want one per stream", got.truncated)
	}
	for _, tr := range got.truncated {
		if tr.GetAvailableFrom() != 4000 {
			t.Fatalf("available_from = %d, want 4000", tr.GetAvailableFrom())
		}
	}
	if !bytes.Equal(got.out[0], wantOut[4000:]) || !bytes.Equal(got.out[1], wantErr[4000:]) {
		t.Fatal("retained output differs")
	}
}

func TestUnknownCommand(t *testing.T) {
	_, c := newClient(t, process.Options{})
	s, err := c.Attach(context.Background(), connect.NewRequest(&testingv1.AttachRequest{CommandId: "nope"}))
	if err != nil {
		t.Fatal(err)
	}
	for s.Receive() {
		t.Fatal("unexpected message")
	}
	if connect.CodeOf(s.Err()) != connect.CodeNotFound {
		t.Fatalf("Attach unknown: %v, want not_found", s.Err())
	}
	_ = s.Close()
	_, err = c.Signal(context.Background(), connect.NewRequest(&testingv1.SignalRequest{CommandId: "nope"}))
	if connect.CodeOf(err) != connect.CodeNotFound {
		t.Fatalf("Signal unknown: %v, want not_found", err)
	}
}

func TestRunStartsAndStreams(t *testing.T) {
	st, c := newClient(t, process.Options{})
	sp := spec(50, 128, 0, 5)
	run := func() collected {
		ctx, cancel := context.WithTimeout(context.Background(), waitTimeout)
		defer cancel()
		s, err := c.Run(ctx, connect.NewRequest(&testingv1.RunRequest{CommandId: "run-1", Spec: sp}))
		if err != nil {
			t.Fatal(err)
		}
		defer func() { _ = s.Close() }()
		return drain(t, s.Receive, s.Msg, s.Err, [2]uint64{})
	}
	got := run()
	if _, first := got.events[0].GetEvent().(*testingv1.AttachResponse_Started); !first || got.started != "run-1" {
		t.Fatalf("first event = %v, want started{run-1}", got.events[0])
	}
	wantOut, wantErr := process.Expected(sp)
	if !bytes.Equal(got.out[0], wantOut) || !bytes.Equal(got.out[1], wantErr) || got.exit.GetCode() != 5 {
		t.Fatal("Run output differs")
	}
	// Run again with the same id does not start the command twice.
	got = run()
	if !bytes.Equal(got.out[0], wantOut) || st.Starts("run-1") != 1 {
		t.Fatalf("second Run: starts = %d", st.Starts("run-1"))
	}
}

func TestSetLabelNeedsRequestIDAndCounts(t *testing.T) {
	st, c := newClient(t, process.Options{})
	start(t, c, "cmd", spec(1, 32, 0, 0))
	_, err := c.SetLabel(context.Background(), connect.NewRequest(&testingv1.SetLabelRequest{CommandId: "cmd", Label: "a"}))
	if connect.CodeOf(err) != connect.CodeInvalidArgument {
		t.Fatalf("SetLabel without request id: %v, want invalid_argument", err)
	}
	for i := 1; i <= 2; i++ {
		req := connect.NewRequest(&testingv1.SetLabelRequest{CommandId: "cmd", Label: fmt.Sprint(i)})
		req.Header().Set(wire.HeaderRequestID, uuid.NewString())
		resp, err := c.SetLabel(context.Background(), req)
		if err != nil {
			t.Fatal(err)
		}
		if resp.Msg.GetCalls() != uint64(i) { //nolint:gosec // small
			t.Fatalf("calls = %d, want %d", resp.Msg.GetCalls(), i)
		}
	}
	if st.LabelCalls("cmd") != 2 {
		t.Fatalf("LabelCalls = %d", st.LabelCalls("cmd"))
	}
}

func TestSignalKills(t *testing.T) {
	_, c := newClient(t, process.Options{})
	start(t, c, "long", spec(10000, 32, 10*time.Millisecond, 0))
	time.Sleep(50 * time.Millisecond)
	if _, err := c.Signal(context.Background(), connect.NewRequest(&testingv1.SignalRequest{CommandId: "long", Signal: "SIGKILL"})); err != nil {
		t.Fatal(err)
	}
	got := attach(t, c, "long", [2]uint64{})
	if got.exit.GetStatus() != testingv1.ExitStatus_EXIT_STATUS_KILLED || got.exit.GetSignal() != "SIGKILL" {
		t.Fatalf("exit = %v, want killed by SIGKILL", got.exit)
	}
	if got.exit.GetStdoutEnd() != uint64(len(got.out[0])) || got.exit.GetStderrEnd() != uint64(len(got.out[1])) {
		t.Fatalf("exit ends %v do not match the output %d/%d", got.exit, len(got.out[0]), len(got.out[1]))
	}
	// Signal is idempotent.
	if _, err := c.Signal(context.Background(), connect.NewRequest(&testingv1.SignalRequest{CommandId: "long", Signal: "SIGKILL"})); err != nil {
		t.Fatal(err)
	}
}

func TestAttachStopsWithCaller(t *testing.T) {
	_, c := newClient(t, process.Options{})
	start(t, c, "forever", spec(100000, 32, 50*time.Millisecond, 0))
	ctx, cancel := context.WithCancel(context.Background())
	s, err := c.Attach(ctx, connect.NewRequest(&testingv1.AttachRequest{CommandId: "forever"}))
	if err != nil {
		t.Fatal(err)
	}
	if !s.Receive() {
		t.Fatalf("no first event: %v", s.Err())
	}
	cancel()
	for s.Receive() { //nolint:revive // drain
	}
	if err := s.Err(); !errors.Is(err, context.Canceled) && connect.CodeOf(err) != connect.CodeCanceled {
		t.Fatalf("err after cancel = %v", err)
	}
	_ = s.Close()
}

func TestHoldDelaysExit(t *testing.T) {
	hold := make(chan struct{})
	st, c := newClient(t, process.Options{Hold: hold})
	sp := spec(10, 32, 0, 3)
	wantOut, wantErr := process.Expected(sp)
	start(t, c, "held", sp)
	start(t, c, "killed", sp)
	deadline := time.Now().Add(waitTimeout)
	for _, id := range []string{"held", "killed"} {
		for {
			o, e := st.Produced(id)
			if o == uint64(len(wantOut)) && e == uint64(len(wantErr)) {
				break
			}
			if time.Now().After(deadline) {
				t.Fatalf("%s: output %d/%d bytes, want %d/%d", id, o, e, len(wantOut), len(wantErr))
			}
			time.Sleep(time.Millisecond)
		}
	}
	// A negative check: without Hold the exit follows the last line at once.
	select {
	case <-st.Done("held"):
		t.Fatal("command exited while held")
	case <-time.After(100 * time.Millisecond):
	}
	// A kill ends a held command.
	if _, err := c.Signal(context.Background(), connect.NewRequest(&testingv1.SignalRequest{CommandId: "killed", Signal: "SIGKILL"})); err != nil {
		t.Fatal(err)
	}
	if got := attach(t, c, "killed", [2]uint64{}); got.exit.GetStatus() != testingv1.ExitStatus_EXIT_STATUS_KILLED {
		t.Fatalf("killed: exit = %v, want killed", got.exit)
	}
	close(hold)
	got := attach(t, c, "held", [2]uint64{})
	if !bytes.Equal(got.out[0], wantOut) || !bytes.Equal(got.out[1], wantErr) {
		t.Fatal("held: output differs")
	}
	if got.exit.GetStatus() != testingv1.ExitStatus_EXIT_STATUS_EXITED || got.exit.GetCode() != 3 {
		t.Fatalf("held: exit = %v, want exited 3", got.exit)
	}
}
