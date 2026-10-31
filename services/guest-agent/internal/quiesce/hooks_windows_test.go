package quiesce

import (
	"context"
	"os"
	"path/filepath"
	"slices"
	"strings"
	"testing"
)

// TestPS1Hooks runs real PowerShell hooks: only *.ps1 files are hooks,
// the argument reaches the script, a non-zero exit fails the hook.
func TestPS1Hooks(t *testing.T) {
	dir := t.TempDir()
	out := filepath.Join(dir, "hooks.log")
	write := func(name, body string) string {
		p := filepath.Join(dir, name)
		if err := os.WriteFile(p, []byte(body), 0o644); err != nil {
			t.Fatal(err)
		}
		return p
	}
	ok := write("10-a.ps1", "Add-Content -LiteralPath '"+out+"' -Value \"a $($args[0])\"\n")
	failing := write("20-fail.ps1", "exit 3\n")
	write("30-c.cmd", "@echo off\r\n")

	hooks, err := listHooks(dir)
	if err != nil {
		t.Fatal(err)
	}
	if want := []string{ok, failing}; !slices.Equal(hooks, want) {
		t.Fatalf("hooks = %q, want %q", hooks, want)
	}
	ctx := context.Background()
	if err := execHook(ctx, ok, hookFreeze); err != nil {
		t.Fatalf("hook freeze: %v", err)
	}
	if err := execHook(ctx, ok, hookThaw); err != nil {
		t.Fatalf("hook thaw: %v", err)
	}
	data, err := os.ReadFile(out)
	if err != nil {
		t.Fatal(err)
	}
	if got := strings.ReplaceAll(string(data), "\r\n", "\n"); got != "a freeze\na thaw\n" {
		t.Errorf("hook output = %q", got)
	}
	if err := execHook(ctx, failing, hookFreeze); err == nil {
		t.Error("a hook exiting 3 succeeded")
	}
}
