package claim

import (
	"fmt"
	"io/fs"

	"golang.org/x/sys/windows"
)

// Protected DACLs of the secret store (S9 spec 12.8). SDDL rights: FA full
// control, FR read, FW write, FX execute (traverse).
const (
	// mountSDDL keeps C:\ProgramData\sbx and what inherits from it (the
	// secrets state record) to SYSTEM and Administrators.
	mountSDDL = "D:P(A;OICI;FA;;;SY)(A;OICI;FA;;;BA)"
	// secretDirSDDL is SYSTEM full control, inherited by new entries; secret
	// files are created with their own protected DACL.
	secretDirSDDL = "D:P(A;OICI;FA;;;SY)"
	// secretFileSDDL is SYSTEM full control without inheritance.
	secretFileSDDL = "D:P(A;;FA;;;SY)"
)

// secretDirACL returns the DACL of secrets\ and files\: SYSTEM, plus list
// and traverse (not inherited) for the default user.
func secretDirACL(user *windows.SID) string {
	if user == nil {
		return secretDirSDDL
	}
	return secretDirSDDL + "(A;;FRFX;;;" + user.String() + ")"
}

// secretFileACL returns the DACL of a secret file: SYSTEM, plus the default
// user with read access, or read and write access when mode has any write
// bit.
func secretFileACL(mode fs.FileMode, user *windows.SID) string {
	if user == nil {
		return secretFileSDDL
	}
	rights := "FR"
	if mode&0o222 != 0 {
		rights = "FRFW"
	}
	return secretFileSDDL + "(A;;" + rights + ";;;" + user.String() + ")"
}

// setDACL replaces the DACL of path with the one in sddl and drops the
// inherited entries.
func setDACL(path, sddl string) error {
	sd, err := windows.SecurityDescriptorFromString(sddl)
	if err != nil {
		return fmt.Errorf("claim: ACL %q: %w", sddl, err)
	}
	dacl, _, err := sd.DACL()
	if err != nil {
		return fmt.Errorf("claim: ACL %q: %w", sddl, err)
	}
	if err := windows.SetNamedSecurityInfo(path, windows.SE_FILE_OBJECT,
		windows.DACL_SECURITY_INFORMATION|windows.PROTECTED_DACL_SECURITY_INFORMATION, nil, nil, dacl, nil); err != nil {
		return fmt.Errorf("claim: set ACL of %s: %w", path, err)
	}
	return nil
}

// lookupAccountSID resolves a local account name.
func lookupAccountSID(account string) (*windows.SID, error) {
	sid, _, _, err := windows.LookupSID("", account)
	if err != nil {
		return nil, fmt.Errorf("claim: lookup %s: %w", account, err)
	}
	return sid, nil
}
