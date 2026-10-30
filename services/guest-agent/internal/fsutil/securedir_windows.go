package fsutil

import (
	"fmt"
	"os"
	"slices"
	"strings"

	"golang.org/x/sys/windows"
)

// SDDL of the agent directories: protected, inherited by files and
// subdirectories.
const (
	systemOnlySDDL      = "D:P(A;OICI;FA;;;SY)"
	systemAndAdminsSDDL = "D:P(A;OICI;FA;;;SY)(A;OICI;FA;;;BA)"
)

func (a DirAccess) sddl() string {
	if a == SystemAndAdmins {
		return systemAndAdminsSDDL
	}
	return systemOnlySDDL
}

// MkdirSecure creates dir (and parents) and gives it the protected DACL of
// a, replacing what it inherited (C:\ProgramData lets users create files in
// subdirectories). A directory that has the DACL already is left alone, so
// the propagation to a large tree does not run on every start.
func MkdirSecure(dir string, a DirAccess) error {
	if err := os.MkdirAll(dir, 0o700); err != nil {
		return err
	}
	want, err := windows.SecurityDescriptorFromString(a.sddl())
	if err != nil {
		return fmt.Errorf("fsutil: ACL %q: %w", a.sddl(), err)
	}
	if cur, err := windows.GetNamedSecurityInfo(dir, windows.SE_FILE_OBJECT, windows.DACL_SECURITY_INFORMATION); err == nil && sameProtectedDACL(cur.String(), want.String()) {
		return nil
	}
	dacl, _, err := want.DACL()
	if err != nil {
		return fmt.Errorf("fsutil: ACL %q: %w", a.sddl(), err)
	}
	if err := windows.SetNamedSecurityInfo(dir, windows.SE_FILE_OBJECT,
		windows.DACL_SECURITY_INFORMATION|windows.PROTECTED_DACL_SECURITY_INFORMATION, nil, nil, dacl, nil); err != nil {
		return fmt.Errorf("fsutil: set ACL of %s: %w", dir, err)
	}
	return nil
}

// sameProtectedDACL reports whether the DACL in SDDL cur is protected and
// has exactly the ACEs of want.
func sameProtectedDACL(cur, want string) bool {
	flags, curACEs := splitDACL(cur)
	_, wantACEs := splitDACL(want)
	return strings.Contains(flags, "P") && slices.Equal(curACEs, wantACEs)
}

// splitDACL returns the flags and the sorted ACEs of the D: part of sddl.
func splitDACL(sddl string) (flags string, aces []string) {
	_, d, ok := strings.Cut(sddl, "D:")
	if !ok {
		return "", nil
	}
	if i := strings.Index(d, "S:"); i >= 0 {
		d = d[:i]
	}
	i := strings.IndexByte(d, '(')
	if i < 0 {
		return d, nil
	}
	flags = d[:i]
	aces = strings.Split(strings.Trim(d[i:], "()"), ")(")
	slices.Sort(aces)
	return flags, aces
}

// TrustedOwner reports whether path is owned by SYSTEM or Administrators,
// the owners of what the agent and its startup script write.
func TrustedOwner(path string) (bool, error) {
	sd, err := windows.GetNamedSecurityInfo(path, windows.SE_FILE_OBJECT, windows.OWNER_SECURITY_INFORMATION)
	if err != nil {
		return false, err
	}
	owner, _, err := sd.Owner()
	if err != nil {
		return false, err
	}
	return owner.IsWellKnown(windows.WinLocalSystemSid) || owner.IsWellKnown(windows.WinBuiltinAdministratorsSid), nil
}
