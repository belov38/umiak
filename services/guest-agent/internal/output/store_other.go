//go:build !linux && !windows

package output

import (
	"errors"
	"io/fs"
	"os"
	"strconv"
	"strings"
)

// blockSize is the granularity of hole punching. Offsets handed to PunchFront
// are rounded down to a multiple of it.
const blockSize = 4096

func defaultStore() Store { return markerStore{} }

// markerStore is the portable fallback for development hosts: the evicted
// prefix is recorded in a sidecar file "<file>.from" holding the decimal
// offset. Data is not actually freed.
type markerStore struct{}

func markerPath(f *os.File) string { return f.Name() + ".from" }

func readMarker(f *os.File) (int64, error) {
	b, err := os.ReadFile(markerPath(f))
	if errors.Is(err, fs.ErrNotExist) {
		return 0, nil
	}
	if err != nil {
		return 0, err
	}
	n, err := strconv.ParseInt(strings.TrimSpace(string(b)), 10, 64)
	if err != nil || n < 0 {
		return 0, nil
	}
	return n, nil
}

// AvailableFrom implements Store.
func (markerStore) AvailableFrom(f *os.File, size int64) (int64, error) {
	n, err := readMarker(f)
	if err != nil {
		return 0, err
	}
	return min(n, size), nil
}

// PunchFront implements Store.
func (markerStore) PunchFront(f *os.File, upTo int64) error {
	n := alignDown(upTo)
	if n <= 0 {
		return nil
	}
	cur, err := readMarker(f)
	if err != nil {
		return err
	}
	if n <= cur {
		return nil
	}
	tmp := markerPath(f) + ".tmp"
	if err := os.WriteFile(tmp, []byte(strconv.FormatInt(n, 10)), 0o644); err != nil {
		return err
	}
	return os.Rename(tmp, markerPath(f))
}

// DefaultStatfs is not supported outside Linux and Windows.
func DefaultStatfs(string) (total, free uint64, err error) {
	return 0, 0, errors.ErrUnsupported
}
