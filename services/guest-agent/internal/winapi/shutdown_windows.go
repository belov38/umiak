package winapi

import (
	"errors"
	"fmt"
	"unsafe"

	"golang.org/x/sys/windows"
)

var procInitiateShutdownW = modadvapi32.NewProc("InitiateShutdownW")

// InitiateShutdownW flags.
const (
	shutdownForceOthers = 0x00000001 // SHUTDOWN_FORCE_OTHERS
	shutdownRestart     = 0x00000004 // SHUTDOWN_RESTART
	// rebootFlags restart the machine also while a user is logged on (the
	// autologon session): without SHUTDOWN_FORCE_OTHERS the call fails with
	// ERROR_SHUTDOWN_USERS_LOGGED_ON.
	rebootFlags = shutdownForceOthers | shutdownRestart
)

// ReasonPlannedReconfig is the shutdown reason of a reboot that applies a
// configuration change (operating system, reconfiguration, planned).
const ReasonPlannedReconfig = windows.SHTDN_REASON_MAJOR_OPERATINGSYSTEM |
	windows.SHTDN_REASON_MINOR_RECONFIG | windows.SHTDN_REASON_FLAG_PLANNED

// Reboot restarts the machine at once, logging off other sessions, with message and reason (recorded in
// the System event log). It enables SeShutdownPrivilege first. A shutdown
// already in progress is not an error.
func Reboot(message string, reason uint32) error {
	if err := EnablePrivileges("SeShutdownPrivilege"); err != nil {
		return err
	}
	msg, err := windows.UTF16PtrFromString(message)
	if err != nil {
		return fmt.Errorf("winapi: shutdown message: %w", err)
	}
	r, _, _ := procInitiateShutdownW.Call(0, uintptr(unsafe.Pointer(msg)), 0, rebootFlags, uintptr(reason))
	if r == 0 {
		return nil
	}
	if e := windows.Errno(r); !errors.Is(e, windows.ERROR_SHUTDOWN_IN_PROGRESS) {
		return fmt.Errorf("winapi: InitiateShutdownW: %w", e)
	}
	return nil
}
