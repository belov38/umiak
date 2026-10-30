package paths

import "path/filepath"

// build maps the Windows production paths (S9 spec section 12.1) through f.
// Linux-only fields (BinLink, CmdSpecDir, SbxEnvFile, MachineIDFile,
// DbusMachineID, HostnameFile, HostsFile, SystemdUnitDir) stay empty: the
// code that uses them does not run on Windows.
func build(f func(string) string, root string) Layout {
	const (
		lib   = `C:\Program Files\sbx-agent`
		etc   = `C:\ProgramData\sbx-agent`
		state = `C:\ProgramData\sbx-agent\state`
		run   = `C:\ProgramData\sbx-agent\run`
		logs  = `C:\ProgramData\sbx-agent\logs`
		sbx   = `C:\ProgramData\sbx`
		ssh   = `C:\ProgramData\ssh`
	)
	j := filepath.Join
	return Layout{
		VersionsDir:  f(j(lib, "versions")),
		CurrentLink:  f(j(lib, "current")),
		PreviousLink: f(j(lib, "previous")),

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
		EarlyFile:        f(j(run, "early.json")),
		AdminSocket:      f(j(run, "admin.sock")),
		EnvSocket:        f(j(run, "env.sock")),
		LogDir:           f(logs),

		SecretsMount:     f(sbx),
		SecretsDir:       f(j(sbx, "secrets")),
		SecretsEnvFile:   f(j(sbx, "secrets", "env")),
		SecretFilesDir:   f(j(sbx, "secrets", "files")),
		SecretsStateFile: f(j(sbx, "secrets.json")),

		EtcDir:          f(etc),
		ConfigFile:      f(j(etc, "agent.toml")),
		TemplateSSHCA:   f(j(etc, "ssh-user-ca.pub")),
		QuiesceHooksDir: f(j(etc, "quiesce.d")),
		SSHUserCA:       f(j(ssh, "sbx_user_ca.pub")),
		SSHDir:          f(ssh),
		SysprepUnattend: f(`C:\Windows\System32\Sysprep\sbx-unattend.xml`),

		root: root,
	}
}
