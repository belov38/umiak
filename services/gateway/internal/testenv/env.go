// Package testenv is the gateway test harness: a fresh Postgres database,
// an in-memory tunnel network, a fake control plane, a throw-away PKI and
// keys, gateway instances on 127.0.0.1 and machines with real local apps.
// Tests that use it need TestMain(m) { pgtest.Main(m) }.
package testenv

import (
	"bytes"
	"context"
	"crypto/rand"
	"crypto/tls"
	"encoding/hex"
	"fmt"
	"log/slog"
	"net"
	"net/http"
	"net/http/cookiejar"
	"os"
	"slices"
	"strings"
	"sync"
	"sync/atomic"
	"testing"
	"time"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5/pgxpool"
	"golang.org/x/crypto/ssh"

	"github.com/belov38/boat-dev-clone/libs/tunnel/gateway"
	"github.com/belov38/boat-dev-clone/libs/tunnel/registry"
	"github.com/belov38/boat-dev-clone/libs/tunnel/tunneltest/memnet"
	"github.com/belov38/boat-dev-clone/libs/tunnel/tunneltest/pgtest"
	"github.com/belov38/boat-dev-clone/libs/tunnel/wire"
	"github.com/belov38/boat-dev-clone/services/gateway/internal/config"
	"github.com/belov38/boat-dev-clone/services/gateway/internal/cpapi"
	"github.com/belov38/boat-dev-clone/services/gateway/internal/cpapi/cpapitest"
	"github.com/belov38/boat-dev-clone/services/gateway/internal/ratelimit"
	"github.com/belov38/boat-dev-clone/services/gateway/internal/server"
)

// Names and tokens of the test platform.
const (
	SbxDomain  = "sbx.test"
	TunnelHost = "tunnel.test"
	SSHHost    = "ssh.test"

	APIToken    = "test-api-token"
	WorkerToken = "test-worker-token"
	PeerToken   = "test-gateway-token"

	// WaitTimeout bounds every wait of the harness.
	WaitTimeout = 30 * time.Second
	// DeadAfter is the memnet liveness timeout of a stalled link (WS 15 s).
	DeadAfter = 300 * time.Millisecond
)

// FastTiming is the shrunk tunnel timing of every instance (spec values in
// gateway.Timing). TCPDeadline is replaced by the config's SSHDrainDeadline.
func FastTiming() gateway.Timing {
	return gateway.Timing{
		Heartbeat:          200 * time.Millisecond,
		StaleAfter:         time.Second,
		Sweep:              200 * time.Millisecond,
		EndpointWait:       100 * time.Millisecond,
		DrainSpread:        100 * time.Millisecond,
		DrainMargin:        time.Second,
		DrainRetryAfter:    100 * time.Millisecond,
		TokenMaxAge:        time.Hour,
		EventBatchMax:      500,
		EventBatchInterval: 50 * time.Millisecond,
		EventRetryMin:      10 * time.Millisecond,
		EventRetryMax:      50 * time.Millisecond,
	}
}

// Options configure an Env.
type Options struct {
	// Timing changes FastTiming for every instance of the Env.
	Timing func(*gateway.Timing)
	// Deps changes the dependencies of every instance of the Env.
	Deps func(*server.Deps)
}

// Env is one test platform.
type Env struct {
	T     testing.TB
	Pool  *pgxpool.Pool
	DSN   string
	Store *registry.Store
	Net   *memnet.Network
	API   *cpapitest.Fake
	PKI   *PKI
	Keys  *Keys
	// Timing is the tunnel timing given to every instance.
	Timing gateway.Timing

	depsMod func(*server.Deps)

	mu    sync.Mutex
	seq   int
	insts []*Inst
}

// New creates the platform. Everything is torn down by t.Cleanup.
func New(t testing.TB, opts Options) *Env {
	t.Helper()
	pool, dsn := pgtest.New(t)
	p, err := newPKI(t.TempDir())
	if err != nil {
		t.Fatalf("testenv: PKI: %v", err)
	}
	keys, err := newKeys()
	if err != nil {
		t.Fatalf("testenv: keys: %v", err)
	}
	timing := FastTiming()
	if opts.Timing != nil {
		opts.Timing(&timing)
	}
	e := &Env{
		T:       t,
		Pool:    pool,
		DSN:     dsn,
		Store:   registry.New(pool),
		Net:     memnet.New(memnet.Options{DeadAfter: DeadAfter}),
		API:     cpapitest.NewFake(),
		PKI:     p,
		Keys:    keys,
		Timing:  timing,
		depsMod: opts.Deps,
	}
	return e
}

