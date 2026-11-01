// Package harness_test runs the real S2 gateway (Postgres registry, memnet
// transport) together with the real guest agent (agent.Run with fake OS
// dependencies) in one process and exercises the agent API through the
// gateway's internal listener.
package harness_test

import (
	"context"
	"crypto/ed25519"
	"crypto/rand"
	"errors"
	"io"
	"log/slog"
	"net"
	"net/http"
	"net/netip"
	"os"
	"os/user"
	"path/filepath"
	"slices"
	"strings"
	"sync"
	"syscall"
	"testing"
	"time"

	"connectrpc.com/connect"
	"github.com/google/uuid"
	"golang.org/x/crypto/ssh"

	"github.com/belov38/umiak/libs/proto/umiak/agent/v1/agentv1connect"
	tunnelv1 "github.com/belov38/umiak/libs/proto/umiak/tunnel/v1"
	"github.com/belov38/umiak/libs/tunnel/gateway"
	"github.com/belov38/umiak/libs/tunnel/h2"
	"github.com/belov38/umiak/libs/tunnel/registry"
	"github.com/belov38/umiak/libs/tunnel/tunneltest/memnet"
	"github.com/belov38/umiak/libs/tunnel/tunneltest/pgtest"
	"github.com/belov38/umiak/libs/tunnel/wire"

	"github.com/belov38/umiak/services/guest-agent/internal/agent"
	"github.com/belov38/umiak/services/guest-agent/internal/config"
	"github.com/belov38/umiak/services/guest-agent/internal/ident"
	"github.com/belov38/umiak/services/guest-agent/internal/paths"
	"github.com/belov38/umiak/services/guest-agent/internal/process"
	"github.com/belov38/umiak/services/guest-agent/internal/quiesce"
	"github.com/belov38/umiak/services/guest-agent/internal/supervisor"
)

func TestMain(m *testing.M) { pgtest.Main(m) }

const (
	serviceToken = "harness-api-token"
	waitTimeout  = 30 * time.Second
	// deadAfter is the memnet liveness timeout of a stalled link.
	deadAfter = 300 * time.Millisecond
	// staleAfter is the instance heartbeat age after which it is dead.
	staleAfter   = 500 * time.Millisecond
	agentVersion = "1.2.3"
	bootID       = "11111111-2222-3333-4444-555555555555"
	// fakeMount is the only mount of the fake freezer.
	fakeMount = "/fake-root"
)

// fastTiming is the gateway timing of libs/tunnel/internal/e2e.
func fastTiming() gateway.Timing {
	return gateway.Timing{
		Heartbeat:          100 * time.Millisecond,
		StaleAfter:         staleAfter,
		Sweep:              100 * time.Millisecond,
		EndpointWait:       50 * time.Millisecond,
		DrainSpread:        200 * time.Millisecond,
		TCPDeadline:        300 * time.Millisecond,
		DrainMargin:        time.Second,
		DrainRetryAfter:    100 * time.Millisecond,
		TokenMaxAge:        time.Hour,
		EventBatchMax:      500,
		EventBatchInterval: 50 * time.Millisecond,
		EventRetryMin:      10 * time.Millisecond,
		EventRetryMax:      50 * time.Millisecond,
	}
}

// testLogger discards logs unless UMIAK_TEST_LOG is set.
func testLogger(args ...any) *slog.Logger {
	if os.Getenv("UMIAK_TEST_LOG") != "" {
		return slog.New(slog.NewTextHandler(os.Stderr, &slog.HandlerOptions{Level: slog.LevelDebug})).With(args...)
	}
	return slog.New(slog.DiscardHandler)
}

// eventually polls cond every 10 ms until it holds or waitTimeout passes.
func eventually(t *testing.T, what string, cond func() bool) {
	t.Helper()
	deadline := time.Now().Add(waitTimeout)
	for !cond() {
		if time.Now().After(deadline) {
			t.Fatalf("timed out after %s waiting for %s", waitTimeout, what)
		}
		time.Sleep(10 * time.Millisecond)
	}
}

