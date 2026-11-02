package winproc

import (
	"errors"
	"fmt"
	"sync"

	"golang.org/x/sys/windows"
)

// ErrShimExists means another shim holds the mutex of the command.
var ErrShimExists = errors.New("winproc: shim mutex already exists")

func shimMutexName(id string) (*uint16, error) {
	if err := checkName("umiak-shim-" + id); err != nil {
		return nil, err
	}
	return windows.UTF16PtrFromString(`Global\umiak-shim-` + id)
}

// ShimMutex creates the named mutex `Global\umiak-shim-<id>` that marks the
// shim of command id as alive: the object exists while the shim holds the
// handle and vanishes with the shim's process. Liveness is the existence of
// the object, not ownership (ownership is per OS thread). release closes it;
// calling release again does nothing.
func ShimMutex(id string) (release func(), err error) {
	name, err := shimMutexName(id)
	if err != nil {
		return nil, err
	}
	h, err := windows.CreateMutex(nil, false, name)
	if errors.Is(err, windows.ERROR_ALREADY_EXISTS) {
		_ = windows.CloseHandle(h)
		return nil, fmt.Errorf("%w: %s", ErrShimExists, id)
	}
	if err != nil {
		return nil, fmt.Errorf("winproc: shim mutex %s: %w", id, err)
	}
	var once sync.Once
	return func() { once.Do(func() { _ = windows.CloseHandle(h) }) }, nil
}

// ShimAlive reports whether the shim mutex of command id exists. A mutex the
// caller may not open exists too.
func ShimAlive(id string) bool {
	name, err := shimMutexName(id)
	if err != nil {
		return false
	}
	h, err := windows.OpenMutex(windows.SYNCHRONIZE, false, name)
	if err == nil {
		_ = windows.CloseHandle(h)
		return true
	}
	return errors.Is(err, windows.ERROR_ACCESS_DENIED)
}
