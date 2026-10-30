package winapi

import (
	"unsafe"

	"golang.org/x/sys/windows"
)

var (
	procNtCreateJobObject     = modntdll.NewProc("NtCreateJobObject")
	procNtMakeTemporaryObject = modntdll.NewProc("NtMakeTemporaryObject")
)

// NtCreateJobObject creates a job object with the given access and object
// attributes (name, OBJ_PERMANENT, ...). A failure is the NTSTATUS as a
// windows.NTStatus error, so callers can match STATUS_OBJECT_NAME_COLLISION
// or STATUS_PRIVILEGE_NOT_HELD with errors.Is.
func NtCreateJobObject(access uint32, oa *windows.OBJECT_ATTRIBUTES) (windows.Handle, error) {
	var h windows.Handle
	r, _, _ := procNtCreateJobObject.Call(uintptr(unsafe.Pointer(&h)), uintptr(access), uintptr(unsafe.Pointer(oa)))
	if st := windows.NTStatus(r); st != windows.STATUS_SUCCESS {
		return 0, st
	}
	return h, nil
}

// NtMakeTemporaryObject clears OBJ_PERMANENT on the object behind h: the
// object is deleted once its last handle is closed. h needs DELETE access.
// A failure is the NTSTATUS as a windows.NTStatus error.
func NtMakeTemporaryObject(h windows.Handle) error {
	r, _, _ := procNtMakeTemporaryObject.Call(uintptr(h))
	if st := windows.NTStatus(r); st != windows.STATUS_SUCCESS {
		return st
	}
	return nil
}