// delivery is one event batch handed to the sink.
type delivery struct {
	at     time.Time
	events []*tunnelv1.Event
}

// recSink records the delivered agent events. It acknowledges every batch
// up to its last seq, or only up to ackCap while that is set.
type recSink struct {
	mu         sync.Mutex
	deliveries []delivery
	conn       []*tunnelv1.ConnectionEvent
	ackCap     uint64 // 0: no cap
}

func (s *recSink) DeliverEvents(_ context.Context, _ string, evs []*tunnelv1.Event) (uint64, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	s.deliveries = append(s.deliveries, delivery{at: time.Now(), events: slices.Clone(evs)})
	last := evs[len(evs)-1].GetSeq()
	if s.ackCap != 0 {
		return min(last, s.ackCap), nil
	}
	return last, nil
}

func (s *recSink) DeliverConnectionEvent(_ context.Context, ev *tunnelv1.ConnectionEvent) error {
	s.mu.Lock()
	s.conn = append(s.conn, ev)
	s.mu.Unlock()
	return nil
}

// capAcks makes the sink acknowledge nothing above seq (0 lifts the cap).
func (s *recSink) capAcks(seq uint64) {
	s.mu.Lock()
	s.ackCap = seq
	s.mu.Unlock()
}

// events returns every delivered event in delivery order, redeliveries
// included.
func (s *recSink) events() []*tunnelv1.Event {
	s.mu.Lock()
	defer s.mu.Unlock()
	var out []*tunnelv1.Event
	for _, d := range s.deliveries {
		out = append(out, d.events...)
	}
	return out
}

// count returns the number of delivered events (a mark for since).
func (s *recSink) count() int { return len(s.events()) }

// since returns the events delivered after the first n.
func (s *recSink) since(n int) []*tunnelv1.Event { return s.events()[n:] }

// maxSeq returns the highest seq delivered so far.
func (s *recSink) maxSeq() uint64 {
	var top uint64
	for _, ev := range s.events() {
		top = max(top, ev.GetSeq())
	}
	return top
}

// find returns the first delivered event of typ for which match holds.
func (s *recSink) find(typ string, match func(*tunnelv1.Event) bool) (*tunnelv1.Event, bool) {
	for _, ev := range s.events() {
		if ev.GetType() == typ && (match == nil || match(ev)) {
			return ev, true
		}
	}
	return nil, false
}

// fakeFreezer simulates FIFREEZE on one fake mount.
type fakeFreezer struct {
	mu     sync.Mutex
	frozen bool
	calls  []string
}

func (f *fakeFreezer) Mounts() ([]quiesce.Mount, error) {
	return []quiesce.Mount{{Path: fakeMount, Source: "/dev/fake", FSType: "ext4"}}, nil
}

func (f *fakeFreezer) Freeze(p string) error {
	f.mu.Lock()
	defer f.mu.Unlock()
	f.calls = append(f.calls, "freeze "+p)
	if f.frozen {
		return &os.PathError{Op: "FIFREEZE", Path: p, Err: syscall.EBUSY}
	}
	f.frozen = true
	return nil
}

func (f *fakeFreezer) Thaw(p string) error {
	f.mu.Lock()
	defer f.mu.Unlock()
	f.calls = append(f.calls, "thaw "+p)
	if !f.frozen {
		return &os.PathError{Op: "FITHAW", Path: p, Err: syscall.EINVAL}
	}
	f.frozen = false
	return nil
}

func (f *fakeFreezer) log() []string {
	f.mu.Lock()
	defer f.mu.Unlock()
	return slices.Clone(f.calls)
}

// agentRun is one running agent.Run.
type agentRun struct {
	cancel context.CancelFunc
	done   chan error
	ready  chan struct{}
}

// env is one database, one gateway with its internal listener on
// 127.0.0.1, a memnet network and one machine running the guest agent.
type env struct {
	t         *testing.T
	store     *registry.Store
	net       *memnet.Network
	sink      *recSink
	gw        *gateway.Gateway
	url       string // internal listener
	peer      *http.Transport
	machineID string
	bs        []byte

	// The machine: layout, supervisor (the command shims outlive agent
	// runs) and the fakes, shared by every agent run.
	root     string // scratch directory for test files
	layout   paths.Layout
	cfg      config.Config
	sup      *supervisor.Fake
	freezer  *fakeFreezer
	resetter *ident.FakeResetter
	user     *process.User

	mu  sync.Mutex
	cur *agentRun
}

