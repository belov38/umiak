package agent

import (
	"time"

	"golang.org/x/sys/unix"
)

// kernelRelease is not reported outside Linux.
func kernelRelease() string { return "" }

// monotonicNow reads CLOCK_MONOTONIC (development runs on macOS).
func monotonicNow() (time.Duration, bool) {
	var ts unix.Timespec
	if err := unix.ClockGettime(unix.CLOCK_MONOTONIC, &ts); err != nil {
		return 0, false
	}
	return time.Duration(ts.Nano()), true
}
