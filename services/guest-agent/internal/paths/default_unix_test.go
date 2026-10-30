//go:build !windows

package paths

import (
	"path/filepath"
	"testing"
)

func TestDefaultLayoutMatchesSpec(t *testing.T) {
	l := Default()
	tests := []struct{ name, got, want string }{
		{"VersionsDir", l.VersionsDir, "/usr/local/lib/sbx-agent/versions"},
		{"CurrentLink", l.CurrentLink, "/usr/local/lib/sbx-agent/current"},
		{"PreviousLink", l.PreviousLink, "/usr/local/lib/sbx-agent/previous"},
		{"BinLink", l.BinLink, "/usr/local/bin/sbx-agent"},
		{"StateDir", l.StateDir, "/var/lib/sbx-agent"},
		{"StateDB", l.StateDB, "/var/lib/sbx-agent/state.db"},
		{"CommandsDir", l.CommandsDir, "/var/lib/sbx-agent/commands"},
		{"UploadsDir", l.UploadsDir, "/var/lib/sbx-agent/uploads"},
		{"IdentityFile", l.IdentityFile, "/var/lib/sbx-agent/identity.json"},
		{"PendingUpdateFile", l.PendingUpdateFile, "/var/lib/sbx-agent/pending-update.json"},
		{"RunDir", l.RunDir, "/run/sbx-agent"},
		{"SecretsMount", l.SecretsMount, "/run/sbx"},
		{"SecretsDir", l.SecretsDir, "/run/sbx/secrets"},
		{"SecretsEnvFile", l.SecretsEnvFile, "/run/sbx/secrets/env"},
		{"SecretFilesDir", l.SecretFilesDir, "/run/sbx/secrets/files"},
		{"SecretsStateFile", l.SecretsStateFile, "/run/sbx/secrets.json"},
		{"CmdSpecDir", l.CmdSpecDir, "/run/sbx/cmd-spec"},
		{"SbxEnvFile", l.SbxEnvFile, "/etc/sbx/env"},
		{"ConfigFile", l.ConfigFile, "/etc/sbx-agent/agent.toml"},
		{"TemplateSSHCA", l.TemplateSSHCA, "/etc/sbx-agent/ssh-user-ca.pub"},
		{"SSHUserCA", l.SSHUserCA, "/etc/ssh/sbx_user_ca.pub"},
		{"MachineIDFile", l.MachineIDFile, "/etc/machine-id"},
		{"QuiesceHooksDir", l.QuiesceHooksDir, "/etc/sbx-agent/quiesce.d"},
		{"SystemdUnitDir", l.SystemdUnitDir, "/etc/systemd/system"},
		{"LogDir", l.LogDir, ""},
		{"EarlyFile", l.EarlyFile, ""},
		{"AdminSocket", l.AdminSocket, ""},
		{"EnvSocket", l.EnvSocket, ""},
		{"SysprepUnattend", l.SysprepUnattend, ""},
	}
	for _, tt := range tests {
		if tt.got != tt.want {
			t.Errorf("%s = %q, want %q", tt.name, tt.got, tt.want)
		}
	}
}

// emptyFields are the Windows-only fields, empty in the Unix layout.
var emptyFields = map[string]bool{
	"LogDir":          true,
	"EarlyFile":       true,
	"AdminSocket":     true,
	"EnvSocket":       true,
	"SysprepUnattend": true,
}

func TestForRootUnix(t *testing.T) {
	root := t.TempDir()
	if want := filepath.Join(root, "var", "lib", "sbx-agent", "state.db"); ForRoot(root).StateDB != want {
		t.Errorf("StateDB = %q, want %q", ForRoot(root).StateDB, want)
	}
}

func TestPerIDPaths(t *testing.T) {
	l := Default()
	if got, want := l.CommandDir("c1"), "/var/lib/sbx-agent/commands/c1"; got != want {
		t.Errorf("CommandDir = %q, want %q", got, want)
	}
	if got, want := l.ShimSocket("c1"), "/run/sbx-agent/cmd/c1.sock"; got != want {
		t.Errorf("ShimSocket = %q, want %q", got, want)
	}
	if got, want := l.CmdSpec("c1"), "/run/sbx/cmd-spec/c1"; got != want {
		t.Errorf("CmdSpec = %q, want %q", got, want)
	}
}

func TestRooted(t *testing.T) {
	root := t.TempDir()
	for _, tt := range []struct {
		name    string
		layout  Layout
		in      string
		want    string
		wantErr bool
	}{
		{"default is identity", Default(), "/etc/foo", filepath.FromSlash("/etc/foo"), false},
		{"default cleans", Default(), "/etc//a/../foo", "", true},
		{"default dotdot", Default(), "/etc/../foo", "", true},
		{"default root", Default(), "/", "", true},
		{"default relative", Default(), "etc/foo", "", true},
		{"default empty", Default(), "", "", true},
		{"rooted maps under root", ForRoot(root), "/etc/foo", filepath.Join(root, "etc", "foo"), false},
		{"rooted redundant slashes", ForRoot(root), "/etc//foo/", filepath.Join(root, "etc", "foo"), false},
		{"rooted slash", ForRoot(root), "/", "", true},
		{"rooted dotdot", ForRoot(root), "/../x", "", true},
		{"rooted relative dotdot", ForRoot(root), "../x", "", true},
		{"rooted relative", ForRoot(root), "etc/foo", "", true},
	} {
		t.Run(tt.name, func(t *testing.T) {
			got, err := tt.layout.Rooted(tt.in)
			if (err != nil) != tt.wantErr {
				t.Fatalf("err = %v, wantErr %v", err, tt.wantErr)
			}
			if got != tt.want {
				t.Errorf("got %q, want %q", got, tt.want)
			}
		})
	}
}
