// Package agent is the agent side of the tunnel (S2 spec sections 4-7): it
// keeps one connection to a gateway, serves HTTP/2 on it (Control and Events
// services, CONNECT to local ports, and the embedding agent's handler), and
// reconnects with backoff, honouring the gateway's reject codes and drain
// requests.
package agent

import (
	"bytes"
	"context"
	"errors"
	"log/slog"
	"net"
	"net/http"
	"strings"
	"sync"
	"sync/atomic"
	"time"

	"connectrpc.com/connect"

	tunnelv1 "github.com/belov38/boat-dev-clone/libs/proto/sbx/tunnel/v1"
	"github.com/belov38/boat-dev-clone/libs/proto/sbx/tunnel/v1/tunnelv1connect"
	"github.com/belov38/boat-dev-clone/libs/tunnel/h2"
	"github.com/belov38/boat-dev-clone/libs/tunnel/transport"
)

// Identity is the per-process identity the agent reports in the handshake.
type Identity struct {
	BootID     string
	InstanceID string
	Vmgenid    string
	Version    string
}

// Credentials gives access to the machine id and bootstrap secret (BS).
type Credentials interface {
	// Bootstrap reads machineId and BS (smbios). Called at start and again after a 401 on BS.
	Bootstrap(ctx context.Context) (machineID string, bs []byte, err error)
}

// RejectDelays are the waits after specific upgrade refusals (spec 5.3).
// Zero fields take the defaults: 60s, 5m, 5m.
type RejectDelays struct {
	// BadBootstrap follows a 401 to the bootstrap secret.
	BadBootstrap time.Duration
	// Retired follows a 403 (machine retired).
	Retired time.Duration
	// Outdated follows a 426 (protocol or agent version not accepted).
	Outdated time.Duration
}

// ConnEvent kinds.
const (
	KindConnected    = "connected"
	KindDisconnected = "disconnected"
	KindRejected     = "rejected"
	KindDrain        = "drain"
)

// ConnEvent reports a connection change to Config.OnConnEvent.
type ConnEvent struct {
	// Kind is one of connected, disconnected, rejected (a failed dial; Status
	// is 0 for transport errors) and drain (the gateway asked to move).
	Kind    string
	ConnID  string
	Epoch   uint64
	Gateway string
	Auth    transport.AuthScheme
	Status  int
	Reason  string
	// TCPDeadline is the drain's tcp_deadline (Kind drain only).
	TCPDeadline time.Duration
}

// Config configures a Client. Zero durations take the spec defaults.
type Config struct {
	Dialer      transport.Dialer
	Credentials Credentials
	Identity    Identity
	// Handler serves everything that is not CONNECT or sbx.tunnel.v1:
	// sbx.agent.v1 and /files (S3). nil answers 404. Requests reach it only
	// over the tunnel, so the library does no authentication.
	Handler http.Handler
	// Info returns the Control/Info answer; nil uses defaults. sbx.tunnel.v1
	// is appended to proto_packages if missing.
	Info func(ctx context.Context) *tunnelv1.InfoResponse
	// Journal is the event journal served by Events; nil serves no events.
	Journal EventJournal
	// DialPolicy checks CONNECT targets; nil is LocalOnly().
	DialPolicy DialPolicy
	// Dial opens a CONNECT target after the policy check; nil dials
	// host:port over TCP with a 10s timeout.
	Dial         func(ctx context.Context, host string, port int) (net.Conn, error)
	Backoff      Backoff
	RejectDelays RejectDelays
	// DrainJitter bounds the random wait before dialing a replacement after
	// Drain (default 250ms).
	DrainJitter time.Duration
	// DrainCloseExtra is added to the drain tcp_deadline before the old
	// connection is closed (default 10s).
	DrainCloseExtra time.Duration
	// HTTP2 overrides the server parameters; zero fields take h2.DefaultServerConfig.
	HTTP2  h2.ServerConfig
	Logger *slog.Logger
	// OnConnEvent is an optional hook, called synchronously from the
	// client's goroutines (possibly concurrently) without internal locks held.
	OnConnEvent func(ConnEvent)
}

// Defaults (spec sections 5.3 and 7).
const (
	defaultBadBootstrap    = 60 * time.Second
	defaultRetired         = 5 * time.Minute
	defaultOutdated        = 5 * time.Minute
	defaultDrainJitter     = 250 * time.Millisecond
	defaultDrainCloseExtra = 10 * time.Second
	// dialTimeout bounds one transport dial and one Bootstrap call.
	dialTimeout = 30 * time.Second
	// maxMessageBytes is the Connect message limit (spec 4.3).
	maxMessageBytes = 16 << 20
)

