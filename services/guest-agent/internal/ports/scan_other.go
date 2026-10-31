//go:build !linux && !windows

package ports

// defaultProcDir is empty here: without an explicit Options.ProcDir there is
// no socket table and Scanner.Run only waits for its context.
const defaultProcDir = ""

// defaultSource has nothing to read on this platform.
func defaultSource() listenerSource { return nil }
