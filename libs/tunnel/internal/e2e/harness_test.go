package e2e_test

import (
	"context"
	"crypto/rand"
	"errors"
	"fmt"
	"log/slog"
	mrand "math/rand/v2"
	"net"
	"net/http"
	"os"
	"slices"
	"strconv"
	"sync"
	"sync/atomic"
	"testing"
	"time"

	"connectrpc.com/connect"
	"github.com/google/uuid"
	"google.golang.org/protobuf/types/known/durationpb"

	tunnelv1 "github.com/belov38/umiak/libs/proto/umiak/tunnel/v1"
	"github.com/belov38/umiak/libs/tunnel/agent"
	"github.com/belov38/umiak/libs/tunnel/gateway"
	"github.com/belov38/umiak/libs/tunnel/h2"
	"github.com/belov38/umiak/libs/tunnel/registry"
	"github.com/belov38/umiak/libs/tunnel/tunneltest/memnet"
	"github.com/belov38/umiak/libs/tunnel/tunneltest/pgtest"
	"github.com/belov38/umiak/libs/tunnel/tunneltest/process"
	testingv1 "github.com/belov38/umiak/libs/tunnel/tunneltest/testpb/umiak/testing/v1"
	"github.com/belov38/umiak/libs/tunnel/tunneltest/testpb/umiak/testing/v1/testingv1connect"
	"github.com/belov38/umiak/libs/tunnel/wire"
)

func TestMain(m *testing.M) { pgtest.Main(m) }

// Shrunk timings of every scenario (spec values in comments).
const (
	serviceToken = "e2e-api-token"
	waitTimeout  = 30 * time.Second
	// deadAfter is the memnet liveness timeout of a stalled link (WS 15 s).
	deadAfter = 300 * time.Millisecond
	// staleAfter is the instance heartbeat age after which it is dead (15 s).
	staleAfter = 500 * time.Millisecond
	// ownerPoll is the pause between registry owner lookups of a client.
	ownerPoll = 50 * time.Millisecond
)

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

func testLogger(args ...any) *slog.Logger {
	if os.Getenv("UMIAK_TEST_LOG") != "" {
		return slog.New(slog.NewTextHandler(os.Stderr, &slog.HandlerOptions{Level: slog.LevelDebug})).With(args...)
	}
	return slog.New(slog.DiscardHandler)
}

// eventually polls cond every 10 ms until it holds or timeout passes.
func eventually(t *testing.T, timeout time.Duration, what string, cond func() bool) {
	t.Helper()
	deadline := time.Now().Add(timeout)
	for !cond() {
		if time.Now().After(deadline) {
			t.Fatalf("timed out after %s waiting for %s", timeout, what)
		}
		time.Sleep(10 * time.Millisecond)
	}
}

// recSink records connection events and acknowledges agent events.
type recSink struct {
	mu   sync.Mutex
	conn []*tunnelv1.ConnectionEvent
}

func (s *recSink) DeliverEvents(_ context.Context, _ string, evs []*tunnelv1.Event) (uint64, error) {
	return evs[len(evs)-1].GetSeq(), nil
}

func (s *recSink) DeliverConnectionEvent(_ context.Context, ev *tunnelv1.ConnectionEvent) error {
	s.mu.Lock()
	s.conn = append(s.conn, ev)
	s.mu.Unlock()
	return nil
}

func (s *recSink) has(machineID, typ string) bool {
	s.mu.Lock()
	defer s.mu.Unlock()
	return slices.ContainsFunc(s.conn, func(ev *tunnelv1.ConnectionEvent) bool {
		return ev.GetMachineId() == machineID && ev.GetType() == typ
	})
}

// env is one database, one memnet network and the gateways on it.
type env struct {
	t     *testing.T
	seed  uint64
	rng   *mrand.Rand // used by one goroutine at a time
	store *registry.Store
	net   *memnet.Network
	sink  *recSink
	peer  *http.Transport

	mu  sync.Mutex
	gws []*gw // live gateways, oldest first
	seq int
}

