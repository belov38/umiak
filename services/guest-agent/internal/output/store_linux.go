//go:build linux

package output

import (
	"errors"
	"fmt"
	"os"
	"runtime"

	"golang.org/x/sys/unix"
)

// errPunchIneffective reports that a punch did not make the evicted prefix
// invisible to AvailableFrom.
// blockSize is the granularity of hole punching. Offsets handed to PunchFront
// are rounded down to a multiple of it.
const blockSize = 4096

var errPunchIneffective = errors.New("punch hole ineffective")

func defaultStore() Store { return sparseStore{} }

// sparseStore keeps the evicted prefix as a hole in the file itself, so
// available_from needs no separate accounting.
type sparseStore struct{}

// AvailableFrom implements Store. It moves the shared file offset of f, so
// callers must use positional reads (ReadAt) on f.
func (sparseStore) AvailableFrom(f *os.File, size int64) (int64, error) {
	off, err := unix.Seek(int(f.Fd()), 0, unix.SEEK_DATA)
	runtime.KeepAlive(f)
	if err != nil {
		if errors.Is(err, unix.ENXIO) {
			return size, nil
		}
		return 0, err
	}
	return min(off, size), nil
}

// PunchFront implements Store. After punching it checks that the hole is
// visible through SEEK_DATA: a filesystem with a block size above 4 KiB
// zero-fills instead of deallocating, which would keep the data.
func (s sparseStore) PunchFront(f *os.File, upTo int64) error {
	n := alignDown(upTo)
	if n <= 0 {
		return nil
	}
	for {
		err := unix.Fallocate(int(f.Fd()), unix.FALLOC_FL_PUNCH_HOLE|unix.FALLOC_FL_KEEP_SIZE, 0, n)
		runtime.KeepAlive(f)
		if errors.Is(err, unix.EINTR) {
			continue
		}
		if err != nil {
			return err
		}
		break
	}
	fi, err := f.Stat()
	if err != nil {
		return err
	}
	avail, err := s.AvailableFrom(f, fi.Size())
	if err != nil {
		return err
	}
	if want := min(n, fi.Size()); avail < want {
		return fmt.Errorf("output: punch hole left data before %d (available_from %d): %w", want, avail, errPunchIneffective)
	}
	return nil
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
