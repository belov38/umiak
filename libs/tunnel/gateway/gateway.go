// Package gateway is the gateway side of the tunnel (S2 spec sections 5, 7,
// 8 and 9.6): it admits agent connections, runs an HTTP/2 client on each of
// them, keeps the registry up to date (instance heartbeat, sweep of dead
// instances), fences sessions that moved to another instance, rotates
// machine tokens and pumps agent events to the control plane.
//
// The S4 gateway binary embeds this package: it puts Admitter behind the
// WebSocket handler, serves the internal listener and calls Run.
package gateway

import (
	"context"
	"errors"
	"log/slog"
	"sync"
	"sync/atomic"
	"time"

	tunnelv1 "github.com/belov38/boat-dev-clone/libs/proto/sbx/tunnel/v1"
	"github.com/belov38/boat-dev-clone/libs/tunnel/h2"
	"github.com/belov38/boat-dev-clone/libs/tunnel/registry"
	"github.com/belov38/boat-dev-clone/libs/tunnel/transport"
	"github.com/belov38/boat-dev-clone/libs/tunnel/wire"
)

// Timing holds the gateway timings. Zero fields take the spec defaults.
type Timing struct {
	// Heartbeat is the instance heartbeat period (5 s).
	Heartbeat time.Duration
	// StaleAfter is the heartbeat age after which an instance is dead (15 s).
	StaleAfter time.Duration
	// Sweep is the period of the stale instance sweep (5 s).
	Sweep time.Duration
	// EndpointWait is how long a draining instance waits to leave the ingress endpoints (5 s).
	EndpointWait time.Duration
	// DrainSpread spreads Control/Drain calls over this window (5 s).
	DrainSpread time.Duration
	// TCPDeadline is the default per-stream drain deadline of TCP streams (2 min).
	TCPDeadline time.Duration
	// MaxTCPDrainDeadline caps a caller-chosen drain deadline of a TCP
	// stream (Sbx-Tcp-Drain-Deadline-Ms, TCPOptions.DrainDeadline) (15 min).
	MaxTCPDrainDeadline time.Duration
	// DrainMargin is added to the overall wait of Drain (10 s): EndpointWait
	// + DrainSpread + the longest TCP drain deadline + DrainMargin.
	DrainMargin time.Duration
	// DrainRetryAfter is the Retry-After of the 503 answered while draining (1 s).
	DrainRetryAfter time.Duration
	// TokenMaxAge is the machine token lifetime before rotation (24 h).
	TokenMaxAge time.Duration
	// EventBatchMax is the largest event batch sent to the sink (500).
	EventBatchMax int
	// EventBatchMaxBytes caps the summed proto size of the events of one
	// batch (4 MiB): a batch is sent before an event that would exceed it is
	// added, so one larger event forms a batch alone.
	EventBatchMaxBytes int
	// MaxEventBytes is the largest Events/Subscribe message the gateway reads
	// (1 MiB, plus a small envelope allowance). A larger one ends the stream;
	// the pump resubscribes with its backoff. Agents replace such events
	// with an sbx.tunnel.event_too_large stub before sending. The agents'
	// agent.Config.MaxEventBytes must not exceed it: an event between the
	// two sizes would end the stream at every resubscribe and stall the
	// machine's events.
	MaxEventBytes int
	// EventBatchInterval is the longest a batch waits after its first event (1 s).
	EventBatchInterval time.Duration
	// EventRetryMin and EventRetryMax bound the backoff of failed sink
	// deliveries (1 s, 30 s).
	EventRetryMin, EventRetryMax time.Duration
}

