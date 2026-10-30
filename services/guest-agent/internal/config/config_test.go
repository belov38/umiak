package config

import (
	"os"
	"path/filepath"
	"reflect"
	"testing"
	"time"
)

func TestLoadDefaults(t *testing.T) {
	cfg, err := Load(filepath.Join(t.TempDir(), "missing.toml"))
	if err != nil {
		t.Fatal(err)
	}
	if cfg.PerStreamBytes != 128<<20 || cfg.TotalBytes != 2<<30 || cfg.TotalFraction != 0.10 {
		t.Errorf("output limits = %d/%d/%v", cfg.PerStreamBytes, cfg.TotalBytes, cfg.TotalFraction)
	}
	if cfg.MaxRunningCommands != 256 {
		t.Errorf("MaxRunningCommands = %d", cfg.MaxRunningCommands)
	}
	if cfg.IdleWindow != 5*time.Minute {
		t.Errorf("IdleWindow = %v", cfg.IdleWindow)
	}
	if want := []uint16{22, 53}; !reflect.DeepEqual(cfg.PortsExclude, want) {
		t.Errorf("PortsExclude = %v, want %v", cfg.PortsExclude, want)
	}
	if want := []string{"identity", "claim", "secrets", "docker"}; !reflect.DeepEqual(cfg.ReadinessRequired, want) {
		t.Errorf("ReadinessRequired = %v, want %v", cfg.ReadinessRequired, want)
	}
	if cfg.DefaultUser != "user" || !cfg.DockerEnabled {
		t.Errorf("DefaultUser = %q, DockerEnabled = %v", cfg.DefaultUser, cfg.DockerEnabled)
	}
	if cfg.TunnelURL != "" || cfg.TrustDir != "" {
		t.Errorf("TunnelURL = %q, TrustDir = %q, want empty", cfg.TunnelURL, cfg.TrustDir)
	}
	if cfg.IdentityDir != "/sys/class/dmi/id" || cfg.PTYIdle != 0 {
		t.Errorf("IdentityDir = %q, PTYIdle = %v; want the sysfs DMI dir and 0", cfg.IdentityDir, cfg.PTYIdle)
	}
}

func TestLoadOverrides(t *testing.T) {
	const doc = `
[tunnel]
url = "wss://tunnel.example.com/v1/connect"
trust_dir = "/tmp/trust"

[user]
default = "dev"

[readiness]
required = ["identity", "claim"]

[docker]
enabled = false

[ports]
exclude = [22, 53, 8080]

[output]
per_stream_bytes = "64MiB"
total_bytes = "1GiB"
total_fraction = 0.25

[limits]
max_running_commands = 8

[idle]
window = "30s"

[identity]
sysfs_dir = "/run/fake-dmi"

[process]
pty_idle = "3s"
`
	path := filepath.Join(t.TempDir(), "agent.toml")
	if err := os.WriteFile(path, []byte(doc), 0o600); err != nil {
		t.Fatal(err)
	}
	cfg, err := Load(path)
	if err != nil {
		t.Fatal(err)
	}
	want := Config{
		TunnelURL:          "wss://tunnel.example.com/v1/connect",
		TrustDir:           "/tmp/trust",
		DefaultUser:        "dev",
		ReadinessRequired:  []string{"identity", "claim"},
		DockerEnabled:      false,
		PortsExclude:       []uint16{22, 53, 8080},
		PerStreamBytes:     64 << 20,
		TotalBytes:         1 << 30,
		TotalFraction:      0.25,
		MaxRunningCommands: 8,
		IdleWindow:         30 * time.Second,
		IdentityDir:        "/run/fake-dmi",
		PTYIdle:            3 * time.Second,
	}
	if !reflect.DeepEqual(cfg, want) {
		t.Errorf("cfg = %+v, want %+v", cfg, want)
	}
}

func TestLoadPartialKeepsDefaults(t *testing.T) {
	path := filepath.Join(t.TempDir(), "agent.toml")
	if err := os.WriteFile(path, []byte("[tunnel]\nurl = \"wss://x/v1/connect\"\n"), 0o600); err != nil {
		t.Fatal(err)
	}
	cfg, err := Load(path)
	if err != nil {
		t.Fatal(err)
	}
	if cfg.TunnelURL != "wss://x/v1/connect" || cfg.MaxRunningCommands != 256 || !cfg.DockerEnabled {
		t.Errorf("cfg = %+v", cfg)
	}
}

func TestLoadErrors(t *testing.T) {
	tests := []struct{ name, doc string }{
		{"syntax", "[tunnel\n"},
		{"bad size", "[output]\nper_stream_bytes = \"lots\"\n"},
		{"bad duration", "[idle]\nwindow = \"soon\"\n"},
		{"bad port", "[ports]\nexclude = [70000]\n"},
		{"bad fraction", "[output]\ntotal_fraction = 1.5\n"},
		{"bad max", "[limits]\nmax_running_commands = 0\n"},
		{"empty sysfs dir", "[identity]\nsysfs_dir = \"\"\n"},
		{"bad pty idle", "[process]\npty_idle = \"0s\"\n"},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			path := filepath.Join(t.TempDir(), "agent.toml")
			if err := os.WriteFile(path, []byte(tt.doc), 0o600); err != nil {
				t.Fatal(err)
			}
			if _, err := Load(path); err == nil {
				t.Error("want error")
			}
		})
	}
}

func TestParseSize(t *testing.T) {
	tests := []struct {
		in      string
		want    int64
		wantErr bool
	}{
		{"128MiB", 128 << 20, false},
		{"2GiB", 2 << 30, false},
		{"64KiB", 64 << 10, false},
		{"4096", 4096, false},
		{" 10 MiB ", 10 << 20, false},
		{"", 0, true},
		{"MiB", 0, true},
		{"1.5GiB", 0, true},
		{"-1", 0, true},
		{"12XB", 0, true},
		{"99999999999GiB", 0, true},
	}
	for _, tt := range tests {
		t.Run(tt.in, func(t *testing.T) {
			got, err := ParseSize(tt.in)
			if (err != nil) != tt.wantErr {
				t.Fatalf("err = %v, wantErr %v", err, tt.wantErr)
			}
			if got != tt.want {
				t.Errorf("got %d, want %d", got, tt.want)
			}
		})
	}
}
