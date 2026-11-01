//go:build integration && linux

// Package integration holds the Linux integration tests of the guest agent
// (spec S3 section 21). They run as root inside the privileged systemd
// container that test/linux/run.sh prepares: the real umiak-agent is installed
// as a package, umiak-identity.service and umiak-agent.service run under systemd,
// and the tests drive the agent over its debug socket
// (`run --debug-listen`), which serves the agent API, Control/Info and a
// read-only Events/Subscribe without a gateway.
package integration

import (
	"context"
	"crypto/rand"
	"encoding/json"
	"fmt"
	"net"
	"net/http"
	"os"
	"os/exec"
	"path/filepath"
	"slices"
	"strconv"
	"strings"
	"testing"
	"time"

	"connectrpc.com/connect"
	"github.com/google/uuid"
	"google.golang.org/protobuf/proto"

	agentv1 "github.com/belov38/umiak/libs/proto/umiak/agent/v1"
	"github.com/belov38/umiak/libs/proto/umiak/agent/v1/agentv1connect"
	tunnelv1 "github.com/belov38/umiak/libs/proto/umiak/tunnel/v1"
	"github.com/belov38/umiak/libs/proto/umiak/tunnel/v1/tunnelv1connect"
	"github.com/belov38/umiak/libs/tunnel/rpcconv"
	"github.com/belov38/umiak/libs/tunnel/wire"
)

// Paths prepared by run.sh.
const (
	debugSock  = "/run/umiak-agent/debug.sock"
	configFile = "/etc/umiak-agent/agent.toml"
	baseConfig = "/var/lib/umiak-it/agent.toml"
	dmiDir     = "/var/lib/umiak-it/dmi"
	pkgDir     = "/it/pkg"
	agentUnit  = "umiak-agent.service"
	stateDir   = "/var/lib/umiak-agent"
)

// waitAgentTimeout bounds a wait for the agent to (re)start.
const waitAgentTimeout = 90 * time.Second

func TestMain(m *testing.M) {
	if os.Geteuid() != 0 {
		fmt.Fprintln(os.Stderr, "integration tests need root in the systemd container (test/linux/run.sh)")
		os.Exit(1)
	}
	os.Exit(m.Run())
}

// agentClient talks to the agent over its debug socket.
type agentClient struct {
	hc     *http.Client
	proc   agentv1connect.ProcessClient
	sys    agentv1connect.SystemClient
	ctl    tunnelv1connect.ControlClient
	events tunnelv1connect.EventsClient
}

// newClient returns a client of the debug socket. Every call carries a fresh
// Umiak-Request-Id.
func newClient() *agentClient {
	hc := &http.Client{Transport: &http.Transport{
		DialContext: func(ctx context.Context, _, _ string) (net.Conn, error) {
			var d net.Dialer
			return d.DialContext(ctx, "unix", debugSock)
		},
		DisableKeepAlives: true,
	}}
	opts := connect.WithInterceptors(requestIDs{})
	const base = "http://agent"
	return &agentClient{
		hc:     hc,
		proc:   agentv1connect.NewProcessClient(hc, base, opts),
		sys:    agentv1connect.NewSystemClient(hc, base, opts),
		ctl:    tunnelv1connect.NewControlClient(hc, base),
		events: tunnelv1connect.NewEventsClient(hc, base),
	}
}

// requestIDs sets a new Umiak-Request-Id on every call that has none.
type requestIDs struct{}

func (requestIDs) WrapUnary(next connect.UnaryFunc) connect.UnaryFunc {
	return func(ctx context.Context, req connect.AnyRequest) (connect.AnyResponse, error) {
		if req.Header().Get(wire.HeaderRequestID) == "" {
			req.Header().Set(wire.HeaderRequestID, uuid.NewString())
		}
		return next(ctx, req)
	}
}

func (requestIDs) WrapStreamingClient(next connect.StreamingClientFunc) connect.StreamingClientFunc {
	return func(ctx context.Context, spec connect.Spec) connect.StreamingClientConn {
		conn := next(ctx, spec)
		conn.RequestHeader().Set(wire.HeaderRequestID, uuid.NewString())
		return conn
	}
}

func (requestIDs) WrapStreamingHandler(next connect.StreamingHandlerFunc) connect.StreamingHandlerFunc {
	return next
}

// tctx returns a context bounded by d that ends with the test.
func tctx(t *testing.T, d time.Duration) context.Context {
	t.Helper()
	ctx, cancel := context.WithTimeout(t.Context(), d)
	t.Cleanup(cancel)
	return ctx
}

