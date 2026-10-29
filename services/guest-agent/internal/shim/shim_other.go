//go:build !linux

package shim

import (
	"fmt"
	"os"
	"runtime"
)

// Main is the shim entry point; the shim needs Linux (cgroups, PTYs,
// pidfds), so elsewhere it only reports that and returns 1.
func Main(_ []string) int {
	_, _ = fmt.Fprintf(os.Stderr, "sbx-agent shim: unsupported on %s\n", runtime.GOOS)
	return 1
}