// newEnv creates the environment. The seed of the scenario's random choices
// is UMIAK_E2E_SEED or random, and is logged when the test fails.
func newEnv(t *testing.T) *env {
	t.Helper()
	seed := mrand.Uint64()
	if s := os.Getenv("UMIAK_E2E_SEED"); s != "" {
		v, err := strconv.ParseUint(s, 10, 64)
		if err != nil {
			t.Fatalf("UMIAK_E2E_SEED: %v", err)
		}
		seed = v
	}
	t.Cleanup(func() {
		if t.Failed() {
			t.Logf("scenario seed %d (rerun with UMIAK_E2E_SEED=%d)", seed, seed)
		}
	})
	pool, _ := pgtest.New(t)
	peer := gateway.NewPeerTransport()
	t.Cleanup(peer.CloseIdleConnections)
	return &env{
		t:     t,
		seed:  seed,
		rng:   mrand.New(mrand.NewPCG(seed, seed^0x9e3779b97f4a7c15)),
		store: registry.New(pool),
		net:   memnet.New(memnet.Options{DeadAfter: deadAfter}),
		sink:  &recSink{},
		peer:  peer,
	}
}

// gw is a running gateway with its internal listener on 127.0.0.1.
type gw struct {
	*gateway.Gateway
	e        *env
	name     string
	url      string
	routed   atomic.Bool // memnet routes new dials here only while set (and Ready)
	cancel   context.CancelFunc
	runErr   chan error
	srv      *http.Server
	srvDone  chan struct{}
	stopOnce sync.Once
}

// startGateway starts a gateway with a fresh instance id; it may run on any
// goroutine. mod may change the config.
func (e *env) startGateway(mod func(*gateway.Config)) (*gw, error) {
	e.mu.Lock()
	e.seq++
	name := fmt.Sprintf("gw-%d", e.seq)
	e.mu.Unlock()
	ln, err := (&net.ListenConfig{}).Listen(context.Background(), "tcp", "127.0.0.1:0")
	if err != nil {
		return nil, err
	}
	g := &gw{e: e, name: name, url: "http://" + ln.Addr().String(), runErr: make(chan error, 1), srvDone: make(chan struct{})}
	cfg := gateway.Config{
		InstanceID:             name,
		InternalURL:            g.url,
		Store:                  e.store,
		ServiceTokens:          gateway.TokenSet{"api": {serviceToken}},
		Sink:                   e.sink,
		AllowedServicePrefixes: []string{"umiak.testing.v1."},
		Timing:                 fastTiming(),
		HTTP2:                  h2.ClientConfig{PingIdle: 200 * time.Millisecond, PingTimeout: 200 * time.Millisecond},
		Logger:                 testLogger("gw", name),
	}
	if mod != nil {
		mod(&cfg)
	}
	gg, err := gateway.New(cfg)
	if err != nil {
		_ = ln.Close()
		return nil, err
	}
	g.Gateway = gg
	ctx, cancel := context.WithCancel(context.Background())
	g.cancel = cancel
	go func() { g.runErr <- gg.Run(ctx) }()
	g.srv = gateway.NewInternalServer(gg.InternalHandler())
	go func() {
		defer close(g.srvDone)
		_ = g.srv.Serve(ln)
	}()
	e.t.Cleanup(g.stop)
	deadline := time.Now().Add(waitTimeout)
	for !gg.Ready() {
		if time.Now().After(deadline) {
			return nil, fmt.Errorf("%s not ready after %s", name, waitTimeout)
		}
		time.Sleep(5 * time.Millisecond)
	}
	g.routed.Store(true)
	e.net.AddGateway(name, gg.Admitter(), func() bool { return g.routed.Load() && gg.Ready() })
	e.mu.Lock()
	e.gws = append(e.gws, g)
	e.mu.Unlock()
	return g, nil
}

