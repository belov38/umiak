package agent

import (
	"fmt"
	"log/slog"

	"golang.org/x/sys/windows"
)

// adminSocketSDDL lets only SYSTEM and Administrators connect to a socket;
// the env socket adds the default user with read and write access.
const adminSocketSDDL = "D:P(A;;FA;;;SY)(A;;FA;;;BA)"

// secureSocket replaces the DACL of the socket file (inherited from run\)
// with adminSocketSDDL, plus the account user for the env socket. The file
// is an AF_UNIX reparse point, so it is opened as one, not followed.
func secureSocket(path string, kind socketKind, user string) error {
	sddl := adminSocketSDDL
	if kind == socketEnv && user != "" {
		if sid, _, _, err := windows.LookupSID("", user); err != nil {
			slog.Warn("agent: env socket: default user not found, socket stays SYSTEM and Administrators only", "user", user, "err", err)
		} else {
			sddl += "(A;;FRFW;;;" + sid.String() + ")"
		}
	}
	sd, err := windows.SecurityDescriptorFromString(sddl)
	if err != nil {
		return fmt.Errorf("agent: socket ACL %q: %w", sddl, err)
	}
	dacl, _, err := sd.DACL()
	if err != nil {
		return fmt.Errorf("agent: socket ACL %q: %w", sddl, err)
	}
	p, err := windows.UTF16PtrFromString(path)
	if err != nil {
		return err
	}
	h, err := windows.CreateFile(p, windows.WRITE_DAC|windows.READ_CONTROL,
		windows.FILE_SHARE_READ|windows.FILE_SHARE_WRITE|windows.FILE_SHARE_DELETE, nil,
		windows.OPEN_EXISTING, windows.FILE_FLAG_OPEN_REPARSE_POINT|windows.FILE_FLAG_BACKUP_SEMANTICS, 0)
	if err != nil {
		return fmt.Errorf("agent: open socket %s: %w", path, err)
	}
	defer windows.CloseHandle(h) //nolint:errcheck // nothing to do on failure
	if err := windows.SetSecurityInfo(h, windows.SE_FILE_OBJECT,
		windows.DACL_SECURITY_INFORMATION|windows.PROTECTED_DACL_SECURITY_INFORMATION, nil, nil, dacl, nil); err != nil {
		return fmt.Errorf("agent: set ACL of %s: %w", path, err)
	}
	return nil
}
