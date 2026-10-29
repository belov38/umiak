package main

import (
	"context"
	"encoding/json"
	"flag"
	"fmt"
	"io"
	"log/slog"
	"os"
	"os/signal"
	"syscall"
	"time"

	"github.com/coreos/go-systemd/v22/daemon"

	"github.com/belov38/boat-dev-clone/services/guest-agent/internal/agent"
	"github.com/belov38/boat-dev-clone/services/guest-agent/internal/config"
	"github.com/belov38/boat-dev-clone/services/guest-agent/internal/docker"
	"github.com/belov38/boat-dev-clone/services/guest-agent/internal/logx"
	"github.com/belov38/boat-dev-clone/services/guest-agent/internal/supervisor"
)

const (
	// logBuffer is the number of log records that may wait for stderr.
	logBuffer = 4096
	// logCloseTimeout bounds the final log flush: stderr may block forever
	// (a frozen journal filesystem), the agent must still exit.
	logCloseTimeout = 2 * time.Second
)

// runAgent implements `sbx-agent run [--debug-listen unix:<path>
// [--debug-confirm]]`, the daemon of sbx-agent.service.
func runAgent(ctx context.Context, d deps, args []string, stderr io.Writer) int {
	fs := flag.NewFlagSet("run", flag.ContinueOnError)
	fs.SetOutput(stderr)
	debugListen := fs.String("debug-listen", "", "test aid: also serve the agent API and Control/Info on unix:<path>")
	debugConfirm := fs.Bool("debug-confirm", false, "test aid: Control/Info on the debug socket confirms a pending update without a tunnel")
	if err := fs.Parse(args); err != nil || fs.NArg() != 0 || (*debugConfirm && *debugListen == "") {
		_, _ = io.WriteString(stderr, "usage: sbx-agent run [--debug-listen unix:<path> [--debug-confirm]]\n")
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
	sup, err := supervisor.NewSystemd(supervisor.DefaultSlice, supervisor.DefaultCgroupRoot)
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
		DebugListen:  *debugListen,
		DebugConfirm: *debugConfirm,
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

// closeLog flushes the async log handler, giving up after logCloseTimeout.
func closeLog(h *logx.Handler) {
	done := make(chan struct{})
	go func() {
		h.Close()
		close(done)
	}()
	select {
	case <-done:
	case <-time.After(logCloseTimeout):
	}
}

// doctorCmd implements `sbx-agent doctor [--json]` (spec 17.6).
func doctorCmd(ctx context.Context, d deps, args []string, stdout, stderr io.Writer) int {
	fs := flag.NewFlagSet("doctor", flag.ContinueOnError)
	fs.SetOutput(stderr)
	asJSON := fs.Bool("json", false, "print JSON")
	if err := fs.Parse(args); err != nil || fs.NArg() != 0 {
		_, _ = io.WriteString(stderr, "usage: sbx-agent doctor [--json]\n")
		return 2
	}
	cfg, err := config.Load(d.layout.ConfigFile)
	if err != nil {
		_, _ = fmt.Fprintf(stderr, "sbx-agent doctor: %v; using the default config\n", err)
		cfg = config.Defaults()
	}
	rep := agent.Doctor(ctx, d.layout, cfg, agent.DoctorOptions{
		Source:   d.source,
		IsActive: d.isActive,
		Statfs:   d.statfs,
		TestAids: d.testAids(),
	})
	if !*asJSON {
		rep.WriteText(stdout)
		return 0
	}
	enc := json.NewEncoder(stdout)
	enc.SetIndent("", "  ")
	if err := enc.Encode(rep); err != nil {
		_, _ = fmt.Fprintf(stderr, "sbx-agent doctor: %v\n", err)
		return 1
	}
	return 0
}
