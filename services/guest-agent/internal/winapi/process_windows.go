package winapi

import (
	"fmt"
	"path/filepath"
	"unsafe"

	"golang.org/x/sys/windows"
)

// ProcessInfo is the identity of a running process.
type ProcessInfo struct {
	// Name is the base name of the executable image, such as "svchost.exe".
	Name string
	// User is the account name of the process token's user without the
	// domain, such as "SYSTEM". Empty when the token cannot be read.
	User string
}

// systemPID is the pid of the System process, whose image name is not
// available to QueryFullProcessImageName.
const systemPID = 4

// QueryProcess describes process pid. It needs only
// PROCESS_QUERY_LIMITED_INFORMATION, so it works for protected processes as
// well; a failed image name lookup is an error, a failed token lookup leaves
// User empty.
func QueryProcess(pid uint32) (ProcessInfo, error) {
	h, err := windows.OpenProcess(windows.PROCESS_QUERY_LIMITED_INFORMATION, false, pid)
	if err != nil {
		if pid == systemPID {
			return ProcessInfo{Name: "System"}, nil
		}
		return ProcessInfo{}, fmt.Errorf("winapi: open process %d: %w", pid, err)
	}
	defer func() { _ = windows.CloseHandle(h) }()

	var info ProcessInfo
	// MAX_PATH is not a limit of this call; 32768 is the longest NT path.
	buf := make([]uint16, 32768)
	n := uint32(len(buf))
	if err := windows.QueryFullProcessImageName(h, 0, &buf[0], &n); err != nil {
		if pid != systemPID {
			return ProcessInfo{}, fmt.Errorf("winapi: process %d image name: %w", pid, err)
		}
		info.Name = "System"
	} else {
		info.Name = filepath.Base(windows.UTF16ToString(buf[:n]))
	}
	info.User = processUser(h)
	return info, nil
}

// processUser returns the token user's account name, or "".
func processUser(h windows.Handle) string {
	var t windows.Token
	if err := windows.OpenProcessToken(h, windows.TOKEN_QUERY, &t); err != nil {
		return ""
	}
	defer func() { _ = t.Close() }()
	tu, err := t.GetTokenUser()
	if err != nil {
		return ""
	}
	account, _, _, err := tu.User.Sid.LookupAccount("")
	if err != nil {
		return tu.User.Sid.String()
	}
	return account
}

var _ = unsafe.Pointer(nil)
