//go:build !windows

package agent

import (
	"os"
	"testing"
)

// wantPrivateSocket checks that only the owner may connect to the socket
// path: mode 0600.
func wantPrivateSocket(t *testing.T, path string) {
	t.Helper()
	fi, err := os.Stat(path)
	if err != nil {
		t.Fatal(err)
	}
	if m := fi.Mode().Perm(); m != 0o600 {
		t.Errorf("%s mode = %v, want 0600", path, m)
	}
}
