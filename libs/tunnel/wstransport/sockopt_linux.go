//go:build linux

package wstransport

import (
	"syscall"
	"time"

	"golang.org/x/sys/unix"
)

// userTimeoutControl returns a net.Dialer/ListenConfig Control function that
// sets TCP_USER_TIMEOUT, or nil when d is not positive. The option makes the
// kernel drop a connection whose sent data stays unacknowledged for d, which
// bounds how long a dead peer goes unnoticed while writes are pending.
func userTimeoutControl(d time.Duration) func(network, address string, c syscall.RawConn) error {
	if d <= 0 {
		return nil
	}
	ms := int(d.Milliseconds())
	return func(_, _ string, c syscall.RawConn) error {
		var serr error
		if err := c.Control(func(fd uintptr) {
			serr = unix.SetsockoptInt(int(fd), unix.IPPROTO_TCP, unix.TCP_USER_TIMEOUT, ms)
		}); err != nil {
			return err
		}
		return serr
	}
}
