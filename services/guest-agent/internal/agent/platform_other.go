//go:build !linux && !darwin

package agent

import "time"

// kernelRelease is not reported on this OS.
func kernelRelease() string { return "" }

// monotonicNow is not available on this OS.
func monotonicNow() (time.Duration, bool) { return 0, false }
