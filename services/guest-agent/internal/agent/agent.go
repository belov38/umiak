// Package agent wires the guest agent together: `sbx-agent run` (the startup
// sequence of spec section 6, the services behind the tunnel, the background
// loops, status.json and the graceful shutdown) and `sbx-agent doctor`
// (section 17.6).
package agent

import (
	"context"
	"errors"
	"io/fs"
	"log/slog"
	"net/http"
	"net/netip"
	"os"
	"strings"
	"sync"
	"time"

	"github.com/belov38/boat-dev-clone/libs/tunnel/transport"

	"github.com/belov38/boat-dev-clone/services/guest-agent/internal/claim"
	"github.com/belov38/boat-dev-clone/services/guest-agent/internal/config"
	"github.com/belov38/boat-dev-clone/services/guest-agent/internal/events"
	"github.com/belov38/boat-dev-clone/services/guest-agent/internal/files"
	"github.com/belov38/boat-dev-clone/services/guest-agent/internal/ident"
	"github.com/belov38/boat-dev-clone/services/guest-agent/internal/output"
	"github.com/belov38/boat-dev-clone/services/guest-agent/internal/paths"
	"github.com/belov38/boat-dev-clone/services/guest-agent/internal/ports"
	"github.com/belov38/boat-dev-clone/services/guest-agent/internal/process"
	"github.com/belov38/boat-dev-clone/services/guest-agent/internal/quiesce"
	"github.com/belov38/boat-dev-clone/services/guest-agent/internal/readiness"
	"github.com/belov38/boat-dev-clone/services/guest-agent/internal/reqcache"
	"github.com/belov38/boat-dev-clone/services/guest-agent/internal/store"
	"github.com/belov38/boat-dev-clone/services/guest-agent/internal/supervisor"
	"github.com/belov38/boat-dev-clone/services/guest-agent/internal/system"
	"github.com/belov38/boat-dev-clone/services/guest-agent/internal/update"
)

// Defaults of the Deps timings.
const (
	DefaultIdentityRetry = 60 * time.Second
	DefaultStatusEvery   = 5 * time.Second
	DefaultJanitorEvery  = time.Second
	DefaultGCEvery       = time.Hour
)

// shutdownFlush bounds the final store flush; a filesystem frozen by someone
// else must not keep the agent from exiting.
const shutdownFlush = 5 * time.Second

// PreShutdownBudget bounds what Deps.PreShutdown triggers: ending the
// command jobs, the secrets wipe and the store flush. With the final
// shutdown flush it stays within the 15 s preshutdown timeout of the Windows
// service (S9 spec 12.2).
const PreShutdownBudget = 10 * time.Second

// preShutdownKill bounds ending the command jobs within PreShutdownBudget.
const preShutdownKill = 3 * time.Second

// bootIDPath is the kernel boot id.
const bootIDPath = "/proc/sys/kernel/random/boot_id"

// DockerClient is the Docker API the agent uses: quiesce pauses containers,
// the docker readiness phase pings the daemon. *docker.Client implements it.
type DockerClient interface {
	quiesce.DockerAPI
	Ping(ctx context.Context) error
}

