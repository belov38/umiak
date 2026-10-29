// Package paths defines the on-disk layout of the guest agent (spec section 5).
// Every file access in the agent goes through a Layout so tests can run
// against a temporary root.
package paths

import (
	"errors"
	"fmt"
	"path"
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

	// SecretsMount is the tmpfs mount point.
	SecretsMount string
	// SecretsDir is the secrets directory inside the mount.
	SecretsDir string
	// SecretsEnvFile is the secret environment file.
	SecretsEnvFile string
	// SecretFilesDir holds secret files by name.
	SecretFilesDir string
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

	// root is the directory the layout is mounted under; empty for Default.
	root string
}

// Default returns the production layout.
func Default() Layout {
	return build(func(p string) string { return p }, "")
}

// ForRoot returns the same tree under root, for tests and dev runs.
func ForRoot(root string) Layout {
	return build(func(p string) string {
		return filepath.Join(root, filepath.FromSlash(p))
	}, root)
}

// Rooted maps a production path (such as /etc/foo from a managed-files list)
// to its location in this layout: unchanged for Default, under the root for
// ForRoot. It rejects relative paths, paths with a ".." element and the
// filesystem root, so a mapped path can never leave the layout.
func (l Layout) Rooted(abs string) (string, error) {
	if !strings.HasPrefix(abs, "/") {
		return "", fmt.Errorf("paths: %q is not absolute", abs)
	}
	for _, elem := range strings.Split(abs, "/") {
		if elem == ".." {
			return "", fmt.Errorf("paths: %q contains \"..\"", abs)
		}
	}
	clean := path.Clean(abs)
	if clean == "/" {
		return "", errors.New("paths: refusing the filesystem root")
	}
	if l.root == "" {
		return filepath.FromSlash(clean), nil
	}
	return filepath.Join(l.root, filepath.FromSlash(clean)), nil
}

// CommandDir returns the directory of command id.
func (l Layout) CommandDir(id string) string {
	return filepath.Join(l.CommandsDir, id)
}

// ShimSocket returns the shim socket path of command id.
func (l Layout) ShimSocket(id string) string {
	return filepath.Join(l.ShimSockDir, id+".sock")
}

// CmdSpec returns the spec file path of command id.
func (l Layout) CmdSpec(id string) string {
	return filepath.Join(l.CmdSpecDir, id)
}

// build maps the slash-separated production paths through f.
func build(f func(string) string, root string) Layout {
	const (
		lib   = "/usr/local/lib/sbx-agent"
		state = "/var/lib/sbx-agent"
		run   = "/run/sbx-agent"
		sbx   = "/run/sbx"
		etc   = "/etc/sbx-agent"
		ssh   = "/etc/ssh"
	)
	j := path.Join
	return Layout{
		VersionsDir:  f(j(lib, "versions")),
		CurrentLink:  f(j(lib, "current")),
		PreviousLink: f(j(lib, "previous")),
		BinLink:      f("/usr/local/bin/sbx-agent"),

		StateDir:          f(state),
		StateDB:           f(j(state, "state.db")),
		CommandsDir:       f(j(state, "commands")),
		UploadsDir:        f(j(state, "uploads")),
		StagingDir:        f(j(state, "staging")),
		IdentityFile:      f(j(state, "identity.json")),
		PendingUpdateFile: f(j(state, "pending-update.json")),
		BadVersionsFile:   f(j(state, "bad-versions")),
		ManagedFilesList:  f(j(state, "managed-files")),

		RunDir:           f(run),
		ShimSockDir:      f(j(run, "cmd")),
		QuiesceFile:      f(j(run, "quiesce.json")),
		QuiesceThawedDir: f(j(run, "quiesce-thawed")),
		StatusFile:       f(j(run, "status.json")),

		SecretsMount:   f(sbx),
		SecretsDir:     f(j(sbx, "secrets")),
		SecretsEnvFile: f(j(sbx, "secrets", "env")),
		SecretFilesDir: f(j(sbx, "secrets", "files")),
		CmdSpecDir:     f(j(sbx, "cmd-spec")),
		SbxEnvFile:     f("/etc/sbx/env"),

		EtcDir:          f(etc),
		ConfigFile:      f(j(etc, "agent.toml")),
		TemplateSSHCA:   f(j(etc, "ssh-user-ca.pub")),
		SSHUserCA:       f(j(ssh, "sbx_user_ca.pub")),
		SSHDir:          f(ssh),
		MachineIDFile:   f("/etc/machine-id"),
		DbusMachineID:   f("/var/lib/dbus/machine-id"),
		HostnameFile:    f("/etc/hostname"),
		HostsFile:       f("/etc/hosts"),
		QuiesceHooksDir: f(j(etc, "quiesce.d")),
		SystemdUnitDir:  f("/etc/systemd/system"),

		root: root,
	}
}
