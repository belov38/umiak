package files

import (
	"errors"
	"os"

	"golang.org/x/sys/unix"
)

// renameNoReplace renames src to dst unless dst exists, atomically with
// renameat2(RENAME_NOREPLACE). An existing dst is an error for which
// errors.Is(err, fs.ErrExist) holds. Filesystems without RENAME_NOREPLACE
// fall back to a check followed by a rename.
func renameNoReplace(src, dst string) error {
	err := unix.Renameat2(unix.AT_FDCWD, src, unix.AT_FDCWD, dst, unix.RENAME_NOREPLACE)
	if errors.Is(err, unix.EINVAL) || errors.Is(err, unix.ENOSYS) {
		return renameCheckFirst(src, dst)
	}
	if err != nil {
		return &os.LinkError{Op: "rename", Old: src, New: dst, Err: err}
	}
	return nil
}
