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
	return CtrlBreakGroup(pid, pid)
}

// CtrlBreakGroup sends CTRL_BREAK_EVENT to process group group on the
// console of process consolePid, a member of that console. It reaches the
// group after its root exited, through a remaining member. The caller must
// have no console, as for CtrlBreak, and must not be in group.
func CtrlBreakGroup(consolePid, group uint32) error {
	consoleMu.Lock()
	defer consoleMu.Unlock()
	if err := winapi.AttachConsole(consolePid); err != nil {
		return fmt.Errorf("winproc: attach to the console of %d: %w", consolePid, err)
	}
	err := windows.GenerateConsoleCtrlEvent(windows.CTRL_BREAK_EVENT, group)
	if ferr := winapi.FreeConsole(); ferr != nil && err == nil {
		err = ferr
	}
	if err != nil {
		return fmt.Errorf("winproc: CTRL_BREAK to group %d: %w", group, err)
	}
	return nil
}
