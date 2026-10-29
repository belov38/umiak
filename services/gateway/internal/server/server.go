// Package server assembles one gateway instance: the embedded tunnel gateway
// (libs/tunnel), its internal listener, the metrics and health listener, the
// route and owner caches and the Postgres LISTEN wiring that invalidates them.
package server

import (
	"context"
	"errors"
	"fmt"
	"io"
	"log/slog"
	"net"
	"net/http"
	"sync"
	"sync/atomic"
	"time"

	"github.com/jackc/pgx/v5/pgxpool"
	"github.com/prometheus/client_golang/prometheus"
	"github.com/prometheus/client_golang/prometheus/collectors"
	"golang.org/x/time/rate"

	"github.com/belov38/boat-dev-clone/libs/tunnel/gateway"
	"github.com/belov38/boat-dev-clone/libs/tunnel/registry"
	"github.com/belov38/boat-dev-clone/services/gateway/internal/config"
	"github.com/belov38/boat-dev-clone/services/gateway/internal/cpapi"
	"github.com/belov38/boat-dev-clone/services/gateway/internal/edge"
	"github.com/belov38/boat-dev-clone/services/gateway/internal/httpproxy"
	"github.com/belov38/boat-dev-clone/services/gateway/internal/obs"
	"github.com/belov38/boat-dev-clone/services/gateway/internal/portauth"
	"github.com/belov38/boat-dev-clone/services/gateway/internal/ratelimit"
	"github.com/belov38/boat-dev-clone/services/gateway/internal/routes"
	"github.com/belov38/boat-dev-clone/services/gateway/internal/sshgw"
	"github.com/belov38/boat-dev-clone/services/gateway/internal/upstream"
)

// Postgres channels the gateway LISTENs on next to the tunnel channels.
const (
	// ChannelRoutes carries a slug whose routes changed, or "*" for all.
	ChannelRoutes = "sbx_routes"
	// ChannelSSHRevoke carries an SSH access revocation (spec 9.5).
	ChannelSSHRevoke = "sbx_ssh_revoke"
)

const (
	// maxTCPStreamsPerMachine is the per-machine CONNECT stream limit,
	// counted by the owner instance.
	maxTCPStreamsPerMachine = 800
	// internalIdleTimeout closes idle conns of the internal listener.
	internalIdleTimeout = 120 * time.Second
	// defaultStaleAfter is gateway.Timing's default heartbeat age after
	// which an instance is dead; the owner cache uses the same value.
	defaultStaleAfter = 15 * time.Second
	// appMaxIdlePerHost and appIdleConnTimeout size the keep-alive pool of
	// each (machine, epoch, port) (spec 7.2).
	appMaxIdlePerHost  = 8
	appIdleConnTimeout = 30 * time.Second
	// appMaxResponseHeaderBytes caps an application's response headers.
	appMaxResponseHeaderBytes = 64 << 10
	// pingInterval and pingTimeout drive the postgres dependency gauge.
	pingInterval = 10 * time.Second
	pingTimeout  = 5 * time.Second
	// metricsReadHeaderTimeout bounds the request headers on the metrics
	// listener.
	metricsReadHeaderTimeout = 10 * time.Second
	// metricsIdleTimeout closes idle keep-alive conns on the metrics
	// listener.
	metricsIdleTimeout = 120 * time.Second
	// Defaults of the tunnel admission bucket for zero config values.
	defaultTunnelAdmitRate  = 200
	defaultTunnelAdmitBurst = 1000
)

