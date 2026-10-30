//go:build !windows

package ports

// isConnRefusedOS has nothing to add off Windows: refusals are
// syscall.ECONNREFUSED.
func isConnRefusedOS(error) bool { return false }
