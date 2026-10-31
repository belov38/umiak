//go:build !windows

package claim

import (
	"os"
	"path/filepath"
	"syscall"
	"testing"
)

func ownerUID(t *testing.T, path string) uint32 {
	t.Helper()
	fi, err := os.Stat(path)
	if err != nil {
		t.Fatal(err)
	}
	return fi.Sys().(*syscall.Stat_t).Uid
}

// testLinkPath is the link_path of fullRequest.
const testLinkPath = "/home/user/.config/key.pem"

// testPath maps a Linux path of the tests to this OS: unchanged here.
func testPath(p string) string { return p }

// blockSecretPath makes writing the secret file path fail until release: a
// non-empty directory cannot be renamed over.
func blockSecretPath(t *testing.T, path string) (release func()) {
	t.Helper()
	mustMkdir(t, filepath.Join(path, "x"))
	return func() {
		if err := os.RemoveAll(path); err != nil {
			t.Fatal(err)
		}
	}
}

// stateFileMod is the harness option of TestSecretsStateFileMode.
func stateFileMod(*Options) {}

// wantRootOnly checks that only root may read path: mode 0600.
func wantRootOnly(t *testing.T, path string) {
	t.Helper()
	fi, err := os.Stat(path)
	if err != nil {
		t.Fatal(err)
	}
	if m := fi.Mode().Perm(); m != 0o600 {
		t.Errorf("%s mode = %o, want 600", filepath.Base(path), m)
	}
}
