package ident

import (
	"context"
	"errors"
	"fmt"
	"log/slog"
	"runtime"
	"unsafe"

	"golang.org/x/sys/windows"

	"github.com/belov38/umiak/services/guest-agent/internal/winapi"
)

const (
	// identityMutex serializes identity apply between the specialize pass,
	// the startup script and the agent service (spec 11.2).
	identityMutex = `Global\umiak-identity`
	// identityMutexSDDL lets SYSTEM and elevated administrators (a manual
	// `umiak-agent identity apply`) open the mutex.
	identityMutexSDDL = "D:P(A;;GA;;;SY)(A;;GA;;;BA)"
	// lockPoll is how often a wait for the mutex checks the context.
	lockPoll = 1000 // ms
)

// SetupInProgress reports whether Windows Setup (specialize and OOBE of a
// clone) is still running: ImageState is not IMAGE_STATE_COMPLETE. An
// unreadable state counts as finished, so a damaged key cannot stop the
// agent forever.
func SetupInProgress() bool {
	st, err := winapi.ImageState()
	if err != nil {
		slog.Warn("cannot read the windows setup state, assuming setup is complete", "err", err)
		return false
	}
	return st != winapi.ImageStateComplete
}

// lockIdentity takes the global identity mutex and returns its release. A
// mutex belongs to an OS thread, so the calling goroutine stays locked to
// its thread until the release. A mutex abandoned by a process that died
// holding it is taken over: the identity steps are idempotent.
func lockIdentity(ctx context.Context) (func(), error) {
	name, err := windows.UTF16PtrFromString(identityMutex)
	if err != nil {
		return nil, err
	}
	sd, err := windows.SecurityDescriptorFromString(identityMutexSDDL)
	if err != nil {
		return nil, fmt.Errorf("ident: mutex ACL: %w", err)
	}
	sa := &windows.SecurityAttributes{SecurityDescriptor: sd}
	sa.Length = uint32(unsafe.Sizeof(*sa))

	runtime.LockOSThread()
	h, err := windows.CreateMutex(sa, false, name)
	if h == 0 {
		runtime.UnlockOSThread()
		return nil, fmt.Errorf("ident: create %s: %w", identityMutex, err)
	}
	for {
		ev, err := windows.WaitForSingleObject(h, lockPoll)
		switch {
		case err != nil:
			_ = windows.CloseHandle(h)
			runtime.UnlockOSThread()
			return nil, fmt.Errorf("ident: wait for %s: %w", identityMutex, err)
		case ev == windows.WAIT_OBJECT_0, ev == windows.WAIT_ABANDONED:
			if ev == windows.WAIT_ABANDONED {
				slog.Warn("the previous holder of the identity mutex died, repeating its work")
			}
			return func() {
				_ = windows.ReleaseMutex(h)
				_ = windows.CloseHandle(h)
				runtime.UnlockOSThread()
			}, nil
		case ev == uint32(windows.WAIT_TIMEOUT):
			if cerr := ctx.Err(); cerr != nil {
				_ = windows.CloseHandle(h)
				runtime.UnlockOSThread()
				return nil, cerr
			}
		default:
			_ = windows.CloseHandle(h)
			runtime.UnlockOSThread()
			return nil, errors.New("ident: unexpected wait result for the identity mutex")
		}
	}
}
