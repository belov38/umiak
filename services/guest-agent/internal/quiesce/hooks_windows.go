package quiesce

import (
	"context"
	"os"
)

// listHooks returns the *.ps1 files of dir in name order (S9 spec 12.10).
func listHooks(dir string) ([]string, error) {
	return listHooksMatching(dir, isPS1Hook)
}

// execHook runs the PowerShell hook path with arg and at most hookTimeout.
func execHook(ctx context.Context, path, arg string) error {
	return runHookArgv(ctx, ps1HookArgv(os.Getenv("SystemRoot"), path, arg), path, arg)
}