// mustGateway is startGateway for the test goroutine.
func (e *env) mustGateway(mod func(*gateway.Config)) *gw {
	e.t.Helper()
	g, err := e.startGateway(mod)
	if err != nil {
		e.t.Fatal(err)
	}
	return g
}

// stop stops Run (if still running) and closes the internal listener.
func (g *gw) stop() { g.stopWith(false) }

// stopWith stops Run and the internal listener; graceful shuts the listener
// down (in-flight proxied calls finish, as a pod does after Drain) instead
// of closing it.
func (g *gw) stopWith(graceful bool) {
	g.stopOnce.Do(func() {
		g.e.net.RemoveGateway(g.name)
		g.e.forget(g)
		g.cancel()
		select {
		case err := <-g.runErr:
			if err != nil {
				g.e.t.Errorf("%s: Run = %v", g.name, err)
			}
		case <-time.After(waitTimeout):
			g.e.t.Errorf("%s: Run did not return", g.name)
		}
		if graceful {
			ctx, cancel := context.WithTimeout(context.Background(), waitTimeout)
			if err := g.srv.Shutdown(ctx); err != nil {
				g.e.t.Errorf("%s: internal listener shutdown: %v", g.name, err)
			}
			cancel()
		}
		_ = g.srv.Close()
		<-g.srvDone
	})
}

func (e *env) forget(g *gw) {
	e.mu.Lock()
	e.gws = slices.DeleteFunc(e.gws, func(x *gw) bool { return x == g })
	e.mu.Unlock()
}

// gateways returns the live gateways.
func (e *env) gateways() []*gw {
	e.mu.Lock()
	defer e.mu.Unlock()
	return slices.Clone(e.gws)
}

func (e *env) byName(name string) *gw {
	e.mu.Lock()
	defer e.mu.Unlock()
	for _, g := range e.gws {
		if g.name == name {
			return g
		}
	}
	return nil
}

// routeOnly makes memnet route new dials to g only.
func (e *env) routeOnly(g *gw) {
	for _, x := range e.gateways() {
		x.routed.Store(x == g)
	}
}

func (e *env) routeAll() {
	for _, x := range e.gateways() {
		x.routed.Store(true)
	}
}

// abandon crashes g: no drain, no registry or sink writes, listener closed.
func (e *env) abandon(g *gw) {
	e.net.RemoveGateway(g.name)
	e.forget(g)
	g.Abandon()
	g.stop()
}

// drain drains g (spec 7) and then shuts its listener down gracefully.
func (e *env) drain(ctx context.Context, g *gw) error {
	e.forget(g)
	err := g.Drain(ctx)
	g.stopWith(true) //nolint:contextcheck // the shutdown is bounded on its own, not by the caller's ctx
	return err
}

// anyURL returns the internal URL of some live gateway: clients start there.
func (e *env) anyURL() string {
	gws := e.gateways()
	if len(gws) == 0 {
		return "http://127.0.0.1:1"
	}
	return gws[0].url
}

// ownerURL polls the registry until a live instance owns the machine.
func (e *env) ownerURL(ctx context.Context, machineID string) (string, error) {
	for {
		o, ok, err := e.store.Owner(ctx, machineID, staleAfter)
		if err == nil && ok {
			return o.InternalURL, nil
		}
		select {
		case <-ctx.Done():
			return "", fmt.Errorf("owner of %s: %w", machineID, ctx.Err())
		case <-time.After(ownerPoll):
		}
	}
}

// bearerRT adds the service token to every request.
type bearerRT struct {
	rt    http.RoundTripper
	token string
}

func (b bearerRT) RoundTrip(r *http.Request) (*http.Response, error) {
	r = r.Clone(r.Context())
	r.Header.Set("Authorization", "Bearer "+b.token)
	return b.rt.RoundTrip(r)
}

