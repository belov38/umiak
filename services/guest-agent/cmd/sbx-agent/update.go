package main

import (
	"crypto/ed25519"
	"flag"
	"fmt"
	"io"
	"log/slog"
	"path/filepath"

	"github.com/belov38/boat-dev-clone/services/guest-agent/internal/update"
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

// installPackage implements `sbx-agent install-package [flags] <tar>`
// (spec 17.1, 17.6; decision 9).
func installPackage(d deps, args []string, stdout, stderr io.Writer) int {
	fs := flag.NewFlagSet("install-package", flag.ContinueOnError)
	fs.SetOutput(stderr)
	noActivate := fs.Bool("no-activate", false, "only place the version, do not switch current")
	noUnits := fs.Bool("no-units", false, "do not install and enable the systemd units")
	writeConfig := fs.Bool("write-config", false, "write the agent.toml template if absent")
	if err := fs.Parse(args); err != nil || fs.NArg() != 1 {
		_, _ = io.WriteString(stderr, "usage: sbx-agent install-package [--no-activate] [--no-units] [--write-config] <package.tar>\n")
		return 2
	}
	slog.SetDefault(slog.New(slog.NewTextHandler(stderr, nil)))
	keys, source, err := installKeys(d)
	if err != nil {
		_, _ = fmt.Fprintf(stderr, "sbx-agent install-package: %v\n", err)
		return 1
	}
	m, err := update.Install(d.layout, fs.Arg(0), keys, update.InstallOptions{
		Activate:     !*noActivate,
		InstallUnits: !*noUnits,
		WriteConfig:  *writeConfig,
		Units:        d.units,
		Config:       d.configTemplate,
		Systemctl:    d.systemctl,
	})
	if err != nil {
		_, _ = fmt.Fprintf(stderr, "sbx-agent install-package: %v\n", err)
		return 1
	}
	_, _ = fmt.Fprintf(stdout, "installed %s (%s/%s), verified with %s\n", m.Version, m.OS, m.Arch, source)
	return 0
}

// rollbackCmd implements `sbx-agent rollback [--to v]` (spec 17.4 step 6).
func rollbackCmd(d deps, args []string, stderr io.Writer) int {
	fs := flag.NewFlagSet("rollback", flag.ContinueOnError)
	fs.SetOutput(stderr)
	to := fs.String("to", "", "switch to this installed version")
	if err := fs.Parse(args); err != nil || fs.NArg() != 0 {
		_, _ = io.WriteString(stderr, "usage: sbx-agent rollback [--to <version>]\n")
		return 2
	}
	slog.SetDefault(slog.New(slog.NewTextHandler(stderr, nil)))
	if err := update.Rollback(d.layout, *to, d.systemctl, d.sleep); err != nil {
		_, _ = fmt.Fprintf(stderr, "sbx-agent rollback: %v\n", err)
		return 1
	}
	return 0
}

// selftestCmd implements `sbx-agent selftest --schema N --shim-protos 1,2`
// (spec 17.4 step 3). It checks the version directory of this binary.
func selftestCmd(d deps, args []string, stdout, stderr io.Writer) int {
	fs := flag.NewFlagSet("selftest", flag.ContinueOnError)
	fs.SetOutput(stderr)
	schema := fs.Int("schema", -1, "state.db schema version (0 for none)")
	protoList := fs.String("shim-protos", "", "comma-separated protocol versions of live shims")
	if err := fs.Parse(args); err != nil || fs.NArg() != 0 || *schema < 0 {
		_, _ = io.WriteString(stderr, "usage: sbx-agent selftest --schema <n> [--shim-protos 1,2]\n")
		return 2
	}
	protos, err := update.ParseProtos(*protoList)
	if err != nil {
		_, _ = fmt.Fprintf(stderr, "sbx-agent selftest: %v\n", err)
		return 2
	}
	exe, err := d.executable()
	if err == nil {
		exe, err = filepath.EvalSymlinks(exe)
	}
	if err != nil {
		_, _ = fmt.Fprintf(stderr, "sbx-agent selftest: %v\n", err)
		return 1
	}
	if err := update.SelfTest(d.layout, filepath.Dir(exe), d.version, *schema, protos); err != nil {
		_, _ = fmt.Fprintf(stderr, "sbx-agent selftest: %v\n", err)
		return 1
	}
	_, _ = fmt.Fprintln(stdout, "ok")
	return 0
}
