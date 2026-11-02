//go:build !windows

package update

import (
	"errors"
	"fmt"
	"io/fs"
	"os"
	"path/filepath"

	"github.com/belov38/umiak/services/guest-agent/internal/fsutil"
	"github.com/belov38/umiak/services/guest-agent/internal/paths"
)

// AgentService is the agent unit that Rollback starts.
const AgentService = "umiak-agent.service"

// enabledUnits are enabled by an install with units.
var enabledUnits = []string{"umiak-identity.service", "umiak-agent.service"}

// DefaultServiceManager returns the ServiceManager of this OS.
func DefaultServiceManager() ServiceManager { return SystemctlManager{} }

// installService installs the systemd units (decision 9).
func installService(l paths.Layout, opts InstallOptions) error {
	sc := opts.Systemctl
	if sc == nil {
		sc = Systemctl
	}
	return installUnits(l, opts.Units, sc)
}

// installUnits writes every file at the root of units into SystemdUnitDir,
// reloads systemd and enables the agent units (decision 9).
func installUnits(l paths.Layout, units fs.FS, systemctl func(args ...string) error) error {
	if units == nil {
		return errors.New("update: no unit files to install")
	}
	entries, err := fs.ReadDir(units, ".")
	if err != nil {
		return err
	}
	if err := os.MkdirAll(l.SystemdUnitDir, 0o755); err != nil {
		return err
	}
	for _, e := range entries {
		if !e.Type().IsRegular() {
			continue
		}
		data, err := fs.ReadFile(units, e.Name())
		if err != nil {
			return err
		}
		if err := fsutil.WriteFileAtomic(filepath.Join(l.SystemdUnitDir, e.Name()), data, 0o644); err != nil {
			return fmt.Errorf("update: install unit %s: %w", e.Name(), err)
		}
	}
	if err := systemctl("daemon-reload"); err != nil {
		return err
	}
	return systemctl(append([]string{"enable"}, enabledUnits...)...)
}
