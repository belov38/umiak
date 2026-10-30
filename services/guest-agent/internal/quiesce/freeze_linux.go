//go:build linux

package quiesce

import (
	"os"

	"golang.org/x/sys/unix"
)

// FIFREEZE and FITHAW from linux/fs.h: _IOWR('X', 119, int) and
// _IOWR('X', 120, int) in the generic ioctl encoding (amd64, arm64 and the
// other architectures without their own _IOC layout).
const (
	ioctlFIFREEZE = 0xC0045877
	ioctlFITHAW   = 0xC0045878
)

// sysFreezer freezes block filesystems with FIFREEZE/FITHAW.
type sysFreezer struct {
	// mountInfo is the mountinfo file to read.
	mountInfo string
}

// NewFreezer returns the freezer of this platform: FIFREEZE/FITHAW on the
// filesystems listed in /proc/self/mountinfo. It needs root.
func NewFreezer() Freezer {
	return &sysFreezer{mountInfo: "/proc/self/mountinfo"}
}

// Freeze implements Freezer. A filesystem that is already frozen fails
// with an error wrapping syscall.EBUSY.
func (f *sysFreezer) Freeze(path string) error {
	return ioctlPath(path, ioctlFIFREEZE, "FIFREEZE")
}

// Thaw implements Freezer. A filesystem that is not frozen fails with an
// error wrapping syscall.EINVAL.
func (f *sysFreezer) Thaw(path string) error {
	return ioctlPath(path, ioctlFITHAW, "FITHAW")
}

// ioctlPath opens path and issues the freeze ioctl req on it. A mount point
// may be a file (a file bind mount); O_NONBLOCK keeps a FIFO from blocking
// the open.
func ioctlPath(path string, req uint, op string) error {
	fd, err := unix.Open(path, unix.O_RDONLY|unix.O_NONBLOCK|unix.O_CLOEXEC, 0)
	if err != nil {
		return &os.PathError{Op: "open", Path: path, Err: err}
	}
	defer func() { _ = unix.Close(fd) }()
	if err := unix.IoctlSetInt(fd, req, 0); err != nil {
		return &os.PathError{Op: op, Path: path, Err: err}
	}
	return nil
}

// syncAll flushes all filesystems (sync(2)).
func syncAll() {
	unix.Sync()
}