// Deps are the external dependencies of an instance.
type Deps struct {
	Pool      *pgxpool.Pool
	API       cpapi.Client
	Logger    *slog.Logger
	AccessLog io.Writer
	Now       func() time.Time
	// Timing is the tunnel timing; tests shrink it. TCPDeadline is always
	// replaced by the config's SSHDrainDeadline.
	Timing gateway.Timing
	// MaxTCPStreamsPerMachine is the per-machine CONNECT stream limit this
	// instance enforces as the owner; 0 means 800. Tests shrink it.
	MaxTCPStreamsPerMachine int
	// AllowedServicePrefixes are the services the internal /rpc/ proxy
	// passes to agents; nil keeps the libs/tunnel default (sbx.agent.v1).
	// Tests add the sbx.testing.v1 Process double.
	AllowedServicePrefixes []string
	// Sink receives the agent and connection events. nil builds the HTTP
	// sink of APIURL; with APIURL empty or config.APIURLNone the tunnel
	// gateway logs, drops and acknowledges them.
	Sink gateway.EventSink
	// OwnerSource answers the owner lookups of the upstream dialer; nil
	// queries the registry. Tests inject a broken registry.
	OwnerSource registry.OwnerSource
}

// Listeners are the sockets an instance serves. A nil listener is not
// served. Run owns the listeners and closes them when it returns.
type Listeners struct {
	Internal net.Listener
	Metrics  net.Listener
	TLS      net.Listener
	Plain    net.Listener
	SSH      net.Listener
}

// Instance is one gateway process.
type Instance struct {
	cfg        config.Config
	deps       Deps
	log        *slog.Logger
	staleAfter time.Duration

	reg     *prometheus.Registry
	metrics *obs.Metrics
	store   *registry.Store
	tunnel  *gateway.Gateway
	routes  *routes.Cache
	owners  *registry.OwnerCache

	upstream      *upstream.Dialer
	appTransports *upstream.AppTransports

	limits  *ratelimit.Limits
	auth    *portauth.Auth
	streams *httpproxy.StreamTracker
	proxy   http.Handler
	ssh     *sshgw.Server // nil when SSHListen is empty

	internal   *http.Server
	metricsSrv *http.Server
	// The public servers: plain (behind an ingress) and, behind the TLS
	// dispatcher, sbx and tunnel.
	plain     *http.Server
	sbxSrv    *http.Server
	tunnelSrv *http.Server

	pingEvery time.Duration

	started       atomic.Bool
	draining      atomic.Bool
	listenStarted atomic.Bool
	drainStarted  atomic.Bool
	drained       chan struct{} // closed when Drain finished
	drainErr      error         // written before drained is closed
	// runStarted is closed once Run serves its listeners; runEnded when Run
	// returned; tunnelExited when the tunnel gateway's Run returned. Drain
	// waits on them, so a drain requested during startup is not lost.
	runStarted   chan struct{}
	runEnded     chan struct{}
	tunnelExited chan struct{}
	// disp is the TLS dispatcher once Run built it; Drain closes it.
	disp atomic.Pointer[edge.Dispatcher]

	hookMu        sync.Mutex
	instanceHooks []func(string)
	readyChecks   []func() bool
	revokeHook    func(string)
}