// Client is the agent-side tunnel client. Create it with New and run it with Run.
type Client struct {
	cfg  Config
	log  *slog.Logger
	srv  *http.Server
	rand func(n time.Duration) time.Duration // uniform in [0, n]
	ran  atomic.Bool

	controlPath, eventsPath string
	control, events         http.Handler

	// drainCh carries an accepted drain to Run. It holds at most one request,
	// and only while replacing is true for the current conn.
	drainCh  chan drainRequest
	watchers sync.WaitGroup

	mu        sync.Mutex
	token     []byte // machine token, memory only; nil uses BS
	current   *tunnelConn
	replacing bool // a replacement for current is being dialed
	conns     map[*tunnelConn]struct{}
}

type drainRequest struct {
	conn     *tunnelConn
	deadline time.Duration
}

// New validates cfg and fills defaults.
func New(cfg Config) (*Client, error) {
	if cfg.Dialer == nil {
		return nil, errors.New("agent: Config.Dialer is required")
	}
	if cfg.Credentials == nil {
		return nil, errors.New("agent: Config.Credentials is required")
	}
	cfg.Backoff = cfg.Backoff.withDefaults()
	if cfg.RejectDelays.BadBootstrap <= 0 {
		cfg.RejectDelays.BadBootstrap = defaultBadBootstrap
	}
	if cfg.RejectDelays.Retired <= 0 {
		cfg.RejectDelays.Retired = defaultRetired
	}
	if cfg.RejectDelays.Outdated <= 0 {
		cfg.RejectDelays.Outdated = defaultOutdated
	}
	if cfg.DrainJitter <= 0 {
		cfg.DrainJitter = defaultDrainJitter
	}
	if cfg.DrainCloseExtra <= 0 {
		cfg.DrainCloseExtra = defaultDrainCloseExtra
	}
	cfg.HTTP2 = h2Defaults(cfg.HTTP2)
	if cfg.Journal == nil {
		cfg.Journal = emptyJournal{}
	}
	if cfg.DialPolicy == nil {
		cfg.DialPolicy = LocalOnly()
	}
	if cfg.Dial == nil {
		cfg.Dial = defaultDial
	}
	if cfg.Logger == nil {
		cfg.Logger = slog.Default()
	}

	c := &Client{
		cfg:     cfg,
		log:     cfg.Logger,
		rand:    randUpTo,
		drainCh: make(chan drainRequest, 1),
		conns:   map[*tunnelConn]struct{}{},
	}
	limit := []connect.HandlerOption{connect.WithReadMaxBytes(maxMessageBytes), connect.WithSendMaxBytes(maxMessageBytes)}
	c.controlPath, c.control = tunnelv1connect.NewControlHandler(controlService{c}, limit...)
	c.eventsPath, c.events = tunnelv1connect.NewEventsHandler(eventsService{cfg.Journal}, limit...)

	c.srv = h2.NewServer(http.HandlerFunc(c.route), cfg.HTTP2)
	c.srv.ErrorLog = slog.NewLogLogger(c.log.Handler(), slog.LevelDebug)
	c.srv.ConnContext = func(ctx context.Context, nc net.Conn) context.Context {
		if tc, ok := nc.(*tunnelConn); ok {
			return context.WithValue(ctx, connKey{}, tc)
		}
		return ctx
	}
	c.srv.ConnState = func(nc net.Conn, s http.ConnState) {
		if s != http.StateClosed && s != http.StateHijacked {
			return
		}
		if tc, ok := nc.(*tunnelConn); ok {
			tc.markDone()
		}
	}
	return c, nil
}

func h2Defaults(cfg h2.ServerConfig) h2.ServerConfig {
	d := h2.DefaultServerConfig()
	if cfg.MaxConcurrentStreams <= 0 {
		cfg.MaxConcurrentStreams = d.MaxConcurrentStreams
	}
	if cfg.StreamWindow <= 0 {
		cfg.StreamWindow = d.StreamWindow
	}
	if cfg.ConnWindow <= 0 {
		cfg.ConnWindow = d.ConnWindow
	}
	if cfg.MaxFrame <= 0 {
		cfg.MaxFrame = d.MaxFrame
	}
	return cfg
}

