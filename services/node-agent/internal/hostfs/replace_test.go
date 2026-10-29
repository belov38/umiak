package hostfs

import (
	"errors"
	"io/fs"
	"os"
	"path/filepath"
	"testing"
)

func TestReplaceLockedRewritesFile(t *testing.T) {
	p := filepath.Join(t.TempDir(), "ethers")
	if err := os.WriteFile(p, []byte("a\nb\n"), 0o600); err != nil {
		t.Fatal(err)
	}
	err := ReplaceLocked(p, func([]byte) ([]byte, error) { return []byte("a\n"), nil })
	if err != nil {
		t.Fatal(err)
	}
	got, _ := os.ReadFile(p) //nolint:gosec // test temp file
	st, _ := os.Stat(p)
	if string(got) != "a\n" || st.Mode().Perm() != 0o644 {
		t.Errorf("content %q mode %v", got, st.Mode().Perm())
	}
	if _, err := os.Stat(p + ".sbx-tmp"); !errors.Is(err, fs.ErrNotExist) {
		t.Error("temp file left behind")
	}
}

func TestReplaceLockedMissingFile(t *testing.T) {
	err := ReplaceLocked(filepath.Join(t.TempDir(), "nope"), func(b []byte) ([]byte, error) { return b, nil })
	if !errors.Is(err, fs.ErrNotExist) {
		t.Errorf("err = %v, want ErrNotExist", err)
	}
}
