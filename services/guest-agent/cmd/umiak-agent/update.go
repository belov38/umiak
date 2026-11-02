package main

import (
	"context"
	"crypto/ed25519"
	"flag"
	"fmt"
	"io"
	"log/slog"
	"path/filepath"

	"github.com/belov38/umiak/services/guest-agent/internal/update"
)

// installKeys returns the keys that verify a package: those of the current
// version for an update, the keys embedded in this binary for the first
// install (spec 17.1).
func installKeys(d deps) ([]ed25519.PublicKey, string, error) {
	cur, err := update.LinkVersion(d.layout.CurrentLink)
	if err != nil {
		return nil, "", err
	}
	if cur != "" {
		p := filepath.Join(d.layout.CurrentLink, filepath.FromSlash(update.UpdateKeysName))
		keys, err := update.ReadKeys(p)
		if err != nil {
			return nil, "", fmt.Errorf("keys of the current version %s: %w", cur, err)
		}
		return keys, p, nil
	}
	keys, err := update.ParseKeys(d.embeddedKeys)
	return keys, "embedded keys", err
}

// installPackage implements `umiak-agent install-package [flags] <tar>`
// (spec 17.1, 17.6; decision 9).
func installPackage(d deps, args []string, stdout, stderr io.Writer) int {
	fs := flag.NewFlagSet("install-package", flag.ContinueOnError)
	fs.SetOutput(stderr)
	noActivate := fs.Bool("no-activate", false, "only place the version, do not switch current")
	noUnits := fs.Bool("no-units", false, "do not install the service (systemd units, Windows service)")
	writeConfig := fs.Bool("write-config", false, "write the agent.toml template if absent")
	if err := fs.Parse(args); err != nil || fs.NArg() != 1 {
		_, _ = io.WriteString(stderr, "usage: umiak-agent install-package [--no-activate] [--no-units] [--write-config] <package.tar>\n")
		return 2
	}
	slog.SetDefault(slog.New(slog.NewTextHandler(stderr, nil)))
	keys, source, err := installKeys(d)
	if err != nil {
		_, _ = fmt.Fprintf(stderr, "umiak-agent install-package: %v\n", err)
		return 1
	}
	m, err := update.Install(d.layout, fs.Arg(0), keys, update.InstallOptions{
		Activate:     !*noActivate,
		InstallUnits: !*noUnits,
		WriteConfig:  *writeConfig,
		Units:        d.units,
		Config:       d.configTemplate,
		Systemctl:    d.systemctl,
		SystemPath:   d.systemPath,
	})
	if err != nil {
		_, _ = fmt.Fprintf(stderr, "umiak-agent install-package: %v\n", err)
		return 1
	}
	_, _ = fmt.Fprintf(stdout, "installed %s (%s/%s), verified with %s\n", m.Version, m.OS, m.Arch, source)
	return 0
}

// rollbackCmd implements `umiak-agent rollback [--to v]` (spec 17.4 step 6).
func rollbackCmd(d deps, args []string, stderr io.Writer) int {
	fs := flag.NewFlagSet("rollback", flag.ContinueOnError)
	fs.SetOutput(stderr)
	to := fs.String("to", "", "switch to this installed version")
	if err := fs.Parse(args); err != nil || fs.NArg() != 0 {
		_, _ = io.WriteString(stderr, "usage: umiak-agent rollback [--to <version>]\n")
		return 2
	}
	log := slog.New(slog.NewTextHandler(stderr, nil))
	slog.SetDefault(log)
	if d.layout.LogDir != "" {
		// Windows: the run-command failure action of the service starts
		// rollback without a console; its log goes to rollback.log.
		var closeLog func()
		log, closeLog = windowsLog(d, "rollback.log", stderr)
		defer closeLog()
	}
	// The failure action runs rollback from previous\ when it can: current
	// may be missing after a crash during a junction switch.
	if v, err := update.RepairCurrent(d.layout); err != nil {
		log.Error("rollback: current is missing and cannot be recreated", "err", err)
	} else if v != "" {
		log.Warn("rollback: recreated the missing current link", "version", v)
	}
	if err := update.Rollback(d.layout, *to, d.services, d.sleep); err != nil {
		log.Error("rollback failed", "err", err)
		_, _ = fmt.Fprintf(stderr, "umiak-agent rollback: %v\n", err)
		return 1
	}
	return 0
}

// selftestCmd implements `umiak-agent selftest --schema N --shim-protos 1,2`
// (spec 17.4 step 3), which checks the version directory of this binary,
// and `umiak-agent selftest --pty` (selftestPTY).
func selftestCmd(ctx context.Context, d deps, args []string, stdout, stderr io.Writer) int {
	fs := flag.NewFlagSet("selftest", flag.ContinueOnError)
	fs.SetOutput(stderr)
	schema := fs.Int("schema", -1, "state.db schema version (0 for none)")
	protoList := fs.String("shim-protos", "", "comma-separated protocol versions of live shims")
	pty := fs.Bool("pty", false, "run a terminal session through the running agent")
	if err := fs.Parse(args); err != nil || fs.NArg() != 0 || (*pty == (*schema >= 0)) || (*pty && *protoList != "") {
		_, _ = io.WriteString(stderr, "usage: umiak-agent selftest --schema <n> [--shim-protos 1,2] | selftest --pty\n")
		return 2
	}
	if *pty {
		return selftestPTY(ctx, d, stdout, stderr)
	}
	protos, err := update.ParseProtos(*protoList)
	if err != nil {
		_, _ = fmt.Fprintf(stderr, "umiak-agent selftest: %v\n", err)
		return 2
	}
	exe, err := d.executable()
	if err == nil {
		exe, err = resolveBinary(exe)
	}
	if err != nil {
		_, _ = fmt.Fprintf(stderr, "umiak-agent selftest: %v\n", err)
		return 1
	}
	if err := update.SelfTest(d.layout, filepath.Dir(exe), d.version, *schema, protos); err != nil {
		_, _ = fmt.Fprintf(stderr, "umiak-agent selftest: %v\n", err)
		return 1
	}
	_, _ = fmt.Fprintln(stdout, "ok")
	return 0
}
