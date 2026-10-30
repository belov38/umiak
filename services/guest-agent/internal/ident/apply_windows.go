package ident

import (
	"fmt"

	"golang.org/x/sys/windows"

	"github.com/belov38/boat-dev-clone/services/guest-agent/internal/winapi"
)

// sshdFileSDDL is the security descriptor sshd accepts for host keys and
// TrustedUserCAKeys: owner SYSTEM, full control for SYSTEM and
// Administrators only, nothing inherited.
const sshdFileSDDL = "O:SYD:P(A;;FA;;;SY)(A;;FA;;;BA)"

// secureSSHFile gives path the owner and DACL of sshdFileSDDL.
func secureSSHFile(path string) error {
	sd, err := windows.SecurityDescriptorFromString(sshdFileSDDL)
	if err != nil {
		return fmt.Errorf("ident: ACL %q: %w", sshdFileSDDL, err)
	}
	owner, _, err := sd.Owner()
	if err != nil {
		return fmt.Errorf("ident: ACL owner: %w", err)
	}
	dacl, _, err := sd.DACL()
	if err != nil {
		return fmt.Errorf("ident: ACL DACL: %w", err)
	}
	// Setting another owner than the caller needs SeRestorePrivilege
	// (held by SYSTEM and elevated administrators).
	_ = winapi.EnablePrivileges("SeRestorePrivilege")
	if err := windows.SetNamedSecurityInfo(path, windows.SE_FILE_OBJECT,
		windows.OWNER_SECURITY_INFORMATION|windows.DACL_SECURITY_INFORMATION|windows.PROTECTED_DACL_SECURITY_INFORMATION,
		owner, nil, dacl, nil); err != nil {
		return fmt.Errorf("ident: set ACL of %s: %w", path, err)
	}
	return nil
}
