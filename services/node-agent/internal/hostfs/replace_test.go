package hostfs

import (
	"errors"
	"fmt"
	"io/fs"
	"os"
	"path/filepath"
	"strings"
	"sync"
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
	if left, _ := filepath.Glob(filepath.Join(filepath.Dir(p), ".ethers.umiak-*")); len(left) > 0 {
		t.Error("temp file left behind")
	}
}

func TestReplaceLockedMissingFile(t *testing.T) {
	err := ReplaceLocked(filepath.Join(t.TempDir(), "nope"), func(b []byte) ([]byte, error) { return b, nil })
	if !errors.Is(err, fs.ErrNotExist) {
		t.Errorf("err = %v, want ErrNotExist", err)
	}
}

func TestReplaceLockedConcurrentEditsAreNotLost(t *testing.T) {
	for round := 0; round < 20; round++ {
		p := filepath.Join(t.TempDir(), "ethers")
		var lines []string
		for i := 0; i < 16; i++ {
			lines = append(lines, fmt.Sprintf("line-%02d", i))
		}
		if err := os.WriteFile(p, []byte(strings.Join(lines, "\n")+"\n"), 0o600); err != nil {
			t.Fatal(err)
		}
		var wg sync.WaitGroup
		for _, l := range lines {
			wg.Add(1)
			go func() {
				defer wg.Done()
				err := ReplaceLocked(p, func(b []byte) ([]byte, error) {
					return []byte(strings.Replace(string(b), l+"\n", "", 1)), nil
				})
				if err != nil {
					t.Error(err)
				}
			}()
		}
		wg.Wait()
		got, _ := os.ReadFile(p) //nolint:gosec // test temp file
		if len(got) != 0 {
			t.Fatalf("round %d: lost updates, left %q", round, got)
		}
	}
}

// Proxmox locks the ethers file and then replaces it by rename, so a Proxmox writer that waited for
// the lock may hold it on an inode that is no longer at path while we lock the current one. Its
// rename can then land while we edit; ours must not overwrite it.
func TestReplaceLockedDoesNotOverwriteAConcurrentRename(t *testing.T) {
	dir := t.TempDir()
	p := filepath.Join(dir, "ethers")
	if err := os.WriteFile(p, []byte("old\ngone\n"), 0o600); err != nil {
		t.Fatal(err)
	}
	calls := 0
	err := ReplaceLocked(p, func(b []byte) ([]byte, error) {
		calls++
		if calls == 1 {
			tmp := filepath.Join(dir, "ethers.tmp")
			if err := os.WriteFile(tmp, []byte(string(b)+"new\n"), 0o600); err != nil { //nolint:gosec // test temp file
				return nil, err
			}
			if err := os.Rename(tmp, p); err != nil {
				return nil, err
			}
		}
		return []byte(strings.Replace(string(b), "gone\n", "", 1)), nil
	})
	if err != nil {
		t.Fatal(err)
	}
	got, _ := os.ReadFile(p) //nolint:gosec // test temp file
	if string(got) != "old\nnew\n" || calls < 2 {
		t.Errorf("content %q after %d edits", got, calls)
	}
}

// A Proxmox writer that read the file before our rename may rename its version over ours right
// after, dropping our change; ReplaceLocked checks its change again and reapplies it.
func TestReplaceLockedReappliesAChangeLostToALaterRename(t *testing.T) {
	dir := t.TempDir()
	p := filepath.Join(dir, "ethers")
	if err := os.WriteFile(p, []byte("old\ngone\n"), 0o600); err != nil {
		t.Fatal(err)
	}
	fired := false
	afterRename = func() {
		if fired {
			return
		}
		fired = true
		tmp := filepath.Join(dir, "ethers.tmp")
		_ = os.WriteFile(tmp, []byte("old\ngone\nnew\n"), 0o600)
		_ = os.Rename(tmp, p)
	}
	t.Cleanup(func() { afterRename = func() {} })
	err := ReplaceLocked(p, func(b []byte) ([]byte, error) {
		return []byte(strings.Replace(string(b), "gone\n", "", 1)), nil
	})
	if err != nil {
		t.Fatal(err)
	}
	if got, _ := os.ReadFile(p); string(got) != "old\nnew\n" { //nolint:gosec // test temp file
		t.Errorf("content %q", got)
	}
}
