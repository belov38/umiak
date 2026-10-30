package files

import (
	"errors"
	"os"
	"path/filepath"
	"strings"
	"syscall"

	"golang.org/x/sys/windows"
)

// moveFile is MoveFileExW(src, dst, flags) with the error as an
// *os.LinkError.
func moveFile(src, dst string, flags uint32) error {
	from, err := windows.UTF16PtrFromString(src)
	if err == nil {
		var to *uint16
		if to, err = windows.UTF16PtrFromString(dst); err == nil {
			err = windows.MoveFileEx(from, to, flags)
		}
	}
	if err != nil {
		return &os.LinkError{Op: "rename", Old: src, New: dst, Err: err}
	}
	return nil
}

// replaceFile renames src over dst with MoveFileExW(REPLACE_EXISTING |
// WRITE_THROUGH) (S9 spec 12.9). NTFS refuses to replace an open or a
// read-only dst with ERROR_ACCESS_DENIED. Then a dst held open without
// FILE_SHARE_DELETE is ERROR_SHARING_VIOLATION (file_in_use); a read-only
// dst loses the attribute for the retry, as root replaces a 0444 file on
// Linux; a dst held open with FILE_SHARE_DELETE is replaced by a POSIX
// rename when src is in the same directory. Otherwise the first error is
// returned and dst is unchanged.
func replaceFile(src, dst string) error {
	const flags = windows.MOVEFILE_REPLACE_EXISTING | windows.MOVEFILE_WRITE_THROUGH
	err := moveFile(src, dst, flags)
	if err == nil || !errors.Is(err, windows.ERROR_ACCESS_DENIED) {
		return err
	}
	if inUse(dst) {
		return &os.LinkError{Op: "rename", Old: src, New: dst, Err: windows.ERROR_SHARING_VIOLATION}
	}
	restore := clearReadOnly(dst)
	retry := moveFile(src, dst, flags)
	if retry != nil && errors.Is(retry, windows.ERROR_ACCESS_DENIED) && sameDir(src, dst) {
		retry = posixRename(src, dst)
	}
	if retry != nil {
		restore()
		return err
	}
	return nil
}

// placeNew moves the finished file tmp to dst unless dst exists
// (fs.ErrExist): MoveFileExW without REPLACE_EXISTING refuses an existing
// dst atomically.
func placeNew(tmp, dst string) error {
	return moveFile(tmp, dst, windows.MOVEFILE_WRITE_THROUGH)
}

// isCrossDevice reports a rename across volumes.
func isCrossDevice(err error) bool {
	return errors.Is(err, windows.ERROR_NOT_SAME_DEVICE) || errors.Is(err, syscall.EXDEV)
}

// inUse reports whether another handle holds path open without
// FILE_SHARE_DELETE: opening it for DELETE is a sharing violation.
func inUse(path string) bool {
	h, err := openHandle(path, windows.DELETE, false)
	if err != nil {
		return errors.Is(err, windows.ERROR_SHARING_VIOLATION)
	}
	_ = windows.CloseHandle(h)
	return false
}

// clearReadOnly clears the read-only attribute of path and returns the
// function that sets it again; both are no-ops when it is not set.
func clearReadOnly(path string) (restore func()) {
	p, err := windows.UTF16PtrFromString(path)
	if err != nil {
		return func() {}
	}
	attrs, err := windows.GetFileAttributes(p)
	if err != nil || attrs&windows.FILE_ATTRIBUTE_READONLY == 0 {
		return func() {}
	}
	if windows.SetFileAttributes(p, attrs&^windows.FILE_ATTRIBUTE_READONLY) != nil {
		return func() {}
	}
	return func() { _ = windows.SetFileAttributes(p, attrs) }
}

// sameDir reports whether a and b are in the same directory.
func sameDir(a, b string) bool {
	return strings.EqualFold(filepath.Dir(a), filepath.Dir(b))
}

// posixRename renames src over dst in their common directory with POSIX
// semantics (os.Root does it with FILE_RENAME_POSIX_SEMANTICS): open
// handles of dst keep the old file.
func posixRename(src, dst string) error {
	r, err := os.OpenRoot(filepath.Dir(dst))
	if err != nil {
		return err
	}
	defer r.Close() //nolint:errcheck // directory handle
	return r.Rename(filepath.Base(src), filepath.Base(dst))
}
