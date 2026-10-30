// Package output manages the on-disk command output logs: reading them in
// chunks for Attach and evicting old data by punching holes (spec section 10).
package output

import "os"

// Store reports and advances the first readable offset of an output file.
// Evicted data is never removed from the offset space: the file keeps its
// size and the evicted prefix becomes a hole (or is hidden by a marker).
type Store interface {
	// AvailableFrom returns the first offset of f that still holds data.
	// size is the current file size; it is the result for a fully evicted file.
	AvailableFrom(f *os.File, size int64) (int64, error)
	// PunchFront evicts the start of f up to upTo, rounded down to a multiple
	// of blockSize (4 KiB, 64 KiB on Windows). The file size and the offsets
	// of the remaining bytes do not change. Evicting less than already
	// evicted is a no-op.
	PunchFront(f *os.File, upTo int64) error
}

// Default returns the Store for the running OS: sparse files on Linux and
// Windows (NTFS), a sidecar marker on other development hosts.
func Default() Store { return defaultStore() }

// alignDown rounds n down to a multiple of blockSize.
func alignDown(n int64) int64 { return n &^ (blockSize - 1) }
