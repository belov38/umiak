package agent

import (
	"time"

	"golang.org/x/sys/unix"
)

// kernelRelease returns the kernel release (uname -r).
func kernelRelease() string {
	var u unix.Utsname
	if err := unix.Uname(&u); err != nil {
		return ""
	}
	return unix.ByteSliceToString(u.Release[:])
}

// monotonicNow reads CLOCK_MONOTONIC, the clock of systemd's
// *TimestampMonotonic properties.
func monotonicNow() (time.Duration, bool) {
	var ts unix.Timespec
	if err := unix.ClockGettime(unix.CLOCK_MONOTONIC, &ts); err != nil {
		return 0, false
	}
	return time.Duration(ts.Nano()), true
}
