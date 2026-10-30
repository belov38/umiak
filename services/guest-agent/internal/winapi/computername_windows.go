package winapi

import (
	"errors"
	"fmt"
	"unsafe"

	"golang.org/x/sys/windows"
)

var procSetComputerNameExW = modkernel32.NewProc("SetComputerNameExW")

// SetComputerNameEx sets the computer name of type nameType (for example
// windows.ComputerNamePhysicalDnsHostname, which also sets the NetBIOS
// name). The new name takes effect at the next boot.
func SetComputerNameEx(nameType uint32, name string) error {
	p, err := windows.UTF16PtrFromString(name)
	if err != nil {
		return fmt.Errorf("winapi: computer name %q: %w", name, err)
	}
	r, _, e := procSetComputerNameExW.Call(uintptr(nameType), uintptr(unsafe.Pointer(p)))
	if r == 0 {
		return fmt.Errorf("winapi: SetComputerNameExW: %w", callErr(e))
	}
	return nil
}

// GetComputerNameEx returns the computer name of type nameType that is in
// effect now (a name set with SetComputerNameEx shows after the reboot).
func GetComputerNameEx(nameType uint32) (string, error) {
	n := uint32(64)
	for range 4 {
		buf := make([]uint16, n)
		err := windows.GetComputerNameEx(nameType, &buf[0], &n)
		if err == nil {
			return windows.UTF16ToString(buf[:n]), nil
		}
		if !errors.Is(err, windows.ERROR_MORE_DATA) {
			return "", fmt.Errorf("winapi: GetComputerNameExW: %w", err)
		}
	}
	return "", errors.New("winapi: GetComputerNameExW: name keeps growing")
}
