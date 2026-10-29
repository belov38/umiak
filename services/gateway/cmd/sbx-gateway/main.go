// Command sbx-gateway is the edge of the sandbox platform: HTTPS preview
// proxy, SSH gateway and the tunnel endpoint for guest agents.
//
//	sbx-gateway [serve]          run the gateway (configuration: SBX_GATEWAY_* env)
//	sbx-gateway check-config     validate the environment and exit
//	sbx-gateway dev-secrets -dir <dir> [flags]
//	                             create the missing local development secrets
//	sbx-gateway healthcheck [-url <url>]
//	                             exit 0 when the URL answers 200 (container healthcheck)
//	sbx-gateway version
package main

import (
	"context"
	"flag"
	"fmt"
	"io"
	"log/slog"
	"net"
	"net/http"
	"os"
	"os/signal"
	"syscall"
	"time"

	"github.com/jackc/pgx/v5/pgxpool"

	"github.com/belov38/boat-dev-clone/libs/tunnel/gateway"
	"github.com/belov38/boat-dev-clone/services/gateway/internal/config"
	"github.com/belov38/boat-dev-clone/services/gateway/internal/cpapi"
	"github.com/belov38/boat-dev-clone/services/gateway/internal/devsecrets"
	"github.com/belov38/boat-dev-clone/services/gateway/internal/server"
)

// version is set with -ldflags "-X main.version=...".
var version = "dev"

const (
	// apiTimeout bounds every call to api; the route lookup has its own,
	// shorter budget in the route cache.
	apiTimeout = 3 * time.Second
	// drainSlack is added to the drain budget for the process's drain
	// context: 920 s + 30 s = 950 s with the defaults, inside the 960 s
	// grace period.
	drainSlack = config.DrainProcessMargin
	// forcedStopWait is how long a second signal waits for the listeners
	// to close before the process exits anyway.
	forcedStopWait = 5 * time.Second
	// runStopWait bounds the wait for Run after a finished drain (the
	// tunnel shutdown closes sessions and deletes the instance row).
	runStopWait = 30 * time.Second
	// healthcheckTimeout bounds the healthcheck request.
	healthcheckTimeout = 3 * time.Second
)

const usage = `usage:
  sbx-gateway [serve]
  sbx-gateway check-config
  sbx-gateway dev-secrets -dir <dir> [-domain sbx.localhost] [-tunnel-host tunnel.localhost] [-ssh-host ssh.localhost] [-owner uid:gid] [-worker-owner uid:gid]
  sbx-gateway healthcheck [-url http://127.0.0.1:9090/readyz]
  sbx-gateway version`

func main() {
	os.Exit(run(os.Args[1:]))
}

func run(args []string) int {
	cmd := "serve"
	if len(args) > 0 {
		cmd, args = args[0], args[1:]
	}
	switch cmd {
	case "serve":
		if len(args) == 0 {
			return serve()
		}
	case "version":
		if len(args) == 0 {
			fmt.Println(version)
			return 0
		}
	case "check-config":
		if len(args) == 0 {
			return checkConfig()
		}
	case "dev-secrets":
		return devSecrets(args)
	case "healthcheck":
		return healthcheck(args)
	}
	fmt.Fprintln(os.Stderr, usage)
	return 2
}

// loadConfig reads the environment and adds the checks of a serving process.
func loadConfig(getenv func(string) string) (config.Config, error) {
	cfg, err := config.FromEnv(getenv)
	if err != nil {
		return config.Config{}, err
	}
	if err := cfg.ValidateServe(); err != nil {
		return config.Config{}, err
	}
	return cfg, nil
}

func checkConfig() int {
	if _, err := loadConfig(os.Getenv); err != nil {
		fmt.Fprintln(os.Stderr, err)
		return 1
	}
	return 0
}

func logLevel(s string) slog.Level {
	switch s {
	case "debug":
		return slog.LevelDebug
	case "warn":
		return slog.LevelWarn
	case "error":
		return slog.LevelError
	}
	return slog.LevelInfo
}

// serve runs serveWith on the process environment and signals.
func serve() int {
	// Signals are caught before anything else, so an early SIGTERM drains
	// instead of killing the process.
	sigs := make(chan os.Signal, 2)
	signal.Notify(sigs, syscall.SIGTERM, syscall.SIGINT)
	defer signal.Stop(sigs)
	return serveWith(serveOptions{getenv: os.Getenv, sigs: sigs, stdout: os.Stdout, stderr: os.Stderr})
}

// serveOptions are the process inputs of serveWith; tests pass their own.
type serveOptions struct {
	getenv func(string) string
	sigs   <-chan os.Signal
	stdout io.Writer // access log
	stderr io.Writer // process log
	// beforeRun runs on the Run goroutine just before Run (a test hook to
	// widen the startup window).
	beforeRun func()
}