// New builds an instance. It opens no listener; Run serves them.
func New(cfg config.Config, deps Deps) (*Instance, error) {
	if deps.Pool == nil {
		return nil, errors.New("server: Deps.Pool is required")
	}
	if deps.API == nil {
		return nil, errors.New("server: Deps.API is required")
	}
	if len(cfg.CookieKeys) == 0 {
		return nil, errors.New("server: cookie keys are required")
	}
	if deps.Logger == nil {
		deps.Logger = slog.Default()
	}
	if deps.AccessLog == nil {
		deps.AccessLog = io.Discard
	}
	if deps.Now == nil {
		deps.Now = time.Now
	}
	if deps.MaxTCPStreamsPerMachine <= 0 {
		deps.MaxTCPStreamsPerMachine = maxTCPStreamsPerMachine
	}
	staleAfter := deps.Timing.StaleAfter
	if staleAfter <= 0 {
		staleAfter = defaultStaleAfter
	}

	i := &Instance{
		cfg:        cfg,
		deps:       deps,
		log:        deps.Logger.With("instance_id", cfg.InstanceID),
		staleAfter: staleAfter,
		reg:        prometheus.NewRegistry(),
		store:      registry.New(deps.Pool),
		pingEvery:  pingInterval,
		drained:    make(chan struct{}),

		runStarted:   make(chan struct{}),
		runEnded:     make(chan struct{}),
		tunnelExited: make(chan struct{}),
	}
	i.reg.MustRegister(collectors.NewGoCollector(), collectors.NewProcessCollector(collectors.ProcessCollectorOpts{}))
	i.metrics = obs.NewMetrics(i.reg)
	i.routes = routes.NewCache(deps.API, routes.CacheConfig{Timeout: cfg.Timeouts.RouteLookup, Now: deps.Now}, i.metrics)
	if deps.OwnerSource != nil {
		i.owners = registry.NewOwnerCacheFunc(deps.OwnerSource, 0)
	} else {
		i.owners = registry.NewOwnerCache(i.store, staleAfter, 0)
	}

	timing := deps.Timing
	timing.TCPDeadline = cfg.SSHDrainDeadline
	gcfg := gateway.Config{
		InstanceID:              cfg.InstanceID,
		InternalURL:             cfg.InternalURL,
		Store:                   i.store,
		ServiceTokens:           cfg.ServiceTokens,
		MinAgentVersion:         cfg.MinAgentVersion,
		MaxTCPStreamsPerMachine: deps.MaxTCPStreamsPerMachine,
		AllowedServicePrefixes:  deps.AllowedServicePrefixes,
		OnInstanceChange:        i.onInstanceChange,
		OnSessionChange:         i.onSessionChange,
		ListenChannels: map[string]func(string){
			ChannelRoutes:    i.onRoutesNotify,
			ChannelSSHRevoke: i.onRevokeNotify,
		},
		Timing: timing,
		Logger: deps.Logger,
	}
	switch {
	case deps.Sink != nil:
		gcfg.Sink = deps.Sink
	case cfg.APIURL != "" && cfg.APIURL != config.APIURLNone:
		gcfg.Sink = gateway.NewHTTPSink(cfg.APIURL, cfg.APIToken, nil)
	}
	g, err := gateway.New(gcfg)
	if err != nil {
		return nil, fmt.Errorf("server: %w", err)
	}
	i.tunnel = g

	i.upstream = upstream.New(upstream.Config{
		Self:        cfg.InstanceID,
		Local:       g,
		Owners:      i.owners,
		Store:       i.store,
		PeerToken:   cfg.PeerToken,
		AgentWait:   cfg.Timeouts.AgentWait,
		DialTimeout: cfg.Timeouts.Dial,
		StaleAfter:  staleAfter,
		Metrics:     i.metrics,
		Logger:      deps.Logger,
	})
	i.appTransports = upstream.NewAppTransports(i.upstream, upstream.TransportConfig{
		HTTPDrain:              cfg.HTTPDrainDeadline,
		ResponseHeaderTimeout:  cfg.Timeouts.ResponseHeader,
		StreamIdle:             cfg.Timeouts.StreamIdle,
		MaxIdlePerHost:         appMaxIdlePerHost,
		IdleConnTimeout:        appIdleConnTimeout,
		MaxResponseHeaderBytes: appMaxResponseHeaderBytes,
	})

	i.limits = ratelimit.New(cfg.RateLimit, i.metrics)
	i.auth = portauth.New(portauth.Config{
		Codec:     portauth.NewCodec(cfg.CookieKeys, deps.Now),
		API:       deps.API,
		AuthURL:   cfg.AuthURL,
		SbxDomain: cfg.SbxDomain,
		CrossSite: cfg.CookieCrossSite,
		Limits:    i.limits,
		Metrics:   i.metrics,
	})
	i.streams = httpproxy.NewStreamTracker()
	accessLog := obs.NewAccessLog(deps.AccessLog)
	i.proxy = httpproxy.New(httpproxy.Config{
		SbxDomain:           cfg.SbxDomain,
		Grammar:             grammar(cfg),
		Routes:              i.routes,
		Auth:                i.auth,
		Limits:              i.limits,
		Upstream:            i.upstream,
		Transports:          i.appTransports,
		TrustedProxies:      cfg.TrustedProxyCIDRs,
		StripCookiePrefixes: cfg.StripCookiePrefixes,
		Metrics:             i.metrics,
		AccessLog:           accessLog,
		Streams:             i.streams,
		Logger:              deps.Logger,
	})
	if cfg.SSHListen != "" {
		i.ssh, err = sshgw.New(sshgw.Config{
			HostSigners:          cfg.SSHHostKeys,
			LoginCAKeys:          cfg.SSHLoginCAKeys,
			UserCA:               cfg.SSHUserCA,
			API:                  deps.API,
			Dialer:               i.upstream,
			Limits:               i.limits,
			Metrics:              i.metrics,
			Log:                  accessLog,
			Logger:               i.log,
			DrainDeadline:        cfg.SSHDrainDeadline,
			KeepaliveInterval:    cfg.SSHKeepaliveInterval,
			KeepaliveMax:         cfg.SSHKeepaliveMax,
			MaxChannels:          cfg.SSHMaxChannels,
			LoginCertMaxValidity: cfg.SSHLoginCertMaxValidity,
			Now:                  deps.Now,
			Self:                 cfg.InstanceID,
			Instances:            i.store,
			Owners:               i.owners,
		})
		if err != nil {
			return nil, fmt.Errorf("server: %w", err)
		}
		// Revocations and the owner drain signals (spec 9.5, 10.3); sshgw
		// queues the work, so the LISTEN and hook goroutines never block.
		i.SetRevokeHook(i.ssh.Revoke)
		i.AddInstanceHook(i.ssh.NotifyInstance)
	}
	rateLimit, burst := cfg.TunnelAdmitRate, cfg.TunnelAdmitBurst
	if rateLimit <= 0 {
		rateLimit = defaultTunnelAdmitRate
	}
	if burst <= 0 {
		burst = defaultTunnelAdmitBurst
	}
	tunnelHandler := edge.TunnelHandler(g.Admitter(), rate.NewLimiter(rate.Limit(rateLimit), burst), i.metrics)
	errLog := slog.NewLogLogger(deps.Logger.Handler(), slog.LevelDebug)
	i.plain = edge.NewPlainServer(edge.PlainHandler(i.proxy, tunnelHandler, cfg.TunnelHost), cfg.Timeouts)
	i.sbxSrv = edge.NewSbxServer(i.proxy, cfg.Timeouts)
	i.tunnelSrv = edge.NewTunnelServer(tunnelHandler)
	for _, s := range i.edgeServers() {
		s.ErrorLog = errLog
	}

	i.internal = gateway.NewInternalServer(g.InternalHandler())
	i.internal.IdleTimeout = internalIdleTimeout
	i.metricsSrv = &http.Server{
		Handler:           i.MetricsHandler(),
		ReadHeaderTimeout: metricsReadHeaderTimeout,
		IdleTimeout:       metricsIdleTimeout,
	}
	return i, nil
}