func (t Timing) withDefaults() Timing {
	def := func(v *time.Duration, d time.Duration) {
		if *v <= 0 {
			*v = d
		}
	}
	def(&t.Heartbeat, 5*time.Second)
	def(&t.StaleAfter, 15*time.Second)
	def(&t.Sweep, 5*time.Second)
	def(&t.EndpointWait, 5*time.Second)
	def(&t.DrainSpread, 5*time.Second)
	def(&t.TCPDeadline, 2*time.Minute)
	def(&t.MaxTCPDrainDeadline, 15*time.Minute)
	def(&t.DrainMargin, 10*time.Second)
	def(&t.DrainRetryAfter, time.Second)
	def(&t.TokenMaxAge, 24*time.Hour)
	def(&t.EventBatchInterval, time.Second)
	def(&t.EventRetryMin, time.Second)
	def(&t.EventRetryMax, 30*time.Second)
	if t.EventBatchMax <= 0 {
		t.EventBatchMax = 500
	}
	if t.EventBatchMaxBytes <= 0 {
		t.EventBatchMaxBytes = 4 << 20
	}
	if t.MaxEventBytes <= 0 {
		t.MaxEventBytes = 1 << 20
	}
	t.EventRetryMax = max(t.EventRetryMax, t.EventRetryMin)
	t.MaxTCPDrainDeadline = max(t.MaxTCPDrainDeadline, t.TCPDeadline)
	return t
}

// TokenSet maps a caller name (api, worker, gateway) to its valid service
// tokens; up to two per caller so tokens can be rotated without downtime.
type TokenSet map[string][]string

// Config configures a Gateway.
type Config struct {
	// InstanceID identifies this gateway instance in the registry (pod name + start uuid).
	InstanceID string
	// InternalURL is the pod's internal listener URL, http://<podIP>:<port>.
	InternalURL string
	Store       *registry.Store
	// ServiceTokens authenticate callers of the internal listener.
	ServiceTokens TokenSet
	// Sink receives agent and connection events; nil logs and drops them
	// and acknowledges agent events at once.
	Sink EventSink
	// MinAgentVersion is the minimum agent version ("" = none); lower or
	// unparsable versions get 426.
	MinAgentVersion string
	// AllowedServicePrefixes are the services the /rpc/ proxy passes
	// (default [wire.ServicePrefixAgent]); sbx.tunnel.v1. is always refused.
	AllowedServicePrefixes []string
	// MaxTCPStreamsPerMachine caps concurrent CONNECT streams per machine (800).
	MaxTCPStreamsPerMachine int
	// OnInstanceChange is called for every NOTIFY on gateway_instances with
	// the instance id, and with "" after the LISTEN connection is
	// (re)established. Calls are sequential, from a gateway goroutine.
	OnInstanceChange func(instanceID string)
	Timing           Timing
	// HTTP2 sets the client parameters on agent connections; zero fields
	// take h2.DefaultClientConfig.
	HTTP2  h2.ClientConfig
	Logger *slog.Logger
}

// Defaults.
const (
	defaultMaxTCPStreams = 800
	// infoTimeout bounds the Control/Info call after connect.
	infoTimeout = 10 * time.Second
	// dbTimeout bounds one registry call made in the background.
	dbTimeout = 5 * time.Second
	// fenceRetry is the wait before re-checking a machine after a registry error.
	fenceRetry = time.Second
	// shutdownEventGrace bounds how long Run waits for pending connection
	// event deliveries before dropping them.
	shutdownEventGrace = 2 * time.Second
)

// Errors.
var (
	// ErrTooManyStreams means the machine already has MaxTCPStreamsPerMachine TCP streams.
	ErrTooManyStreams = errors.New("gateway: too many tcp streams for this machine")
	// ErrMachineMoved is the cause of requests aborted or refused because
	// the machine moved to another gateway instance while this one was draining.
	ErrMachineMoved = errors.New("gateway: machine moved to another instance")
	// ErrSessionClosed is returned for requests on a closed session.
	ErrSessionClosed = errors.New("gateway: tunnel session closed")
)

