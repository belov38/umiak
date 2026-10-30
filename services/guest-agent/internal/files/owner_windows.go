package files

import (
	"errors"
	"io/fs"
	"os"
	"syscall"
)

// sysInfo is the part of a stat result that fs.FileInfo does not expose.
// Windows has no numeric owners or inodes; S9 brings its own model.
type sysInfo struct {
	ino      uint64
	uid, gid uint32
}

// sysOf returns zero values on Windows.
func sysOf(fs.FileInfo) sysInfo { return sysInfo{} }

// lchown is a no-op on Windows.
func lchown(string, owner) error { return nil }

// fchown is a no-op on Windows.
func fchown(*os.File, owner) error { return nil }

// rootLchown is a no-op on Windows.
func rootLchown(*os.Root, string, owner) error { return nil }

// openRead opens path for reading.
func openRead(path string) (*os.File, error) { return os.Open(path) }

// deviceOf is unknown on Windows: every path counts as one device, and a
// failed rename falls back to a copy.
func deviceOf(string) (uint64, bool) { return 0, true }

// isNotEmpty reports a "directory not empty" error.
func isNotEmpty(err error) bool {
	return errors.Is(err, syscall.ENOTEMPTY) || errors.Is(err, syscall.EEXIST)
}