// grammar returns the label grammar of the config; empty fields take the
// defaults.
func grammar(cfg config.Config) routes.Grammar {
	g := routes.DefaultGrammar()
	if cfg.ReservedPorts != nil {
		g.ReservedPorts = map[uint16]bool{}
		for _, p := range cfg.ReservedPorts {
			if p > 0 && p <= 65535 {
				g.ReservedPorts[uint16(p)] = true
			}
		}
	}
	if cfg.ReservedSuffixes != nil {
		g.ReservedSuffixes = cfg.ReservedSuffixes
	}
	if cfg.ReservedSlugs != nil {
		g.ReservedSlugs = cfg.ReservedSlugs
	}
	return g
}

// onInstanceChange runs on a tunnel gateway goroutine. "" means the LISTEN
// connection was (re)established: an owner whose instance died unnoticed
// may be cached, so the whole owner cache is dropped.
func (i *Instance) onInstanceChange(id string) {
	if id == "" {
		i.owners.Invalidate("")
	}
	i.hookMu.Lock()
	hooks := i.instanceHooks
	i.hookMu.Unlock()
	for _, h := range hooks {
		h(id)
	}
}

// onSessionChange runs on a tunnel gateway goroutine for every
// tunnel_sessions NOTIFY ("" to resync everything). The owner cache drops
// the machine; a moved machine may mean that the old owner of SSH backend
// streams drains (spec 10.3).
func (i *Instance) onSessionChange(machineID string) {
	i.owners.Invalidate(machineID)
	if i.ssh != nil {
		i.ssh.NotifyMachine(machineID)
	}
}