// refusedAddr is dialed for a port without an app: nothing listens on
// 127.0.0.1:1, so the dial fails with a real ECONNREFUSED.
const refusedAddr = "127.0.0.1:1"

// Logger returns a discarding logger, or a debug logger on stderr when
// SBX_TEST_LOG is set.
func Logger(args ...any) *slog.Logger {
	if os.Getenv("SBX_TEST_LOG") != "" {
		return slog.New(slog.NewTextHandler(os.Stderr, &slog.HandlerOptions{Level: slog.LevelDebug})).With(args...)
	}
	return slog.New(slog.DiscardHandler)
}

// InstanceConfig returns the test configuration of an instance. Listen
// addresses are informational: StartInstance opens the sockets itself.
func (e *Env) InstanceConfig(instanceID, internalURL string) config.Config {
	return config.Config{
		InstanceID:     instanceID,
		DatabaseURL:    e.DSN,
		InternalListen: "127.0.0.1:0",
		InternalURL:    internalURL,
		ServiceTokens: gateway.TokenSet{
			"api":     {APIToken},
			"worker":  {WorkerToken},
			"gateway": {PeerToken},
		},
		PeerToken: PeerToken,

		HTTPListen:    "127.0.0.1:0",
		MetricsListen: "127.0.0.1:0",
		SSHListen:     "127.0.0.1:0",

		SbxDomain:  SbxDomain,
		TunnelHost: TunnelHost,
		SSHHost:    SSHHost,

		SbxCertFile:    e.PKI.SbxCertFile,
		SbxKeyFile:     e.PKI.SbxKeyFile,
		TunnelCertFile: e.PKI.TunnelCertFile,
		TunnelKeyFile:  e.PKI.TunnelKeyFile,

		APIToken: APIToken,
		AuthURL:  "https://app.test/sso/authorize",

		CookieKeys:          []config.CookieKey{e.Keys.Cookie},
		StripCookiePrefixes: []string{"_oauth2_proxy", "__Host-oauth2_proxy", "__Secure-oauth2_proxy"},

		SSHHostKeys:    []ssh.Signer{e.Keys.SSHHost},
		SSHUserCA:      e.Keys.UserCA,
		SSHLoginCAKeys: []ssh.PublicKey{e.Keys.LoginCA.PublicKey()},

		ReservedPorts:    []int{22, 47800, 47984, 47989, 47990, 48010},
		ReservedSuffixes: []string{"desktop"},
		ReservedSlugs:    []string{"api", "app", "www", "ssh", "tunnel", "admin", "static", "sbx"},

		RateLimit: ratelimit.Config{
			IPRate: 300, IPBurst: 2000, LabelRate: 1000, LabelBurst: 3000,
			AuthFailPerMin: 20, AuthBlock: 5 * time.Minute, ConnsPerIP: 512, TunnelConnsPerIP: 512,
			SSHConnPerMin: 10, SSHConnBurst: 20, SSHAuthFailPerMin: 10, SSHSessionsPerUser: 20,
		},

		HTTPDrainDeadline: time.Second,
		SSHDrainDeadline:  2 * time.Second,

		Timeouts: config.Timeouts{
			TLSHandshake:   2 * time.Second,
			ReadHeader:     2 * time.Second,
			MaxHeaderBytes: 64 << 10,
			ClientIdle:     10 * time.Second,
			RouteLookup:    time.Second,
			AgentWait:      2 * time.Second,
			Dial:           5 * time.Second,
			ResponseHeader: 10 * time.Second,
			StreamIdle:     time.Minute,
		},

		TunnelAdmitRate:  1000,
		TunnelAdmitBurst: 1000,

		LogLevel: "debug",
	}
}

// Deps returns the dependencies of an instance on this Env.
func (e *Env) Deps() server.Deps {
	d := server.Deps{
		Pool:      e.Pool,
		API:       e.API,
		Logger:    Logger(),
		AccessLog: &LogBuffer{},
		Now:       time.Now,
		Timing:    e.Timing,
	}
	if e.depsMod != nil {
		e.depsMod(&d)
	}
	return d
}

