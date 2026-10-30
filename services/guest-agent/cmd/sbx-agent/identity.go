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
	version   string
	source    ident.Source
	resetter  ident.Resetter
	stopAgent func() error
	freezer   quiesce.Freezer
	docker    quiesce.DockerAPI

	// systemctl runs systemctl (install-package, rollback).
	systemctl func(args ...string) error
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
}

// defaultDeps returns the production dependencies.
func defaultDeps() deps {
	l := paths.Default()
	return deps{
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
	}
}

// identityApply implements `sbx-agent identity apply`. An unreadable or
// malformed serial is logged and still exits 0: a machine without identity
// must boot, the agent then runs without a tunnel (spec section 7.1).
func identityApply(ctx context.Context, d deps, stderr io.Writer) int {
	log := slog.New(slog.NewTextHandler(stderr, nil))
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

// sealCmd implements `sbx-agent seal`.
func sealCmd(ctx context.Context, d deps, stdout, stderr io.Writer) int {
	if err := ident.Seal(ctx, d.layout, d.stopAgent); err != nil {
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
