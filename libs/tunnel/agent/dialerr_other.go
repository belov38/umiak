//go:build !windows

package agent

import (
	"errors"
	"syscall"
)

// isConnRefused reports whether err is a refused TCP connection.
func isConnRefused(err error) bool {
	return errors.Is(err, syscall.ECONNREFUSED)
}
