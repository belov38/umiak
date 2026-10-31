package main

import (
	"bytes"
	"context"
	"errors"
	"fmt"
	"io"
	"io/fs"
	"log/slog"
	"os"
	"os/exec"
	"strings"
	"time"

	"github.com/belov38/boat-dev-clone/services/guest-agent/internal/agent"
	"github.com/belov38/boat-dev-clone/services/guest-agent/internal/docker"
	"github.com/belov38/boat-dev-clone/services/guest-agent/internal/ident"
	"github.com/belov38/boat-dev-clone/services/guest-agent/internal/logx"
	"github.com/belov38/boat-dev-clone/services/guest-agent/internal/output"
	"github.com/belov38/boat-dev-clone/services/guest-agent/internal/paths"
	"github.com/belov38/boat-dev-clone/services/guest-agent/internal/quiesce"
	"github.com/belov38/boat-dev-clone/services/guest-agent/internal/update"
	"github.com/belov38/boat-dev-clone/services/guest-agent/packaging"
)

// deps holds what the CLI subcommands touch, so tests can point them at a
// temporary tree and fakes.
type deps struct {
	layout paths.Layout
	// version is the compiled agent version.
	version  string
	source   ident.Source
	resetter ident.Resetter
	// winResetter is set on Windows; it selects the Windows identity
	// apply, early and seal.
	winResetter ident.WinResetter
	stopAgent   func() error
	freezer     quiesce.Freezer
	docker      quiesce.DockerAPI

	// services starts and restarts the agent service (rollback).
	services update.ServiceManager
	// systemctl runs systemctl for the unit install of install-package
	// (Linux).
	systemctl func(args ...string) error
	// systemPath makes install-package add current to the system Path
	// (Windows).
	systemPath bool
	// doctorUnits and doctorService are the OS parts of doctor; nil
	// keeps the Linux defaults.
	doctorUnits   []agent.DoctorUnit
	doctorService func(ctx context.Context) *agent.ServiceReport
	// sleep pauses rollback.
	sleep func(time.Duration)
	// executable returns the path of the running binary (selftest).
	executable func() (string, error)
	// isActive returns `systemctl is-active <unit>` (doctor, docker phase).
	isActive func(ctx context.Context, unit string) string
	// statfs reports the size and free space of a filesystem (doctor).
	statfs func(path string) (total, free uint64, err error)
	// embeddedKeys, units and configTemplate are the packaging files
	// embedded in the binary.
	embeddedKeys   []byte
	units          fs.FS
	configTemplate []byte
	// failRun makes `run` exit 1 at once (the failRun build-time test aid).
	failRun bool
	// devKey reports a devUpdateKey build (doctor).
	devKey bool
	// stdin feeds `call ... -` and the input of exec.
	stdin io.Reader
	// newID returns the id of a command exec or selftest --pty starts;
	// nil uses newCommandID.
	newID func() string
}

// defaultDeps returns the production dependencies.
func defaultDeps() deps {
	l := paths.Default()
	d := deps{
		layout:  l,
		version: version,
		source: configuredSource{
			configFile: l.ConfigFile,
			bootIDPath: "/proc/sys/kernel/random/boot_id",
		},
		resetter:  ident.LinuxResetter{Layout: l},
		stopAgent: stopAgentService,
		freezer:   quiesce.NewFreezer(),
		docker:    &docker.Client{},

		services:       update.DefaultServiceManager(),
		systemctl:      update.Systemctl,
		sleep:          time.Sleep,
		executable:     os.Executable,
		isActive:       agent.SystemctlIsActive,
		statfs:         output.DefaultStatfs,
		embeddedKeys:   embeddedKeys(packaging.UpdateKeys, devUpdateKey),
		units:          packaging.Units,
		configTemplate: packaging.AgentTOML,
		failRun:        failRun == "1",
		devKey:         devUpdateKey != "",
		stdin:          os.Stdin,
	}
	platformDeps(&d)
	serviceDeps(&d)
	return d
}

// identityApply implements `sbx-agent identity apply [--specialize]`. An
// unreadable or malformed serial is logged and still exits 0: a machine
// without identity must boot, the agent then runs without a tunnel (spec
// section 7.1). --specialize is the Windows sysprep specialize pass.
func identityApply(ctx context.Context, d deps, args []string, stderr io.Writer) int {
	specialize := false
	for _, a := range args {
		if a != "--specialize" {
			_, _ = io.WriteString(stderr, usage)
			return 2
		}
		specialize = true
	}
	if specialize && d.winResetter == nil {
		_, _ = fmt.Fprintln(stderr, "sbx-agent identity apply: --specialize is Windows only")
		return 2
	}
	log := slog.New(slog.NewTextHandler(stderr, nil))
	if d.winResetter != nil {
		var closeLog func()
		log, closeLog = windowsLog(d, "identity.log", stderr)
		defer closeLog()
	}
	raw, err := d.source.Read(ctx)
	if err != nil {
		log.Warn("identity apply: cannot read the identity source, skipping", "err", err)
		return 0
	}
	id, err := ident.Parse(raw)
	if err != nil {
		log.Warn("identity apply: invalid identity, skipping", "err", err)
		return 0
	}
	for _, w := range id.Warnings {
		log.Warn("identity apply: " + w)
	}
	if d.winResetter != nil {
		return identityApplyWindows(ctx, d, id, specialize, log)
	}
	changed, err := ident.Apply(ctx, d.layout, id, d.resetter, false)
	if err != nil {
		log.Error("identity apply failed", "err", err)
		return 1
	}
	if changed {
		log.Info("identity applied", "machine_id", id.MachineID, "hostname", ident.DefaultHostname(id.MachineID))
	} else {
		log.Info("identity unchanged", "machine_id", id.MachineID)
	}
	return 0
}

