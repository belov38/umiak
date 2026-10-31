package process

import (
	"errors"
	"fmt"
	"strings"

	"golang.org/x/sys/windows"
	"golang.org/x/sys/windows/registry"
)

// Accounts and paths of the Windows template (spec 8.2, 12.5).
const (
	// defaultAccount is the only local account commands run as besides
	// SYSTEM in v1.
	defaultAccount = "user"
	// systemProfile is the profile directory of SYSTEM.
	systemProfile = `C:\Windows\System32\config\systemprofile`
	// pwshPath is the shell of every account (PowerShell 7).
	pwshPath = `C:\Program Files\PowerShell\7\pwsh.exe`
	// profileListKey holds ProfileImagePath per account SID.
	profileListKey = `SOFTWARE\Microsoft\Windows NT\CurrentVersion\ProfileList\`
)

// lookupUser resolves the two v1 accounts: user (the default account) and
// SYSTEM, with root as an alias of SYSTEM. Other names are not found.
func lookupUser(name string) (*User, error) {
	switch {
	case strings.EqualFold(name, "SYSTEM"), name == "root":
		return &User{Name: "SYSTEM", Home: systemProfile, Shell: pwshPath,
			Windows: &WinUser{Account: "SYSTEM", System: true}}, nil
	case strings.EqualFold(name, defaultAccount):
	default:
		return nil, fmt.Errorf("%w: %s", ErrUserNotFound, name)
	}
	sid, _, typ, err := windows.LookupSID("", defaultAccount)
	switch {
	case errors.Is(err, windows.ERROR_NONE_MAPPED):
		return nil, fmt.Errorf("%w: %s", ErrUserNotFound, name)
	case err != nil:
		return nil, fmt.Errorf("process: lookup user %s: %w", name, err)
	case typ != windows.SidTypeUser:
		return nil, fmt.Errorf("%w: %s is not a user account", ErrUserNotFound, name)
	}
	return &User{Name: defaultAccount, Home: profileDir(sid.String()), Shell: pwshPath,
		Windows: &WinUser{Account: defaultAccount}}, nil
}

// profileDir returns the profile directory of the account sid from the
// ProfileList, or C:\Users\user when it has no profile yet.
func profileDir(sid string) string {
	fallback := `C:\Users\` + defaultAccount
	k, err := registry.OpenKey(registry.LOCAL_MACHINE, profileListKey+sid, registry.QUERY_VALUE)
	if err != nil {
		return fallback
	}
	defer k.Close() //nolint:errcheck // read-only key
	v, typ, err := k.GetStringValue("ProfileImagePath")
	if err != nil || v == "" {
		return fallback
	}
	if typ == registry.EXPAND_SZ {
		if x, err := registry.ExpandString(v); err == nil {
			v = x
		}
	}
	return v
}