// Gateway is one gateway instance. Create it with New and run it with Run.
type Gateway struct {
	cfg   Config
	log   *slog.Logger
	store *registry.Store
	sink  EventSink

	started   atomic.Bool
	running   atomic.Bool // registered and serving: Run is between start and shutdown
	draining  atomic.Bool // set by Drain: Ready false, admission 503
	abandoned atomic.Bool

	// Drain state, see drain.go.
	drainStarted atomic.Bool
	drainDone    chan struct{} // closed when the first Drain call finished
	drainErr     error         // result of the first Drain call, set before drainDone closes
	drainedCh    chan struct{} // closed by Drain to make Run shut down
	drainedOnce  sync.Once
	sessGone     chan struct{} // signalled (non-blocking) whenever a session is unregistered

	// bg is the context of background work that must outlive one session
	// (connection events, registry writes on close). It is cancelled by
	// Abandon or at the very end of Run.
	bg       context.Context
	bgCancel context.CancelFunc

	abandonCh   chan struct{}
	abandonOnce sync.Once
	runDone     chan struct{}

	fenceQ *machineQueue
	instQ  *idQueue

	mu       sync.Mutex
	sessions map[string]*session // by machine id, every state but closed
	sessUp   chan struct{}       // closed and replaced whenever a session registers
	closing  bool                // no new sessions: Run is shutting down or the gateway was abandoned
	sessWG   sync.WaitGroup      // session goroutines, Add only under mu while !closing
	evWG     sync.WaitGroup      // connection event deliveries, see goEvents

	evPending atomic.Int64 // running goEvents deliveries (observability, tests)
	resyncs   atomic.Int64 // completed "check every session" fence passes (tests)
}

// New validates cfg and fills defaults.
func New(cfg Config) (*Gateway, error) {
	if cfg.InstanceID == "" {
		return nil, errors.New("gateway: Config.InstanceID is required")
	}
	if cfg.Store == nil {
		return nil, errors.New("gateway: Config.Store is required")
	}
	if cfg.MinAgentVersion != "" {
		if _, err := wire.CompareVersions(cfg.MinAgentVersion, cfg.MinAgentVersion); err != nil {
			return nil, errors.New("gateway: Config.MinAgentVersion is not a semver version")
		}
	}
	if len(cfg.AllowedServicePrefixes) == 0 {
		cfg.AllowedServicePrefixes = []string{wire.ServicePrefixAgent}
	}
	if cfg.MaxTCPStreamsPerMachine <= 0 {
		cfg.MaxTCPStreamsPerMachine = defaultMaxTCPStreams
	}
	cfg.Timing = cfg.Timing.withDefaults()
	cfg.HTTP2 = h2Defaults(cfg.HTTP2)
	if cfg.Logger == nil {
		cfg.Logger = slog.Default()
	}
	g := &Gateway{
		cfg:       cfg,
		log:       cfg.Logger.With("instance_id", cfg.InstanceID),
		store:     cfg.Store,
		sink:      cfg.Sink,
		abandonCh: make(chan struct{}),
		runDone:   make(chan struct{}),
		drainDone: make(chan struct{}),
		drainedCh: make(chan struct{}),
		sessGone:  make(chan struct{}, 1),
		fenceQ:    newMachineQueue(),
		instQ:     newIDQueue(),
		sessions:  map[string]*session{},
		sessUp:    make(chan struct{}),
	}
	if g.sink == nil {
		g.sink = logSink{log: g.log}
	}
	g.bg, g.bgCancel = context.WithCancel(context.Background())
	return g, nil
}

func h2Defaults(cfg h2.ClientConfig) h2.ClientConfig {
	d := h2.DefaultClientConfig()
	if cfg.StreamWindow <= 0 {
		cfg.StreamWindow = d.StreamWindow
	}
	if cfg.ConnWindow <= 0 {
		cfg.ConnWindow = d.ConnWindow
	}
	if cfg.MaxFrame <= 0 {
		cfg.MaxFrame = d.MaxFrame
	}
	if cfg.PingIdle <= 0 {
		cfg.PingIdle = d.PingIdle
	}
	if cfg.PingTimeout <= 0 {
		cfg.PingTimeout = d.PingTimeout
	}
	return cfg
}

// Admitter returns the admission side, to be used by the WebSocket handler.
func (g *Gateway) Admitter() transport.Admitter { return admitter{g} }

// Ready reports whether the instance accepts new connections: Run is
// running and the instance is not draining. Use it for the readiness probe.
func (g *Gateway) Ready() bool { return g.running.Load() && !g.draining.Load() }

// Machine returns the connection of a machine served by this instance. Only
// sessions that serve calls (active or draining) are returned; moved and
// closed sessions are not.
func (g *Gateway) Machine(machineID string) (transport.MachineConn, bool) {
	s, st := g.lookup(machineID)
	if s == nil || !st.serving() {
		return nil, false
	}
	return s.mc, true
}