// serveWith runs the gateway until a signal. The first SIGTERM or SIGINT
// drains it (spec 10); a second one stops it at once. It returns the exit
// status.
func serveWith(o serveOptions) int {
	cfg, err := loadConfig(o.getenv)
	if err != nil {
		_, _ = fmt.Fprintln(o.stderr, "sbx-gateway:", err)
		return 1
	}
	log := slog.New(slog.NewJSONHandler(o.stderr, &slog.HandlerOptions{Level: logLevel(cfg.LogLevel)}))
	slog.SetDefault(log)
	log.Info("gateway: starting", "version", version, "instance_id", cfg.InstanceID,
		"sbx_domain", cfg.SbxDomain, "tunnel_host", cfg.TunnelHost, "api", cfg.APIURL)

	pool, err := pgxpool.New(context.Background(), cfg.DatabaseURL)
	if err != nil {
		log.Error("gateway: database", "err", err)
		return 1
	}
	// The pool is closed only once Run returned: pool.Close waits for the
	// acquired conns, which a stuck Run may hold, and a forced exit must not
	// wait for it.

	var api cpapi.Client
	if cfg.APIURL == config.APIURLNone {
		log.Warn("gateway: SBX_GATEWAY_API_URL=none, running without api: routes answer 503 route_lookup_unavailable, SSH logins fail, agent events are dropped")
		api = cpapi.Unavailable()
	} else {
		api = cpapi.NewHTTPClient(cfg.APIURL, cfg.APIToken, &http.Client{Timeout: apiTimeout})
	}

	timing := gateway.Timing{EndpointWait: cfg.EndpointWait}
	inst, err := server.New(cfg, server.Deps{
		Pool:      pool,
		API:       api,
		Logger:    log,
		AccessLog: o.stdout,
		Timing:    timing,
	})
	if err != nil {
		pool.Close()
		log.Error("gateway: setup", "err", err)
		return 1
	}
	ls, err := listen(cfg)
	if err != nil {
		pool.Close()
		log.Error("gateway: listen", "err", err)
		return 1
	}

	runCtx, stopRun := context.WithCancel(context.Background())
	defer stopRun()
	runDone := make(chan error, 1)
	go func() {
		if o.beforeRun != nil {
			o.beforeRun()
		}
		runDone <- inst.Run(runCtx, ls)
	}()

	var sig os.Signal
	select {
	case err := <-runDone:
		pool.Close()
		if err != nil {
			log.Error("gateway: stopped", "err", err)
			return 1
		}
		return 0
	case sig = <-o.sigs:
	}
	budget := cfg.DrainTimeout
	if budget <= 0 {
		budget = server.DrainBudget(cfg, timing) + drainSlack
	}
	log.Info("gateway: signal, draining", "signal", sig.String(), "timeout", budget.String())
	return drain(log, inst, pool, budget, o.sigs, stopRun, runDone)
}

// drain runs the instance drain bounded by budget, then waits for Run. A
// second signal at any point cancels the drain and Run and exits within
// forcedStopWait.
func drain(log *slog.Logger, inst *server.Instance, pool *pgxpool.Pool, budget time.Duration,
	sigs <-chan os.Signal, stopRun func(), runDone <-chan error,
) int {
	ctx, cancel := context.WithTimeout(context.Background(), budget)
	defer cancel()
	drainDone := make(chan error, 1)
	go func() { drainDone <- inst.Drain(ctx) }()

	// stopNow cancels everything and waits at most forcedStopWait for Run;
	// the pool is closed only when Run returned.
	stopNow := func() int {
		cancel()
		stopRun()
		select {
		case err := <-runDone:
			if err != nil {
				log.Warn("gateway: stopped", "err", err)
			}
			pool.Close()
		case <-time.After(forcedStopWait):
			log.Warn("gateway: Run did not stop in time, exiting anyway")
		}
		return 1
	}

	select {
	case derr := <-drainDone:
		if derr != nil {
			// Run may still serve (the drain never reached it): stop it.
			log.Error("gateway: drain failed, stopping", "err", derr)
			stopRun()
		}
		// Run returns once the drain is over.
		select {
		case rerr := <-runDone:
			pool.Close()
			if derr != nil || rerr != nil {
				log.Error("gateway: drain ended with errors", "drain_err", derr, "run_err", rerr)
				return 1
			}
			log.Info("gateway: exiting after a clean drain")
			return 0
		case sig := <-sigs:
			log.Warn("gateway: second signal, stopping now", "signal", sig.String())
			return stopNow()
		case <-time.After(runStopWait):
			log.Error("gateway: Run did not return after the drain, stopping")
			return stopNow()
		}
	case sig := <-sigs:
		log.Warn("gateway: second signal, stopping now", "signal", sig.String())
		return stopNow()
	case err := <-runDone:
		log.Error("gateway: stopped during the drain", "err", err)
		cancel()
		select {
		case derr := <-drainDone:
			if derr != nil {
				log.Warn("gateway: drain", "err", derr)
			}
			pool.Close()
		case <-time.After(forcedStopWait):
		}
		return 1
	}
}

