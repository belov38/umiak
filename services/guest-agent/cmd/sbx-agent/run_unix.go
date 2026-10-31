//go:build !windows

package main

import (
	"context"
	"io"
	"log/slog"
	"os"
	"os/signal"
	"path/filepath"
	"syscall"

	"github.com/coreos/go-systemd/v22/daemon"

	"github.com/belov38/boat-dev-clone/services/guest-agent/internal/agent"
	"github.com/belov38/boat-dev-clone/services/guest-agent/internal/config"
	"github.com/belov38/boat-dev-clone/services/guest-agent/internal/docker"
	"github.com/belov38/boat-dev-clone/services/guest-agent/internal/logx"
	"github.com/belov38/boat-dev-clone/services/guest-agent/internal/supervisor"
)

// runAgent implements `sbx-agent run [--debug-listen unix:<path>
// [--debug-confirm]]`, the daemon of sbx-agent.service.
func runAgent(ctx context.Context, d deps, args []string, stderr io.Writer) int {
	o, ok := parseRunFlags(args, stderr)
	if !ok {
		return 2
	}

	if d.failRun {
		_, _ = io.WriteString(stderr, "sbx-agent run: this build has failRun set (integration test package), exiting\n")
		return 1
	}

	h := logx.NewHandler(stderr, slog.LevelInfo, logBuffer)
	defer closeLog(h)
	log := slog.New(h)
	slog.SetDefault(log)

	cfg, err := config.Load(d.layout.ConfigFile)
	if err != nil {
		log.Error("agent: load config", "err", err)
		return 1
	}
	// The D-Bus connection lives as long as its context. The shutdown
	// still needs it (stopping the quiesce watchdog unit after SIGTERM), so
	// no cancellation reaches it; it is closed by sup.Close.
	sup, err := supervisor.NewSystemd(context.WithoutCancel(ctx), supervisor.DefaultSlice, supervisor.DefaultCgroupRoot)
	if err != nil {
		log.Error("agent: connect to systemd", "err", err)
		return 1
	}
	defer func() { _ = sup.Close() }()

	var dockerClient agent.DockerClient
	if cfg.DockerEnabled {
		dockerClient = &docker.Client{}
	}
	ctx, stop := signal.NotifyContext(ctx, syscall.SIGTERM, os.Interrupt)
	defer stop()
	err = agent.Run(ctx, d.layout, cfg, d.version, agent.Deps{
		Supervisor:   sup,
		IdentSource:  d.source,
		Resetter:     d.resetter,
		Freezer:      d.freezer,
		Docker:       dockerClient,
		DockerActive: func(ctx context.Context) bool { return d.isActive(ctx, "docker.service") == "active" },
		SdNotify:     sdNotify,
		LogDropped:   h.Dropped,
		Log:          log,
		DebugListen:  o.debugListen,
		DebugConfirm: o.debugConfirm,
	})
	if err != nil {
		log.Error("agent: stopped with an error", "err", err)
		return 1
	}
	log.Info("agent: stopped")
	return 0
}

// sdNotify sends a state to systemd; outside a notify unit it does nothing.
func sdNotify(state string) error {
	_, err := daemon.SdNotify(false, state)
	return err
}

// serviceDeps keeps the systemd defaults of install-package, rollback and
// doctor.
func serviceDeps(*deps) {}

// resolveBinary resolves the symlinks of the path of the running binary.
func resolveBinary(path string) (string, error) {
	return filepath.EvalSymlinks(path)
}
