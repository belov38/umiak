package main

import (
	"bytes"
	"context"
	"errors"
	"fmt"
	"io"
	"log/slog"
	"os/exec"
	"strings"
	"time"

	"github.com/belov38/boat-dev-clone/services/guest-agent/internal/ident"
	"github.com/belov38/boat-dev-clone/services/guest-agent/internal/paths"
)

// deps holds what the identity subcommands touch, so tests can point them at
// a temporary tree.
type deps struct {
	layout    paths.Layout
	source    ident.Source
	resetter  ident.Resetter
	stopAgent func() error
}

// defaultDeps returns the production dependencies.
func defaultDeps() deps {
	l := paths.Default()
	return deps{
		layout: l,
		source: ident.SysfsSource{
			Dir:        "/sys/class/dmi/id",
			BootIDPath: "/proc/sys/kernel/random/boot_id",
		},
		resetter:  ident.LinuxResetter{Layout: l},
		stopAgent: stopAgentService,
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
