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

	"github.com/belov38/boat-dev-clone/libs/tunnel/gateway"
	"github.com/belov38/boat-dev-clone/libs/tunnel/registry"
	"github.com/belov38/boat-dev-clone/services/gateway/internal/config"
	"github.com/belov38/boat-dev-clone/services/gateway/internal/cpapi"
	"github.com/belov38/boat-dev-clone/services/gateway/internal/obs"
	"github.com/belov38/boat-dev-clone/services/gateway/internal/routes"
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
	// pingInterval and pingTimeout drive the postgres dependency gauge.
	pingInterval = 10 * time.Second
	pingTimeout  = 5 * time.Second
	// metricsReadHeaderTimeout bounds the request headers on the metrics
	// listener.
	metricsReadHeaderTimeout = 10 * time.Second
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

	internal   *http.Server
	metricsSrv *http.Server

	pingEvery time.Duration

	started       atomic.Bool
	draining      atomic.Bool
	listenStarted atomic.Bool
	drainOnce     sync.Once
	drained       chan struct{} // closed when Drain finished

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
	if deps.Logger == nil {
		deps.Logger = slog.Default()
	}
	if deps.AccessLog == nil {
		deps.AccessLog = io.Discard
	}
	if deps.Now == nil {
		deps.Now = time.Now
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
	}
	i.reg.MustRegister(collectors.NewGoCollector(), collectors.NewProcessCollector(collectors.ProcessCollectorOpts{}))
	i.metrics = obs.NewMetrics(i.reg)
	i.routes = routes.NewCache(deps.API, routes.CacheConfig{Timeout: cfg.Timeouts.RouteLookup, Now: deps.Now}, i.metrics)
	i.owners = registry.NewOwnerCache(i.store, staleAfter, 0)

	timing := deps.Timing
	timing.TCPDeadline = cfg.SSHDrainDeadline
	gcfg := gateway.Config{
		InstanceID:              cfg.InstanceID,
		InternalURL:             cfg.InternalURL,
		Store:                   i.store,
		ServiceTokens:           cfg.ServiceTokens,
		MinAgentVersion:         cfg.MinAgentVersion,
		MaxTCPStreamsPerMachine: maxTCPStreamsPerMachine,
		OnInstanceChange:        i.onInstanceChange,
		OnSessionChange:         i.owners.Invalidate,
		ListenChannels: map[string]func(string){
			ChannelRoutes:    i.onRoutesNotify,
			ChannelSSHRevoke: i.onRevokeNotify,
		},
		Timing: timing,
		Logger: deps.Logger,
	}
	if cfg.APIURL != "" {
		gcfg.Sink = gateway.NewHTTPSink(cfg.APIURL, cfg.APIToken, nil)
	}
	g, err := gateway.New(gcfg)
	if err != nil {
		return nil, fmt.Errorf("server: %w", err)
	}
	i.tunnel = g

	i.internal = gateway.NewInternalServer(g.InternalHandler())
	i.internal.IdleTimeout = internalIdleTimeout
	i.metricsSrv = &http.Server{Handler: i.MetricsHandler(), ReadHeaderTimeout: metricsReadHeaderTimeout}
	return i, nil
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

// onRoutesNotify runs on the LISTEN goroutine. "" follows every (re)LISTEN:
// notifications may have been missed, so the cache is flushed. A lost
// connection alone flushes nothing, so cached routes keep being served
// during a Postgres outage.
func (i *Instance) onRoutesNotify(payload string) {
	if payload == "" {
		i.listenStarted.Store(true)
		i.routes.Flush()
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

// Run serves the non-nil listeners and runs the tunnel gateway until ctx is
// done, Drain finished, or a server fails. It then stops everything, closes
// the listeners and returns the first error (nil for a normal stop). Run may
// be called only once.
func (i *Instance) Run(ctx context.Context, ls Listeners) error {
	if !i.started.CompareAndSwap(false, true) {
		return errors.New("server: Run called twice")
	}
	runCtx, cancel := context.WithCancel(ctx)
	defer cancel()

	tunnelDone := make(chan error, 1)
	go func() { tunnelDone <- i.tunnel.Run(runCtx) }()

	var wg sync.WaitGroup
	fatal := make(chan error, 2)
	serve := func(name string, srv *http.Server, ln net.Listener) {
		wg.Go(func() {
			if err := srv.Serve(ln); !errors.Is(err, http.ErrServerClosed) {
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
	wg.Go(func() { i.pingLoop(runCtx) })

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
	_ = i.internal.Close()
	_ = i.metricsSrv.Close()
	// Listeners without a server yet (TLS, plain, SSH) are owned here too.
	for _, ln := range []net.Listener{ls.TLS, ls.Plain, ls.SSH} {
		if ln != nil {
			_ = ln.Close()
		}
	}
	wg.Wait()
	return err
}

// Drain takes the instance out of service: Ready turns false, the tunnel
// gateway drains (spec 7), and then the internal listener is shut down
// gracefully so proxied streams can finish. Run returns afterwards. Drain is
// idempotent; Run must have been started.
func (i *Instance) Drain(ctx context.Context) error {
	i.draining.Store(true)
	err := i.tunnel.Drain(ctx)
	if serr := i.internal.Shutdown(ctx); serr != nil {
		err = errors.Join(err, fmt.Errorf("server: internal listener shutdown: %w", serr))
	}
	i.drainOnce.Do(func() { close(i.drained) })
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
