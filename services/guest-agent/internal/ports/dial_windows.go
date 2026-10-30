package ports

import (
	"errors"

	"golang.org/x/sys/windows"
)

// isConnRefusedOS reports whether err is WSAECONNREFUSED, which Winsock
// returns for a refused connect instead of a syscall.ECONNREFUSED.
func isConnRefusedOS(err error) bool {
	return errors.Is(err, windows.WSAECONNREFUSED)
}
