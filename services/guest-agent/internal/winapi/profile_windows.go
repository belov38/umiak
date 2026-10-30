package winapi

import (
	"errors"
	"fmt"
	"sync"
	"unsafe"

	"golang.org/x/sys/windows"
)

// piNoUI keeps LoadUserProfileW from showing error dialogs.
const piNoUI = 0x00000001

var (
	procLoadUserProfileW      = moduserenv.NewProc("LoadUserProfileW")
	procUnloadUserProfile     = moduserenv.NewProc("UnloadUserProfile")
	procAdjustTokenPrivileges = modadvapi32.NewProc("AdjustTokenPrivileges")
)

// profileInfo is PROFILEINFOW.
type profileInfo struct {
	Size        uint32
	Flags       uint32
	UserName    *uint16
	ProfilePath *uint16
	DefaultPath *uint16
	ServerName  *uint16
	PolicyPath  *uint16
	Profile     windows.Handle
}

// profilePrivileges are needed by LoadUserProfileW; SYSTEM holds them but
// they may be disabled in the service token.
var profilePrivileges = sync.OnceValue(func() error {
	return EnablePrivileges("SeBackupPrivilege", "SeRestorePrivilege")
})

// LoadProfile loads the profile (registry hive HKCU and the profile
// directory) of user for token t, so the user's environment and
// per-user settings apply to the processes started with t. unload releases
// it; t must stay open until then. Loads are reference counted by Windows.
func LoadProfile(t windows.Token, user string) (unload func(), err error) {
	if err := profilePrivileges(); err != nil {
		return nil, fmt.Errorf("winapi: load profile %s: %w", user, err)
	}
	name, err := windows.UTF16PtrFromString(user)
	if err != nil {
		return nil, fmt.Errorf("winapi: load profile %s: %w", user, err)
	}
	pi := profileInfo{Flags: piNoUI, UserName: name}
	pi.Size = uint32(unsafe.Sizeof(pi))
	r, _, e := procLoadUserProfileW.Call(uintptr(t), uintptr(unsafe.Pointer(&pi)))
	if r == 0 {
		return nil, fmt.Errorf("winapi: LoadUserProfileW %s: %w", user, callErr(e))
	}
	var once sync.Once
	return func() {
		once.Do(func() {
			_, _, _ = procUnloadUserProfile.Call(uintptr(t), uintptr(pi.Profile))
		})
	}, nil
}

// EnablePrivileges enables the named privileges in the token of the
// process. A privilege the token lacks is an error.
func EnablePrivileges(names ...string) error {
	var t windows.Token
	if err := windows.OpenProcessToken(windows.CurrentProcess(),
		windows.TOKEN_ADJUST_PRIVILEGES|windows.TOKEN_QUERY, &t); err != nil {
		return fmt.Errorf("winapi: open process token: %w", err)
	}
	defer t.Close() //nolint:errcheck // read-only use
	for _, n := range names {
		p, err := windows.UTF16PtrFromString(n)
		if err != nil {
			return err
		}
		var tp windows.Tokenprivileges
		tp.PrivilegeCount = 1
		if err := windows.LookupPrivilegeValue(nil, p, &tp.Privileges[0].Luid); err != nil {
			return fmt.Errorf("winapi: privilege %s: %w", n, err)
		}
		tp.Privileges[0].Attributes = windows.SE_PRIVILEGE_ENABLED
		// AdjustTokenPrivileges succeeds with the last error
		// ERROR_NOT_ALL_ASSIGNED when the token lacks the privilege; the
		// x/sys wrapper drops it, the proc call keeps it.
		r, _, e := procAdjustTokenPrivileges.Call(uintptr(t), 0, uintptr(unsafe.Pointer(&tp)), 0, 0, 0)
		if r == 0 {
			return fmt.Errorf("winapi: enable %s: %w", n, callErr(e))
		}
		if errors.Is(e, windows.ERROR_NOT_ALL_ASSIGNED) {
			return fmt.Errorf("winapi: enable %s: %w", n, e)
		}
	}
	return nil
}
