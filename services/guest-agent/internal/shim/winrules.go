package shim

import (
	"errors"
	"path/filepath"

	"github.com/belov38/boat-dev-clone/services/guest-agent/internal/shimproto"
	"github.com/belov38/boat-dev-clone/services/guest-agent/internal/wincmd"
)

// Rules of the Windows shim that need no Windows API, so they are tested on
// every platform (S9 spec 12.6, "Сигналы и Kill" and "Exit").

// errUnsupportedSignal rejects a signal Windows cannot deliver.
var errUnsupportedSignal = errors.New("unsupported_signal")

// Linux signal numbers the Windows shim maps.
const (
	sigHUP  = 1
	sigINT  = 2
	sigKILL = 9
	sigTERM = 15
)

// winAction is what a signal does to a Windows command.
type winAction int

const (
	// winSoft: CTRL_BREAK_EVENT to the process group of the main process,
	// or the byte 0x03 into the ConPTY input.
	winSoft winAction = iota + 1
	// winHangup: ClosePseudoConsole (CTRL_CLOSE_EVENT to its processes).
	winHangup
	// winTerminate: TerminateJobObject.
	winTerminate
)

// winSignalAction maps a signal: SIGINT and SIGTERM are soft, SIGKILL
// terminates the job, SIGHUP closes the pseudo console of a PTY command.
// Everything else, and SIGHUP without a PTY, is errUnsupportedSignal.
func winSignalAction(sig int, pty bool) (winAction, error) {
	switch {
	case sig == sigINT, sig == sigTERM:
		return winSoft, nil
	case sig == sigKILL:
		return winTerminate, nil
	case sig == sigHUP && pty:
		return winHangup, nil
	}
	return 0, errUnsupportedSignal
}

// winExit returns the status, code and reason of exit.json for a main
// process that exited with code. terminated means the shim ended the job
// before it saw the exit; the process then counts as KILLED with code 1
// (the TerminateJobObject code) unless it had exited with another code on
// its own first. NTSTATUS codes such as 0xC0000005 pass as they are, as a
// signed 32-bit value. The reason is the first kill's, else SIGNAL for a
// KILLED process after a signal request, else NONE.
//
// A termination by another process (the agent's KillCgroup while this shim
// lives, used only when it cannot reach the shim) is not detectable: the
// exit code 1 is indistinguishable from the program's own, so it stays
// EXITED with code 1 and reason NONE.
func winExit(code uint32, terminated bool, killReason string, signalled bool) (status string, c int32, reason string) {
	status = shimproto.StatusExited
	if terminated && code == terminateCode {
		status = shimproto.StatusKilled
	}
	switch {
	case killReason != "":
		reason = killReason
	case status == shimproto.StatusKilled && signalled:
		reason = shimproto.ReasonSignal
	default:
		reason = shimproto.ReasonNone
	}
	return status, int32(code), reason //nolint:gosec // NTSTATUS codes are reported as signed values
}

// terminateCode is the exit code TerminateJobObject gives the processes.
const terminateCode = 1

// winCommandLine resolves argv[0] through PATH and PATHEXT of env (relative
// paths against cwd) and returns the application name and the command line
// for CreateProcess (S9 spec 12.6, ruling R7a). A batch file runs as
// cmd.exe from sysDir with a command line BatchCommandLine builds again
// here, so arguments cmd.exe would reinterpret fail with
// wincmd.ErrUnsafeBatchArgs even when the agent's check was skipped. Other
// programs get argv composed by the MSVCRT rules, argv[0] as given.
func winCommandLine(argv, env []string, cwd, sysDir string) (app, cmdline string, err error) {
	prog, batch, err := wincmd.ResolveProgram(argv[0], env, cwd)
	if err != nil {
		return "", "", err
	}
	if !batch {
		return prog, wincmd.ComposeArgs(argv), nil
	}
	cmdline, err = wincmd.BatchCommandLine(prog, argv[1:])
	if err != nil {
		return "", "", err
	}
	return filepath.Join(sysDir, "cmd.exe"), cmdline, nil
}