// sh runs a shell command in the container and returns its combined output.
// A failure fails the test.
func sh(t *testing.T, script string) string {
	t.Helper()
	out, err := shErr(script)
	if err != nil {
		t.Fatalf("%s: %v\n%s", script, err, out)
	}
	return out
}

// shErr runs a shell command and returns its combined output and error.
func shErr(script string) (string, error) {
	ctx, cancel := context.WithTimeout(context.Background(), 3*time.Minute)
	defer cancel()
	out, err := exec.CommandContext(ctx, "/bin/sh", "-c", script).CombinedOutput()
	return string(out), err
}

// eventually polls cond every 100 ms until it holds or d passes.
func eventually(t *testing.T, d time.Duration, what string, cond func() bool) {
	t.Helper()
	deadline := time.Now().Add(d)
	for !cond() {
		if time.Now().After(deadline) {
			t.Fatalf("timed out after %v waiting for %s", d, what)
		}
		time.Sleep(100 * time.Millisecond)
	}
}

// mainPID returns the main pid of umiak-agent.service, 0 when it is not running.
func mainPID(t *testing.T) int {
	t.Helper()
	out := strings.TrimSpace(sh(t, "systemctl show -p MainPID --value "+agentUnit))
	pid, err := strconv.Atoi(out)
	if err != nil {
		t.Fatalf("MainPID %q: %v", out, err)
	}
	return pid
}

// waitAgent waits until the agent answers System/Info on the debug socket
// and returns the answer.
func waitAgent(t *testing.T) *agentv1.InfoResponse {
	t.Helper()
	c := newClient()
	var info *agentv1.InfoResponse
	eventually(t, waitAgentTimeout, "the agent to answer on "+debugSock, func() bool {
		ctx, cancel := context.WithTimeout(context.Background(), 2*time.Second)
		defer cancel()
		res, err := c.sys.Info(ctx, connect.NewRequest(&agentv1.InfoRequest{}))
		if err != nil {
			return false
		}
		info = res.Msg
		return true
	})
	return info
}

// restartAgent restarts umiak-agent.service and waits until it answers.
func restartAgent(t *testing.T) {
	t.Helper()
	sh(t, "systemctl restart "+agentUnit)
	waitAgent(t)
}

// kill9Agent kills the agent with SIGKILL and waits for systemd to start a
// new one that answers.
func kill9Agent(t *testing.T) {
	t.Helper()
	old := mainPID(t)
	if old == 0 {
		t.Fatal("the agent is not running")
	}
	sh(t, fmt.Sprintf("kill -9 %d", old))
	waitRestarted(t, old)
}

// waitRestarted waits for systemd to replace the agent process old and for
// the new one to answer. It then clears the unit's start rate limit: the
// tests kill the agent more often than StartLimitBurst allows, which would
// otherwise trigger the rollback unit.
func waitRestarted(t *testing.T, old int) {
	t.Helper()
	eventually(t, waitAgentTimeout, "a new agent process", func() bool {
		pid := mainPID(t)
		return pid != 0 && pid != old
	})
	waitAgent(t)
	sh(t, "systemctl reset-failed "+agentUnit+" || true")
}

// withConfig writes agent.toml as the base configuration plus extra, restarts
// the agent and restores the base configuration (with another restart) when
// the test ends.
func withConfig(t *testing.T, extra string) {
	t.Helper()
	base, err := os.ReadFile(baseConfig)
	if err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(configFile, append(append(base, '\n'), extra...), 0o644); err != nil {
		t.Fatal(err)
	}
	restartAgent(t)
	t.Cleanup(func() {
		if err := os.WriteFile(configFile, base, 0o644); err != nil {
			t.Error(err)
		}
		restartAgent(t)
	})
}

// newID returns a command id unique to this run.
func newID(prefix string) string {
	b := make([]byte, 4)
	_, _ = rand.Read(b)
	return fmt.Sprintf("it-%s-%x", prefix, b)
}

// shellSpec returns the spec of a shell command run as user ("" = default).
func shellSpec(script, user string) *agentv1.CommandSpec {
	return &agentv1.CommandSpec{Cmd: &agentv1.CommandSpec_Shell{Shell: script}, User: user}
}

// runResult is the collected output of a command.
type runResult struct {
	stdout, stderr, pty []byte
	// ends are the offsets after the last received byte of each stream.
	ends      map[agentv1.Stream]uint64
	exit      *agentv1.ExitEvent
	truncated []*agentv1.TruncatedEvent
}