// newEnv starts the gateway and the agent and waits until the agent's
// tunnel session serves.
func newEnv(t *testing.T) *env {
	t.Helper()
	pool, _ := pgtest.New(t)
	e := &env{
		t:         t,
		store:     registry.New(pool),
		net:       memnet.New(memnet.Options{DeadAfter: deadAfter}),
		sink:      &recSink{},
		peer:      gateway.NewPeerTransport(),
		machineID: uuid.NewString(),
		bs:        make([]byte, wire.SecretLen),
		freezer:   &fakeFreezer{},
	}
	t.Cleanup(e.peer.CloseIdleConnections)
	if _, err := rand.Read(e.bs); err != nil {
		t.Fatal(err)
	}
	if err := e.store.PutCredentials(t.Context(), e.machineID, wire.HashSecret(e.bs)); err != nil {
		t.Fatalf("PutCredentials: %v", err)
	}
	e.startGateway()
	e.setupMachine()
	e.startAgent()
	e.waitServing()
	return e
}

// startGateway runs one gateway and its internal listener.
func (e *env) startGateway() {
	t := e.t
	ln, err := (&net.ListenConfig{}).Listen(t.Context(), "tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatal(err)
	}
	e.url = "http://" + ln.Addr().String()
	g, err := gateway.New(gateway.Config{
		InstanceID:    "gw-1",
		InternalURL:   e.url,
		Store:         e.store,
		ServiceTokens: gateway.TokenSet{"api": {serviceToken}},
		Sink:          e.sink,
		Timing:        fastTiming(),
		HTTP2:         h2.ClientConfig{PingIdle: 200 * time.Millisecond, PingTimeout: 200 * time.Millisecond},
		Logger:        testLogger("gw", "gw-1"),
	})
	if err != nil {
		t.Fatal(err)
	}
	e.gw = g
	ctx, cancel := context.WithCancel(context.Background())
	runErr := make(chan error, 1)
	go func() { runErr <- g.Run(ctx) }()
	srv := gateway.NewInternalServer(g.InternalHandler())
	srvDone := make(chan struct{})
	go func() {
		defer close(srvDone)
		_ = srv.Serve(ln)
	}()
	t.Cleanup(func() {
		e.net.RemoveGateway("gw-1")
		cancel()
		select {
		case err := <-runErr:
			if err != nil {
				t.Errorf("gateway Run = %v", err)
			}
		case <-time.After(waitTimeout):
			t.Error("gateway Run did not return")
		}
		_ = srv.Close()
		<-srvDone
	})
	eventually(t, "gateway ready", g.Ready)
	e.net.AddGateway("gw-1", g.Admitter(), g.Ready)
}

// setupMachine creates the machine's layout in a short temporary root
// (darwin limits unix socket paths to 104 bytes, too few for t.TempDir())
// and the fakes.
func (e *env) setupMachine() {
	t := e.t
	root, err := os.MkdirTemp("", "umiakh")
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = os.RemoveAll(root) })
	e.layout = paths.ForRoot(root + "/m")
	e.root = root + "/work"
	if err := os.MkdirAll(e.root, 0o755); err != nil {
		t.Fatal(err)
	}
	cu, err := user.Current()
	if err != nil {
		t.Fatal(err)
	}
	if e.user, err = process.LookupUser(cu.Username); err != nil {
		t.Fatal(err)
	}
	e.cfg = config.Defaults()
	e.cfg.DockerEnabled = false
	e.cfg.DefaultUser = cu.Username
	e.resetter = &ident.FakeResetter{OnRegenerate: func() error { return writeHostKey(e.layout.SSHDir) }}
	e.sup = supervisor.NewFake(e.layout)
	// Registered first so it runs last, after every agent run stopped.
	t.Cleanup(func() { _ = e.sup.Close() })
}

