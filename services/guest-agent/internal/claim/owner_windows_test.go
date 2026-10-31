package claim

import (
	"os"
	"path/filepath"
	"strings"
	"testing"

	"golang.org/x/sys/windows"
)

func ownerUID(t *testing.T, _ string) uint32 {
	t.Helper()
	t.Skip("file ownership is not observable on Windows")
	return 0
}

// testLinkPath is the link_path of fullRequest; Rooted maps it under the
// harness root.
const testLinkPath = `C:\Users\user\.config\key.pem`

// testPath maps a Linux path of the tests to Windows: /home/user is the
// profile C:\Users\user, anything else goes on C:.
func testPath(p string) string {
	if rest, ok := strings.CutPrefix(p, "/home/user"); ok {
		return `C:\Users\user` + filepath.FromSlash(rest)
	}
	return `C:` + filepath.FromSlash(p)
}

// blockSecretPath makes writing the secret file path fail until release: a
// file there held open without sharing. (A directory in the way is
// removed on Windows, see replaceSecret.)
func blockSecretPath(t *testing.T, path string) (release func()) {
	t.Helper()
	if !isSystem(t) {
		t.Skip("a file in the SYSTEM-only secret directory needs SYSTEM")
	}
	mustWrite(t, path, "held")
	f := openShared(t, path, 0)
	return func() {
		_ = f.Close()
		if err := os.RemoveAll(path); err != nil {
			t.Fatal(err)
		}
	}
}

// stateFileMod is the harness option of TestSecretsStateFileMode: the real
// secrets root, whose protected DACL the state file inherits.
func stateFileMod(o *Options) { o.MountSecrets = nil }

// wantRootOnly checks that only SYSTEM and Administrators may open path.
func wantRootOnly(t *testing.T, path string) {
	t.Helper()
	system, err := windows.CreateWellKnownSid(windows.WinLocalSystemSid)
	if err != nil {
		t.Fatal(err)
	}
	admins, err := windows.CreateWellKnownSid(windows.WinBuiltinAdministratorsSid)
	if err != nil {
		t.Fatal(err)
	}
	got := aces(t, path)
	if len(got) != 2 || got[system.String()] != fileAllAccess || got[admins.String()] != fileAllAccess {
		t.Errorf("%s ACEs = %v, want SYSTEM and Administrators only", filepath.Base(path), got)
	}
}