// Inst is a running instance.
type Inst struct {
	*server.Instance
	Name        string
	InternalURL string
	HTTPSAddr   string
	PlainAddr   string
	SSHAddr     string // empty when the config disables SSH
	MetricsURL  string
	Config      config.Config
	AccessLog   *LogBuffer

	internalH2 atomic.Int64

	e        *Env
	routed   atomic.Bool
	cancel   context.CancelFunc
	runErr   chan error
	stopOnce sync.Once
}

// StartInstance starts an instance on 127.0.0.1 (internal, metrics, plain,
// TLS and, unless the config's SSHListen is empty, SSH listeners) and waits
// until it is ready; mod may change the config. The instance is registered
// in memnet under its InstanceID while it is Ready (and routed, see
// RouteOnly).
func (e *Env) StartInstance(mod func(*config.Config)) *Inst {
	e.T.Helper()
	e.mu.Lock()
	e.seq++
	name := fmt.Sprintf("gw-%d", e.seq)
	e.mu.Unlock()

	internal := e.listen()
	metrics := e.listen()
	plain := e.listen()
	tlsLn := e.listen()
	cfg := e.InstanceConfig(name, "http://"+internal.Addr().String())
	if mod != nil {
		mod(&cfg)
	}
	var sshLn net.Listener
	if cfg.SSHListen != "" {
		sshLn = e.listen()
	}
	deps := e.Deps()
	alog := deps.AccessLog.(*LogBuffer)
	deps.Logger = Logger("gw", cfg.InstanceID)
	inst, err := server.New(cfg, deps)
	if err != nil {
		for _, ln := range []net.Listener{internal, metrics, plain, tlsLn, sshLn} {
			if ln != nil {
				_ = ln.Close()
			}
		}
		e.T.Fatalf("testenv: server.New: %v", err)
	}

	i := &Inst{
		Instance:    inst,
		Name:        cfg.InstanceID,
		InternalURL: cfg.InternalURL,
		HTTPSAddr:   tlsLn.Addr().String(),
		PlainAddr:   plain.Addr().String(),
		MetricsURL:  "http://" + metrics.Addr().String(),
		Config:      cfg,
		AccessLog:   alog,
		e:           e,
		runErr:      make(chan error, 1),
	}
	if sshLn != nil {
		i.SSHAddr = sshLn.Addr().String()
	}
	ctx, cancel := context.WithCancel(context.Background())
	i.cancel = cancel
	internal = &h2CountingListener{Listener: internal, n: &i.internalH2}
	go func() {
		i.runErr <- inst.Run(ctx, server.Listeners{Internal: internal, Metrics: metrics, Plain: plain, TLS: tlsLn, SSH: sshLn})
	}()
	e.T.Cleanup(func() { e.StopInstance(i, false) })

	deadline := time.Now().Add(WaitTimeout)
	for !inst.Ready() || !inst.ListenStarted() {
		if time.Now().After(deadline) {
			e.T.Fatalf("testenv: %s not ready after %s", i.Name, WaitTimeout)
		}
		time.Sleep(5 * time.Millisecond)
	}
	i.routed.Store(true)
	e.Net.AddGateway(i.Name, inst.Tunnel().Admitter(), func() bool { return i.routed.Load() && inst.Ready() })
	e.mu.Lock()
	e.insts = append(e.insts, i)
	e.mu.Unlock()
	return i
}

func (e *Env) listen() net.Listener {
	e.T.Helper()
	ln, err := (&net.ListenConfig{}).Listen(context.Background(), "tcp", "127.0.0.1:0")
	if err != nil {
		e.T.Fatalf("testenv: listen: %v", err)
	}
	return ln
}

// StopInstance stops an instance and removes it from memnet. graceful
// drains it first (the tunnel drain, then a graceful shutdown of the
// internal listener); otherwise Run is cancelled, which closes its sessions.
// Repeated calls do nothing.
func (e *Env) StopInstance(i *Inst, graceful bool) {
	i.stopOnce.Do(func() {
		e.Net.RemoveGateway(i.Name)
		e.mu.Lock()
		e.insts = slices.DeleteFunc(e.insts, func(x *Inst) bool { return x == i })
		e.mu.Unlock()
		if graceful {
			ctx, cancel := context.WithTimeout(context.Background(), WaitTimeout)
			if err := i.Drain(ctx); err != nil {
				e.T.Errorf("testenv: %s: Drain = %v", i.Name, err)
			}
			cancel()
		}
		i.cancel()
		select {
		case err := <-i.runErr:
			if err != nil {
				e.T.Errorf("testenv: %s: Run = %v", i.Name, err)
			}
		case <-time.After(WaitTimeout):
			e.T.Errorf("testenv: %s: Run did not return", i.Name)
		}
	})
}

