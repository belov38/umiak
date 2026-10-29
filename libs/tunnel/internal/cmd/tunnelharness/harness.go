package main

import (
	"context"
	"crypto/rand"
	"errors"
	"fmt"
	"log/slog"
	"net"
	"net/http"
	"slices"
	"sync"
	"time"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5/pgxpool"

	"github.com/belov38/boat-dev-clone/libs/tunnel/agent"
	"github.com/belov38/boat-dev-clone/libs/tunnel/gateway"
	"github.com/belov38/boat-dev-clone/libs/tunnel/h2"
	"github.com/belov38/boat-dev-clone/libs/tunnel/internal/pgtest"
	"github.com/belov38/boat-dev-clone/libs/tunnel/registry"
	"github.com/belov38/boat-dev-clone/libs/tunnel/tunneltest/memnet"
	"github.com/belov38/boat-dev-clone/libs/tunnel/tunneltest/process"
	"github.com/belov38/boat-dev-clone/libs/tunnel/wire"
)

// Shrunk timings (spec values in comments), the same as internal/e2e.
const (
	// deadAfter is the memnet liveness timeout of a stalled link (WS 15 s).
	deadAfter = 300 * time.Millisecond
	// stallFor is how long the stall fault blocks a link.
	stallFor = 2 * deadAfter
	// readyTimeout bounds the start of a gateway and the stop of a component.
	readyTimeout = 30 * time.Second
	// drainBegunTimeout bounds the wait for a drain to start.
	drainBegunTimeout = 5 * time.Second
)

