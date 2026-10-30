//go:build !windows

package agent

import "os"

// secureSocket makes the socket file owner-only. Outside Windows the local
// sockets only run in tests.
func secureSocket(path string, _ socketKind, _ string) error {
	return os.Chmod(path, 0o600)
}