// route is the agent mux.
func (c *Client) route(w http.ResponseWriter, r *http.Request) {
	switch {
	case r.Method == http.MethodConnect:
		c.serveConnect(w, r)
	case strings.HasPrefix(r.URL.Path, c.controlPath):
		c.control.ServeHTTP(w, r)
	case strings.HasPrefix(r.URL.Path, c.eventsPath):
		c.events.ServeHTTP(w, r)
	case c.cfg.Handler != nil:
		c.cfg.Handler.ServeHTTP(w, r)
	default:
		http.NotFound(w, r)
	}
}

// Run keeps a tunnel connection up until ctx is done, then closes all
// connections and returns nil. It may be called only once.
func (c *Client) Run(ctx context.Context) error {
	if !c.ran.CompareAndSwap(false, true) {
		return errors.New("agent: Run called more than once")
	}
	ln := h2.New()
	serveDone := make(chan struct{})
	go func() {
		defer close(serveDone)
		_ = c.srv.Serve(ln)
	}()
	c.loop(ctx, ln)
	c.shutdown(ln, serveDone)
	return nil
}

// loop is the connection state machine. States: connected (cur set, no
// drain: wait for its end or a drain), dialing (cur nil), replacing (cur
// draining: dial a replacement while cur keeps serving).
func (c *Client) loop(ctx context.Context, ln *h2.ConnListener) {
	bo := c.cfg.Backoff
	bo.rand = c.rand
	var (
		machineID string
		bs        []byte // nil: Bootstrap must be (re)read
		cur       *tunnelConn
		drain     *drainRequest
		wait      = bo.Next()
	)
	for {
		if cur != nil && drain == nil {
			select {
			case <-ctx.Done():
				return
			case <-cur.done:
				if time.Since(cur.connectedAt) >= bo.ResetAfter {
					bo.Reset()
				}
				c.clearCurrent(cur)
				cur = nil
				wait = bo.Next()
			case d := <-c.drainCh:
				if d.conn != cur {
					c.endReplacing()
					continue
				}
				if time.Since(cur.connectedAt) >= bo.ResetAfter {
					bo.Reset()
				}
				drain = &d
				wait = c.rand(c.cfg.DrainJitter)
			}
			continue
		}

		// Dialing or replacing: wait, then make one attempt.
		var curDone <-chan struct{}
		if cur != nil {
			curDone = cur.done
		}
		until := time.Now().Add(wait)
		timer := time.NewTimer(wait)
		select {
		case <-ctx.Done():
			timer.Stop()
			return
		case <-curDone:
			// The draining conn died before its replacement was up: this is
			// now a plain reconnect, keeping the remaining wait.
			timer.Stop()
			c.clearCurrent(cur)
			cur, drain = nil, nil
			wait = max(time.Until(until), 0)
			continue
		case <-timer.C:
		}

		if bs == nil {
			id, secret, err := c.bootstrap(ctx)
			if err != nil {
				if ctx.Err() != nil {
					return
				}
				wait = bo.Next()
				c.log.Warn("tunnel: reading bootstrap credentials failed", "err", err, "retry_in", wait)
				continue
			}
			machineID, bs = id, secret
		}

		hello := c.hello(machineID, bs)
		dctx, cancel := context.WithTimeout(ctx, dialTimeout)
		raw, info, err := c.cfg.Dialer.Dial(dctx, hello)
		cancel()
		if ctx.Err() != nil {
			if err == nil {
				_ = raw.Close()
			}
			return
		}
		if err != nil {
			var reread bool
			wait, reread = c.dialFailed(err, hello, &bo)
			if reread {
				bs = nil
			}
			continue
		}

		var old *tunnelConn
		if drain != nil {
			old = cur
		}
		next := c.install(ln, raw, info, hello.Scheme)
		if old != nil {
			c.retire(old, drain.deadline+c.cfg.DrainCloseExtra)
		}
		cur, drain = next, nil
	}
}

func (c *Client) bootstrap(ctx context.Context) (string, []byte, error) {
	bctx, cancel := context.WithTimeout(ctx, dialTimeout)
	defer cancel()
	id, bs, err := c.cfg.Credentials.Bootstrap(bctx)
	if err == nil && (id == "" || len(bs) == 0) {
		err = errors.New("empty machine id or bootstrap secret")
	}
	return id, bs, err
}

