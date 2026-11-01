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

	"github.com/belov38/umiak/services/guest-agent/internal/agent"
	"github.com/belov38/umiak/services/guest-agent/internal/config"
	"github.com/belov38/umiak/services/guest-agent/internal/logx"
	"github.com/belov38/umiak/services/guest-agent/internal/supervisor"
	"github.com/belov38/umiak/services/guest-agent/internal/update"
)

// The agent log: <LogDir>\agent.log (agentLogName), 10 files of 10 MiB (S9
// spec 12.1).
const (
	agentLogBytes = 10 << 20
	agentLogKeep  = 10
)

// runAgent implements `umiak-agent run [--debug-listen unix:<path>
// [--debug-confirm]]` on Windows. Under the service control manager it runs
// the umiak-agent service (serviceHandler); otherwise it runs in the console
// until Ctrl+C (tests, debugging).
func runAgent(ctx context.Context, d deps, args []string, stderr io.Writer) int {
	o, ok := parseRunFlags(args, stderr)
	if !ok {
		return 2
	}
	inService, err := svc.IsWindowsService()
	if err != nil {
		_, _ = fmt.Fprintf(stderr, "umiak-agent run: %v\n", err)
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
		_, _ = fmt.Fprintf(stderr, "umiak-agent run: %v\n", err)
		return 1
	}
	return 0
}

// runWindowsAgent runs the agent once and returns the exit code; the log is
// flushed when it returns.
func runWindowsAgent(ctx context.Context, d deps, o runOptions, stderr io.Writer, hooks agentHooks) int {
	if d.failRun {
		_, _ = io.WriteString(stderr, "umiak-agent run: this build has failRun set (integration test package), exiting\n")
		return 1
	}
	w := stderr
	logFile, logErr := logx.NewRotatingFile(d.layout.LogDir, agentLogName, agentLogBytes, agentLogKeep)
	var fallbackErr error
	if logErr != nil {
		// A service has no stderr: keep a log in the system temp directory
		// rather than none.
		logFile, fallbackErr = logx.NewRotatingFile(os.TempDir(), "umiak-"+agentLogName, agentLogBytes, 2)
	}
	if logErr == nil || fallbackErr == nil {
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
	switch {
	case logErr != nil && fallbackErr == nil:
		log.Warn("agent: cannot open the agent log, logging to the temp directory", "dir", os.TempDir(), "err", logErr)
	case logErr != nil:
		log.Warn("agent: no log file, logging to stderr", "err", logErr, "fallback_err", fallbackErr)
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
// supervisor, the boot id of the identity source, the Windows start
// (WinBoot: Windows Setup and boot step gates, ident.ApplyWindows in
// ModeService, sshd) and shims started from the version directory. The
// admin and env sockets come from the layout. cleanup releases what it
// opened.
func platformAgentDeps(ctx context.Context, d deps) (agent.Deps, func(), error) {
	if d.winResetter == nil {
		return agent.Deps{}, nil, errors.New("agent: no Windows identity resetter")
	}
	sup, err := supervisor.NewWindows(d.layout)
	if err != nil {
		return agent.Deps{}, nil, err
	}
	exe, err := d.executable()
	if err != nil {
		_ = sup.Close()
		return agent.Deps{}, nil, err
	}
	src := d.source
	return agent.Deps{
		Supervisor:  sup,
		IdentSource: src,
		WinBoot:     &agent.WinBoot{Resetter: d.winResetter},
		Freezer:     d.freezer,
		Statfs:      d.statfs,
		ShimPath:    versionShimPath(d.layout, exe, finalPath),
		BootID: func() (string, error) {
			// FirmwareSource falls back to a volatile registry id when the
			// boot counter cannot be read (S9 spec 12.4).
			raw, err := src.Read(ctx)
			if err != nil {
				return "", err
			}
			if id := strings.TrimSpace(raw.BootID); id != "" {
				return id, nil
			}
			return "", errors.New("agent: neither the boot counter nor the volatile registry key gives a boot id")
		},
	}, func() { _ = sup.Close() }, nil
}

// volumeNameDOS is VOLUME_NAME_DOS of GetFinalPathNameByHandle (a drive
// letter path); x/sys has no constant for it.
const volumeNameDOS = 0

// resolveBinary resolves the path of the running binary, which runs
// through the current junction on the system Path (finalPath).
func resolveBinary(path string) (string, error) {
	return finalPath(path)
}

// finalPath resolves path with junctions and symlinks followed
// (GetFinalPathNameByHandle): filepath.EvalSymlinks leaves junctions such
// as current alone since Go 1.23.
func finalPath(path string) (string, error) {
	p, err := windows.UTF16PtrFromString(path)
	if err != nil {
		return "", err
	}
	h, err := windows.CreateFile(p, 0, windows.FILE_SHARE_READ|windows.FILE_SHARE_WRITE|windows.FILE_SHARE_DELETE,
		nil, windows.OPEN_EXISTING, windows.FILE_FLAG_BACKUP_SEMANTICS, 0)
	if err != nil {
		return "", err
	}
	defer windows.CloseHandle(h) //nolint:errcheck // read-only use
	buf := make([]uint16, windows.MAX_LONG_PATH)
	n, err := windows.GetFinalPathNameByHandle(h, &buf[0], uint32(len(buf)), volumeNameDOS)
	if err != nil {
		return "", err
	}
	if int(n) > len(buf) {
		return "", errors.New("agent: final path too long")
	}
	s := windows.UTF16ToString(buf[:n])
	// \\?\C:\x -> C:\x; \\?\UNC\server\x -> \\server\x.
	if rest, ok := strings.CutPrefix(s, `\\?\UNC\`); ok {
		return `\\` + rest, nil
	}
	return strings.TrimPrefix(s, `\\?\`), nil
}
