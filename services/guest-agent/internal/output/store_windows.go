//go:build windows

package output

import (
	"errors"
	"fmt"
	"os"
	"unsafe"

	"golang.org/x/sys/windows"
)

// blockSize is the granularity of hole punching. NTFS frees sparse data in
// whole compression units (16 clusters, 64 KiB with 4 KiB clusters); zeroing
// a smaller range only overwrites it with zero bytes. Offsets handed to
// PunchFront are rounded down to a multiple of it.
const blockSize = 64 << 10

// errPunchIneffective reports that a punch did not make the evicted prefix
// invisible to AvailableFrom.
var errPunchIneffective = errors.New("punch hole ineffective")

func defaultStore() Store { return sparseStore{} }

// sparseStore keeps the evicted prefix as a deallocated range of the file
// itself, so available_from needs no separate accounting.
type sparseStore struct{}

// zeroData is FILE_ZERO_DATA_INFORMATION.
type zeroData struct {
	fileOffset      int64
	beyondFinalZero int64
}

// allocatedRange is FILE_ALLOCATED_RANGE_BUFFER.
type allocatedRange struct {
	fileOffset int64
	length     int64
}

// ioctl runs DeviceIoControl on f. in and out may be nil. The handle is used
// through SyscallConn so f stays alive and its mode is not changed.
func ioctl(f *os.File, code uint32, in, out unsafe.Pointer, inSize, outSize uint32) (returned uint32, err error) {
	rc, err := f.SyscallConn()
	if err != nil {
		return 0, err
	}
	var ioErr error
	err = rc.Control(func(fd uintptr) {
		ioErr = windows.DeviceIoControl(windows.Handle(fd), code,
			(*byte)(in), inSize, (*byte)(out), outSize, &returned, nil)
	})
	if err != nil {
		return 0, err
	}
	return returned, ioErr
}

// MarkSparse sets the sparse attribute of f (FSCTL_SET_SPARSE). The command
// shim calls it on the output files it creates, so evicted prefixes are
// deallocated instead of zero-filled. f needs write access.
func MarkSparse(f *os.File) error {
	if _, err := ioctl(f, windows.FSCTL_SET_SPARSE, nil, nil, 0, 0); err != nil {
		return fmt.Errorf("output: mark %s sparse: %w", f.Name(), err)
	}
	return nil
}

// AvailableFrom implements Store: the start of the first allocated range of
// f. It needs only read access and does not touch the file offset.
func (sparseStore) AvailableFrom(f *os.File, size int64) (int64, error) {
	if size <= 0 {
		return 0, nil
	}
	in := allocatedRange{fileOffset: 0, length: size}
	var out [1]allocatedRange
	n, err := ioctl(f, windows.FSCTL_QUERY_ALLOCATED_RANGES,
		unsafe.Pointer(&in), unsafe.Pointer(&out[0]), uint32(unsafe.Sizeof(in)), uint32(unsafe.Sizeof(out)))
	// With more than one range the call fails with ERROR_MORE_DATA after
	// filling the first entry, which is all that is needed.
	if err != nil && !errors.Is(err, windows.ERROR_MORE_DATA) {
		return 0, err
	}
	if n < uint32(unsafe.Sizeof(out[0])) {
		return size, nil
	}
	return min(out[0].fileOffset, size), nil
}

// PunchFront implements Store. f must be open for writing. It marks the file
// sparse first (a no-op for files the shim already marked), zeroes the range
// and checks that the range became invisible to AvailableFrom: a volume with
// clusters above 4 KiB or without sparse support would keep the data.
func (s sparseStore) PunchFront(f *os.File, upTo int64) error {
	fi, err := f.Stat()
	if err != nil {
		return err
	}
	// Never zero past the end: that could extend the file.
	n := alignDown(min(upTo, fi.Size()))
	if n <= 0 {
		return nil
	}
	cur, err := s.AvailableFrom(f, fi.Size())
	if err != nil {
		return err
	}
	if cur >= n {
		return nil
	}
	if _, err := ioctl(f, windows.FSCTL_SET_SPARSE, nil, nil, 0, 0); err != nil {
		return fmt.Errorf("output: set sparse: %w", err)
	}
	in := zeroData{fileOffset: 0, beyondFinalZero: n}
	if _, err := ioctl(f, windows.FSCTL_SET_ZERO_DATA, unsafe.Pointer(&in), nil, uint32(unsafe.Sizeof(in)), 0); err != nil {
		return fmt.Errorf("output: zero data: %w", err)
	}
	avail, err := s.AvailableFrom(f, fi.Size())
	if err != nil {
		return err
	}
	if avail < n {
		return fmt.Errorf("output: punch hole left data before %d (available_from %d): %w", n, avail, errPunchIneffective)
	}
	return nil
}

// DefaultStatfs returns the size and the space available to the calling user
// of the volume holding path (GetDiskFreeSpaceExW).
func DefaultStatfs(path string) (total, free uint64, err error) {
	p, err := windows.UTF16PtrFromString(path)
	if err != nil {
		return 0, 0, err
	}
	var avail, totalBytes, totalFree uint64
	if err := windows.GetDiskFreeSpaceEx(p, &avail, &totalBytes, &totalFree); err != nil {
		return 0, 0, err
	}
	return totalBytes, avail, nil
}