// hello builds the handshake: Bearer MT if known, else the bootstrap secret.
func (c *Client) hello(machineID string, bs []byte) transport.Hello {
	h := transport.Hello{
		MachineID:       machineID,
		BootID:          c.cfg.Identity.BootID,
		AgentInstanceID: c.cfg.Identity.InstanceID,
		Vmgenid:         c.cfg.Identity.Vmgenid,
		AgentVersion:    c.cfg.Identity.Version,
		Scheme:          transport.AuthBootstrap,
		Secret:          bs,
	}
	c.mu.Lock()
	if c.token != nil {
		h.Scheme, h.Secret = transport.AuthToken, c.token
	}
	c.mu.Unlock()
	return h
}

// dialFailed logs and reports a failed attempt and returns the delay before
// the next one (spec 5.3) and whether the credentials must be re-read.
func (c *Client) dialFailed(err error, hello transport.Hello, bo *Backoff) (time.Duration, bool) {
	ev := ConnEvent{Kind: KindRejected, Auth: hello.Scheme, Reason: err.Error()}
	var rej *transport.RejectError
	if errors.As(err, &rej) {
		ev.Status = rej.Status
		if rej.Reason != "" {
			ev.Reason = rej.Reason
		}
	}
	var (
		wait   time.Duration
		reread bool
	)
	switch {
	case ev.Status == http.StatusUnauthorized && hello.Scheme == transport.AuthToken:
		c.dropToken(hello.Secret)
		wait = 0
	case ev.Status == http.StatusUnauthorized:
		reread = true
		wait = c.cfg.RejectDelays.BadBootstrap
	case ev.Status == http.StatusForbidden:
		wait = c.cfg.RejectDelays.Retired
	case ev.Status == http.StatusUpgradeRequired:
		wait = c.cfg.RejectDelays.Outdated
	case ev.Status == http.StatusServiceUnavailable && rej.RetryAfter > 0:
		wait = rej.RetryAfter + c.rand(rej.RetryAfter/5)
	default:
		wait = bo.Next()
	}
	c.log.Warn("tunnel: connection attempt failed", "status", ev.Status, "auth", authName(hello.Scheme),
		"reason", ev.Reason, "retry_in", wait)
	c.emit(ev)
	return wait, reread
}

// install hands an admitted connection to the HTTP/2 server and makes it current.
func (c *Client) install(ln *h2.ConnListener, raw net.Conn, info transport.ConnInfo, auth transport.AuthScheme) *tunnelConn {
	tc := &tunnelConn{Conn: raw, info: info, auth: auth, connectedAt: time.Now(), done: make(chan struct{})}
	c.mu.Lock()
	c.conns[tc] = struct{}{}
	c.current = tc
	c.replacing = false
	c.mu.Unlock()
	if err := ln.Push(tc); err != nil {
		tc.closeWith("listener closed")
		tc.markDone()
	}
	c.log.Info("tunnel: connected", "conn_id", info.ConnID, "epoch", info.Epoch,
		"gateway", info.GatewayInstance, "auth", authName(auth))
	c.emit(ConnEvent{Kind: KindConnected, ConnID: info.ConnID, Epoch: info.Epoch,
		Gateway: info.GatewayInstance, Auth: auth})
	c.watchers.Add(1)
	go c.watch(tc)
	return tc
}

// retire schedules the close of a drained connection.
func (c *Client) retire(tc *tunnelConn, after time.Duration) {
	c.mu.Lock()
	if _, live := c.conns[tc]; live {
		tc.retire = time.AfterFunc(after, func() { tc.closeWith("drain deadline") })
	}
	c.mu.Unlock()
	c.log.Info("tunnel: replacement up, retiring old connection", "conn_id", tc.info.ConnID,
		"epoch", tc.info.Epoch, "close_in", after, "reason", "drain")
}

// watch reports the end of a connection.
func (c *Client) watch(tc *tunnelConn) {
	defer c.watchers.Done()
	<-tc.done
	c.mu.Lock()
	delete(c.conns, tc)
	if tc.retire != nil {
		tc.retire.Stop()
	}
	c.mu.Unlock()
	reason := tc.closeReason()
	c.log.Info("tunnel: disconnected", "conn_id", tc.info.ConnID, "epoch", tc.info.Epoch,
		"gateway", tc.info.GatewayInstance, "reason", reason, "lived", time.Since(tc.connectedAt))
	c.emit(ConnEvent{Kind: KindDisconnected, ConnID: tc.info.ConnID, Epoch: tc.info.Epoch,
		Gateway: tc.info.GatewayInstance, Auth: tc.auth, Reason: reason})
}

