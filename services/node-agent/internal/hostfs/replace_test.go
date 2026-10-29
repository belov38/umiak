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
	if left, _ := filepath.Glob(filepath.Join(filepath.Dir(p), ".ethers.sbx-*")); len(left) > 0 {
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