// collect reads an attach stream to its end. Data events of a stream must
// be contiguous (a truncation may move the position forward).
func collect(t *testing.T, stream *connect.ServerStreamForClient[agentv1.AttachResponse]) runResult {
	t.Helper()
	r := runResult{ends: map[agentv1.Stream]uint64{}}
	for stream.Receive() {
		switch ev := stream.Msg().GetEvent().(type) {
		case *agentv1.AttachResponse_Data:
			d := ev.Data
			if end, ok := r.ends[d.GetStream()]; ok && d.GetOffset() != end {
				t.Errorf("stream %v: data at offset %d, want %d", d.GetStream(), d.GetOffset(), end)
			}
			r.ends[d.GetStream()] = d.GetOffset() + uint64(len(d.GetData()))
			switch d.GetStream() {
			case agentv1.Stream_STREAM_STDOUT:
				r.stdout = append(r.stdout, d.GetData()...)
			case agentv1.Stream_STREAM_STDERR:
				r.stderr = append(r.stderr, d.GetData()...)
			case agentv1.Stream_STREAM_PTY:
				r.pty = append(r.pty, d.GetData()...)
			}
		case *agentv1.AttachResponse_Truncated:
			r.truncated = append(r.truncated, ev.Truncated)
			r.ends[ev.Truncated.GetStream()] = ev.Truncated.GetAvailableFrom()
		case *agentv1.AttachResponse_Exit:
			r.exit = ev.Exit
		}
	}
	if err := stream.Err(); err != nil {
		t.Fatalf("attach stream: %v", err)
	}
	_ = stream.Close()
	return r
}

// run runs a command with Process/Run and returns its output.
func run(t *testing.T, c *agentClient, id string, spec *agentv1.CommandSpec, d time.Duration) runResult {
	t.Helper()
	stream, err := c.proc.Run(tctx(t, d), connect.NewRequest(&agentv1.RunRequest{CommandId: id, Spec: spec}))
	if err != nil {
		t.Fatalf("Run %s: %v", id, err)
	}
	r := collect(t, stream)
	if r.exit == nil {
		t.Fatalf("Run %s ended without an exit event", id)
	}
	return r
}

// start starts a command and returns its info.
func start(t *testing.T, c *agentClient, id string, spec *agentv1.CommandSpec) *agentv1.CommandInfo {
	t.Helper()
	res, err := c.proc.Start(tctx(t, 30*time.Second), connect.NewRequest(&agentv1.StartRequest{CommandId: id, Spec: spec}))
	if err != nil {
		t.Fatalf("Start %s: %v", id, err)
	}
	return res.Msg.GetCommand()
}

// get returns the command info of id.
func get(t *testing.T, c *agentClient, id string) *agentv1.CommandInfo {
	t.Helper()
	res, err := c.proc.Get(tctx(t, 10*time.Second), connect.NewRequest(&agentv1.GetRequest{CommandId: id}))
	if err != nil {
		t.Fatalf("Get %s: %v", id, err)
	}
	return res.Msg.GetCommand()
}

// waitExited polls Get until the command exited and returns its info.
func waitExited(t *testing.T, c *agentClient, id string, d time.Duration) *agentv1.CommandInfo {
	t.Helper()
	var info *agentv1.CommandInfo
	eventually(t, d, "command "+id+" to exit", func() bool {
		info = get(t, c, id)
		return info.GetState() == agentv1.CommandState_COMMAND_STATE_EXITED
	})
	return info
}

// attach attaches to a command from the offsets in req.
func attach(t *testing.T, c *agentClient, req *agentv1.AttachRequest, follow bool) runResult {
	t.Helper()
	req.Follow = proto.Bool(follow)
	stream, err := c.proc.Attach(tctx(t, 5*time.Minute), connect.NewRequest(req))
	if err != nil {
		t.Fatalf("Attach %s: %v", req.GetCommandId(), err)
	}
	return collect(t, stream)
}

// journal returns the agent's journal events after seq after, read until
// no event arrives for quiet.
func journal(t *testing.T, after uint64, quiet time.Duration) []*tunnelv1.Event {
	t.Helper()
	evs, err := tryJournal(t, after, quiet)
	if err != nil {
		t.Fatalf("Events/Subscribe: %v", err)
	}
	return evs
}

// tryJournal is journal that returns the error of an agent that does not
// answer.
func tryJournal(t *testing.T, after uint64, quiet time.Duration) ([]*tunnelv1.Event, error) {
	t.Helper()
	ctx, cancel := context.WithCancel(t.Context())
	defer cancel()
	stream, err := newClient().events.Subscribe(ctx, connect.NewRequest(&tunnelv1.SubscribeRequest{AfterSeq: proto.Uint64(after)}))
	if err != nil {
		return nil, err
	}
	evs := make(chan *tunnelv1.Event, 1024)
	go func() {
		defer close(evs)
		for stream.Receive() {
			if e := stream.Msg().GetEvent(); e != nil {
				evs <- e
			}
		}
	}()
	var out []*tunnelv1.Event
	for {
		select {
		case e, ok := <-evs:
			if !ok {
				return out, nil
			}
			out = append(out, e)
		case <-time.After(quiet):
			cancel()
			_ = stream.Close()
			return out, nil
		}
	}
}