// InternalH2Conns returns how many HTTP/2 conns the internal listener of i
// has accepted: peer conns of other instances (and h2c internal API
// clients). Conns that do not start with the HTTP/2 preface, such as port
// probes of other local processes, are not counted.
func (i *Inst) InternalH2Conns() int64 { return i.internalH2.Load() }

// h2Preface starts every prior-knowledge HTTP/2 conn.
const h2Preface = "PRI * HTTP/2.0\r\n"

// h2CountingListener counts accepted conns that start with the HTTP/2
// preface.
type h2CountingListener struct {
	net.Listener
	n *atomic.Int64
}

func (l *h2CountingListener) Accept() (net.Conn, error) {
	c, err := l.Listener.Accept()
	if err != nil {
		return nil, err
	}
	return &prefaceConn{Conn: c, n: l.n}, nil
}

// prefaceConn checks the first bytes read for the HTTP/2 preface.
type prefaceConn struct {
	net.Conn
	n    *atomic.Int64
	seen []byte
	done bool
}

// The preface is read on the server goroutine of the conn before any other
// reader of the conn starts.
func (c *prefaceConn) Read(b []byte) (int, error) {
	n, err := c.Conn.Read(b)
	if !c.done && n > 0 {
		c.seen = append(c.seen, b[:min(n, len(h2Preface)-len(c.seen))]...)
		if len(c.seen) == len(h2Preface) || !strings.HasPrefix(h2Preface, string(c.seen)) {
			c.done = true
			if string(c.seen) == h2Preface {
				c.n.Add(1)
			}
			c.seen = nil
		}
	}
	return n, err
}

// Instances returns the running instances, oldest first.
func (e *Env) Instances() []*Inst {
	e.mu.Lock()
	defer e.mu.Unlock()
	return slices.Clone(e.insts)
}

func (e *Env) byName(name string) *Inst {
	e.mu.Lock()
	defer e.mu.Unlock()
	for _, i := range e.insts {
		if i.Name == name {
			return i
		}
	}
	return nil
}

// RouteOnly makes memnet send new agent dials only to the given instances;
// with none, to all of them again.
func (e *Env) RouteOnly(insts ...*Inst) {
	for _, x := range e.Instances() {
		x.routed.Store(len(insts) == 0 || slices.Contains(insts, x))
	}
}

// Route registers a route to port of m in the fake control plane and
// returns it. Defaults: a random slug, public, ready, hostRewrite preserve,
// http1. m may be nil (no machine). mod may change the route; the label is
// recomputed if mod changed the slug or the port but not the label.
func (e *Env) Route(m *Machine, port uint16, mod func(*cpapi.Route)) cpapi.Route {
	slug := "s" + randHex(6)
	r := cpapi.Route{
		Label:        fmt.Sprintf("%s-%d", slug, port),
		SandboxID:    "sbx_" + randHex(8),
		Slug:         slug,
		Port:         port,
		SandboxState: "ready",
		Access:       "public",
		AuthEpoch:    1,
		HostRewrite:  "preserve",
		AppProtocol:  "http1",
		TeamID:       "team_test",
		Kind:         cpapi.KindPort,
	}
	if m != nil {
		r.MachineID = m.ID
	}
	def := r.Label
	if mod != nil {
		mod(&r)
	}
	if r.Label == def {
		r.Label = fmt.Sprintf("%s-%d", r.Slug, r.Port)
	}
	e.API.SetRoute(r)
	return r
}

// Host returns the sbx host name of a route label.
func Host(label string) string { return label + "." + SbxDomain }

// NotifyRoutes sends pg_notify('sbx_routes', payload).
func (e *Env) NotifyRoutes(payload string) {
	e.T.Helper()
	e.notify(server.ChannelRoutes, payload)
}

// Notify sends pg_notify(channel, payload).
func (e *Env) Notify(channel, payload string) {
	e.T.Helper()
	e.notify(channel, payload)
}

