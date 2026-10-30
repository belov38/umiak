//go:build !windows

package config

// DefaultIdentityDir is the sysfs directory of the smbios identity.
const DefaultIdentityDir = "/sys/class/dmi/id"

// osDefaults sets the Linux defaults (S3 spec section 5).
func osDefaults(cfg *Config) {
	cfg.ReadinessRequired = []string{"identity", "claim", "secrets", "docker"}
	cfg.DockerEnabled = true
	cfg.PortsExclude = []uint16{22, 53}
}
