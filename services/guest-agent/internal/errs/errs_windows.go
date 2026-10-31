package errs

import (
	"syscall"

	"connectrpc.com/connect"
	"golang.org/x/sys/windows"
)

// fileInUse is a sharing or lock violation: another process holds the file
// open without FILE_SHARE_DELETE or FILE_SHARE_WRITE (S9 spec section 12.9).
var fileInUse = mapping{code: connect.CodeFailedPrecondition, detail: FileInUse, retryable: true}

// osErrnoTable maps the Win32 error codes that the fs sentinels and
// errnoTable do not cover. It is consulted before errnoTable.
var osErrnoTable = map[syscall.Errno]mapping{
	// A missing parent directory. Package syscall defines ENOTDIR as this
	// code, so without the entry every missing parent would map to
	// not_directory; a non-directory in the way is ERROR_DIRECTORY here.
	windows.ERROR_PATH_NOT_FOUND:      {code: connect.CodeNotFound, detail: PathNotFound},
	windows.ERROR_DIR_NOT_EMPTY:       notEmpty,
	windows.ERROR_DIRECTORY:           notDirectory,
	windows.ERROR_DISK_FULL:           noSpace,
	windows.ERROR_HANDLE_DISK_FULL:    noSpace,
	windows.ERROR_DISK_QUOTA_EXCEEDED: noSpace,
	windows.ERROR_NOT_SAME_DEVICE:     crossDevice,
	windows.ERROR_SHARING_VIOLATION:   fileInUse,
	windows.ERROR_LOCK_VIOLATION:      fileInUse,
	windows.ERROR_USER_MAPPED_FILE:    fileInUse,
}