// listen opens the configured listeners. An empty address (or "off" for
// the metrics listener) opens none.
func listen(cfg config.Config) (server.Listeners, error) {
	var ls server.Listeners
	var opened []net.Listener
	for _, l := range []struct {
		dst        *net.Listener
		name, addr string
	}{
		{&ls.Internal, "internal", cfg.InternalListen},
		{&ls.Metrics, "metrics", cfg.MetricsListen},
		{&ls.TLS, "tls", cfg.TLSListen},
		{&ls.Plain, "http", cfg.HTTPListen},
		{&ls.SSH, "ssh", cfg.SSHListen},
	} {
		if l.addr == "" || l.addr == "off" {
			continue
		}
		ln, err := (&net.ListenConfig{}).Listen(context.Background(), "tcp", l.addr)
		if err != nil {
			for _, o := range opened {
				_ = o.Close()
			}
			return server.Listeners{}, fmt.Errorf("%s listener %s: %w", l.name, l.addr, err)
		}
		opened = append(opened, ln)
		*l.dst = ln
	}
	return ls, nil
}

func devSecrets(args []string) int {
	fs := flag.NewFlagSet("dev-secrets", flag.ContinueOnError)
	dir := fs.String("dir", "", "output directory (created when missing)")
	domain := fs.String("domain", devsecrets.DefaultDomain, "sbx domain: the certificate covers *.<domain>")
	tunnelHost := fs.String("tunnel-host", devsecrets.DefaultTunnelHost, "tunnel host name of the agents")
	sshHost := fs.String("ssh-host", devsecrets.DefaultSSHHost, "SSH host name (host key comments)")
	owner := fs.String("owner", "", "uid:gid that owns the created files (the gateway's user)")
	workerOwner := fs.String("worker-owner", "", "uid:gid that owns worker-gateway-token (the worker's user)")
	if err := fs.Parse(args); err != nil {
		return 2
	}
	if *dir == "" || fs.NArg() != 0 {
		fmt.Fprintln(os.Stderr, usage)
		return 2
	}
	o, err := devsecrets.ParseOwner(*owner)
	if err != nil {
		fmt.Fprintln(os.Stderr, "sbx-gateway dev-secrets:", err)
		return 2
	}
	wo, err := devsecrets.ParseOwner(*workerOwner)
	if err != nil {
		fmt.Fprintln(os.Stderr, "sbx-gateway dev-secrets:", err)
		return 2
	}
	written, err := devsecrets.Generate(devsecrets.Options{
		Dir: *dir, Domain: *domain, TunnelHost: *tunnelHost, SSHHost: *sshHost,
		Owner: o, WorkerOwner: wo,
	})
	for _, name := range written {
		fmt.Println("wrote", name)
	}
	if err != nil {
		fmt.Fprintln(os.Stderr, "sbx-gateway dev-secrets:", err)
		return 1
	}
	if len(written) == 0 {
		fmt.Println("all files exist in", *dir)
	}
	return 0
}

// healthcheck is the container healthcheck of an image without a shell.
func healthcheck(args []string) int {
	fs := flag.NewFlagSet("healthcheck", flag.ContinueOnError)
	url := fs.String("url", "http://127.0.0.1:9090/readyz", "URL that must answer 200")
	if err := fs.Parse(args); err != nil || fs.NArg() != 0 {
		return 2
	}
	ctx, cancel := context.WithTimeout(context.Background(), healthcheckTimeout)
	defer cancel()
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, *url, nil)
	if err != nil {
		fmt.Fprintln(os.Stderr, "sbx-gateway healthcheck:", err)
		return 2
	}
	resp, err := http.DefaultClient.Do(req)
	if err != nil {
		fmt.Fprintln(os.Stderr, "sbx-gateway healthcheck:", err)
		return 1
	}
	_, _ = io.Copy(io.Discard, io.LimitReader(resp.Body, 4<<10))
	_ = resp.Body.Close()
	if resp.StatusCode != http.StatusOK {
		fmt.Fprintln(os.Stderr, "sbx-gateway healthcheck:", resp.Status)
		return 1
	}
	return 0
}