func fastTiming() gateway.Timing {
	return gateway.Timing{
		Heartbeat:          100 * time.Millisecond,
		StaleAfter:         500 * time.Millisecond,
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

// Fault kinds of POST /fault.
const (
	faultCut          = "cut"
	faultStall        = "stall"
	faultDrain        = "drain"
	faultKillGateway  = "kill-gateway"
	faultRestartAgent = "restart-agent"
)

// harness owns the database pool, the memnet network, the gateways and the
// machines.
type harness struct {
	ctx   context.Context // cancelled when the harness stops
	log   *slog.Logger
	token string
	pool  *pgxpool.Pool
	store *registry.Store
	net   *memnet.Network

	machines []*machine // fixed after newHarness

	mu   sync.Mutex
	gws  []*gw // live gateways (not drained or killed), oldest first
	all  []*gw // every gateway started, for the final stop
	seq  int
	busy map[string]bool // fault kinds in progress

	bg sync.WaitGroup // drains and stall timers in progress
}

// newHarness migrates the database and starts the gateways and agents. On
// error the returned harness (if any) holds what was started; close it.
func newHarness(ctx context.Context, cfg config, log *slog.Logger) (*harness, error) {
	pool, err := pgxpool.New(ctx, cfg.dsn)
	if err != nil {
		return nil, fmt.Errorf("database: %w", err)
	}
	h := &harness{
		ctx:   ctx,
		log:   log,
		token: cfg.token,
		pool:  pool,
		store: registry.New(pool),
		net:   memnet.New(memnet.Options{DeadAfter: deadAfter}),
		busy:  map[string]bool{},
	}
	if err := pgtest.ApplyMigrations(ctx, pool); err != nil {
		return h, fmt.Errorf("migrations: %w", err)
	}
	for range cfg.gateways {
		if _, err := h.startGateway(); err != nil { //nolint:contextcheck // gateways run on the harness context (h.ctx is ctx)
			return h, err
		}
	}
	for range cfg.agents {
		m, err := h.newMachine(ctx)
		if err != nil {
			return h, err
		}
		h.machines = append(h.machines, m)
	}
	// Wait until every agent is connected, so the first call does not
	// have to wait for a route.
	for _, m := range h.machines {
		if err := m.waitConnected(ctx, readyTimeout); err != nil {
			return h, err
		}
	}
	return h, nil
}

func (h *harness) info(controlURL string) readyInfo {
	h.mu.Lock()
	defer h.mu.Unlock()
	ri := readyInfo{Machines: []string{}, Gateways: []gatewayInfo{}, Control: controlURL}
	for _, m := range h.machines {
		ri.Machines = append(ri.Machines, m.id)
	}
	for _, g := range h.gws {
		ri.Gateways = append(ri.Gateways, gatewayInfo{ID: g.name, URL: g.url})
	}
	return ri
}

// close stops the agents, then the gateways, the pending drains and the
// database pool.
func (h *harness) close() {
	var wg sync.WaitGroup
	for _, m := range h.machines {
		wg.Go(m.stop)
	}
	wg.Wait()
	h.mu.Lock()
	all := slices.Clone(h.all)
	h.mu.Unlock()
	for _, g := range all {
		wg.Go(func() { g.stop(false) })
	}
	wg.Wait()
	h.bg.Wait()
	for _, m := range h.machines {
		m.procs.Close()
	}
	h.pool.Close()
}

// gw is a running gateway with its internal listener on 127.0.0.1.
type gw struct {
	*gateway.Gateway
	h        *harness
	name     string
	url      string
	cancel   context.CancelFunc
	runErr   chan error
	srv      *http.Server
	srvDone  chan struct{}
	stopOnce sync.Once
}

// startGateway starts a gateway with a fresh instance id and waits until it
// is ready; memnet routes new dials to it while it is Ready.
func (h *harness) startGateway() (*gw, error) {
	h.mu.Lock()
	h.seq++
	name := fmt.Sprintf("gw-%d", h.seq)
	h.mu.Unlock()
	ln, err := (&net.ListenConfig{}).Listen(h.ctx, "tcp", "127.0.0.1:0")
	if err != nil {
		return nil, err
	}
	g := &gw{h: h, name: name, url: "http://" + ln.Addr().String(), runErr: make(chan error, 1), srvDone: make(chan struct{})}
	gg, err := gateway.New(gateway.Config{
		InstanceID:             name,
		InternalURL:            g.url,
		Store:                  h.store,
		ServiceTokens:          gateway.TokenSet{"api": {h.token}},
		AllowedServicePrefixes: []string{"sbx.testing.v1."},
		Timing:                 fastTiming(),
		HTTP2:                  h2.ClientConfig{PingIdle: 200 * time.Millisecond, PingTimeout: 200 * time.Millisecond},
		Logger:                 h.log.With("gw", name),
	})
	if err != nil {
		_ = ln.Close()
		return nil, err
	}
	g.Gateway = gg
	// Run outlives the request that started it; it stops with the harness.
	ctx, cancel := context.WithCancel(h.ctx)
	g.cancel = cancel
	go func() { g.runErr <- gg.Run(ctx) }()
	g.srv = gateway.NewInternalServer(gg.InternalHandler())
	go func() {
		defer close(g.srvDone)
		_ = g.srv.Serve(ln)
	}()
	h.mu.Lock()
	h.all = append(h.all, g)
	h.mu.Unlock()
	deadline := time.Now().Add(readyTimeout)
	for !gg.Ready() {
		if time.Now().After(deadline) || h.ctx.Err() != nil {
			g.stop(false)
			return nil, fmt.Errorf("%s not ready", name)
		}
		time.Sleep(5 * time.Millisecond)
	}
	h.net.AddGateway(name, gg.Admitter(), gg.Ready)
	h.mu.Lock()
	h.gws = append(h.gws, g)
	h.mu.Unlock()
	h.log.Info("tunnelharness: gateway started", "gw", name, "url", g.url)
	return g, nil
}

// stop stops Run and the internal listener. graceful shuts the listener down
// (in-flight proxied calls finish, as a pod does after Drain) before closing it.
func (g *gw) stop(graceful bool) {
	g.stopOnce.Do(func() {
		g.h.net.RemoveGateway(g.name)
		g.h.forget(g)
		g.cancel()
		select {
		case err := <-g.runErr:
			if err != nil {
				g.h.log.Warn("tunnelharness: gateway Run", "gw", g.name, "err", err)
			}
		case <-time.After(readyTimeout):
			g.h.log.Error("tunnelharness: gateway Run did not return", "gw", g.name)
		}
		if graceful {
			ctx, cancel := context.WithTimeout(context.Background(), readyTimeout)
			if err := g.srv.Shutdown(ctx); err != nil {
				g.h.log.Warn("tunnelharness: internal listener shutdown", "gw", g.name, "err", err)
			}
			cancel()
		}
		_ = g.srv.Close()
		<-g.srvDone
	})
}

// forget removes g from the live gateways.
func (h *harness) forget(g *gw) {
	h.mu.Lock()
	h.gws = slices.DeleteFunc(h.gws, func(x *gw) bool { return x == g })
	h.mu.Unlock()
}

func (h *harness) byName(name string) *gw {
	h.mu.Lock()
	defer h.mu.Unlock()
	for _, g := range h.gws {
		if g.name == name {
			return g
		}
	}
	return nil
}

func (h *harness) machine(id string) *machine {
	for _, m := range h.machines {
		if m.id == id {
			return m
		}
	}
	return nil
}

func (h *harness) starts(commandID string) int {
	n := 0
	for _, m := range h.machines {
		n += m.procs.Starts(commandID)
	}
	return n
}

func (h *harness) labelCalls(commandID string) uint64 {
	var n uint64
	for _, m := range h.machines {
		n += m.procs.LabelCalls(commandID)
	}
	return n
}

// begin marks a fault kind as in progress; false if it already is.
func (h *harness) begin(kind string) bool {
	h.mu.Lock()
	defer h.mu.Unlock()
	if h.busy[kind] {
		return false
	}
	h.busy[kind] = true
	return true
}

func (h *harness) end(kind string) {
	h.mu.Lock()
	delete(h.busy, kind)
	h.mu.Unlock()
}

// faultResult is the answer of POST /fault: what the fault touched.
type faultResult struct {
	Kind string `json:"kind"`
	// Applied is true when the fault hit something: links, a gateway or
	// the agent. Faults that would hit nothing are refused with 409.
	Applied bool `json:"applied"`
	// Links is the number of the machine's memnet links cut or stalled, or
	// served by the drained or killed gateway.
	Links int `json:"links"`
	// Gateway is the gateway of the affected links, or the one drained or killed.
	Gateway string `json:"gateway,omitempty"`
	// Agent is the instance id of the new agent client (restart-agent).
	Agent string `json:"agent,omitempty"`
}

// fault injects one fault into machine id and returns what it touched.
func (h *harness) fault(kind, id string) (*faultResult, error) {
	switch kind {
	case faultCut, faultStall, faultDrain, faultKillGateway, faultRestartAgent:
	default:
		return nil, &faultError{status: http.StatusBadRequest, msg: "unknown fault kind " + kind}
	}
	m := h.machine(id)
	if m == nil {
		return nil, &faultError{status: http.StatusNotFound, msg: "unknown machine " + id}
	}
	if !h.begin(kind) {
		return nil, busy("a %s fault is in progress", kind)
	}
	res := &faultResult{Kind: kind, Applied: true}
	switch kind {
	case faultCut:
		defer h.end(kind)
		links := h.net.Links(m.id)
		if len(links) == 0 {
			return nil, busy("machine %s has no live link", m.id)
		}
		for _, l := range links {
			l.Cut()
		}
		res.Links = len(links)
		res.Gateway = links[len(links)-1].Gateway
	case faultStall:
		l := m.newestLink()
		if l == nil {
			h.end(kind)
			return nil, busy("machine %s has no live link", m.id)
		}
		l.Stall(stallFor)
		res.Links = 1
		res.Gateway = l.Gateway
		h.bg.Go(func() {
			defer h.end(kind)
			select {
			case <-time.After(stallFor):
			case <-h.ctx.Done():
			}
		})
	case faultDrain, faultKillGateway:
		owner, err := h.replaceOwner(m)
		if err != nil {
			h.end(kind)
			return nil, err
		}
		res.Gateway = owner.name
		for _, l := range h.net.Links(m.id) {
			if l.Gateway == owner.name {
				res.Links++
			}
		}
		if kind == faultKillGateway {
			defer h.end(kind)
			// A crash: no drain, no registry writes, listener closed.
			h.forget(owner)
			h.net.RemoveGateway(owner.name)
			owner.Abandon()
			owner.stop(false)
			break
		}
		h.forget(owner)
		h.bg.Go(func() {
			defer h.end(kind)
			if err := owner.Drain(h.ctx); err != nil {
				h.log.Warn("tunnelharness: drain", "gw", owner.name, "err", err)
			}
			owner.stop(true)
		})
		// Answer once the drain has begun (the gateway stops being Ready).
		deadline := time.Now().Add(drainBegunTimeout)
		for owner.Ready() {
			if time.Now().After(deadline) {
				return nil, errors.New("drain of " + owner.name + " did not begin")
			}
			time.Sleep(time.Millisecond)
		}
	case faultRestartAgent:
		defer h.end(kind)
		if err := m.restart(); err != nil {
			return nil, err
		}
		res.Agent = m.instanceID()
	}
	return res, nil
}

// replaceOwner finds the live gateway serving the machine's newest link and
// starts a replacement gateway first, as in a rolling update.
func (h *harness) replaceOwner(m *machine) (*gw, error) {
	l := m.newestLink()
	if l == nil {
		return nil, busy("machine %s has no live link", m.id)
	}
	owner := h.byName(l.Gateway)
	if owner == nil {
		return nil, busy("owner %s of machine %s is already gone", l.Gateway, m.id)
	}
	if _, err := h.startGateway(); err != nil {
		return nil, fmt.Errorf("replacement gateway: %w", err)
	}
	return owner, nil
}

// machine is one VM: credentials, the Process store (it outlives agent
// clients, like the shim and the disk) and the current agent client.
type machine struct {
	h     *harness
	id    string
	bs    []byte
	procs *process.Store

	mu  sync.Mutex
	cur *agentRun

	connected chan struct{} // closed on the first KindConnected
	connOnce  sync.Once
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

func (h *harness) newMachine(ctx context.Context) (*machine, error) {
	bs := make([]byte, wire.SecretLen)
	if _, err := rand.Read(bs); err != nil {
		return nil, err
	}
	m := &machine{h: h, id: uuid.NewString(), bs: bs, procs: process.NewStore(process.Options{}), connected: make(chan struct{})}
	if err := h.store.PutCredentials(ctx, m.id, wire.HashSecret(bs)); err != nil {
		return nil, fmt.Errorf("PutCredentials: %w", err)
	}
	m.mu.Lock()
	defer m.mu.Unlock()
	if err := m.startLocked(); err != nil { //nolint:contextcheck // agents run on the harness context (h.ctx is ctx)
		return nil, err
	}
	return m, nil
}

func (m *machine) startLocked() error {
	mux := http.NewServeMux()
	mux.Handle(m.procs.Handler())
	inst := "agent-" + uuid.NewString()
	c, err := agent.New(agent.Config{
		Dialer:      m.h.net.Dialer(),
		Credentials: staticCreds{id: m.id, bs: m.bs},
		Identity:    agent.Identity{BootID: "boot-" + m.id, InstanceID: inst, Vmgenid: "gen-1", Version: "1.0.0"},
		Handler:     mux,
		Backoff:     agent.Backoff{First: 5 * time.Millisecond, Base: 10 * time.Millisecond, Max: 100 * time.Millisecond, ResetAfter: time.Minute},
		RejectDelays: agent.RejectDelays{
			BadBootstrap: 50 * time.Millisecond, Retired: 50 * time.Millisecond, Outdated: 50 * time.Millisecond,
		},
		DrainJitter:     20 * time.Millisecond,
		DrainCloseExtra: 2 * time.Second,
		Logger:          m.h.log.With("agent", inst),
		OnConnEvent: func(ev agent.ConnEvent) {
			if ev.Kind == agent.KindConnected {
				m.connOnce.Do(func() { close(m.connected) })
			}
		},
	})
	if err != nil {
		return err
	}
	// The agent outlives the request that started it; it stops with the harness.
	ctx, cancel := context.WithCancel(m.h.ctx)
	run := &agentRun{instanceID: inst, cancel: cancel, done: make(chan error, 1)}
	go func() { run.done <- c.Run(ctx) }()
	m.cur = run
	m.h.log.Info("tunnelharness: agent started", "machine", m.id, "agent", inst)
	return nil
}

func (m *machine) waitConnected(ctx context.Context, timeout time.Duration) error {
	select {
	case <-m.connected:
		return nil
	case <-ctx.Done():
		return ctx.Err()
	case <-time.After(timeout):
		return fmt.Errorf("agent of %s not connected after %s", m.id, timeout)
	}
}

func (r *agentRun) stop() error {
	r.cancel()
	select {
	case err := <-r.done:
		if errors.Is(err, context.Canceled) {
			return nil
		}
		return err
	case <-time.After(readyTimeout):
		return errors.New("agent Run did not return")
	}
}

// restart replaces the agent client: new instance id, same Process store
// and credentials, no machine token (it lived in memory).
func (m *machine) restart() error {
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
		m.h.log.Warn("tunnelharness: agent stop", "machine", m.id, "err", err)
	}
}

func (m *machine) instanceID() string {
	m.mu.Lock()
	defer m.mu.Unlock()
	return m.cur.instanceID
}

// newestLink returns the machine's newest live memnet link, or nil.
func (m *machine) newestLink() *memnet.Link {
	ls := m.h.net.Links(m.id)
	if len(ls) == 0 {
		return nil
	}
	return ls[len(ls)-1]
}
