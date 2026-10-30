package ports

// defaultProcDir is the procfs mount used when Options.ProcDir is empty.
const defaultProcDir = "/proc"

// defaultSource is unused on Linux: defaultProcDir selects the procfs source.
func defaultSource() listenerSource { return nil }
