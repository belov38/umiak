package files

import (
	"errors"
	"io/fs"
	"os"
	"path/filepath"
	"syscall"

	"golang.org/x/sys/windows"
)

// errNotDir is the errno of a non-directory in the way: ERROR_DIRECTORY,
// since package syscall defines ENOTDIR as ERROR_PATH_NOT_FOUND (a missing
// parent, mapped to not_found).
var errNotDir error = windows.ERROR_DIRECTORY

// sysInfo is the part of a stat result that fs.FileInfo does not expose.
// Windows has no numeric owners: owner names come from the SID
// (setOwnerMode) and owners are set by account (lchown).
type sysInfo struct {
	uid, gid uint32
}

// sysOf returns zero values on Windows.
func sysOf(fs.FileInfo) sysInfo { return sysInfo{} }

// lookupGroup accepts any name: Windows ignores groups (S9 spec 12.9).
func lookupGroup(string) (uint32, error) { return 0, nil }

// fchown gives the open file f to o. The handle of f lacks WRITE_OWNER, so
// the file is reopened by name.
func fchown(f *os.File, o owner) error { return lchown(f.Name(), o) }

// rootLchown gives name inside r (not a link target) to o.
func rootLchown(r *os.Root, name string, o owner) error {
	return lchown(filepath.Join(r.Name(), name), o)
}

// openRead opens path for reading.
func openRead(path string) (*os.File, error) { return os.Open(path) }

// deviceOf is unknown on Windows: every path counts as one device, and a
// failed rename falls back to a copy.
func deviceOf(string) (uint64, bool) { return 0, true }

// isNotEmpty reports a "directory not empty" error.
func isNotEmpty(err error) bool {
	return errors.Is(err, syscall.ENOTEMPTY) || errors.Is(err, syscall.EEXIST) ||
		errors.Is(err, windows.ERROR_DIR_NOT_EMPTY)
}
