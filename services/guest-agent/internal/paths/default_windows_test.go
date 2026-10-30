package paths

import (
	"path/filepath"
	"reflect"
	"testing"
)

// emptyFields are the Linux-only fields, empty in the Windows layout.
var emptyFields = map[string]bool{
	"BinLink":        true,
	"CmdSpecDir":     true,
	"SbxEnvFile":     true,
	"MachineIDFile":  true,
	"DbusMachineID":  true,
	"HostnameFile":   true,
	"HostsFile":      true,
	"SystemdUnitDir": true,
}

func TestWindowsDefaultLayout(t *testing.T) {
	const (
		lib   = `C:\Program Files\sbx-agent`
		etc   = `C:\ProgramData\sbx-agent`
		state = `C:\ProgramData\sbx-agent\state`
		run   = `C:\ProgramData\sbx-agent\run`
		sbx   = `C:\ProgramData\sbx`
		ssh   = `C:\ProgramData\ssh`
	)
	want := map[string]string{
		"VersionsDir":  lib + `\versions`,
		"CurrentLink":  lib + `\current`,
		"PreviousLink": lib + `\previous`,

		"StateDir":          state,
		"StateDB":           state + `\state.db`,
		"CommandsDir":       state + `\commands`,
		"UploadsDir":        state + `\uploads`,
		"StagingDir":        state + `\staging`,
		"IdentityFile":      state + `\identity.json`,
		"PendingUpdateFile": state + `\pending-update.json`,
		"BadVersionsFile":   state + `\bad-versions`,
		"ManagedFilesList":  state + `\managed-files`,

		"RunDir":           run,
		"ShimSockDir":      run + `\cmd`,
		"QuiesceFile":      run + `\quiesce.json`,
		"QuiesceThawedDir": run + `\quiesce-thawed`,
		"StatusFile":       run + `\status.json`,
		"EarlyFile":        run + `\early.json`,
		"AdminSocket":      run + `\admin.sock`,
		"EnvSocket":        run + `\env.sock`,
		"LogDir":           `C:\ProgramData\sbx-agent\logs`,

		"SecretsMount":     sbx,
		"SecretsDir":       sbx + `\secrets`,
		"SecretsEnvFile":   sbx + `\secrets\env`,
		"SecretFilesDir":   sbx + `\secrets\files`,
		"SecretsStateFile": sbx + `\secrets.json`,

		"EtcDir":          etc,
		"ConfigFile":      etc + `\agent.toml`,
		"TemplateSSHCA":   etc + `\ssh-user-ca.pub`,
		"QuiesceHooksDir": etc + `\quiesce.d`,
		"SSHDir":          ssh,
		"SSHUserCA":       ssh + `\sbx_user_ca.pub`,
		"SysprepUnattend": `C:\Windows\System32\Sysprep\sbx-unattend.xml`,
	}
	v := reflect.ValueOf(Default())
	for i := range v.NumField() {
		f := v.Type().Field(i)
		if !f.IsExported() {
			continue
		}
		got := v.Field(i).String()
		w, ok := want[f.Name]
		if !ok && !emptyFields[f.Name] {
			t.Errorf("%s = %q has no expected value", f.Name, got)
			continue
		}
		if got != w {
			t.Errorf("%s = %q, want %q", f.Name, got, w)
		}
	}
}

func TestWindowsPerIDPaths(t *testing.T) {
	l := Default()
	if got, want := l.CommandDir("c1"), `C:\ProgramData\sbx-agent\state\commands\c1`; got != want {
		t.Errorf("CommandDir = %q, want %q", got, want)
	}
	if got, want := l.ShimSocket("c1"), `C:\ProgramData\sbx-agent\run\cmd\c1.sock`; got != want {
		t.Errorf("ShimSocket = %q, want %q", got, want)
	}
}

func TestWindowsForRoot(t *testing.T) {
	root := t.TempDir()
	l := ForRoot(root)
	if want := filepath.Join(root, "ProgramData", "sbx-agent", "state", "state.db"); l.StateDB != want {
		t.Errorf("StateDB = %q, want %q", l.StateDB, want)
	}
	if want := filepath.Join(root, "Program Files", "sbx-agent", "current"); l.CurrentLink != want {
		t.Errorf("CurrentLink = %q, want %q", l.CurrentLink, want)
	}
}

func TestWindowsRooted(t *testing.T) {
	root := t.TempDir()
	for _, tt := range []struct {
		name    string
		layout  Layout
		in      string
		want    string
		wantErr bool
	}{
		{"default is identity", Default(), `C:\ProgramData\foo`, `C:\ProgramData\foo`, false},
		{"default forward slashes", Default(), `C:/ProgramData//foo/`, `C:\ProgramData\foo`, false},
		{"default dotdot", Default(), `C:\ProgramData\..\foo`, "", true},
		{"default dotdot slash", Default(), `C:/ProgramData/../foo`, "", true},
		{"default drive root", Default(), `C:\`, "", true},
		{"default drive relative", Default(), `C:foo`, "", true},
		{"default rooted without drive", Default(), `\foo`, "", true},
		{"default relative", Default(), `foo\bar`, "", true},
		{"default empty", Default(), "", "", true},
		{"default UNC", Default(), `\\server\share\foo`, "", true},
		{"default device path", Default(), `\\?\C:\foo`, "", true},
		{"default pipe", Default(), `\\.\pipe\foo`, "", true},
		{"rooted maps under root", ForRoot(root), `C:\ProgramData\foo`, filepath.Join(root, "ProgramData", "foo"), false},
		{"rooted drive root", ForRoot(root), `C:\`, "", true},
		{"rooted dotdot", ForRoot(root), `C:\..\x`, "", true},
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
