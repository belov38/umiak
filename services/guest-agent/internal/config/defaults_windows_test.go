package config

import (
	"reflect"
	"testing"
	"time"
)

func TestConfigDefaultsWindows(t *testing.T) {
	cfg := Defaults()
	if want := []string{"identity", "claim", "secrets"}; !reflect.DeepEqual(cfg.ReadinessRequired, want) {
		t.Errorf("ReadinessRequired = %v, want %v", cfg.ReadinessRequired, want)
	}
	if cfg.DockerEnabled {
		t.Error("DockerEnabled = true, want false")
	}
	if cfg.DefaultUser != "user" {
		t.Errorf("DefaultUser = %q, want user", cfg.DefaultUser)
	}
	if want := []uint16{22, 135}; !reflect.DeepEqual(cfg.PortsExclude, want) {
		t.Errorf("PortsExclude = %v, want %v", cfg.PortsExclude, want)
	}
	want := []string{"System", "lsass.exe", "wininit.exe", "services.exe", "svchost.exe", "spoolsv.exe"}
	if !reflect.DeepEqual(cfg.PortsExcludeProcesses, want) {
		t.Errorf("PortsExcludeProcesses = %v, want %v", cfg.PortsExcludeProcesses, want)
	}
	if cfg.PendingSecretsWait != 30*time.Second {
		t.Errorf("PendingSecretsWait = %v, want 30s", cfg.PendingSecretsWait)
	}
	if cfg.IdentityDir != "" || DefaultIdentityDir != "" {
		t.Errorf("IdentityDir = %q, DefaultIdentityDir = %q; want empty", cfg.IdentityDir, DefaultIdentityDir)
	}
}