// lookup returns the local session of a machine and its state, or nil when
// there is none (or it is closed). Task 8 routes on it: a serving session is
// proxied, a moved one answers 421.
func (g *Gateway) lookup(machineID string) (*session, sessionState) {
	g.mu.Lock()
	s := g.sessions[machineID]
	g.mu.Unlock()
	if s == nil {
		return nil, stateClosed
	}
	st := s.state()
	if st == stateClosed {
		return nil, stateClosed
	}
	return s, st
}

// waitLocal waits up to d for a serving local session of the machine and
// returns it, or nil.
func (g *Gateway) waitLocal(ctx context.Context, machineID string, d time.Duration) *session {
	t := time.NewTimer(d)
	defer t.Stop()
	for {
		g.mu.Lock()
		up := g.sessUp
		g.mu.Unlock()
		if s, st := g.lookup(machineID); s != nil && st.serving() {
			return s
		}
		select {
		case <-up:
		case <-t.C:
			return nil
		case <-ctx.Done():
			return nil
		}
	}
}

// snapshotSessions returns the registered sessions.
func (g *Gateway) snapshotSessions() []*session {
	g.mu.Lock()
	defer g.mu.Unlock()
	out := make([]*session, 0, len(g.sessions))
	for _, s := range g.sessions {
		out = append(out, s)
	}
	return out
}

// Run registers the instance and runs the heartbeat, the sweep and the
// LISTEN loops until ctx is done or Drain finished its waits. Then it closes
// every session (marking it disconnected), deletes the instance row and
// returns nil. Run may be called only once.
func (g *Gateway) Run(ctx context.Context) error {
	if !g.started.CompareAndSwap(false, true) {
		return errors.New("gateway: Run called more than once")
	}
	defer close(g.runDone)
	if err := g.store.RegisterInstance(ctx, g.cfg.InstanceID, g.cfg.InternalURL); err != nil {
		g.bgCancel()
		return err
	}
	g.log.Info("gateway: instance registered", "internal_url", g.cfg.InternalURL)

	loopCtx, stopLoops := context.WithCancel(ctx)
	defer stopLoops()
	var loops sync.WaitGroup
	for _, loop := range []func(context.Context){g.heartbeatLoop, g.sweepLoop, g.listenLoop, g.fenceWorker, g.instanceWorker} {
		loops.Go(func() { loop(loopCtx) })
	}
	g.running.Store(true)

	select {
	case <-ctx.Done():
	case <-g.abandonCh:
	case <-g.drainedCh:
	}
	g.running.Store(false)
	stopLoops()
	loops.Wait()
	if g.abandoned.Load() {
		return nil
	}
	g.shutdown(context.WithoutCancel(ctx))
	return nil
}

// shutdown closes every session, waits for their registry writes and
// events, and deletes the instance row.
func (g *Gateway) shutdown(ctx context.Context) {
	g.mu.Lock()
	g.closing = true
	sessions := make([]*session, 0, len(g.sessions))
	for _, s := range g.sessions {
		sessions = append(sessions, s)
	}
	g.mu.Unlock()
	for _, s := range sessions {
		s.close("gateway shutdown")
	}
	g.sessWG.Wait()

	dctx, cancel := context.WithTimeout(ctx, dbTimeout)
	if err := g.store.DeleteInstance(dctx, g.cfg.InstanceID); err != nil {
		g.log.Warn("gateway: deleting instance row failed", "err", err)
	}
	cancel()

	done := make(chan struct{})
	go func() {
		g.evWG.Wait()
		close(done)
	}()
	select {
	case <-done:
	case <-time.After(shutdownEventGrace):
		g.log.Warn("gateway: pending connection events dropped at shutdown", "pending", g.evPending.Load())
	}
	g.bgCancel()
	g.log.Info("gateway: instance stopped")
}

// Abandon simulates a crash, for tests: it stops every loop, drops every
// connection and touches nothing in the registry and the sink. It waits for
// Run to return if Run was started.
func (g *Gateway) Abandon() {
	g.abandonOnce.Do(func() {
		g.abandoned.Store(true)
		g.running.Store(false)
		g.bgCancel()
		g.mu.Lock()
		g.closing = true
		sessions := make([]*session, 0, len(g.sessions))
		for _, s := range g.sessions {
			sessions = append(sessions, s)
		}
		g.mu.Unlock()
		close(g.abandonCh)
		for _, s := range sessions {
			s.close("abandoned")
		}
	})
	if g.started.Load() {
		<-g.runDone
	}
	g.sessWG.Wait()
}

