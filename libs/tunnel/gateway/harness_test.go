package gateway

import (
	"context"
	"crypto/rand"
	"errors"
	"io"
	"log/slog"
	"net"
	"os"
	"sync"
	"sync/atomic"
	"testing"
	"time"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"

	tunnelv1 "github.com/belov38/umiak/libs/proto/umiak/tunnel/v1"
	"github.com/belov38/umiak/libs/tunnel/agent"
	"github.com/belov38/umiak/libs/tunnel/registry"
	"github.com/belov38/umiak/libs/tunnel/transport"
	"github.com/belov38/umiak/libs/tunnel/tunneltest/journal"
	"github.com/belov38/umiak/libs/tunnel/tunneltest/memnet"
	"github.com/belov38/umiak/libs/tunnel/tunneltest/pgtest"
	"github.com/belov38/umiak/libs/tunnel/wire"
)

func TestMain(m *testing.M) { pgtest.Main(m) }

// waitTimeout bounds every wait in these tests; it is generous on purpose.
const waitTimeout = 10 * time.Second

func testLogger() *slog.Logger {
	if os.Getenv("UMIAK_TEST_LOG") != "" {
		return slog.New(slog.NewTextHandler(os.Stderr, &slog.HandlerOptions{Level: slog.LevelDebug}))
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

// recSink is a recording EventSink.
type recSink struct {
	mu       sync.Mutex
	attempts [][]*tunnelv1.Event // every DeliverEvents call, failed ones included
	batches  [][]*tunnelv1.Event // successful DeliverEvents calls
	conn     []*tunnelv1.ConnectionEvent
	failNext int
	adjust   []int64 // added to the acked seq of the next successful calls
}

func (s *recSink) DeliverEvents(_ context.Context, _ string, evs []*tunnelv1.Event) (uint64, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	s.attempts = append(s.attempts, evs)
	if s.failNext > 0 {
		s.failNext--
		return 0, errors.New("sink: injected failure")
	}
	s.batches = append(s.batches, evs)
	acked := evs[len(evs)-1].GetSeq()
	if len(s.adjust) > 0 {
		acked = uint64(int64(acked) + s.adjust[0]) //nolint:gosec // test values stay positive
		s.adjust = s.adjust[1:]
	}
	return acked, nil
}

func (s *recSink) setAdjust(adj ...int64) {
	s.mu.Lock()
	s.adjust = adj
	s.mu.Unlock()
}

// hangSink blocks every delivery until its context ends, like an api that
// accepts connections but never answers.
type hangSink struct{}

func (hangSink) DeliverEvents(ctx context.Context, _ string, _ []*tunnelv1.Event) (uint64, error) {
	<-ctx.Done()
	return 0, ctx.Err()
}

func (hangSink) DeliverConnectionEvent(ctx context.Context, _ *tunnelv1.ConnectionEvent) error {
	<-ctx.Done()
	return ctx.Err()
}

func (s *recSink) DeliverConnectionEvent(_ context.Context, ev *tunnelv1.ConnectionEvent) error {
	s.mu.Lock()
	defer s.mu.Unlock()
	s.conn = append(s.conn, ev)
	return nil
}

func (s *recSink) setFailNext(n int) {
	s.mu.Lock()
	s.failNext = n
	s.mu.Unlock()
}

// connEvents returns the recorded connection events of a machine.
func (s *recSink) connEvents(machineID string) []*tunnelv1.ConnectionEvent {
	s.mu.Lock()
	defer s.mu.Unlock()
	var out []*tunnelv1.ConnectionEvent
	for _, ev := range s.conn {
		if ev.GetMachineId() == machineID {
			out = append(out, ev)
		}
	}
	return out
}

func (s *recSink) hasConnEvent(machineID string, epoch uint64, typ string) bool {
	for _, ev := range s.connEvents(machineID) {
		if ev.GetEpoch() == epoch && ev.GetType() == typ {
			return true
		}
	}
	return false
}

func (s *recSink) snapshot() (attempts, batches [][]*tunnelv1.Event) {
	s.mu.Lock()
	defer s.mu.Unlock()
	return append([][]*tunnelv1.Event(nil), s.attempts...), append([][]*tunnelv1.Event(nil), s.batches...)
}

// env is one database and one memnet network shared by gateways and agents.
type env struct {
	t     *testing.T
	pool  *pgxpool.Pool
	dsn   string
	store *registry.Store
	net   *memnet.Network
}

func newEnv(t *testing.T) *env {
	t.Helper()
	pool, dsn := pgtest.New(t)
	return &env{
		t:     t,
		pool:  pool,
		dsn:   dsn,
		store: registry.New(pool),
		net:   memnet.New(memnet.Options{DeadAfter: 200 * time.Millisecond}),
	}
}

// fastTiming shrinks every timing for tests.
func fastTiming() Timing {
	return Timing{
		Heartbeat:          50 * time.Millisecond,
		StaleAfter:         3 * time.Second,
		Sweep:              50 * time.Millisecond,
		EndpointWait:       50 * time.Millisecond,
		DrainSpread:        50 * time.Millisecond,
		TCPDeadline:        2 * time.Second,
		DrainRetryAfter:    1500 * time.Millisecond,
		TokenMaxAge:        time.Hour,
		EventBatchMax:      500,
		EventBatchInterval: 50 * time.Millisecond,
		EventRetryMin:      10 * time.Millisecond,
		EventRetryMax:      50 * time.Millisecond,
	}
}

// testGW is a running gateway registered on the memnet network.
type testGW struct {
	*Gateway
	t      *testing.T
	name   string
	sink   *recSink
	routed atomic.Bool // memnet routes new dials here only while set (and Ready)
	cancel context.CancelFunc
	done   chan error
}

// gateway starts a gateway named name; mod may adjust the config.
func (e *env) gateway(name string, mod func(*Config)) *testGW {
	e.t.Helper()
	tg := &testGW{t: e.t, name: name, sink: &recSink{}, done: make(chan error, 1)}
	cfg := Config{
		InstanceID:  name,
		InternalURL: "http://" + name + ".internal:8080",
		Store:       e.store,
		Sink:        tg.sink,
		Timing:      fastTiming(),
		Logger:      testLogger().With("gw", name),
	}
	if mod != nil {
		mod(&cfg)
	}
	g, err := New(cfg)
	if err != nil {
		e.t.Fatalf("New: %v", err)
	}
	tg.Gateway = g
	tg.routed.Store(true)
	e.net.AddGateway(name, g.Admitter(), func() bool { return tg.routed.Load() && g.Ready() })
	ctx, cancel := context.WithCancel(context.Background())
	tg.cancel = cancel
	go func() { tg.done <- g.Run(ctx) }()
	e.t.Cleanup(tg.stop)
	eventually(e.t, waitTimeout, name+" ready", g.Ready)
	return tg
}

// waitEventsIdle waits until no connection event delivery is pending.
func (tg *testGW) waitEventsIdle() {
	tg.t.Helper()
	eventually(tg.t, waitTimeout, tg.name+" connection events delivered", func() bool {
		return tg.evPending.Load() == 0
	})
}

// stop cancels Run and waits for it to return.
func (tg *testGW) stop() {
	tg.cancel()
	select {
	case err := <-tg.done:
		if err != nil {
			tg.t.Errorf("%s: Run = %v", tg.name, err)
		}
	case <-time.After(waitTimeout):
		tg.t.Errorf("%s: Run did not return after cancel", tg.name)
	}
}

// machine creates credentials for a new machine and returns its id and BS.
func (e *env) machine() (string, []byte) {
	e.t.Helper()
	bs := make([]byte, wire.SecretLen)
	if _, err := rand.Read(bs); err != nil {
		e.t.Fatal(err)
	}
	id := uuid.NewString()
	if err := e.store.PutCredentials(context.Background(), id, wire.HashSecret(bs)); err != nil {
		e.t.Fatalf("PutCredentials: %v", err)
	}
	return id, bs
}

type staticCreds struct {
	id string
	bs []byte
}

func (c staticCreds) Bootstrap(context.Context) (string, []byte, error) { return c.id, c.bs, nil }

// testAgent is a running agent.Client.
type testAgent struct {
	t       *testing.T
	journal *journal.Mem
	events  chan agent.ConnEvent
	cancel  context.CancelFunc
	done    chan error
	once    sync.Once
}

// agentConfig returns an agent config with small timings and the given identity.
func agentConfig(e *env, id string, bs []byte, ident agent.Identity) agent.Config {
	return agent.Config{
		Dialer:      e.net.Dialer(),
		Credentials: staticCreds{id: id, bs: bs},
		Identity:    ident,
		Backoff:     agent.Backoff{First: 5 * time.Millisecond, Base: 10 * time.Millisecond, Max: 50 * time.Millisecond, ResetAfter: time.Minute},
		RejectDelays: agent.RejectDelays{
			BadBootstrap: 50 * time.Millisecond,
			Retired:      50 * time.Millisecond,
			Outdated:     50 * time.Millisecond,
		},
		DrainJitter:     5 * time.Millisecond,
		DrainCloseExtra: 5 * time.Second,
		Logger:          testLogger().With("agent", ident.InstanceID),
	}
}

func defaultIdentity() agent.Identity {
	return agent.Identity{BootID: "boot-1", InstanceID: "inst-" + uuid.NewString(), Vmgenid: "gen-1", Version: "1.5.0"}
}

// startAgent runs an agent with cfg. A nil Journal gets a fresh journal.Mem.
func (e *env) startAgent(cfg agent.Config) *testAgent {
	e.t.Helper()
	a := &testAgent{t: e.t, events: make(chan agent.ConnEvent, 256), done: make(chan error, 1)}
	if cfg.Journal == nil {
		a.journal = journal.New()
		cfg.Journal = a.journal
	} else if j, ok := cfg.Journal.(*journal.Mem); ok {
		a.journal = j
	}
	cfg.OnConnEvent = func(ev agent.ConnEvent) {
		select {
		case a.events <- ev:
		default:
		}
	}
	c, err := agent.New(cfg)
	if err != nil {
		e.t.Fatal(err)
	}
	ctx, cancel := context.WithCancel(context.Background())
	a.cancel = cancel
	go func() { a.done <- c.Run(ctx) }()
	e.t.Cleanup(a.stop)
	return a
}

func (a *testAgent) stop() {
	a.once.Do(func() {
		a.cancel()
		select {
		case err := <-a.done:
			if err != nil {
				a.t.Errorf("agent Run = %v", err)
			}
		case <-time.After(waitTimeout):
			a.t.Error("agent Run did not return after cancel")
		}
	})
}

// waitEvent returns the next connection event matching pred.
func (a *testAgent) waitEvent(what string, pred func(agent.ConnEvent) bool) agent.ConnEvent {
	a.t.Helper()
	timer := time.NewTimer(waitTimeout)
	defer timer.Stop()
	for {
		select {
		case ev := <-a.events:
			if pred(ev) {
				return ev
			}
		case <-timer.C:
			a.t.Fatalf("timed out waiting for agent event: %s", what)
			return agent.ConnEvent{}
		}
	}
}

func (a *testAgent) waitConnected() agent.ConnEvent {
	a.t.Helper()
	return a.waitEvent("connected", func(ev agent.ConnEvent) bool { return ev.Kind == agent.KindConnected })
}

func (a *testAgent) waitRejected(status int) agent.ConnEvent {
	a.t.Helper()
	return a.waitEvent("rejected", func(ev agent.ConnEvent) bool {
		return ev.Kind == agent.KindRejected && ev.Status == status
	})
}

// credentials reads the MT columns of a machine.
func (e *env) credentials(id string) (mt, next []byte) {
	e.t.Helper()
	err := e.pool.QueryRow(context.Background(),
		`SELECT mt_hash, mt_next_hash FROM tunnel.tunnel_credentials WHERE machine_id = $1`, id).Scan(&mt, &next)
	if err != nil {
		e.t.Fatalf("read credentials: %v", err)
	}
	return mt, next
}

func (e *env) session(id string) registry.Session {
	e.t.Helper()
	s, err := e.store.Session(context.Background(), id)
	if err != nil {
		e.t.Fatalf("Session: %v", err)
	}
	return s
}

// togglePool is a separate pool whose connections can be made to fail, to
// keep a gateway's LISTEN connection down.
type togglePool struct {
	pool *pgxpool.Pool
	down atomic.Bool
}

var errPoolDown = errors.New("test: database access disabled")

func (e *env) togglePool(appName string) *togglePool {
	e.t.Helper()
	cfg, err := pgxpool.ParseConfig(e.dsn)
	if err != nil {
		e.t.Fatal(err)
	}
	cfg.ConnConfig.RuntimeParams["application_name"] = appName
	tp := &togglePool{}
	cfg.PrepareConn = func(context.Context, *pgx.Conn) (bool, error) {
		if tp.down.Load() {
			return true, errPoolDown
		}
		return true, nil
	}
	tp.pool, err = pgxpool.NewWithConfig(context.Background(), cfg)
	if err != nil {
		e.t.Fatal(err)
	}
	e.t.Cleanup(tp.pool.Close)
	return tp
}

// onceDialer lets one dial through and refuses every later one with a long
// 503, so a second agent with the same machine id does not fight it.
type onceDialer struct {
	d    transport.Dialer
	used atomic.Bool
}

func (o *onceDialer) Dial(ctx context.Context, h transport.Hello) (net.Conn, transport.ConnInfo, error) {
	if o.used.Load() {
		return nil, transport.ConnInfo{}, &transport.RejectError{Status: 503, RetryAfter: time.Hour, Reason: "test: no more dials"}
	}
	c, info, err := o.d.Dial(ctx, h)
	if err == nil {
		o.used.Store(true)
	}
	return c, info, err
}

// startEcho listens on 127.0.0.1 and echoes; after the client half-closes it
// writes "|eof" and closes.
func startEcho(t *testing.T) uint16 {
	t.Helper()
	ln, err := net.ListenTCP("tcp", &net.TCPAddr{IP: net.IPv4(127, 0, 0, 1)})
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = ln.Close() })
	go func() {
		for {
			c, err := ln.AcceptTCP()
			if err != nil {
				return
			}
			go func() {
				defer func() { _ = c.Close() }()
				if _, err := io.Copy(c, c); err != nil {
					return
				}
				_, _ = io.WriteString(c, "|eof")
			}()
		}
	}()
	return uint16(ln.Addr().(*net.TCPAddr).Port) //nolint:gosec // a TCP port fits in uint16
}

// startBye listens on 127.0.0.1; every connection gets "bye" and is closed
// without reading.
func startBye(t *testing.T) uint16 {
	t.Helper()
	ln, err := net.ListenTCP("tcp", &net.TCPAddr{IP: net.IPv4(127, 0, 0, 1)})
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = ln.Close() })
	go func() {
		for {
			c, err := ln.AcceptTCP()
			if err != nil {
				return
			}
			_, _ = io.WriteString(c, "bye")
			_ = c.Close()
		}
	}()
	return uint16(ln.Addr().(*net.TCPAddr).Port) //nolint:gosec // a TCP port fits in uint16
}

// echo writes msg on c and expects it back.
func echo(t *testing.T, c net.Conn, msg string) {
	t.Helper()
	if _, err := io.WriteString(c, msg); err != nil {
		t.Fatalf("write: %v", err)
	}
	buf := make([]byte, len(msg))
	if _, err := io.ReadFull(c, buf); err != nil {
		t.Fatalf("read echo: %v", err)
	}
	if string(buf) != msg {
		t.Fatalf("echo = %q, want %q", buf, msg)
	}
}
