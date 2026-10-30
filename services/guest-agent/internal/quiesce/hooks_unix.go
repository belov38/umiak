//go:build !windows

package quiesce

import (
	"context"
	"io/fs"
)

// listHooks returns the executable regular files of dir in name order.
func listHooks(dir string) ([]string, error) {
	return listHooksMatching(dir, isExecHook)
}

// isExecHook accepts executable files.
func isExecHook(_ string, info fs.FileInfo) bool {
	return info.Mode().Perm()&0o111 != 0
}

// execHook runs path with arg and at most hookTimeout.
func execHook(ctx context.Context, path, arg string) error {
	return runHookArgv(ctx, []string{path, arg}, path, arg)
}