// heartbeatLoop refreshes heartbeat_at. When the row is gone (another
// instance swept this one while it was alive) it registers again; the swept
// sessions are fenced by the resync so their agents reconnect with a fresh
// epoch.
func (g *Gateway) heartbeatLoop(ctx context.Context) {
	t := time.NewTicker(g.cfg.Timing.Heartbeat)
	defer t.Stop()
	for {
		select {
		case <-ctx.Done():
			return
		case <-t.C:
		}
		g.heartbeatOnce(ctx)
	}
}

// heartbeatOnce sends one heartbeat and registers again when the row is gone.
func (g *Gateway) heartbeatOnce(ctx context.Context) {
	hctx, cancel := context.WithTimeout(ctx, dbTimeout)
	err := g.store.Heartbeat(hctx, g.cfg.InstanceID)
	cancel()
	switch {
	case err == nil:
	case errors.Is(err, registry.ErrNotFound):
		g.log.Error("gateway: instance row was swept while alive; registering again")
		g.reRegister(ctx)
	case ctx.Err() != nil:
	default:
		g.log.Warn("gateway: heartbeat failed", "err", err)
	}
}

// reRegister registers the instance again and re-checks every local
// session: the ones the sweep marked disconnected are fenced, sessions
// admitted after the sweep keep running.
func (g *Gateway) reRegister(ctx context.Context) {
	rctx, cancel := context.WithTimeout(ctx, dbTimeout)
	defer cancel()
	if err := g.store.RegisterInstance(rctx, g.cfg.InstanceID, g.cfg.InternalURL); err != nil {
		g.log.Warn("gateway: registering again failed", "err", err)
		return
	}
	if g.draining.Load() {
		if err := g.store.SetInstanceState(rctx, g.cfg.InstanceID, registry.InstanceDraining); err != nil {
			g.log.Warn("gateway: restoring draining state failed", "err", err)
		}
	}
	g.fenceQ.push("")
}

// goEvents delivers connection events in the background. They are not
// ordered (spec 9.6), so nothing waits for them except Run's shutdown, which
// gives them shutdownEventGrace. Callers are session goroutines (tracked by
// sessWG) and the sweep loop, so no Add happens after shutdown's Wait starts.
func (g *Gateway) goEvents(evs ...*tunnelv1.ConnectionEvent) {
	g.evPending.Add(1)
	g.evWG.Go(func() {
		defer g.evPending.Add(-1)
		for _, ev := range evs {
			g.deliverConnectionEvent(g.bg, ev)
		}
	})
}

// sweepLoop marks the sessions of dead instances disconnected and reports
// them to the sink.
func (g *Gateway) sweepLoop(ctx context.Context) {
	t := time.NewTicker(g.cfg.Timing.Sweep)
	defer t.Stop()
	for {
		select {
		case <-ctx.Done():
			return
		case <-t.C:
		}
		sctx, cancel := context.WithTimeout(ctx, dbTimeout)
		swept, err := g.store.SweepStale(sctx, g.cfg.InstanceID, g.cfg.Timing.StaleAfter)
		cancel()
		if err != nil {
			if ctx.Err() == nil {
				g.log.Warn("gateway: sweep failed", "err", err)
			}
			continue
		}
		if len(swept) == 0 {
			continue
		}
		for _, sw := range swept {
			g.log.Info("gateway: session of a dead instance marked disconnected", "machine_id", sw.MachineID,
				"epoch", sw.Epoch, "dead_instance", sw.InstanceID, "reason", "instance stale")
		}
		evs := make([]*tunnelv1.ConnectionEvent, 0, len(swept))
		for _, sw := range swept {
			evs = append(evs, newConnectionEvent(sw.MachineID, sw.Epoch, evDisconnected,
				sw.InstanceID, sw.AgentInstanceID, sw.DisconnectedAt))
		}
		g.goEvents(evs...)
	}
}