// client is a Go Connect client of a machine's Process service through the
// internal listener at url. It does not accept gzip (like the TS
// agent-client): the double's output compresses about 1000:1, which would
// hide both large envelopes and the flow-control bound of the payload.
func (e *env) client(url, machineID string) testingv1connect.ProcessClient {
	return testingv1connect.NewProcessClient(&http.Client{Transport: bearerRT{rt: e.peer, token: serviceToken}},
		url+"/v1/machines/"+machineID+"/rpc", connect.WithAcceptCompression("gzip", nil, nil))
}

// retryable reports whether a client retries err (Connect codes that mean
// the call itself is wrong are final).
func retryable(err error) bool {
	switch connect.CodeOf(err) {
	case connect.CodeInvalidArgument, connect.CodeNotFound, connect.CodePermissionDenied,
		connect.CodeFailedPrecondition, connect.CodeAlreadyExists:
		return false
	default:
		return true
	}
}

// movedURL returns Umiak-Instance-Url of a 421 answer to a unary call.
func movedURL(err error) string {
	var ce *connect.Error
	if errors.As(err, &ce) {
		return ce.Meta().Get(wire.HeaderInstanceURL)
	}
	return ""
}

// startCommand calls Start through the gateways until it succeeds, following
// 421 and re-looking-up the owner after other retryable errors.
func (e *env) startCommand(ctx context.Context, machineID, commandID string, spec *testingv1.CommandSpec) error {
	url := e.anyURL()
	for {
		_, err := e.client(url, machineID).Start(ctx, connect.NewRequest(&testingv1.StartRequest{CommandId: commandID, Spec: spec}))
		if err == nil {
			return nil
		}
		if ctx.Err() != nil || !retryable(err) {
			return fmt.Errorf("Start %s: %w", commandID, err)
		}
		if u := movedURL(err); u != "" {
			url = u
			continue
		}
		if url, err = e.ownerURL(ctx, machineID); err != nil {
			return err
		}
	}
}

func spec(lines, lineBytes uint32, interval time.Duration, code int32) *testingv1.CommandSpec {
	return &testingv1.CommandSpec{Lines: lines, LineBytes: lineBytes, Interval: durationpb.New(interval), ExitCode: code}
}

// machine is one VM: credentials, the Process store (shim and disk, it
// outlives agent clients) and the current agent client.
type machine struct {
	e     *env
	id    string
	bs    []byte
	procs *process.Store
	mod   func(*agent.Config)

	mu  sync.Mutex
	cur *agentRun
	gen int

	evMu   sync.Mutex
	events []connEv
}

// connEv is an agent connection event with the client generation that sent it.
type connEv struct {
	agent.ConnEvent
	gen int
	at  time.Time
}

type agentRun struct {
	instanceID string
	cancel     context.CancelFunc
	done       chan error
}

type staticCreds struct {
	id string
	bs []byte
}

func (c staticCreds) Bootstrap(context.Context) (string, []byte, error) { return c.id, c.bs, nil }

// newMachine creates credentials and a Process store and starts an agent.
func (e *env) newMachine(popts process.Options, mod func(*agent.Config)) *machine {
	e.t.Helper()
	bs := make([]byte, wire.SecretLen)
	if _, err := rand.Read(bs); err != nil {
		e.t.Fatal(err)
	}
	m := &machine{e: e, id: uuid.NewString(), bs: bs, procs: process.NewStore(popts), mod: mod}
	if err := e.store.PutCredentials(context.Background(), m.id, wire.HashSecret(bs)); err != nil {
		e.t.Fatalf("PutCredentials: %v", err)
	}
	e.t.Cleanup(m.procs.Close)
	m.mu.Lock()
	err := m.startLocked()
	m.mu.Unlock()
	if err != nil {
		e.t.Fatal(err)
	}
	e.t.Cleanup(m.stop)
	return m
}

