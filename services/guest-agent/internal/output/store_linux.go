//go:build linux

package output

import (
	"errors"
	"os"

	"golang.org/x/sys/unix"
)

func defaultStore() Store { return sparseStore{} }

// sparseStore keeps the evicted prefix as a hole in the file itself, so
// available_from needs no separate accounting.
type sparseStore struct{}

// AvailableFrom implements Store. It moves the shared file offset of f, so
// callers must use positional reads (ReadAt) on f.
func (sparseStore) AvailableFrom(f *os.File, size int64) (int64, error) {
	off, err := unix.Seek(int(f.Fd()), 0, unix.SEEK_DATA)
	if err != nil {
		if errors.Is(err, unix.ENXIO) {
			return size, nil
		}
		return 0, err
	}
	return min(off, size), nil
}

// PunchFront implements Store.
func (sparseStore) PunchFront(f *os.File, upTo int64) error {
	n := alignDown(upTo)
	if n <= 0 {
		return nil
	}
	for {
		err := unix.Fallocate(int(f.Fd()), unix.FALLOC_FL_PUNCH_HOLE|unix.FALLOC_FL_KEEP_SIZE, 0, n)
		if !errors.Is(err, unix.EINTR) {
			return err
		}
	}
}

// DefaultStatfs returns the size and the space available to unprivileged
// users of the filesystem holding path.
func DefaultStatfs(path string) (total, free uint64, err error) {
	var st unix.Statfs_t
	if err := unix.Statfs(path, &st); err != nil {
		return 0, 0, err
	}
	bs := uint64(st.Bsize)
	return st.Blocks * bs, st.Bavail * bs, nil
}
