package winproc

import (
	"fmt"
	"sync"

	"golang.org/x/sys/windows"

	"github.com/belov38/boat-dev-clone/services/guest-agent/internal/winapi"
)

// consoleMu serializes CtrlBreak: a process has at most one console, and
// attaching is process-wide.
var consoleMu sync.Mutex

// CtrlBreak sends CTRL_BREAK_EVENT to the process group whose root is pid
// (a process started with NewProcessGroup) on that process's console. The
// caller must have no console of its own (the shim is a DETACHED_PROCESS);
// otherwise attaching fails with ERROR_ACCESS_DENIED.
func CtrlBreak(pid uint32) error {
	consoleMu.Lock()
	defer consoleMu.Unlock()
	if err := winapi.AttachConsole(pid); err != nil {
		return fmt.Errorf("winproc: attach to the console of %d: %w", pid, err)
	}
	err := windows.GenerateConsoleCtrlEvent(windows.CTRL_BREAK_EVENT, pid)
	if ferr := winapi.FreeConsole(); ferr != nil && err == nil {
		err = ferr
	}
	if err != nil {
		return fmt.Errorf("winproc: CTRL_BREAK to %d: %w", pid, err)
	}
	return nil
}
