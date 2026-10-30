//go:build !windows

package update

import (
	"errors"
	"fmt"
	"io/fs"
	"os"
	"path/filepath"

	"github.com/belov38/boat-dev-clone/services/guest-agent/internal/fsutil"
	"github.com/belov38/boat-dev-clone/services/guest-agent/internal/paths"
)

// AgentService is the agent unit that Rollback starts.
const AgentService = "sbx-agent.service"

// enabledUnits are enabled by an install with units.
var enabledUnits = []string{"sbx-identity.service", "sbx-agent.service"}

// DefaultServiceManager returns the ServiceManager of this OS.
func DefaultServiceManager() ServiceManager { return SystemctlManager{} }

// installService installs the systemd units (decision 9).
func installService(l paths.Layout, opts InstallOptions) error {
	sm := SystemctlManager{}
	if opts.Services != nil {
		m, ok := opts.Services.(SystemctlManager)
		if !ok {
			return fmt.Errorf("update: installing units needs a SystemctlManager, got %T", opts.Services)
		}
		sm = m
	}
	return installUnits(l, opts.Units, sm.run)
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
