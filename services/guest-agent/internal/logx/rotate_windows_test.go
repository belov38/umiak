package logx

import (
	"path/filepath"
	"testing"

	"golang.org/x/sys/windows"
)

func TestRotatingFileRenameFailure(t *testing.T) {
	// A reader that holds agent.log open without FILE_SHARE_DELETE makes
	// the rename to agent.log.1 fail with a sharing violation.
	testRotationBlocked(t, func(t *testing.T, dir string) func() {
		name, err := windows.UTF16PtrFromString(filepath.Join(dir, "agent.log"))
		if err != nil {
			t.Fatal(err)
		}
		h, err := windows.CreateFile(name, windows.GENERIC_READ,
			windows.FILE_SHARE_READ|windows.FILE_SHARE_WRITE, nil,
			windows.OPEN_EXISTING, windows.FILE_ATTRIBUTE_NORMAL, 0)
		if err != nil {
			t.Fatal(err)
		}
		return func() { _ = windows.CloseHandle(h) }
	})
}
