package winapi

import (
	"fmt"
	"unsafe"

	"golang.org/x/sys/windows"
)

var procNetUserSetInfo = modnetapi32.NewProc("NetUserSetInfo")

// SetUserPassword sets the password of the local account user
// (NetUserSetInfo level 1003, USER_INFO_1003). The local password policy
// applies.
func SetUserPassword(user, password string) error {
	u, err := windows.UTF16PtrFromString(user)
	if err != nil {
		return fmt.Errorf("winapi: set password of %s: %w", user, err)
	}
	pw, err := windows.UTF16FromString(password)
	if err != nil {
		return fmt.Errorf("winapi: set password of %s: %w", user, err)
	}
	defer clear(pw)
	info := struct{ password *uint16 }{&pw[0]} // USER_INFO_1003
	var parmErr uint32
	r, _, _ := procNetUserSetInfo.Call(0, uintptr(unsafe.Pointer(u)), 1003,
		uintptr(unsafe.Pointer(&info)), uintptr(unsafe.Pointer(&parmErr)))
	if r != 0 {
		return fmt.Errorf("winapi: NetUserSetInfo %s: %w", user, windows.Errno(r))
	}
	return nil
}
