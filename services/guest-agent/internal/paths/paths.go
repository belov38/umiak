// Package paths defines the on-disk layout of the guest agent (S3 spec
// section 5, S9 spec section 12.1 for Windows). Every file access in the
// agent goes through a Layout so tests can run against a temporary root.
// Fields that only one OS uses are empty on the other.
package paths

import (
	"errors"
	"fmt"
	"path/filepath"
	"strings"
)

// Layout holds every filesystem path the agent uses.
type Layout struct {
	// VersionsDir holds one directory per installed agent version.
	VersionsDir string
	// CurrentLink and PreviousLink are symlinks to version directories.
	CurrentLink  string
	PreviousLink string
	// BinLink is the CLI symlink to current/sbx-agent.
	BinLink string

	// StateDir is the root of persistent agent state.
	StateDir string
	// StateDB is the bbolt database.
	StateDB string
	// CommandsDir holds one directory per command.
	CommandsDir string
	// UploadsDir holds temporary upload files.
	UploadsDir string
	// StagingDir holds packages being installed.
	StagingDir string
	// IdentityFile records the applied machine identity.
	IdentityFile string
	// PendingUpdateFile records an unfinished self-update.
	PendingUpdateFile string
	// BadVersionsFile lists versions the agent refuses to start.
	BadVersionsFile string
	// ManagedFilesList lists files the agent owns outside its own directories.
	ManagedFilesList string

	// RunDir is the volatile agent directory (cleared on reboot).
	RunDir string
	// ShimSockDir holds one shim socket per command.
	ShimSockDir string
	// QuiesceFile is the quiesce lease record.
	QuiesceFile string
	// QuiesceThawedDir holds markers for leases that were auto-thawed.
	QuiesceThawedDir string
	// StatusFile is the agent status snapshot for the CLI.
	StatusFile string
	// EarlyFile is the marker the early boot step writes for the current
	// boot (Windows).
	EarlyFile string
	// AdminSocket serves the full agent API to local administrators
	// (Windows).
	AdminSocket string
	// EnvSocket serves the sandbox env to SSH session profiles (Windows).
	EnvSocket string
	// LogDir holds the rotated agent log (Windows; Linux uses journald).
	LogDir string

	// SecretsMount is the tmpfs mount point.
	SecretsMount string
	// SecretsDir is the secrets directory inside the mount.
	SecretsDir string
	// SecretsEnvFile is the secret environment file.
	SecretsEnvFile string
	// SecretFilesDir holds secret files by name.
	SecretFilesDir string
	// SecretsStateFile is the agent's root-only record of the applied
	// secret set (full secret env and file metadata) inside the tmpfs.
	SecretsStateFile string
	// CmdSpecDir holds command specs until the shim reads them.
	CmdSpecDir string
	// SbxEnvFile is the non-secret sandbox environment read by PAM.
	SbxEnvFile string

	// EtcDir is the agent configuration directory.
	EtcDir string
	// ConfigFile is agent.toml.
	ConfigFile string
	// TemplateSSHCA holds the SSH CA keys baked into the template.
	TemplateSSHCA string
	// SSHUserCA holds the effective SSH CA keys.
	SSHUserCA string
	// SSHDir is the sshd configuration directory (host keys).
	SSHDir string
	// MachineIDFile is /etc/machine-id.
	MachineIDFile string
	// DbusMachineID is the legacy D-Bus machine-id copy.
	DbusMachineID string
	// HostnameFile is /etc/hostname.
	HostnameFile string
	// HostsFile is /etc/hosts.
	HostsFile string
	// QuiesceHooksDir holds user pre-freeze and post-thaw hooks.
	QuiesceHooksDir string
	// SystemdUnitDir is where the agent installs its unit files.
	SystemdUnitDir string
	// SysprepUnattend is the answer file of the template's sysprep run,
	// deleted once the clone's identity is applied (Windows).
	SysprepUnattend string
	// SetupCompleteScript is the script Windows Setup runs at the end of a
	// clone's first boot; the template installs one that runs the clone
	// first-boot script (Windows).
	SetupCompleteScript string
	// FirstBootDone is the marker the clone first-boot script writes as its
	// last action (Windows).
	FirstBootDone string

	// root is the directory the layout is mounted under; empty for Default.
	root string
}

// Default returns the production layout.
func Default() Layout {
	return build(func(p string) string { return p }, "")
}

// ForRoot returns the same tree under root, for tests and dev runs. The
// drive of a Windows path is dropped: C:\ProgramData\x maps to
// root\ProgramData\x.
func ForRoot(root string) Layout {
	return build(func(p string) string {
		return filepath.Join(root, filepath.FromSlash(p[len(filepath.VolumeName(p)):]))
	}, root)
}

// Rooted maps a production path (such as /etc/foo or C:\ProgramData\foo
// from a managed-files list) to its location in this layout: cleaned for
// Default, under the root for ForRoot. It rejects relative paths, paths with
// a ".." element, the filesystem (drive) root and, on Windows, paths that are
// not on a drive letter (UNC, device paths), so a mapped path can never leave
// the layout.
func (l Layout) Rooted(abs string) (string, error) {
	vol := filepath.VolumeName(abs)
	if !filepath.IsAbs(abs) {
		return "", fmt.Errorf("paths: %q is not absolute", abs)
	}
	if len(vol) > 2 {
		return "", fmt.Errorf("paths: %q is not on a drive", abs)
	}
	for _, elem := range strings.Split(filepath.ToSlash(abs), "/") {
		if elem == ".." {
			return "", fmt.Errorf("paths: %q contains \"..\"", abs)
		}
	}
	clean := filepath.Clean(abs)
	rest := clean[len(vol):]
	if rest == string(filepath.Separator) {
		return "", errors.New("paths: refusing the filesystem root")
	}
	if l.root == "" {
		return clean, nil
	}
	return filepath.Join(l.root, rest), nil
}

// CommandDir returns the directory of command id.
func (l Layout) CommandDir(id string) string {
	return filepath.Join(l.CommandsDir, id)
}

// ShimSocket returns the shim socket path of command id.
func (l Layout) ShimSocket(id string) string {
	return filepath.Join(l.ShimSockDir, id+".sock")
}

// CmdSpec returns the spec file path of command id, or "" without a
// CmdSpecDir (Windows).
func (l Layout) CmdSpec(id string) string {
	if l.CmdSpecDir == "" {
		return ""
	}
	return filepath.Join(l.CmdSpecDir, id)
}
