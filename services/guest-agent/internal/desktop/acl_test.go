package desktop

import (
	"path/filepath"
	"slices"
	"testing"
)

func TestACLCommandsKeepInheritableGrantsOnDirectories(t *testing.T) {
	dir := filepath.Join("state", "moon")
	got := aclCommands(dir, "acct", true, []string{"config.json", "data"})
	if len(got) != 3 || !slices.Contains(got[0], "acct:(OI)(CI)F") || slices.Contains(got[0], "/T") {
		t.Fatalf("directory grant: %q", got)
	}
	for i, c := range []string{"config.json", "data"} {
		want := []string{filepath.Join(dir, c), "/reset", "/T", "/Q"}
		if !slices.Equal(got[i+1], want) {
			t.Fatalf("child %d: %q, want %q", i, got[i+1], want)
		}
	}
	file := aclCommands(filepath.Join(dir, "ice.json"), "acct", false, nil)
	if len(file) != 1 || !slices.Contains(file[0], "acct:F") || !slices.Contains(file[0], "*S-1-5-18:F") {
		t.Fatalf("file grant: %q", file)
	}
}