// Deps holds every OS-specific piece of the running agent, so tests can run
// it with fakes on any OS. Nil fields take the production default unless
// noted otherwise.
type Deps struct {
	// Supervisor runs command shims and quiesce watchdogs. Required.
	Supervisor supervisor.Supervisor
	// IdentSource reads the smbios identity. Required.
	IdentSource ident.Source
	// Resetter applies an identity change to the running system. Required
	// unless WinBoot is set.
	Resetter ident.Resetter
	// WinBoot, when set, makes the start follow Windows (S9 spec 12.3, see
	// winboot.go): the Windows Setup and boot step gates before the S3
	// sequence, ident.ApplyWindows instead of ident.Apply, sshd started once
	// the identity is ready. Nil keeps the Linux start.
	WinBoot *WinBoot
	// Freezer freezes filesystems for quiesce; nil skips the freeze.
	Freezer quiesce.Freezer
	// Docker pauses containers and answers the docker phase ping; nil
	// skips both. It is ignored when [docker] enabled is false.
	Docker DockerClient
	// DockerActive reports whether docker.service is active; nil skips
	// the check.
	DockerActive func(ctx context.Context) bool
	// Dialer opens the tunnel transport. Nil dials the effective tunnel
	// URL over a WebSocket, trusting <trust>/tunnel-ca.pem.
	Dialer transport.Dialer
	// Now is the clock. Default time.Now.
	Now func() time.Time
	// SdNotify sends a state to systemd (Type=notify). Nil does nothing.
	SdNotify func(state string) error
	// BootID returns the kernel boot id. Default: read
	// /proc/sys/kernel/random/boot_id.
	BootID func() (string, error)
	// MountSecrets mounts the secrets tmpfs (claim.Options.MountSecrets).
	MountSecrets func(dir string) error
	// LookupUser resolves users for the claim (claim.Options.LookupUser).
	LookupUser func(name string) (*process.User, error)
	// Statfs reports the size and free space of a filesystem (output
	// janitor and doctor). Default output.DefaultStatfs.
	Statfs func(path string) (total, free uint64, err error)
	// ProcDir is the procfs root of the ports scanner ("" = /proc).
	ProcDir string
	// LocalAddrs lists the interface addresses a CONNECT to localhost tries
	// after the loopback ones (ports.Dialer.LocalAddrs). Default
	// ports.InterfaceAddrs.
	LocalAddrs func() []netip.Addr
	// ShimPath is the binary started as the shim. Default os.Executable.
	ShimPath string
	// Hostname returns the hostname for System/Info. Default os.Hostname.
	Hostname func() (string, error)
	// IdleSample is IdleLoop.Sample. Default system.NewSampler.
	IdleSample func() (cpuPercent float64, ioBytes uint64)
	// Metrics collects resource usage. Default system.GopsutilMetrics.
	Metrics system.MetricsSource
	// LogDropped reports the log records the async handler dropped
	// (logx.Handler.Dropped); nil reports 0.
	LogDropped func() uint64
	// Log is the agent logger. Default slog.Default().
	Log *slog.Logger

	// IdentityRetry is the identity re-read period while the identity
	// phase failed. Default 60 s.
	IdentityRetry time.Duration
	// StatusEvery is the status.json period. Default 5 s.
	StatusEvery time.Duration
	// JanitorEvery is the output janitor period. Default 1 s.
	JanitorEvery time.Duration
	// GCEvery is the version GC period. Default 1 h.
	GCEvery time.Duration

	// DebugListen, "unix:<path>", serves the agent mux and
	// sbx.tunnel.v1.Control/Info on a local socket (test and QGA aid,
	// see debug.go). Empty disables it.
	DebugListen string
	// DebugConfirm lets a Control/Info served on the debug socket confirm
	// a pending update without a tunnel connection.
	DebugConfirm bool

	// PreShutdown, when closed, makes the agent end every command (the
	// supervisor's KillCgroup, on Windows the command job), then wipe the
	// secrets and flush state.db like System/PrepareStop, all bounded by
	// PreShutdownBudget, and then stop as if its context ended: the
	// PRESHUTDOWN control of the Windows service (S9 spec 12.2). Nil never
	// fires.
	PreShutdown <-chan struct{}
}

// withDefaults fills the production defaults and checks the required fields.
func (d Deps) withDefaults() (Deps, error) {
	switch {
	case d.Supervisor == nil:
		return d, errors.New("agent: Deps.Supervisor is required")
	case d.IdentSource == nil:
		return d, errors.New("agent: Deps.IdentSource is required")
	case d.Resetter == nil && d.WinBoot == nil:
		return d, errors.New("agent: Deps.Resetter is required")
	}
	if d.WinBoot != nil {
		w, err := d.WinBoot.withDefaults()
		if err != nil {
			return d, err
		}
		d.WinBoot = w
	}
	if d.Now == nil {
		d.Now = time.Now
	}
	if d.SdNotify == nil {
		d.SdNotify = func(string) error { return nil }
	}
	if d.BootID == nil {
		d.BootID = readBootID
	}
	if d.ShimPath == "" {
		exe, err := os.Executable()
		if err != nil {
			return d, err
		}
		d.ShimPath = exe
	}
	if d.LogDropped == nil {
		d.LogDropped = func() uint64 { return 0 }
	}
	if d.Log == nil {
		d.Log = slog.Default()
	}
	if d.IdentityRetry <= 0 {
		d.IdentityRetry = DefaultIdentityRetry
	}
	if d.StatusEvery <= 0 {
		d.StatusEvery = DefaultStatusEvery
	}
	if d.JanitorEvery <= 0 {
		d.JanitorEvery = DefaultJanitorEvery
	}
	if d.GCEvery <= 0 {
		d.GCEvery = DefaultGCEvery
	}
	return d, nil
}

