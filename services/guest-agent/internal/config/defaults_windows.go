package config

// DefaultIdentityDir is empty on Windows: the smbios identity is read from
// the firmware table, not from files.
const DefaultIdentityDir = ""

// osDefaults sets the Windows defaults (S9 spec sections 12.1 and 12.9).
// RPC 135 and the dynamic RPC ports of the system services are not reported.
func osDefaults(cfg *Config) {
	cfg.ReadinessRequired = []string{"identity", "claim", "secrets"}
	cfg.DockerEnabled = false
	cfg.PortsExclude = []uint16{22, 135}
	cfg.PortsExcludeProcesses = []string{"System", "lsass.exe", "wininit.exe", "services.exe", "svchost.exe", "spoolsv.exe"}
}
