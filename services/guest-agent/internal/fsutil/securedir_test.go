package fsutil

import (
	"os"
	"path/filepath"
	"testing"
)

func TestIsSecure(t *testing.T) {
	for _, a := range []DirAccess{SystemOnly, SystemAndAdmins} {
		dir := filepath.Join(t.TempDir(), "state")
		if err := os.Mkdir(dir, 0o755); err != nil {
			t.Fatal(err)
		}
		if ok, err := IsSecure(dir, a); err != nil || ok {
			t.Errorf("%v: plain directory: IsSecure = %v, %v; want false", a, ok, err)
		}
		if err := MkdirSecure(dir, a); err != nil {
			t.Fatal(err)
		}
		if ok, err := IsSecure(dir, a); err != nil || !ok {
			t.Errorf("%v: after MkdirSecure: IsSecure = %v, %v; want true", a, ok, err)
		}
	}
	if _, err := IsSecure(filepath.Join(t.TempDir(), "missing"), SystemOnly); err == nil {
		t.Error("IsSecure of a missing directory succeeded")
	}
}