// lastSeq returns the seq of the newest journal event.
func lastSeq(t *testing.T) uint64 {
	t.Helper()
	evs := journal(t, 0, 300*time.Millisecond)
	if len(evs) == 0 {
		return 0
	}
	return evs[len(evs)-1].GetSeq()
}

// waitEvent waits until the journal after seq holds an event of typ whose
// payload, unmarshalled into msg, satisfies match (nil = any), and returns
// it.
func waitEvent(t *testing.T, after uint64, typ string, d time.Duration, msg proto.Message, match func() bool) *tunnelv1.Event {
	t.Helper()
	var found *tunnelv1.Event
	eventually(t, d, "event "+typ, func() bool {
		for _, e := range journal(t, after, 300*time.Millisecond) {
			if e.GetType() != typ {
				continue
			}
			if msg != nil {
				if err := e.GetPayload().UnmarshalTo(msg); err != nil {
					t.Fatalf("event %s payload: %v", typ, err)
				}
			}
			if match == nil || match() {
				found = e
				return true
			}
		}
		return false
	})
	return found
}

// waitEventLoose is waitEvent that keeps polling while the agent does not
// answer (restarts, failed versions).
func waitEventLoose(t *testing.T, after uint64, typ string, d time.Duration, msg proto.Message, match func() bool) *tunnelv1.Event {
	t.Helper()
	var found *tunnelv1.Event
	eventually(t, d, "event "+typ, func() bool {
		evs, err := tryJournal(t, after, 300*time.Millisecond)
		if err != nil {
			time.Sleep(500 * time.Millisecond)
			return false
		}
		for _, e := range evs {
			if e.GetType() != typ {
				continue
			}
			if err := e.GetPayload().UnmarshalTo(msg); err != nil {
				t.Fatalf("event %s payload: %v", typ, err)
			}
			if match == nil || match() {
				found = e
				return true
			}
		}
		return false
	})
	return found
}

// doctor runs `umiak-agent doctor --json` and returns the decoded report.
func doctor(t *testing.T) map[string]any {
	t.Helper()
	out, err := exec.CommandContext(t.Context(), "/usr/local/bin/umiak-agent", "doctor", "--json").Output()
	if err != nil {
		t.Fatalf("doctor: %v", err)
	}
	var rep map[string]any
	if err := json.Unmarshal(out, &rep); err != nil {
		t.Fatalf("doctor output: %v\n%s", err, out)
	}
	return rep
}

// pids returns the pids of processes whose command line contains pattern.
func pids(pattern string) []string {
	out, _ := exec.CommandContext(context.Background(), "pgrep", "-f", pattern).Output()
	return strings.Fields(string(out))
}

// errDetail returns the umiak detail code of a Connect error, or "".
func errDetail(err error) string {
	d, ok := rpcconv.Detail(err)
	if !ok {
		return ""
	}
	return d.GetCode()
}

// cmdDir returns the command directory of id.
func cmdDir(id string) string { return filepath.Join(stateDir, "commands", id) }

func TestContainerSmoke(t *testing.T) {
	if out, err := shErr("systemctl is-active " + agentUnit); strings.TrimSpace(out) != "active" {
		t.Fatalf("umiak-agent is %q (%v)", strings.TrimSpace(out), err)
	}
	info := waitAgent(t)
	if info.GetMachineId() == "" || info.GetVersion() == "" {
		t.Errorf("System/Info = %v", info)
	}
	rep := doctor(t)
	units, _ := rep["units"].(map[string]any)
	if units["umiak-agent"] != "active" || units["umiak-identity"] != "active" {
		t.Errorf("doctor units = %v", units)
	}
	if id, _ := rep["identity"].(map[string]any); id == nil || id["machine_id"] != info.GetMachineId() {
		t.Errorf("doctor identity = %v, want machine %s", rep["identity"], info.GetMachineId())
	}
	// doctor shows that this machine runs a test build with a fake smbios.
	aids, _ := rep["test_aids"].([]any)
	if rep["identity_dir"] != dmiDir || !slices.Contains(aids, any("devUpdateKey")) || !slices.Contains(aids, any("identity.sysfs_dir")) {
		t.Errorf("doctor identity_dir %v, test_aids %v", rep["identity_dir"], aids)
	}
	t.Logf("agent %s, machine %s, kernel %s", info.GetVersion(), info.GetMachineId(), info.GetKernel())
}
