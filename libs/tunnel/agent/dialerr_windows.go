//go:build windows

package agent

import (
	"errors"
	"syscall"
)

// wsaeconnrefused is WSAECONNREFUSED. syscall.ECONNREFUSED on Windows is a
// Go-defined invented value that Winsock never returns.
const wsaeconnrefused = syscall.Errno(10061)

// isConnRefused reports whether err is a refused TCP connection.
func isConnRefused(err error) bool {
	return errors.Is(err, wsaeconnrefused) || errors.Is(err, syscall.ECONNREFUSED)
}
