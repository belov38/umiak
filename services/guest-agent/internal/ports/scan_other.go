//go:build !linux

package ports

// defaultProcDir is empty off Linux: without an explicit Options.ProcDir
// there is no procfs and Scanner.Run only waits for its context.
const defaultProcDir = ""