// writeHostKey writes a fresh ed25519 public host key into dir, as the
// regeneration of the host keys at the identity reset does.
func writeHostKey(dir string) error {
	pub, _, err := ed25519.GenerateKey(rand.Reader)
	if err != nil {
		return err
	}
	sp, err := ssh.NewPublicKey(pub)
	if err != nil {
		return err
	}
	if err := os.MkdirAll(dir, 0o755); err != nil {
		return err
	}
	return os.WriteFile(filepath.Join(dir, "ssh_host_ed25519_key.pub"), ssh.MarshalAuthorizedKey(sp), 0o644)
}

// deps returns the fake dependencies of one agent run.
func (e *env) deps(ready chan struct{}) agent.Deps {
	var once sync.Once
	return agent.Deps{
		Supervisor:  e.sup,
		IdentSource: ident.Static{Raw: ident.Raw{Serial: wire.SMBIOSSerial(e.machineID, e.bs), UUID: e.machineID}},
		Resetter:    e.resetter,
		Freezer:     e.freezer,
		Dialer:      e.net.Dialer(),
		SdNotify: func(state string) error {
			if state == "READY=1" {
				once.Do(func() { close(ready) })
			}
			return nil
		},
		BootID:       func() (string, error) { return bootID, nil },
		MountSecrets: func(dir string) error { return os.MkdirAll(dir, 0o755) },
		LookupUser:   func(string) (*process.User, error) { return e.user, nil },
		Statfs:       func(string) (uint64, uint64, error) { return 100 << 30, 50 << 30, nil },
		Hostname:     func() (string, error) { return "umiak-harness", nil },
		IdleSample:   func() (float64, uint64) { return 0, 0 },
		// Loopback only: the interface addresses of a developer machine
		// (VPN, firewalled) may time out instead of refusing.
		LocalAddrs: func() []netip.Addr { return nil },
		ShimPath:   "/usr/local/lib/umiak-agent/versions/" + agentVersion + "/umiak-agent",
		Log:        testLogger("agent", e.machineID),

		IdentityRetry: 20 * time.Millisecond,
		StatusEvery:   50 * time.Millisecond,
	}
}

// startAgent runs agent.Run in a goroutine and waits for READY=1.
func (e *env) startAgent() {
	e.t.Helper()
	ctx, cancel := context.WithCancel(context.Background())
	run := &agentRun{cancel: cancel, done: make(chan error, 1), ready: make(chan struct{})}
	deps := e.deps(run.ready)
	go func() { run.done <- agent.Run(ctx, e.layout, e.cfg, agentVersion, deps) }()
	e.mu.Lock()
	first := e.cur == nil
	e.cur = run
	e.mu.Unlock()
	if first {
		e.t.Cleanup(func() { e.stopAgent() })
	}
	select {
	case <-run.ready:
	case err := <-run.done:
		e.t.Fatalf("agent exited before READY=1: %v", err)
	case <-time.After(waitTimeout):
		e.t.Fatal("no READY=1")
	}
}

// stopAgent stops the current agent run (if any) and waits for Run.
func (e *env) stopAgent() {
	e.mu.Lock()
	run := e.cur
	e.cur = nil
	e.mu.Unlock()
	if run == nil {
		return
	}
	run.cancel()
	select {
	case err := <-run.done:
		if err != nil {
			e.t.Errorf("agent Run = %v", err)
		}
	case <-time.After(waitTimeout):
		e.t.Error("agent Run did not return")
	}
}

// restartAgent stops the agent and runs it again over the same layout,
// store and command shims, then waits until the new session serves.
func (e *env) restartAgent() {
	e.t.Helper()
	old, _ := e.store.Session(e.t.Context(), e.machineID)
	e.stopAgent()
	e.startAgent()
	eventually(e.t, "a session of the restarted agent", func() bool {
		s, err := e.store.Session(e.t.Context(), e.machineID)
		return err == nil && s.AgentInstanceID != old.AgentInstanceID && s.State == "connected"
	})
	e.waitServing()
}

