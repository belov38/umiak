package errs

import (
	"fmt"
	"io/fs"
	"syscall"
	"testing"

	"connectrpc.com/connect"
	"golang.org/x/sys/windows"

	"github.com/belov38/umiak/libs/tunnel/rpcconv"
)

func TestFromErrnoWindowsSharingViolation(t *testing.T) {
	for _, errno := range []syscall.Errno{
		windows.ERROR_SHARING_VIOLATION,
		windows.ERROR_LOCK_VIOLATION,
		windows.ERROR_USER_MAPPED_FILE,
	} {
		t.Run(errno.Error(), func(t *testing.T) {
			err := FromErrno(&fs.PathError{Op: "remove", Path: `C:\x`, Err: errno})
			if err.Code() != connect.CodeFailedPrecondition {
				t.Errorf("code = %v, want failed_precondition", err.Code())
			}
			d, ok := rpcconv.Detail(err)
			if !ok || d.GetCode() != FileInUse || !d.GetRetryable() {
				t.Errorf("detail = %v (ok=%v), want %q retryable", d, ok, FileInUse)
			}
		})
	}
}

func TestFromErrnoWindows(t *testing.T) {
	tests := []struct {
		errno      syscall.Errno
		wantCode   connect.Code
		wantDetail string
	}{
		{windows.ERROR_FILE_NOT_FOUND, connect.CodeNotFound, PathNotFound},
		{windows.ERROR_PATH_NOT_FOUND, connect.CodeNotFound, PathNotFound},
		{windows.ERROR_ALREADY_EXISTS, connect.CodeAlreadyExists, AlreadyExists},
		{windows.ERROR_FILE_EXISTS, connect.CodeAlreadyExists, AlreadyExists},
		{windows.ERROR_ACCESS_DENIED, connect.CodePermissionDenied, PermissionDenied},
		{windows.ERROR_DIR_NOT_EMPTY, connect.CodeFailedPrecondition, FailedPrecondition},
		{windows.ERROR_DIRECTORY, connect.CodeFailedPrecondition, NotDirectory},
		{windows.ERROR_DISK_FULL, connect.CodeResourceExhausted, NoSpace},
		{windows.ERROR_HANDLE_DISK_FULL, connect.CodeResourceExhausted, NoSpace},
		{windows.ERROR_DISK_QUOTA_EXCEEDED, connect.CodeResourceExhausted, NoSpace},
		{windows.ERROR_NOT_SAME_DEVICE, connect.CodeFailedPrecondition, CrossDevice},
		// The invented errnos of package syscall, used by portable code.
		// ENOTDIR is ERROR_PATH_NOT_FOUND on Windows: a missing parent.
		{syscall.ENOTDIR, connect.CodeNotFound, PathNotFound},
		{syscall.ENOSPC, connect.CodeResourceExhausted, NoSpace},
		{windows.ERROR_INVALID_FUNCTION, connect.CodeInternal, Internal},
	}
	for _, tt := range tests {
		t.Run(tt.errno.Error(), func(t *testing.T) {
			err := FromErrno(&fs.PathError{Op: "open", Path: `C:\x`, Err: tt.errno})
			if err.Code() != tt.wantCode {
				t.Errorf("code = %v, want %v", err.Code(), tt.wantCode)
			}
			d, ok := rpcconv.Detail(err)
			if !ok || d.GetCode() != tt.wantDetail || d.GetRetryable() {
				t.Errorf("detail = %v (ok=%v), want %q not retryable", d, ok, tt.wantDetail)
			}
		})
	}
}

func TestIsNoSpaceWindows(t *testing.T) {
	for _, errno := range []syscall.Errno{windows.ERROR_DISK_FULL, windows.ERROR_HANDLE_DISK_FULL, windows.ERROR_DISK_QUOTA_EXCEEDED} {
		if !IsNoSpace(fmt.Errorf("write: %w", errno)) {
			t.Errorf("IsNoSpace(%v) = false", errno)
		}
	}
	if IsNoSpace(windows.ERROR_ACCESS_DENIED) {
		t.Error("IsNoSpace(ERROR_ACCESS_DENIED) = true")
	}
}
