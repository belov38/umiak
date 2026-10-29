//go:build !linux

package shim

import (
	"fmt"
	"io"
	"os"
	"runtime"
)

// Main is the shim entry point; the shim needs Linux (cgroups, PTYs,
// pidfds), so elsewhere it only reports that and returns 1.
func Main(args []string) int {
	return Run(args, os.Stderr)
}

// Run is Main with an explicit log writer.
func Run(_ []string, stderr io.Writer) int {
	_, _ = fmt.Fprintf(stderr, "sbx-agent shim: unsupported on %s\n", runtime.GOOS)
	return 1
}
