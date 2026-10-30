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

// listHooks returns the executable regular files of dir in name order.
// Hidden files are skipped; a missing dir has no hooks.
func listHooks(dir string) ([]string, error) {
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
		if err != nil || !info.Mode().IsRegular() || info.Mode().Perm()&0o111 == 0 {
			continue
		}
		out = append(out, p)
	}
	return out, nil
}

// execHook runs path with arg and at most hookTimeout. Its output is
// discarded.
func execHook(ctx context.Context, path, arg string) error {
	ctx, cancel := context.WithTimeout(ctx, hookTimeout)
	defer cancel()
	cmd := exec.CommandContext(ctx, path, arg)
	cmd.WaitDelay = time.Second
	if err := cmd.Run(); err != nil {
		if ctx.Err() != nil {
			return fmt.Errorf("quiesce: hook %s %s: timed out after %s", path, arg, hookTimeout)
		}
		return fmt.Errorf("quiesce: hook %s %s: %w", path, arg, err)
	}
	return nil
}