func (m *machine) startLocked() error {
	m.gen++
	gen := m.gen
	mux := http.NewServeMux()
	mux.Handle(m.procs.Handler())
	inst := "agent-" + uuid.NewString()
	cfg := agent.Config{
		Dialer:      m.e.net.Dialer(),
		Credentials: staticCreds{id: m.id, bs: m.bs},
		Identity:    agent.Identity{BootID: "boot-" + m.id, InstanceID: inst, Vmgenid: "gen-1", Version: "1.0.0"},
		Handler:     mux,
		Backoff:     agent.Backoff{First: 5 * time.Millisecond, Base: 10 * time.Millisecond, Max: 100 * time.Millisecond, ResetAfter: time.Minute},
		RejectDelays: agent.RejectDelays{
			BadBootstrap: 50 * time.Millisecond, Retired: 50 * time.Millisecond, Outdated: 50 * time.Millisecond,
		},
		DrainJitter:     20 * time.Millisecond,
		DrainCloseExtra: 2 * time.Second,
		Logger:          testLogger("agent", inst),
		OnConnEvent: func(ev agent.ConnEvent) {
			m.evMu.Lock()
			m.events = append(m.events, connEv{ConnEvent: ev, gen: gen, at: time.Now()})
			m.evMu.Unlock()
		},
	}
	if m.mod != nil {
		m.mod(&cfg)
	}
	c, err := agent.New(cfg)
	if err != nil {
		return err
	}
	ctx, cancel := context.WithCancel(context.Background())
	run := &agentRun{instanceID: inst, cancel: cancel, done: make(chan error, 1)}
	go func() { run.done <- c.Run(ctx) }()
	m.cur = run
	return nil
}

func (r *agentRun) stop() error {
	r.cancel()
	select {
	case err := <-r.done:
		return err
	case <-time.After(waitTimeout):
		return errors.New("agent Run did not return")
	}
}

// restartAgent replaces the agent client: new instance id, same Process
// store and credentials, no machine token (it lived in memory).
func (m *machine) restartAgent() error {
	m.mu.Lock()
	defer m.mu.Unlock()
	if err := m.cur.stop(); err != nil {
		return err
	}
	return m.startLocked()
}

func (m *machine) stop() {
	m.mu.Lock()
	defer m.mu.Unlock()
	if err := m.cur.stop(); err != nil {
		m.e.t.Error(err)
	}
}

// generation returns the generation of the current agent client.
func (m *machine) generation() int {
	m.mu.Lock()
	defer m.mu.Unlock()
	return m.gen
}

// findEvent returns the first recorded event matching pred.
func (m *machine) findEvent(pred func(connEv) bool) (connEv, bool) {
	m.evMu.Lock()
	defer m.evMu.Unlock()
	for _, ev := range m.events {
		if pred(ev) {
			return ev, true
		}
	}
	return connEv{}, false
}

// waitEvent waits for an event matching pred.
func (m *machine) waitEvent(t *testing.T, what string, pred func(connEv) bool) connEv {
	t.Helper()
	var ev connEv
	eventually(t, waitTimeout, what, func() bool {
		var ok bool
		ev, ok = m.findEvent(pred)
		return ok
	})
	return ev
}

// waitConnectedTo waits until the machine's agent connected to g.
func (m *machine) waitConnectedTo(t *testing.T, g *gw) connEv {
	t.Helper()
	return m.waitEvent(t, m.id+" connected to "+g.name, func(ev connEv) bool {
		return ev.Kind == agent.KindConnected && ev.Gateway == g.name
	})
}

// newestLink returns the machine's newest live memnet link, or nil.
func (m *machine) newestLink() *memnet.Link {
	ls := m.e.net.Links(m.id)
	if len(ls) == 0 {
		return nil
	}
	return ls[len(ls)-1]
}

// ownerGateway returns the live gateway serving the newest link.
func (m *machine) ownerGateway() *gw {
	l := m.newestLink()
	if l == nil {
		return nil
	}
	return m.e.byName(l.Gateway)
}

// fatalError stops a reader: the agent broke the output contract.
type fatalError struct{ msg string }

func (e *fatalError) Error() string { return e.msg }