// identityApplyWindows applies id on Windows. In the specialize pass it
// never reboots (Windows Setup does); otherwise it does nothing while
// Windows Setup runs, and reboots when the computer name changed.
func identityApplyWindows(ctx context.Context, d deps, id ident.Identity, specialize bool, log *slog.Logger) int {
	mode := ident.ModeEarly
	if specialize {
		mode = ident.ModeSpecialize
	} else if ident.SetupInProgress() {
		log.Info("identity apply: windows setup is in progress, skipping")
		return 0
	}
	changed, reboot, err := ident.ApplyWindows(ctx, d.layout, id, d.winResetter, mode)
	if err != nil {
		log.Error("identity apply failed", "err", err)
		return 1
	}
	if changed {
		log.Info("identity applied", "machine_id", id.MachineID, "computer_name", ident.WindowsComputerName(id.MachineID), "mode", mode.String())
	} else {
		log.Info("identity unchanged", "machine_id", id.MachineID)
	}
	if reboot {
		log.Info("rebooting to apply the computer name")
		if err := d.winResetter.Reboot("sbx identity changed"); err != nil {
			log.Error("reboot failed", "err", err)
			return 1
		}
	}
	return 0
}

// earlyCmd implements `sbx-agent early`, the Windows startup script.
func earlyCmd(ctx context.Context, d deps, args []string, stderr io.Writer) int {
	if len(args) != 0 {
		_, _ = io.WriteString(stderr, usage)
		return 2
	}
	if d.winResetter == nil {
		_, _ = fmt.Fprintln(stderr, "sbx-agent early: Windows only")
		return 2
	}
	log, closeLog := windowsLog(d, "early.log", stderr)
	defer closeLog()
	// A crash during a self-update can leave current missing; the service
	// cannot start without it (its image path is under current).
	if v, err := update.RepairCurrent(d.layout); err != nil {
		log.Error("early: current is missing and cannot be recreated", "err", err)
	} else if v != "" {
		log.Warn("early: recreated the missing current link", "version", v)
	}
	if err := ident.Early(ctx, d.layout, d.source, d.winResetter); err != nil {
		log.Error("early failed", "err", err)
		return 1
	}
	return 0
}

// windowsLogBytes is the size of one early.log or identity.log file.
const windowsLogBytes = 1 << 20

// windowsLog returns a logger that writes to stderr and, when the layout
// has a log directory, to a small rotating file there: the output of a
// startup script or of the specialize pass is otherwise lost. It also
// becomes the default logger, which the ident package logs to, until the
// returned close restores the previous one.
func windowsLog(d deps, name string, stderr io.Writer) (*slog.Logger, func()) {
	w, closeFn := stderr, func() {}
	if d.layout.LogDir != "" {
		if f, err := logx.NewRotatingFile(d.layout.LogDir, name, windowsLogBytes, 2); err == nil {
			// The file goes first: io.MultiWriter stops at the first
			// failing writer, and a process started by the service control
			// manager has no usable stderr.
			w, closeFn = io.MultiWriter(f, stderr), func() { _ = f.Close() }
		}
	}
	prev := slog.Default()
	log := slog.New(slog.NewTextHandler(w, nil))
	slog.SetDefault(log)
	return log, func() {
		slog.SetDefault(prev)
		closeFn()
	}
}

// sealCmd implements `sbx-agent seal`.
func sealCmd(ctx context.Context, d deps, stdout, stderr io.Writer) int {
	var err error
	if d.winResetter != nil {
		err = ident.SealWindows(ctx, d.layout, d.stopAgent, d.winResetter.WipeSecrets)
	} else {
		err = ident.Seal(ctx, d.layout, d.stopAgent)
	}
	if err != nil {
		_, _ = fmt.Fprintf(stderr, "sbx-agent seal: %v\n", err)
		return 1
	}
	_, _ = fmt.Fprintln(stdout, "sealed")
	return 0
}

// stopAgentService stops sbx-agent.service. A unit that is not loaded counts
// as stopped.
func stopAgentService() error {
	var out bytes.Buffer
	ctx, cancel := context.WithTimeout(context.Background(), time.Minute)
	defer cancel()
	cmd := exec.CommandContext(ctx, "systemctl", "stop", "sbx-agent.service")
	cmd.Stdout, cmd.Stderr = &out, &out
	err := cmd.Run()
	if err == nil {
		return nil
	}
	var exitErr *exec.ExitError
	if errors.As(err, &exitErr) && strings.Contains(out.String(), "not loaded") {
		return nil
	}
	return fmt.Errorf("systemctl stop sbx-agent.service: %w: %s", err, strings.TrimSpace(out.String()))
}
