package winapi

import (
	"errors"
	"fmt"
	"unsafe"

	"golang.org/x/sys/windows"
)

var (
	procCreateJobObjectW          = modkernel32.NewProc("CreateJobObjectW")
	procOpenJobObjectW            = modkernel32.NewProc("OpenJobObjectW")
	procAttachConsole             = modkernel32.NewProc("AttachConsole")
	procFreeConsole               = modkernel32.NewProc("FreeConsole")
	procUpdateProcThreadAttribute = modkernel32.NewProc("UpdateProcThreadAttribute")
)

// CreateJobObject creates the job object name (Win32 name, e.g.
// `Global\sbx-wd-<lease>`; "" for an unnamed job) with default security.
// When the name exists it returns the existing job's handle with
// existed = true (the x/sys wrapper drops that ERROR_ALREADY_EXISTS).
func CreateJobObject(name string) (h windows.Handle, existed bool, err error) {
	var n *uint16
	if name != "" {
		if n, err = windows.UTF16PtrFromString(name); err != nil {
			return 0, false, fmt.Errorf("winapi: job name %q: %w", name, err)
		}
	}
	r, _, e := procCreateJobObjectW.Call(0, uintptr(unsafe.Pointer(n)))
	if r == 0 {
		return 0, false, callErr(e)
	}
	return windows.Handle(r), errors.Is(e, windows.ERROR_ALREADY_EXISTS), nil
}

// OpenJobObject opens the named job object (Win32 name, e.g.
// `Global\sbx-cmd-<id>`). A missing job is windows.ERROR_FILE_NOT_FOUND.
func OpenJobObject(access uint32, inherit bool, name string) (windows.Handle, error) {
	n, err := windows.UTF16PtrFromString(name)
	if err != nil {
		return 0, fmt.Errorf("winapi: job name %q: %w", name, err)
	}
	var inh uintptr
	if inherit {
		inh = 1
	}
	r, _, e := procOpenJobObjectW.Call(uintptr(access), inh, uintptr(unsafe.Pointer(n)))
	if r == 0 {
		return 0, callErr(e)
	}
	return windows.Handle(r), nil
}

// AttachConsole attaches the calling process to the console of process pid.
// It fails with ERROR_ACCESS_DENIED when the caller already has a console.
func AttachConsole(pid uint32) error {
	r, _, e := procAttachConsole.Call(uintptr(pid))
	if r == 0 {
		return callErr(e)
	}
	return nil
}

// FreeConsole detaches the calling process from its console.
func FreeConsole() error {
	r, _, e := procFreeConsole.Call()
	if r == 0 {
		return callErr(e)
	}
	return nil
}

// UpdateProcThreadAttributeValue sets attribute attr of list to the
// pointer-sized value v itself rather than to memory v points at. Some
// attributes (PROC_THREAD_ATTRIBUTE_PSEUDOCONSOLE) take a handle this way;
// the x/sys Update would keep the handle in a Go slice of pointers.
func UpdateProcThreadAttributeValue(list *windows.ProcThreadAttributeList, attr uintptr, v uintptr) error {
	r, _, e := procUpdateProcThreadAttribute.Call(uintptr(unsafe.Pointer(list)), 0, attr, v,
		unsafe.Sizeof(v), 0, 0)
	if r == 0 {
		return callErr(e)
	}
	return nil
}