func (e *Env) notify(channel, payload string) {
	e.T.Helper()
	if _, err := e.Pool.Exec(context.Background(), `SELECT pg_notify($1, $2)`, channel, payload); err != nil {
		e.T.Fatalf("testenv: pg_notify %s: %v", channel, err)
	}
}

// PlainClient returns an HTTP/1 client that sends every request to the
// plain listener of i, whatever the URL's host. It follows no redirects and
// has no cookie jar.
func (e *Env) PlainClient(i *Inst) *http.Client {
	tr := &http.Transport{
		DialContext: func(ctx context.Context, network, _ string) (net.Conn, error) {
			return (&net.Dialer{}).DialContext(ctx, network, i.PlainAddr)
		},
		DisableCompression: true,
	}
	e.T.Cleanup(tr.CloseIdleConnections)
	return &http.Client{
		Transport:     tr,
		CheckRedirect: func(*http.Request, []*http.Request) error { return http.ErrUseLastResponse },
	}
}

// HTTPClient returns a client that sends every request to the TLS listener
// of i, whatever the URL's host; the SNI is the URL's host. It trusts
// PKI.Roots, speaks HTTP/2 when h2 is set (HTTP/1.1 otherwise), follows no
// redirects and has no cookie jar.
func (e *Env) HTTPClient(i *Inst, h2 bool) *http.Client {
	var p http.Protocols
	p.SetHTTP1(true)
	p.SetHTTP2(h2)
	tr := &http.Transport{
		DialContext: func(ctx context.Context, network, _ string) (net.Conn, error) {
			return (&net.Dialer{}).DialContext(ctx, network, i.HTTPSAddr)
		},
		TLSClientConfig:    &tls.Config{RootCAs: e.PKI.Roots, MinVersion: tls.VersionTLS12},
		ForceAttemptHTTP2:  h2,
		Protocols:          &p,
		DisableCompression: true,
	}
	e.T.Cleanup(tr.CloseIdleConnections)
	return &http.Client{
		Transport:     tr,
		CheckRedirect: func(*http.Request, []*http.Request) error { return http.ErrUseLastResponse },
	}
}

// TLSDial opens a TLS conn to the TLS listener of i with the SNI sni and the
// ALPN protocols alpn, verified against PKI.Roots. The caller closes it.
func (e *Env) TLSDial(i *Inst, sni string, alpn ...string) (*tls.Conn, error) {
	ctx, cancel := context.WithTimeout(context.Background(), WaitTimeout)
	defer cancel()
	d := &tls.Dialer{Config: &tls.Config{ServerName: sni, RootCAs: e.PKI.Roots, NextProtos: alpn, MinVersion: tls.VersionTLS12}}
	c, err := d.DialContext(ctx, "tcp", i.HTTPSAddr)
	if err != nil {
		return nil, err
	}
	return c.(*tls.Conn), nil
}

// NewCredentials registers bootstrap credentials of a new machine without
// starting an agent, for tests that speak the tunnel upgrade themselves.
func (e *Env) NewCredentials() (machineID string, bootstrapSecret []byte) {
	e.T.Helper()
	bs, err := wire.NewSecret()
	if err != nil {
		e.T.Fatal(err)
	}
	id := uuid.NewString()
	if err := e.Store.PutCredentials(context.Background(), id, wire.HashSecret(bs)); err != nil {
		e.T.Fatalf("testenv: PutCredentials: %v", err)
	}
	return id, bs
}

// Jar returns an empty cookie jar.
func (e *Env) Jar() http.CookieJar {
	j, err := cookiejar.New(nil)
	if err != nil {
		e.T.Fatal(err)
	}
	return j
}

// LogBuffer is a concurrency-safe in-memory log.
type LogBuffer struct {
	mu  sync.Mutex
	buf bytes.Buffer
}

func (b *LogBuffer) Write(p []byte) (int, error) {
	b.mu.Lock()
	defer b.mu.Unlock()
	return b.buf.Write(p)
}

// String returns everything written so far.
func (b *LogBuffer) String() string {
	b.mu.Lock()
	defer b.mu.Unlock()
	return b.buf.String()
}

func randHex(n int) string {
	b := make([]byte, n)
	if _, err := rand.Read(b); err != nil {
		panic(err)
	}
	return hex.EncodeToString(b)
}
