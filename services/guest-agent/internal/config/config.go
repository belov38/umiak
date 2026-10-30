// Package config loads agent.toml: /etc/sbx-agent/agent.toml on Linux (S3
// spec section 5), C:\ProgramData\sbx-agent\agent.toml on Windows (S9 spec
// section 12.1). The defaults differ per OS (defaults_unix.go,
// defaults_windows.go).
package config

import (
	"errors"
	"fmt"
	"io/fs"
	"math"
	"os"
	"strconv"
	"strings"
	"time"

	"github.com/pelletier/go-toml/v2"
)

// Config is the agent configuration with defaults applied.
type Config struct {
	// TunnelURL is the gateway WebSocket endpoint.
	TunnelURL string
	// TrustDir overrides the trust directory. Empty means
	// "<current version>/trust", resolved by the caller.
	TrustDir string
	// DefaultUser runs commands when the request names no user.
	DefaultUser string
	// ReadinessRequired lists the phases that gate "ready".
	ReadinessRequired []string
	// DockerEnabled turns on the docker readiness phase and pause on quiesce.
	DockerEnabled bool
	// PortsExclude lists ports not reported in ports.changed.
	PortsExclude []uint16
	// PortsExcludeProcesses lists process image names (such as svchost.exe)
	// whose listeners are not reported in ports.changed.
	PortsExcludeProcesses []string
	// PerStreamBytes caps the retained output of one stream.
	PerStreamBytes int64
	// TotalBytes caps the retained output of all commands.
	TotalBytes int64
	// TotalFraction caps the retained output as a fraction of the state
	// filesystem; the smaller of the two limits wins.
	TotalFraction float64
	// MaxRunningCommands caps concurrently running commands.
	MaxRunningCommands int
	// IdleWindow is how long the VM must be inactive to count as idle.
	IdleWindow time.Duration
	// IdentityDir is the directory with the smbios files (product_serial,
	// product_uuid, product_family). A test aid: the Linux integration
	// tests point it at a fake directory. Default DefaultIdentityDir.
	IdentityDir string
	// PTYIdle overrides the idle timeout of PTY commands. A test aid
	// ([process] pty_idle); 0 keeps the default of the process package.
	PTYIdle time.Duration
	// PendingSecretsWait is how long Process/Start waits for UpdateSecrets
	// while the secrets phase is pending with a non-empty secret set (S9
	// spec 12.8). 0 (Linux) starts without waiting.
	PendingSecretsWait time.Duration
}

// Defaults returns the configuration used when agent.toml is absent.
func Defaults() Config {
	cfg := Config{
		DefaultUser:        "user",
		PerStreamBytes:     128 << 20,
		TotalBytes:         2 << 30,
		TotalFraction:      0.10,
		MaxRunningCommands: 256,
		IdleWindow:         5 * time.Minute,
		IdentityDir:        DefaultIdentityDir,
	}
	osDefaults(&cfg)
	return cfg
}

// file mirrors the TOML document. Pointers distinguish absent keys from zero
// values, so a partial file keeps the defaults.
type file struct {
	Tunnel struct {
		URL      *string `toml:"url"`
		TrustDir *string `toml:"trust_dir"`
	} `toml:"tunnel"`
	User struct {
		Default *string `toml:"default"`
	} `toml:"user"`
	Readiness struct {
		Required *[]string `toml:"required"`
	} `toml:"readiness"`
	Docker struct {
		Enabled *bool `toml:"enabled"`
	} `toml:"docker"`
	Ports struct {
		Exclude          *[]int    `toml:"exclude"`
		ExcludeProcesses *[]string `toml:"exclude_processes"`
	} `toml:"ports"`
	Output struct {
		PerStreamBytes *string  `toml:"per_stream_bytes"`
		TotalBytes     *string  `toml:"total_bytes"`
		TotalFraction  *float64 `toml:"total_fraction"`
	} `toml:"output"`
	Limits struct {
		MaxRunningCommands *int `toml:"max_running_commands"`
	} `toml:"limits"`
	Idle struct {
		Window *string `toml:"window"`
	} `toml:"idle"`
	Identity struct {
		SysfsDir *string `toml:"sysfs_dir"`
	} `toml:"identity"`
	Process struct {
		PTYIdle *string `toml:"pty_idle"`
	} `toml:"process"`
}

// Load reads the configuration at path. A missing file yields the defaults.
func Load(path string) (Config, error) {
	cfg := Defaults()
	data, err := os.ReadFile(path)
	if errors.Is(err, fs.ErrNotExist) {
		return cfg, nil
	}
	if err != nil {
		return Config{}, fmt.Errorf("config: %w", err)
	}
	var f file
	if err := toml.Unmarshal(data, &f); err != nil {
		return Config{}, fmt.Errorf("config: parse %s: %w", path, err)
	}
	if err := f.apply(&cfg); err != nil {
		return Config{}, fmt.Errorf("config: %s: %w", path, err)
	}
	return cfg, nil
}

