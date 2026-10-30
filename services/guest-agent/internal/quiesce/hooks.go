package quiesce

import (
	"context"
	"errors"
	"fmt"
	"io/fs"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"time"
)

// Hook arguments (the QGA fsfreeze-hook convention).
const (
	hookFreeze = "freeze"
	hookThaw   = "thaw"
)

// hookTimeout bounds one hook run (spec 14.2).
const hookTimeout = 5 * time.Second

// HookRunner runs one hook with its argument.
type HookRunner func(ctx context.Context, path, arg string) error

// listHooksMatching returns the regular files of dir accepted by ok, in
// name order. Hidden files are skipped; a missing dir has no hooks.
func listHooksMatching(dir string, ok func(name string, info fs.FileInfo) bool) ([]string, error) {
	entries, err := os.ReadDir(dir)
	if errors.Is(err, fs.ErrNotExist) {
		return nil, nil
	}
	if err != nil {
		return nil, fmt.Errorf("quiesce: list hooks: %w", err)
	}
	var out []string
	for _, e := range entries {
		if strings.HasPrefix(e.Name(), ".") {
			continue
		}
		p := filepath.Join(dir, e.Name())
		info, err := os.Stat(p) // follows symlinks
		if err != nil || !info.Mode().IsRegular() || !ok(e.Name(), info) {
			continue
		}
		out = append(out, p)
	}
	return out, nil
}

// isPS1Hook accepts *.ps1 files in any case (Windows, S9 spec 12.10).
func isPS1Hook(name string, _ fs.FileInfo) bool {
	return strings.EqualFold(filepath.Ext(name), ".ps1")
}

// ps1HookArgv is the command line of a PowerShell hook: Windows PowerShell
// from systemRoot (PATH lookup without it), no profile, no prompts, any
// execution policy.
func ps1HookArgv(systemRoot, path, arg string) []string {
	exe := "powershell.exe"
	if systemRoot != "" {
		exe = systemRoot + `\System32\WindowsPowerShell\v1.0\powershell.exe`
	}
	return []string{exe, "-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-File", path, arg}
}

// runHookArgv runs the hook path with arg through argv, at most
// hookTimeout. Its output is discarded.
func runHookArgv(ctx context.Context, argv []string, path, arg string) error {
	ctx, cancel := context.WithTimeout(ctx, hookTimeout)
	defer cancel()
	cmd := exec.CommandContext(ctx, argv[0], argv[1:]...)
	cmd.WaitDelay = time.Second
	if err := cmd.Run(); err != nil {
		if ctx.Err() != nil {
			return fmt.Errorf("quiesce: hook %s %s: timed out after %s", path, arg, hookTimeout)
		}
		return fmt.Errorf("quiesce: hook %s %s: %w", path, arg, err)
	}
	return nil
}