// onRoutesNotify runs on the LISTEN goroutine. "" follows every (re)LISTEN:
// notifications may have been missed, so the cache is flushed. A lost
// connection alone flushes nothing, so cached routes keep being served
// during a Postgres outage.
func (i *Instance) onRoutesNotify(payload string) {
	if payload == "" {
		// Flush first: a test that waits for ListenStarted must never race
		// the initial flush.
		i.routes.Flush()
		i.listenStarted.Store(true)
		return
	}
	i.routes.InvalidateSlug(payload)
}

func (i *Instance) onRevokeNotify(payload string) {
	i.hookMu.Lock()
	h := i.revokeHook
	i.hookMu.Unlock()
	if h != nil {
		h(payload)
	}
}

// AddInstanceHook adds a hook called for every gateway instance change, with
// "" after every (re)LISTEN. Hooks run sequentially on a tunnel gateway
// goroutine and must return quickly.
func (i *Instance) AddInstanceHook(h func(instanceID string)) {
	i.hookMu.Lock()
	defer i.hookMu.Unlock()
	i.instanceHooks = append(i.instanceHooks[:len(i.instanceHooks):len(i.instanceHooks)], h)
}

// SetRevokeHook sets the handler of sbx_ssh_revoke payloads, and of "" after
// every (re)LISTEN. It runs on the LISTEN goroutine and must not block.
func (i *Instance) SetRevokeHook(h func(payload string)) {
	i.hookMu.Lock()
	defer i.hookMu.Unlock()
	i.revokeHook = h
}

// AddReadyCheck adds a condition of Ready, such as "certificates loaded".
func (i *Instance) AddReadyCheck(c func() bool) {
	i.hookMu.Lock()
	defer i.hookMu.Unlock()
	i.readyChecks = append(i.readyChecks[:len(i.readyChecks):len(i.readyChecks)], c)
}

// Ready reports whether the instance takes new traffic: the tunnel gateway
// runs and is not draining, the instance is not draining and every ready
// check holds. Postgres and api health do not count (spec 12.3).
func (i *Instance) Ready() bool {
	if i.draining.Load() || !i.tunnel.Ready() {
		return false
	}
	i.hookMu.Lock()
	checks := i.readyChecks
	i.hookMu.Unlock()
	for _, c := range checks {
		if !c() {
			return false
		}
	}
	return true
}

// ListenStarted reports whether the LISTEN connection was established at
// least once, so route notifications are heard. For tests and diagnostics.
func (i *Instance) ListenStarted() bool { return i.listenStarted.Load() }

// Tunnel returns the embedded tunnel gateway.
func (i *Instance) Tunnel() *gateway.Gateway { return i.tunnel }

// Metrics returns the gateway metrics.
func (i *Instance) Metrics() *obs.Metrics { return i.metrics }

// Routes returns the route cache.
func (i *Instance) Routes() *routes.Cache { return i.routes }

// Owners returns the machine owner cache.
func (i *Instance) Owners() *registry.OwnerCache { return i.owners }

// Upstream returns the dialer of application streams.
func (i *Instance) Upstream() *upstream.Dialer { return i.upstream }

// AppTransports returns the HTTP transports to applications.
func (i *Instance) AppTransports() *upstream.AppTransports { return i.appTransports }

// Limits returns the abuse limits.
func (i *Instance) Limits() *ratelimit.Limits { return i.limits }

// Streams returns the tracker of long HTTP streams, for the drain.
func (i *Instance) Streams() *httpproxy.StreamTracker { return i.streams }

