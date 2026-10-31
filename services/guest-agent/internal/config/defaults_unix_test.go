//go:build !windows

package config

import (
	"reflect"
	"testing"
)

func TestConfigDefaultsUnix(t *testing.T) {
	cfg := Defaults()
	if want := []string{"identity", "claim", "secrets", "docker"}; !reflect.DeepEqual(cfg.ReadinessRequired, want) {
		t.Errorf("ReadinessRequired = %v, want %v", cfg.ReadinessRequired, want)
	}
	if !cfg.DockerEnabled {
		t.Error("DockerEnabled = false, want true")
	}
	if want := []uint16{22, 53}; !reflect.DeepEqual(cfg.PortsExclude, want) {
		t.Errorf("PortsExclude = %v, want %v", cfg.PortsExclude, want)
	}
	if cfg.PortsExcludeProcesses != nil {
		t.Errorf("PortsExcludeProcesses = %v, want nil", cfg.PortsExcludeProcesses)
	}
	if cfg.PendingSecretsWait != 0 {
		t.Errorf("PendingSecretsWait = %v, want 0", cfg.PendingSecretsWait)
	}
	if cfg.IdentityDir != "/sys/class/dmi/id" || DefaultIdentityDir != "/sys/class/dmi/id" {
		t.Errorf("IdentityDir = %q, DefaultIdentityDir = %q; want the sysfs DMI dir", cfg.IdentityDir, DefaultIdentityDir)
	}
}
