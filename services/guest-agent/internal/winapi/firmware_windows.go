package winapi

import (
	"errors"
	"fmt"
	"unsafe"

	"golang.org/x/sys/windows"
)

// FirmwareTableRSMB is the 'RSMB' provider signature of GetSystemFirmwareTable:
// the raw SMBIOS table.
const FirmwareTableRSMB uint32 = 'R'<<24 | 'S'<<16 | 'M'<<8 | 'B'

var procGetSystemFirmwareTable = modkernel32.NewProc("GetSystemFirmwareTable")

// maxFirmwareTableTries bounds the size/read loop: the table can grow between
// the size query and the read only if it changes underneath us.
const maxFirmwareTableTries = 4

// GetSystemFirmwareTable returns the firmware table of the given provider
// signature and table id. For FirmwareTableRSMB the result is the
// RawSMBIOSData structure (8-byte header followed by the SMBIOS table).
func GetSystemFirmwareTable(signature, tableID uint32) ([]byte, error) {
	for range maxFirmwareTableTries {
		n, _, err := procGetSystemFirmwareTable.Call(uintptr(signature), uintptr(tableID), 0, 0)
		if n == 0 {
			return nil, fmt.Errorf("winapi: GetSystemFirmwareTable size: %w", callErr(err))
		}
		buf := make([]byte, n)
		got, _, err := procGetSystemFirmwareTable.Call(
			uintptr(signature), uintptr(tableID), uintptr(unsafe.Pointer(&buf[0])), n)
		switch {
		case got == 0:
			return nil, fmt.Errorf("winapi: GetSystemFirmwareTable: %w", callErr(err))
		case got <= n:
			return buf[:got], nil
		}
		// got > n: the table grew, retry with the new size.
	}
	return nil, fmt.Errorf("winapi: GetSystemFirmwareTable: table size keeps changing")
}

// callErr turns the error of a LazyProc.Call into a usable one: Call always
// returns a non-nil Errno, which is "operation completed successfully" when
// the last error was not set.
func callErr(err error) error {
	if errors.Is(err, windows.Errno(0)) {
		return windows.ERROR_INVALID_DATA
	}
	return err
}