// readBootID reads the kernel boot id.
func readBootID() (string, error) {
	b, err := os.ReadFile(bootIDPath)
	if err != nil {
		return "", err
	}
	id := strings.TrimSpace(string(b))
	if id == "" {
		return "", errors.New("agent: empty boot id")
	}
	return id, nil
}

// agent is one run of the agent process.
type agent struct {
	l       paths.Layout
	cfg     config.Config
	version string
	d       Deps
	log     *slog.Logger

	// exit ends the run gracefully (update exit, identity change).
	exit context.CancelFunc

	bootID     string
	instanceID string
	// bootErr is the failure of the Windows boot step (or of the reboot
	// for the computer name); set during startup, read-only afterwards.
	bootErr error
	// firstBootWaited is set once the start waited for the clone
	// first-boot script (startup only).
	firstBootWaited bool
	monoRef         monoRef

	st       *store.Store
	emit     events.Emitter
	tracker  *readiness.Tracker
	quiesce  *quiesce.Manager
	claim    *claim.Manager
	proc     *process.Manager
	files    *files.Service
	ports    *ports.Scanner
	tcp      *ports.Counter
	updater  *update.Manager
	guard    *update.StartGuard // update deadline until CheckPending
	system   *system.Service
	idle     *system.IdleLoop
	gopsutil *system.GopsutilMetrics // nil when Deps.Metrics is set
	mux      http.Handler
	confirm  *confirmer
	reqcache *reqcache.Cache
	tunnel   *tunnelState
	identity *identityState

	stopOnce sync.Once

	// bg tracks the background goroutines that end with the run context.
	bg sync.WaitGroup
}

// Run is `sbx-agent run`: it starts the agent in the order of spec section 6
// and S5 17.3, serves until ctx ends or the agent asks to exit (an applied
// update, a changed identity), then shuts down: the tunnel closes, the
// process monitors stop, the store is flushed and closed. Command shims are
// left alone. A graceful shutdown returns nil.
func Run(ctx context.Context, l paths.Layout, cfg config.Config, version string, deps Deps) error {
	d, err := deps.withDefaults()
	if err != nil {
		return err
	}
	ctx, cancel := context.WithCancel(ctx)
	defer cancel()
	a := &agent{l: l, cfg: cfg, version: version, d: d, log: d.Log, exit: cancel}
	return a.run(ctx)
}

// run is Run after the defaults.
func (a *agent) run(ctx context.Context) error {
	err := a.startup(ctx)
	if err != nil {
		// Stopped during startup (SIGTERM) is a graceful exit. Checked
		// before shutdown, which cancels ctx itself.
		stopped := ctx.Err() != nil
		a.shutdown() //nolint:contextcheck // the shutdown outlives the cancelled run context
		if stopped {
			return nil
		}
		return err
	}
	select {
	case <-ctx.Done():
	case <-a.d.PreShutdown:
		a.preShutdown() //nolint:contextcheck // runs on its own budget while the run context is live
	}
	a.log.Info("agent: shutting down")
	a.notifyStopping()
	a.shutdown() //nolint:contextcheck // the shutdown outlives the cancelled run context
	return nil
}

// preShutdown ends the commands, wipes the secrets and flushes state.db
// through the claim manager, then ends the run. The commands go first: a
// process holding a secret file open would keep it on disk. PrepareStop
// also drops the secrets held in memory, so the quiesce auto-thaw of the
// shutdown cannot write the secret files back.
func (a *agent) preShutdown() {
	a.log.Info("agent: system shutdown, ending commands and wiping secrets")
	ctx, cancel := context.WithTimeout(context.Background(), PreShutdownBudget)
	defer cancel()
	a.killCommands(ctx)
	wiped, err := a.claim.PrepareStop(ctx)
	switch {
	case err != nil:
		a.log.Error("agent: wipe secrets before shutdown", "err", err)
	case !wiped:
		a.log.Warn("agent: some secret files are in use and stay on disk until the next boot")
	}
	a.exit()
}

// killCommands kills every command that has a command directory through the
// supervisor, within preShutdownKill. A command that is gone already is
// skipped.
func (a *agent) killCommands(ctx context.Context) {
	entries, err := os.ReadDir(a.l.CommandsDir)
	if err != nil {
		if !errors.Is(err, fs.ErrNotExist) {
			a.log.Warn("agent: list commands", "err", err)
		}
		return
	}
	ctx, cancel := context.WithTimeout(ctx, preShutdownKill)
	defer cancel()
	for _, e := range entries {
		if !e.IsDir() {
			continue
		}
		if ctx.Err() != nil {
			a.log.Warn("agent: no time left to end the commands")
			return
		}
		err := a.d.Supervisor.KillCgroup(ctx, e.Name())
		if err != nil && !errors.Is(err, supervisor.ErrUnitNotFound) {
			a.log.Warn("agent: end command", "id", e.Name(), "err", err)
		}
	}
}

