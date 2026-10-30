//go:build linux

package quiesce

import (
	"fmt"
	"os"

	"golang.org/x/sys/unix"
)

// Mounts implements Freezer: the freezable mounts of mountinfo in freeze
// order (see selectMounts).
func (f *sysFreezer) Mounts() ([]Mount, error) {
	file, err := os.Open(f.mountInfo)
	if err != nil {
		return nil, fmt.Errorf("quiesce: %w", err)
	}
	defer func() { _ = file.Close() }()
	entries, err := parseMountInfo(file)
	if err != nil {
		return nil, err
	}
	return selectMounts(entries, blockDev), nil
}

// blockDev returns the device number of source when it is a block device.
func blockDev(source string) (uint64, bool) {
	var st unix.Stat_t
	if err := unix.Stat(source, &st); err != nil || st.Mode&unix.S_IFMT != unix.S_IFBLK {
		return 0, false
	}
	return uint64(st.Rdev), true //nolint:unconvert // Rdev is uint32 on some architectures
}