func (f *file) apply(cfg *Config) error {
	if f.Tunnel.URL != nil {
		cfg.TunnelURL = *f.Tunnel.URL
	}
	if f.Tunnel.TrustDir != nil {
		cfg.TrustDir = *f.Tunnel.TrustDir
	}
	if f.User.Default != nil {
		if *f.User.Default == "" {
			return errors.New("user.default is empty")
		}
		cfg.DefaultUser = *f.User.Default
	}
	if f.Readiness.Required != nil {
		cfg.ReadinessRequired = *f.Readiness.Required
	}
	if f.Docker.Enabled != nil {
		cfg.DockerEnabled = *f.Docker.Enabled
	}
	if f.Ports.Exclude != nil {
		ports := make([]uint16, 0, len(*f.Ports.Exclude))
		for _, p := range *f.Ports.Exclude {
			if p < 1 || p > math.MaxUint16 {
				return fmt.Errorf("ports.exclude: invalid port %d", p)
			}
			ports = append(ports, uint16(p))
		}
		cfg.PortsExclude = ports
	}
	if f.Ports.ExcludeProcesses != nil {
		for _, name := range *f.Ports.ExcludeProcesses {
			if name == "" {
				return errors.New("ports.exclude_processes: empty process name")
			}
		}
		cfg.PortsExcludeProcesses = *f.Ports.ExcludeProcesses
	}
	if err := parseSizeInto(f.Output.PerStreamBytes, &cfg.PerStreamBytes, "output.per_stream_bytes"); err != nil {
		return err
	}
	if err := parseSizeInto(f.Output.TotalBytes, &cfg.TotalBytes, "output.total_bytes"); err != nil {
		return err
	}
	if f.Output.TotalFraction != nil {
		v := *f.Output.TotalFraction
		if v <= 0 || v > 1 {
			return fmt.Errorf("output.total_fraction %v is outside (0, 1]", v)
		}
		cfg.TotalFraction = v
	}
	if f.Limits.MaxRunningCommands != nil {
		if *f.Limits.MaxRunningCommands < 1 {
			return fmt.Errorf("limits.max_running_commands %d is below 1", *f.Limits.MaxRunningCommands)
		}
		cfg.MaxRunningCommands = *f.Limits.MaxRunningCommands
	}
	if f.Idle.Window != nil {
		d, err := time.ParseDuration(*f.Idle.Window)
		if err != nil || d <= 0 {
			return fmt.Errorf("idle.window %q is not a positive duration", *f.Idle.Window)
		}
		cfg.IdleWindow = d
	}
	if f.Identity.SysfsDir != nil {
		if *f.Identity.SysfsDir == "" {
			return errors.New("identity.sysfs_dir is empty")
		}
		cfg.IdentityDir = *f.Identity.SysfsDir
	}
	if f.Process.PTYIdle != nil {
		d, err := time.ParseDuration(*f.Process.PTYIdle)
		if err != nil || d <= 0 {
			return fmt.Errorf("process.pty_idle %q is not a positive duration", *f.Process.PTYIdle)
		}
		cfg.PTYIdle = d
	}
	return nil
}

func parseSizeInto(s *string, dst *int64, key string) error {
	if s == nil {
		return nil
	}
	n, err := ParseSize(*s)
	if err != nil {
		return fmt.Errorf("%s: %w", key, err)
	}
	if n == 0 {
		return fmt.Errorf("%s is zero", key)
	}
	*dst = n
	return nil
}

var sizeUnits = []struct {
	suffix string
	mult   int64
}{
	{"KiB", 1 << 10},
	{"MiB", 1 << 20},
	{"GiB", 1 << 30},
}

// ParseSize parses a byte count: plain digits or digits with a KiB, MiB or
// GiB suffix.
func ParseSize(s string) (int64, error) {
	s = strings.TrimSpace(s)
	mult := int64(1)
	for _, u := range sizeUnits {
		if num, ok := strings.CutSuffix(s, u.suffix); ok {
			s, mult = strings.TrimSpace(num), u.mult
			break
		}
	}
	n, err := strconv.ParseInt(s, 10, 64)
	if err != nil || n < 0 {
		return 0, fmt.Errorf("invalid size %q", s)
	}
	if n > math.MaxInt64/mult {
		return 0, fmt.Errorf("size %q overflows", s)
	}
	return n * mult, nil
}
