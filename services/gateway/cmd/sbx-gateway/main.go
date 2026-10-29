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
	drainSlack = 30 * time.Second
	// forcedStopWait is how long a second signal waits for the listeners
	// to close before the process exits anyway.
	forcedStopWait = 5 * time.Second
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
func loadConfig() (config.Config, error) {
	cfg, err := config.FromEnv(os.Getenv)
	if err != nil {
		return config.Config{}, err
	}
	if err := cfg.ValidateServe(); err != nil {
		return config.Config{}, err
	}
	return cfg, nil
}

func checkConfig() int {
	if _, err := loadConfig(); err != nil {
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

// serve runs the gateway until a signal. The first SIGTERM or SIGINT
// drains it (spec 10); a second one stops it at once.
func serve() int {
	cfg, err := loadConfig()
	if err != nil {
		fmt.Fprintln(os.Stderr, "sbx-gateway:", err)
		return 1
	}
	log := slog.New(slog.NewJSONHandler(os.Stderr, &slog.HandlerOptions{Level: logLevel(cfg.LogLevel)}))
	slog.SetDefault(log)
	log.Info("gateway: starting", "version", version, "instance_id", cfg.InstanceID,
		"sbx_domain", cfg.SbxDomain, "tunnel_host", cfg.TunnelHost, "api", cfg.APIURL)

	// Signals are caught before anything else, so an early SIGTERM is not
	// the default (immediate) exit.
	sigs := make(chan os.Signal, 2)
	signal.Notify(sigs, syscall.SIGTERM, syscall.SIGINT)
	defer signal.Stop(sigs)

	pool, err := pgxpool.New(context.Background(), cfg.DatabaseURL)
	if err != nil {
		log.Error("gateway: database", "err", err)
		return 1
	}
	defer pool.Close()

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
		AccessLog: os.Stdout,
		Timing:    timing,
	})
	if err != nil {
		log.Error("gateway: setup", "err", err)
		return 1
	}
	ls, err := listen(cfg)
	if err != nil {
		log.Error("gateway: listen", "err", err)
		return 1
	}

	runCtx, stopRun := context.WithCancel(context.Background())
	defer stopRun()
	runDone := make(chan error, 1)
	go func() { runDone <- inst.Run(runCtx, ls) }()

	select {
	case err := <-runDone:
		if err != nil {
			log.Error("gateway: stopped", "err", err)
			return 1
		}
		return 0
	case sig := <-sigs:
		budget := cfg.DrainTimeout
		if budget <= 0 {
			budget = server.DrainBudget(cfg, timing) + drainSlack
		}
		log.Info("gateway: signal, draining", "signal", sig.String(), "timeout", budget.String())
		return drain(log, inst, budget, sigs, stopRun, runDone)
	}
}

// drain runs the instance drain bounded by budget. A second signal cancels
// it and stops the instance at once.
func drain(log *slog.Logger, inst *server.Instance, budget time.Duration, sigs <-chan os.Signal, stopRun func(), runDone <-chan error) int {
	ctx, cancel := context.WithTimeout(context.Background(), budget)
	defer cancel()
	drainDone := make(chan error, 1)
	go func() { drainDone <- inst.Drain(ctx) }()

	select {
	case err := <-drainDone:
		// Run returns once the drain is over.
		rerr := <-runDone
		if err != nil || rerr != nil {
			log.Error("gateway: drain ended with errors", "drain_err", err, "run_err", rerr)
			return 1
		}
		log.Info("gateway: exiting after a clean drain")
		return 0
	case sig := <-sigs:
		log.Warn("gateway: second signal, stopping now", "signal", sig.String())
		cancel()
		stopRun()
		select {
		case err := <-runDone:
			if err != nil {
				log.Warn("gateway: stopped", "err", err)
			}
		case <-time.After(forcedStopWait):
		}
		return 1
	case err := <-runDone:
		log.Error("gateway: stopped during the drain", "err", err)
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
	created, err := devsecrets.Generate(devsecrets.Options{
		Dir: *dir, Domain: *domain, TunnelHost: *tunnelHost, SSHHost: *sshHost,
		Owner: o, WorkerOwner: wo,
	})
	for _, name := range created {
		fmt.Println("created", name)
	}
	if err != nil {
		fmt.Fprintln(os.Stderr, "sbx-gateway dev-secrets:", err)
		return 1
	}
	if len(created) == 0 {
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
