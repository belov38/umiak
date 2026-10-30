//go:build !windows

package files

import (
	"errors"
	"io/fs"
	"os"
	"path/filepath"
	"syscall"
)

// sysInfo is the part of a stat result that fs.FileInfo does not expose.
type sysInfo struct {
	ino, dev uint64
	uid, gid uint32
}

// sysOf returns the inode, device and owner of fi.
func sysOf(fi fs.FileInfo) sysInfo {
	st, ok := fi.Sys().(*syscall.Stat_t)
	if !ok {
		return sysInfo{}
	}
	return sysInfo{ino: uint64(st.Ino), dev: uint64(st.Dev), uid: st.Uid, gid: st.Gid} //nolint:unconvert // types differ per OS
}

// lchown gives path (not a symlink target) to o.
func lchown(path string, o owner) error {
	return os.Lchown(path, o.uid, o.gid)
}

// fchown gives the open file f to o.
func fchown(f *os.File, o owner) error {
	return f.Chown(o.uid, o.gid)
}

// rootLchown gives name inside r (not a symlink target) to o. Only the
// os.Root unpack of non-Linux systems uses it.
//
//nolint:unused // used by archive_put_other.go
func rootLchown(r *os.Root, name string, o owner) error {
	return r.Lchown(name, o.uid, o.gid)
}

// openRead opens path for reading without blocking on a FIFO.
func openRead(path string) (*os.File, error) {
	return os.OpenFile(path, os.O_RDONLY|syscall.O_NONBLOCK, 0)
}

// deviceOf returns the device of the nearest existing ancestor of p
// (p included).
func deviceOf(p string) (uint64, bool) {
	for {
		fi, err := os.Stat(p)
		if err == nil {
			return sysOf(fi).dev, true
		}
		if !errors.Is(err, fs.ErrNotExist) {
			return 0, false
		}
		parent := filepath.Dir(p)
		if parent == p {
			return 0, false
		}
		p = parent
	}
}

// isNotEmpty reports a "directory not empty" error.
func isNotEmpty(err error) bool {
	return errors.Is(err, syscall.ENOTEMPTY) || errors.Is(err, syscall.EEXIST)
}