// SSH returns the SSH gateway, or nil when SSHListen is empty.
func (i *Instance) SSH() *sshgw.Server { return i.ssh }

// HTTPHandler returns the public HTTP proxy handler.
func (i *Instance) HTTPHandler() http.Handler { return i.proxy }

// edgeServers returns the public HTTP servers, for the shutdown and the
// drain.
func (i *Instance) edgeServers() []*http.Server {
	return []*http.Server{i.plain, i.sbxSrv, i.tunnelSrv}
}

// startEdge loads the certificates and builds the TLS dispatcher of ln
// (PROXY protocol v2 first when configured).
func (i *Instance) startEdge(ln net.Listener) (*edge.Dispatcher, []*edge.CertSource, error) {
	sbx, err := edge.NewCertSource("sbx", i.cfg.SbxCertFile, i.cfg.SbxKeyFile, i.metrics)
	if err != nil {
		return nil, nil, fmt.Errorf("server: %w", err)
	}
	tun, err := edge.NewCertSource("tunnel", i.cfg.TunnelCertFile, i.cfg.TunnelKeyFile, i.metrics)
	if err != nil {
		return nil, nil, fmt.Errorf("server: %w", err)
	}
	for _, c := range []*edge.CertSource{sbx, tun} {
		c.SetLogger(i.log)
	}
	i.AddReadyCheck(func() bool { return sbx.Loaded() && tun.Loaded() })
	if i.cfg.ProxyProtocol {
		ln = edge.WrapProxyProtocol(ln, i.cfg.ProxyProtocolCIDRs, i.cfg.Timeouts.TLSHandshake)
	}
	d := edge.NewDispatcher(ln, edge.DispatchConfig{
		SbxDomain:        i.cfg.SbxDomain,
		TunnelHost:       i.cfg.TunnelHost,
		Sbx:              sbx,
		Tunnel:           tun,
		HandshakeTimeout: i.cfg.Timeouts.TLSHandshake,
		// Node SNAT (spec 11) has its own handshake budget.
		MaxHandshakesPerIP: i.cfg.TLSMaxHandshakesPerIP,
		HandshakeExempt:    i.cfg.RateLimit.Exempt,
		ConnLimit:          i.limits.AcquireConn,
		Metrics:            i.metrics,
		Logger:             i.log,
	})
	return d, []*edge.CertSource{sbx, tun}, nil
}

