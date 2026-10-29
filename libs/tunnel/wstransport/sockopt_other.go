//go:build !linux

package wstransport

import (
	"syscall"
	"time"
)

// userTimeoutControl is a no-op: TCP_USER_TIMEOUT is Linux only. TCP
// keepalive and the WebSocket ping loop still detect dead peers.
func userTimeoutControl(time.Duration) func(network, address string, c syscall.RawConn) error {
	return nil
}
