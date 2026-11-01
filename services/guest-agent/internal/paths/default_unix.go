//go:build !windows

package paths

import "path"

// build maps the slash-separated Linux production paths through f.
func build(f func(string) string, root string) Layout {
	const (
		lib   = "/usr/local/lib/umiak-agent"
		state = "/var/lib/umiak-agent"
		run   = "/run/umiak-agent"
		umiak = "/run/umiak"
		etc   = "/etc/umiak-agent"
		ssh   = "/etc/ssh"
	)
	j := path.Join
	return Layout{
		VersionsDir:  f(j(lib, "versions")),
		CurrentLink:  f(j(lib, "current")),
		PreviousLink: f(j(lib, "previous")),
		BinLink:      f("/usr/local/bin/umiak-agent"),

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

		SecretsMount:     f(umiak),
		SecretsDir:       f(j(umiak, "secrets")),
		SecretsEnvFile:   f(j(umiak, "secrets", "env")),
		SecretFilesDir:   f(j(umiak, "secrets", "files")),
		SecretsStateFile: f(j(umiak, "secrets.json")),
		CmdSpecDir:       f(j(umiak, "cmd-spec")),
		UmiakEnvFile:     f("/etc/umiak/env"),

		EtcDir:          f(etc),
		ConfigFile:      f(j(etc, "agent.toml")),
		TemplateSSHCA:   f(j(etc, "ssh-user-ca.pub")),
		SSHUserCA:       f(j(ssh, "umiak_user_ca.pub")),
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