// Run serves the non-nil listeners and runs the tunnel gateway until ctx is
// done, Drain finished, or a server fails. It then stops everything, closes
// the listeners and returns the first error (nil for a normal stop). Run may
// be called only once.
func (i *Instance) Run(ctx context.Context, ls Listeners) error {
	if !i.started.CompareAndSwap(false, true) {
		return errors.New("server: Run called twice")
	}
	defer close(i.runEnded)
	var disp *edge.Dispatcher
	var certs []*edge.CertSource
	if ls.TLS != nil {
		var err error
		if disp, certs, err = i.startEdge(ls.TLS); err != nil {
			for _, ln := range []net.Listener{ls.Internal, ls.Metrics, ls.TLS, ls.Plain, ls.SSH} {
				if ln != nil {
					_ = ln.Close()
				}
			}
			return err
		}
	}
	runCtx, cancel := context.WithCancel(ctx)
	defer cancel()

	tunnelDone := make(chan error, 1)
	go func() {
		defer close(i.tunnelExited)
		tunnelDone <- i.tunnel.Run(runCtx)
	}()

	var wg sync.WaitGroup
	fatal := make(chan error, 8) // at most one per server
	serve := func(name string, srv *http.Server, ln net.Listener) {
		wg.Go(func() {
			err := srv.Serve(ln)
			// Drain closes the public listeners itself.
			if errors.Is(err, net.ErrClosed) && i.draining.Load() {
				return
			}
			if !errors.Is(err, http.ErrServerClosed) {
				fatal <- fmt.Errorf("server: %s listener: %w", name, err)
			}
		})
	}
	if ls.Internal != nil {
		serve("internal", i.internal, ls.Internal)
	}
	if ls.Metrics != nil {
		serve("metrics", i.metricsSrv, ls.Metrics)
	}
	if ls.Plain != nil {
		serve("plain", i.plain, ls.Plain)
	}
	if disp != nil {
		i.disp.Store(disp)
		serve("tls sbx", i.sbxSrv, disp.Sbx())
		serve("tls tunnel", i.tunnelSrv, disp.Tunnel())
		// Not cancelled with runCtx: the dispatcher is closed after its
		// servers, so they see ErrServerClosed, not a closed listener.
		edgeCtx := context.WithoutCancel(runCtx)
		wg.Go(func() {
			if err := disp.Serve(edgeCtx); err != nil {
				fatal <- fmt.Errorf("server: tls listener: %w", err)
			}
		})
		for _, c := range certs {
			wg.Go(func() { c.Run(runCtx) })
		}
	}
	if ls.SSH != nil && i.ssh != nil {
		ln := ls.SSH
		if i.cfg.ProxyProtocol {
			ln = edge.WrapProxyProtocol(ln, i.cfg.ProxyProtocolCIDRs, i.cfg.Timeouts.TLSHandshake)
		}
		wg.Go(func() { //nolint:contextcheck // SSH conns run on the sshgw server context, ended by Close
			if err := i.ssh.Serve(ln); err != nil {
				fatal <- fmt.Errorf("server: ssh listener: %w", err)
			}
		})
	}
	wg.Go(func() { i.pingLoop(runCtx) })
	wg.Go(func() { i.limits.Run(runCtx) })
	close(i.runStarted)

	var err error
	tunnelExited := false
	select {
	case <-ctx.Done():
	case <-i.drained:
	case err = <-fatal:
	case err = <-tunnelDone:
		tunnelExited = true
		if i.draining.Load() {
			// Drain shuts the internal listener down gracefully once the
			// tunnel drain is over; let it finish.
			select {
			case <-i.drained:
			case <-ctx.Done():
			}
		} else if err == nil {
			err = errors.New("server: tunnel gateway stopped")
		}
	}
	cancel()
	if !tunnelExited {
		if terr := <-tunnelDone; err == nil {
			err = terr
		}
	}
	// A cancelled ctx is a normal stop, also when the cancellation hit the
	// startup (the instance registration) and surfaced as a context error.
	if ctx.Err() != nil && (errors.Is(err, context.Canceled) || errors.Is(err, context.DeadlineExceeded)) {
		err = nil
	}
	_ = i.internal.Close()
	_ = i.metricsSrv.Close()
	for _, s := range i.edgeServers() {
		_ = s.Close()
	}
	if disp != nil {
		_ = disp.Close()
	}
	if i.ssh != nil {
		_ = i.ssh.Close()
	}
	// Hijacked conns (WebSocket) are not closed by Server.Close.
	i.streams.CloseAll()
	i.appTransports.CloseIdleConnections()
	i.upstream.Close()
	// The SSH listener when SSH is disabled is owned here too; the TLS
	// listener is closed by the dispatcher.
	for _, ln := range []net.Listener{ls.TLS, ls.SSH} {
		if ln != nil {
			_ = ln.Close()
		}
	}
	wg.Wait()
	return err
}

// pingLoop keeps sbx_gateway_dependency_up{dep="postgres"} current.
func (i *Instance) pingLoop(ctx context.Context) {
	t := time.NewTicker(i.pingEvery)
	defer t.Stop()
	for {
		pctx, cancel := context.WithTimeout(ctx, pingTimeout)
		err := i.deps.Pool.Ping(pctx)
		cancel()
		if ctx.Err() != nil {
			return
		}
		up := 1.0
		if err != nil {
			up = 0
			i.log.Warn("gateway: postgres ping failed", "err", err)
		}
		i.metrics.DependencyUp.WithLabelValues("postgres").Set(up)
		select {
		case <-ctx.Done():
			return
		case <-t.C:
		}
	}
}