// waitServing waits until the gateway serves the machine's session.
func (e *env) waitServing() {
	e.t.Helper()
	eventually(e.t, "the agent's tunnel session", func() bool {
		_, ok := e.gw.Machine(e.machineID)
		return ok
	})
}

// cut breaks every tunnel link: the agent reconnects.
func (e *env) cut() { e.net.CutAll() }

// rpcURL is the base URL of the agent's Connect services.
func (e *env) rpcURL() string { return e.url + "/v1/machines/" + e.machineID + "/rpc" }

// filesURL is the URL of the agent's /files endpoint.
func (e *env) filesURL() string { return e.url + "/v1/machines/" + e.machineID + "/files" }

// bearerRT adds the service token to every request.
type bearerRT struct{ rt http.RoundTripper }

func (b bearerRT) RoundTrip(r *http.Request) (*http.Response, error) {
	r = r.Clone(r.Context())
	r.Header.Set("Authorization", "Bearer "+serviceToken)
	return b.rt.RoundTrip(r)
}

// httpClient calls the internal listener with the service token.
func (e *env) httpClient() *http.Client { return &http.Client{Transport: bearerRT{rt: e.peer}} }

func (e *env) process() agentv1connect.ProcessClient {
	return agentv1connect.NewProcessClient(e.httpClient(), e.rpcURL())
}

func (e *env) filesystem() agentv1connect.FilesystemClient {
	return agentv1connect.NewFilesystemClient(e.httpClient(), e.rpcURL())
}

func (e *env) system() agentv1connect.SystemClient {
	return agentv1connect.NewSystemClient(e.httpClient(), e.rpcURL())
}

// withRequestID sets Umiak-Request-Id on req.
func withRequestID[T any](req *connect.Request[T], id string) *connect.Request[T] {
	req.Header().Set(wire.HeaderRequestID, id)
	return req
}

// ctx returns a context bounded by waitTimeout.
func ctx(t *testing.T) context.Context {
	c, cancel := context.WithTimeout(t.Context(), waitTimeout)
	t.Cleanup(cancel)
	return c
}

// response is a finished /files response with its body read.
type response struct {
	status int
	header http.Header
	body   []byte
}

// do sends a /files request through the gateway: rest is appended to
// filesURL (with its query).
func (e *env) do(method, rest string, body io.Reader) *response {
	e.t.Helper()
	req, err := http.NewRequestWithContext(ctx(e.t), method, e.filesURL()+rest, body)
	if err != nil {
		e.t.Fatal(err)
	}
	// Set explicitly, the transport does not decode the body: a compressed
	// answer keeps its Content-Encoding and fails the check below.
	req.Header.Set("Accept-Encoding", "gzip")
	res, err := e.httpClient().Do(req)
	if err != nil {
		e.t.Fatalf("%s %s: %v", method, rest, err)
	}
	defer func() { _ = res.Body.Close() }()
	b, err := io.ReadAll(res.Body)
	if err != nil {
		e.t.Fatalf("%s %s: read body: %v", method, rest, err)
	}
	// /files never compresses (global constraint), on success or error.
	if ce := res.Header.Get("Content-Encoding"); ce != "" {
		e.t.Errorf("%s %s: Content-Encoding %q", method, rest, ce)
	}
	return &response{status: res.StatusCode, header: res.Header, body: b}
}

// retryable reports whether a client retries err through the gateway:
// unavailable (agent_unavailable, machine_moved), or a transport error such
// as an EOF or a stream reset (the gateway resets a Connect stream cut
// inside an envelope; Connect reports a peer RST_STREAM as internal, and
// the HTTP/2 stream error type is unexported, hence the message check).
func retryable(err error) bool {
	if connect.CodeOf(err) == connect.CodeUnavailable {
		return true
	}
	var ne net.Error
	return errors.Is(err, io.EOF) || errors.Is(err, io.ErrUnexpectedEOF) || errors.Is(err, syscall.ECONNRESET) ||
		errors.As(err, &ne) || strings.Contains(err.Error(), "stream error: ")
}