// notifyStopping sends STOPPING=1 to systemd once.
func (a *agent) notifyStopping() {
	a.stopOnce.Do(func() {
		if err := a.d.SdNotify("STOPPING=1"); err != nil {
			a.log.Warn("agent: sd_notify STOPPING=1", "err", err)
		}
	})
}

// shutdown stops everything started so far, in reverse order. An active
// quiesce lease is thawed first: a reboot or poweroff must not leave the
// guest frozen, and the store flush below needs it thawed.
func (a *agent) shutdown() {
	if a.quiesce != nil {
		a.quiesce.AutoThaw(quiesce.ByAgentStop)
	}
	if a.guard != nil {
		a.guard.Stop()
	}
	a.exit() // ends the background goroutines also after a failed startup
	a.bg.Wait()
	if a.proc != nil {
		if err := a.proc.Close(); err != nil {
			a.log.Warn("agent: close process manager", "err", err)
		}
	}
	if a.tunnel != nil {
		a.tunnel.disconnected("agent stopped")
		a.writeStatus()
	}
	if a.st != nil {
		// One budget for both flushes. The request cache goes first: its
		// outcomes buffered during a freeze are lost once the store closes,
		// and a retry would run the mutation again.
		fctx, cancel := context.WithTimeout(context.Background(), shutdownFlush)
		if a.reqcache != nil {
			if err := a.reqcache.Flush(fctx); err != nil {
				a.log.Warn("agent: flush request cache", "err", err)
			}
		}
		if err := a.st.Flush(fctx); err != nil {
			a.log.Warn("agent: flush state.db", "err", err)
		}
		cancel()
		if err := a.st.Close(); err != nil {
			a.log.Warn("agent: close state.db", "err", err)
		}
	}
}

// goBG runs fn in a background goroutine tracked by a.bg.
func (a *agent) goBG(fn func()) {
	a.bg.Add(1)
	go func() {
		defer a.bg.Done()
		fn()
	}()
}

// startLoops starts the background loops; they end with ctx.
func (a *agent) startLoops(ctx context.Context) {
	janitor := &output.Janitor{
		Layout:       a.l,
		Store:        output.Default(),
		PerStream:    a.cfg.PerStreamBytes,
		Total:        a.cfg.TotalBytes,
		Fraction:     a.cfg.TotalFraction,
		Commands:     a.proc.JanitorCommands,
		Statfs:       a.d.Statfs,
		Emit:         a.emit,
		Now:          a.d.Now,
		RemoveRecord: a.proc.RemoveRecord,
	}
	activity := &system.ActivityLoop{Counts: a.proc, TCP: a.tcp, Emit: a.emit, Now: a.d.Now}
	var dockerPing func(context.Context) error
	if a.cfg.DockerEnabled && a.d.Docker != nil {
		dockerPing = a.d.Docker.Ping
	}

	a.goBG(func() { janitor.Run(ctx, a.d.JanitorEvery) })
	a.goBG(func() { a.files.Janitor(ctx) })
	a.goBG(func() { a.ports.Run(ctx) })
	a.goBG(func() { activity.Run(ctx) })
	a.goBG(func() { a.idle.Run(ctx) })
	if a.gopsutil != nil {
		a.goBG(func() { a.gopsutil.Run(ctx) })
	}
	a.goBG(func() { claim.WatchDocker(ctx, a.tracker, a.cfg.DockerEnabled, a.d.DockerActive, dockerPing) })
	a.goBG(func() { a.quiesce.RunProbe(ctx) })
	a.goBG(func() { a.statusLoop(ctx) })
	a.goBG(func() { a.gcLoop(ctx) })
	a.goBG(func() { a.confirm.run(ctx) })
}

// gcLoop removes old agent versions every GCEvery, keeping the versions of
// live shims (spec 17.4 step 7).
func (a *agent) gcLoop(ctx context.Context) {
	t := time.NewTicker(a.d.GCEvery)
	defer t.Stop()
	for {
		select {
		case <-ctx.Done():
			return
		case <-t.C:
		}
		keep, _ := update.ShimVersions(a.l, a.proc.UnitAlive)
		if err := a.updater.GC(keep); err != nil {
			a.log.Warn("agent: version gc", "err", err)
		}
	}
}