// reader is the Go-side resume helper (spec 9.1): it attaches through the
// gateways, follows the owner after every retryable error and splices each
// stream by offset (equal: accept, overlap: trim, gap: reattach).
type reader struct {
	e         *env
	machineID string
	commandID string

	out      [2][]byte
	exit     *testingv1.ExitEvent
	exitAt   time.Time    // when exit arrived
	attaches atomic.Int64 // Attach calls made, readable while running
	// attachBytes counts the bytes accepted from the current Attach call.
	attachBytes atomic.Int64
	errCount    atomic.Int64 // len(errs), readable while running
	errs        []error
	errAt       []time.Time // when each of errs was seen
	errURL      []string    // the gateway URL of the failed attach
	overlaps    int
	gaps        int
	lastData    time.Time
	maxPause    time.Duration
	bytes       atomic.Int64 // accepted bytes, readable while running
	// slow is slept after every data event: a slow consumer keeps the
	// pipeline full, so the agent is mostly blocked inside a message.
	slow time.Duration
}

func newReader(e *env, machineID, commandID string) *reader {
	return &reader{e: e, machineID: machineID, commandID: commandID}
}

// run reads the command's output to its exit event.
func (r *reader) run(ctx context.Context) error {
	url := r.e.anyURL()
	for {
		if err := ctx.Err(); err != nil {
			return fmt.Errorf("attach %s after %d attaches (%d/%d bytes): %w", r.commandID, r.attaches.Load(),
				len(r.out[0]), len(r.out[1]), err)
		}
		done, err := r.attachOnce(ctx, url)
		if done {
			return err
		}
		if err == nil {
			continue // a gap: attach again from the expected offsets
		}
		r.errs = append(r.errs, err)
		r.errAt = append(r.errAt, time.Now())
		r.errURL = append(r.errURL, url)
		r.errCount.Add(1)
		if !retryable(err) {
			return fmt.Errorf("attach %s: %w", r.commandID, err)
		}
		// An attach that failed before any data waits a little: the owner
		// in the registry may still be a dead instance.
		if r.attachBytes.Load() == 0 {
			select {
			case <-ctx.Done():
			case <-time.After(ownerPoll):
			}
		}
		// Streaming Connect clients see 421 without metadata: find the
		// owner in the registry.
		if url, err = r.e.ownerURL(ctx, r.machineID); err != nil {
			return err
		}
	}
}

// errorsBetween counts the errors seen from from to to (inclusive). Call it
// after run returned.
func (r *reader) errorsBetween(from, to time.Time) int {
	n := 0
	for _, at := range r.errAt {
		if !at.Before(from) && !at.After(to) {
			n++
		}
	}
	return n
}

func streamIndex(s testingv1.Stream) int {
	if s == testingv1.Stream_STREAM_STDERR {
		return 1
	}
	return 0
}

// attachOnce runs one Attach call. It returns done with a nil error at the
// exit event, done with an error when the contract is broken, and !done
// with the stream error (nil for a gap) otherwise.
func (r *reader) attachOnce(ctx context.Context, url string) (bool, error) {
	actx, cancel := context.WithCancel(ctx)
	defer cancel()
	r.attaches.Add(1)
	r.attachBytes.Store(0)
	s, err := r.e.client(url, r.machineID).Attach(actx, connect.NewRequest(&testingv1.AttachRequest{
		CommandId:    r.commandID,
		StdoutOffset: uint64(len(r.out[0])),
		StderrOffset: uint64(len(r.out[1])),
	}))
	if err != nil {
		return false, err
	}
	defer func() { _ = s.Close() }()
	for s.Receive() {
		switch ev := s.Msg().GetEvent().(type) {
		case *testingv1.AttachResponse_Data:
			if gap := r.accept(ev.Data); gap {
				r.gaps++
				return false, nil
			}
		case *testingv1.AttachResponse_Exit:
			if ev.Exit.GetStdoutEnd() != uint64(len(r.out[0])) || ev.Exit.GetStderrEnd() != uint64(len(r.out[1])) {
				return true, &fatalError{fmt.Sprintf("exit %v before the output end (%d/%d bytes read)",
					ev.Exit, len(r.out[0]), len(r.out[1]))}
			}
			r.exit, r.exitAt = ev.Exit, time.Now()
			return true, nil
		case *testingv1.AttachResponse_Truncated:
			return true, &fatalError{fmt.Sprintf("unexpected truncated event %v", ev.Truncated)}
		case *testingv1.AttachResponse_Heartbeat, *testingv1.AttachResponse_Started:
		}
	}
	if err := s.Err(); err != nil {
		return false, err
	}
	return false, connect.NewError(connect.CodeUnavailable, errors.New("stream ended without exit"))
}