func (c *Client) shutdown(ln *h2.ConnListener, serveDone <-chan struct{}) {
	_ = ln.Close()
	c.mu.Lock()
	conns := make([]*tunnelConn, 0, len(c.conns))
	for tc := range c.conns {
		conns = append(conns, tc)
		if tc.retire != nil {
			tc.retire.Stop()
		}
	}
	c.current = nil
	c.mu.Unlock()
	for _, tc := range conns {
		tc.closeWith("shutdown")
	}
	_ = c.srv.Close()
	<-serveDone
	c.watchers.Wait()
}

// clearCurrent forgets tc as the current conn (it ended) and any pending drain.
func (c *Client) clearCurrent(tc *tunnelConn) {
	c.mu.Lock()
	defer c.mu.Unlock()
	if c.current != tc {
		return
	}
	c.current = nil
	c.replacing = false
	select {
	case <-c.drainCh:
	default:
	}
}

func (c *Client) endReplacing() {
	c.mu.Lock()
	c.replacing = false
	c.mu.Unlock()
}

func (c *Client) setToken(tok []byte) {
	c.mu.Lock()
	c.token = bytes.Clone(tok)
	c.mu.Unlock()
	c.log.Info("tunnel: machine token updated")
}

// dropToken forgets the MT after a 401, unless it was replaced meanwhile.
func (c *Client) dropToken(used []byte) {
	c.mu.Lock()
	defer c.mu.Unlock()
	if bytes.Equal(c.token, used) {
		c.token = nil
	}
}

// requestDrain starts make-before-break if tc is the current conn and no
// replacement is in progress; otherwise the drain is a no-op.
func (c *Client) requestDrain(tc *tunnelConn, reason string, deadline time.Duration) {
	if tc == nil {
		return
	}
	c.mu.Lock()
	accept := tc == c.current && !c.replacing && !tc.isDone()
	if accept {
		select {
		case c.drainCh <- drainRequest{conn: tc, deadline: deadline}:
			c.replacing = true
		default:
			accept = false
		}
	}
	c.mu.Unlock()
	if !accept {
		c.log.Debug("tunnel: drain ignored", "conn_id", tc.info.ConnID, "epoch", tc.info.Epoch, "reason", reason)
		return
	}
	c.log.Info("tunnel: drain requested", "conn_id", tc.info.ConnID, "epoch", tc.info.Epoch,
		"gateway", tc.info.GatewayInstance, "reason", reason, "tcp_deadline", deadline)
	c.emit(ConnEvent{Kind: KindDrain, ConnID: tc.info.ConnID, Epoch: tc.info.Epoch,
		Gateway: tc.info.GatewayInstance, Auth: tc.auth, Reason: reason, TCPDeadline: deadline})
}

func (c *Client) emit(ev ConnEvent) {
	if c.cfg.OnConnEvent != nil {
		c.cfg.OnConnEvent(ev)
	}
}

func authName(s transport.AuthScheme) string {
	if s == transport.AuthToken {
		return "token"
	}
	return "bootstrap"
}

// tunnelConn is one tunnel connection as seen by the HTTP/2 server.
type tunnelConn struct {
	net.Conn
	info        transport.ConnInfo
	auth        transport.AuthScheme
	connectedAt time.Time

	done     chan struct{} // closed when the server is done with the conn
	doneOnce sync.Once
	reason   atomic.Pointer[string] // first local close reason
	retire   *time.Timer            // guarded by Client.mu
}

func (tc *tunnelConn) closeWith(reason string) {
	tc.reason.CompareAndSwap(nil, &reason)
	_ = tc.Close()
}

func (tc *tunnelConn) closeReason() string {
	if r := tc.reason.Load(); r != nil {
		return *r
	}
	return "closed by peer or transport"
}

func (tc *tunnelConn) markDone() { tc.doneOnce.Do(func() { close(tc.done) }) }

func (tc *tunnelConn) isDone() bool {
	select {
	case <-tc.done:
		return true
	default:
		return false
	}
}

type connKey struct{}

// connFromContext returns the tunnel conn a request arrived on.
func connFromContext(ctx context.Context) *tunnelConn {
	tc, _ := ctx.Value(connKey{}).(*tunnelConn)
	return tc
}
