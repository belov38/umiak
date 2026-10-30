//go:build !windows

package files

import (
	"errors"
	"io/fs"
	"os"
	"syscall"
)

// replaceFile renames src over dst atomically.
func replaceFile(src, dst string) error { return os.Rename(src, dst) }

// placeNew moves the finished file tmp to dst unless dst exists
// (fs.ErrExist): a hard link refuses an existing dst atomically, then tmp is
// removed.
func placeNew(tmp, dst string) error {
	if err := os.Link(tmp, dst); err != nil {
		return err
	}
	_ = os.Remove(tmp)
	return nil
}

// isCrossDevice reports a rename across filesystems.
func isCrossDevice(err error) bool { return errors.Is(err, syscall.EXDEV) }

// renameCheckFirst renames src to dst after checking that dst does not
// exist (fs.ErrExist otherwise). The two steps are not atomic.
func renameCheckFirst(src, dst string) error {
	if _, err := os.Lstat(dst); err == nil {
		return &os.LinkError{Op: "rename", Old: src, New: dst, Err: fs.ErrExist}
	}
	return os.Rename(src, dst)
}