// accept splices one data event; it reports a gap.
func (r *reader) accept(d *testingv1.DataEvent) bool {
	now := time.Now()
	if !r.lastData.IsZero() {
		r.maxPause = max(r.maxPause, now.Sub(r.lastData))
	}
	r.lastData = now
	i := streamIndex(d.GetStream())
	exp := uint64(len(r.out[i]))
	off, data := d.GetOffset(), d.GetData()
	switch {
	case off == exp:
	case off < exp:
		r.overlaps++
		end := off + uint64(len(data))
		if end <= exp {
			return false
		}
		data = data[exp-off:]
	default:
		return true
	}
	r.out[i] = append(r.out[i], data...)
	r.bytes.Add(int64(len(data)))
	r.attachBytes.Add(int64(len(data)))
	if r.slow > 0 {
		time.Sleep(r.slow)
	}
	return false
}

// codes returns the Connect codes of the errors seen, for logs.
func (r *reader) codes() map[string]int {
	out := map[string]int{}
	for _, err := range r.errs {
		out[connect.CodeOf(err).String()]++
	}
	return out
}

// check compares the reader's result with the expected output and exit.
func (r *reader) check(t *testing.T, name string, wantOut, wantErr []byte, code int32) {
	t.Helper()
	if !slices.Equal(r.out[0], wantOut) || !slices.Equal(r.out[1], wantErr) {
		t.Errorf("%s: output differs: stdout %d/%d bytes, stderr %d/%d bytes (first diff stdout at %d, stderr at %d)",
			name, len(r.out[0]), len(wantOut), len(r.out[1]), len(wantErr), firstDiff(r.out[0], wantOut), firstDiff(r.out[1], wantErr))
	}
	if r.exit == nil || r.exit.GetStatus() != testingv1.ExitStatus_EXIT_STATUS_EXITED || r.exit.GetCode() != code {
		t.Errorf("%s: exit = %v, want exited %d", name, r.exit, code)
	}
	if r.gaps != 0 {
		t.Errorf("%s: %d gaps in the output offsets", name, r.gaps)
	}
}

func firstDiff(a, b []byte) int {
	for i := range min(len(a), len(b)) {
		if a[i] != b[i] {
			return i
		}
	}
	if len(a) == len(b) {
		return -1
	}
	return min(len(a), len(b))
}

// waitBytes waits until the reader accepted at least n bytes.
func (r *reader) waitBytes(t *testing.T, n int64) {
	t.Helper()
	eventually(t, waitTimeout, fmt.Sprintf("%s: %d bytes read", r.commandID, n), func() bool { return r.bytes.Load() >= n })
}

// goRun runs the reader in a goroutine; the error arrives on the channel.
func (r *reader) goRun(ctx context.Context) <-chan error {
	ch := make(chan error, 1)
	go func() { ch <- r.run(ctx) }()
	return ch
}

// waitErr waits for a reader's result.
func waitErr(t *testing.T, ch <-chan error, what string) {
	t.Helper()
	select {
	case err := <-ch:
		if err != nil {
			t.Fatalf("%s: %v", what, err)
		}
	case <-time.After(2 * waitTimeout):
		t.Fatalf("%s: no result", what)
	}
}
