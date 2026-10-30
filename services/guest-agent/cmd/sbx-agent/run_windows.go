package main

import (
	"context"
	"errors"
	"fmt"
	"io"
	"log/slog"
	"os"
	"os/signal"
	"strings"

	"golang.org/x/sys/windows"
	"golang.org/x/sys/windows/svc"

	"github.com/belov38/boat-dev-clone/services/guest-agent/internal/agent"
	"github.com/belov38/boat-dev-clone/services/guest-agent/internal/config"
	"github.com/belov38/boat-dev-clone/services/guest-agent/internal/logx"
	"github.com/belov38/boat-dev-clone/services/guest-agent/internal/supervisor"
	"github.com/belov38/boat-dev-clone/services/guest-agent/internal/update"
)

// The agent log: <LogDir>\agent.log, 10 files of 10 MiB (S9 spec 12.1).
const (
	agentLogName  = "agent.log"
	agentLogBytes = 10 << 20
	agentLogKeep  = 10
)

// runAgent implements `sbx-agent run [--debug-listen unix:<path>
// [--debug-confirm]]` on Windows. Under the service control manager it runs
// the sbx-agent service (serviceHandler); otherwise it runs in the console
// until Ctrl+C (tests, debugging).
func runAgent(ctx context.Context, d deps, args []string, stderr io.Writer) int {
	o, ok := parseRunFlags(args, stderr)
	if !ok {
		return 2
	}
	inService, err := svc.IsWindowsService()
	if err != nil {
		_, _ = fmt.Fprintf(stderr, "sbx-agent run: %v\n", err)
		return 1
	}
	if !inService {
		ctx, stop := signal.NotifyContext(ctx, os.Interrupt)
		defer stop()
		return runWindowsAgent(ctx, d, o, stderr, agentHooks{})
	}
	h := &serviceHandler{
		// A service has no usable stderr: the log goes to the file only.
		run: func(ctx context.Context, hooks agentHooks) int {
			return runWindowsAgent(ctx, d, o, io.Discard, hooks)
		},
		exit: os.Exit,
	}
	if err := svc.Run(update.AgentService, h); err != nil {
		_, _ = fmt.Fprintf(stderr, "sbx-agent run: %v\n", err)
		return 1
	}
	return 0
}

// runWindowsAgent runs the agent once and returns the exit code; the log is
// flushed when it returns.
func runWindowsAgent(ctx context.Context, d deps, o runOptions, stderr io.Writer, hooks agentHooks) int {
	if d.failRun {
		_, _ = io.WriteString(stderr, "sbx-agent run: this build has failRun set (integration test package), exiting\n")
		return 1
	}
	w := stderr
	logFile, logErr := logx.NewRotatingFile(d.layout.LogDir, agentLogName, agentLogBytes, agentLogKeep)
	if logErr == nil {
		defer func() { _ = logFile.Close() }()
		if stderr == io.Discard {
			w = logFile
		} else {
			w = io.MultiWriter(stderr, logFile)
		}
	}
	h := logx.NewHandler(w, slog.LevelInfo, logBuffer)
	defer closeLog(h)
	log := slog.New(h)
	slog.SetDefault(log)
	if logErr != nil {
		log.Warn("agent: no log file, logging to stderr", "err", logErr)
	}
	if hooks.service {
		// The Windows form of CPUWeight: the agent stays responsive
		// under a busy sandbox.
		if err := windows.SetPriorityClass(windows.CurrentProcess(), windows.ABOVE_NORMAL_PRIORITY_CLASS); err != nil {
			log.Warn("agent: set process priority", "err", err)
		}
	}

	cfg, err := config.Load(d.layout.ConfigFile)
	if err != nil {
		log.Error("agent: load config", "err", err)
		return 1
	}
	ad, cleanup, err := platformAgentDeps(ctx, d)
	if err != nil {
		log.Error("agent: platform", "err", err)
		return 1
	}
	defer cleanup()
	ad.SdNotify = hooks.notify
	ad.PreShutdown = hooks.preShutdown
	ad.LogDropped = h.Dropped
	ad.Log = log
	ad.DebugListen = o.debugListen
	ad.DebugConfirm = o.debugConfirm
	if err := agent.Run(ctx, d.layout, cfg, d.version, ad); err != nil {
		log.Error("agent: stopped with an error", "err", err)
		return 1
	}
	log.Info("agent: stopped")
	return 0
}

// platformAgentDeps returns the Windows parts of agent.Deps: the Windows
// supervisor and the boot id of the identity source. Task 17 completes the
// wiring (Windows resetter, early wait, admin socket); cleanup releases what
// it opened.
func platformAgentDeps(ctx context.Context, d deps) (agent.Deps, func(), error) {
	sup, err := supervisor.NewWindows(d.layout)
	if err != nil {
		return agent.Deps{}, nil, err
	}
	src := d.source
	return agent.Deps{
		Supervisor:  sup,
		IdentSource: src,
		Resetter:    d.resetter,
		Freezer:     d.freezer,
		Statfs:      d.statfs,
		BootID: func() (string, error) {
			raw, err := src.Read(ctx)
			if err != nil {
				return "", err
			}
			if id := strings.TrimSpace(raw.BootID); id != "" {
				return id, nil
			}
			return "", errors.New("agent: the identity source has no boot id")
		},
	}, func() { _ = sup.Close() }, nil
}
