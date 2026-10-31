//go:build !windows

package errs

import "syscall"

// osErrnoTable has no entries on Unix: errnoTable covers them.
var osErrnoTable = map[syscall.Errno]mapping{}
