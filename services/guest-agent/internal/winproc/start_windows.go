package winproc

import (
	"context"
	"errors"
	"fmt"
	"math"
	"runtime"
	"strings"
	"sync"
	"unicode/utf16"
	"unsafe"

	"golang.org/x/sys/windows"

	"github.com/belov38/boat-dev-clone/services/guest-agent/internal/winapi"
)

// PROC_THREAD_ATTRIBUTE_JOB_LIST (x/sys lacks it).
const procThreadAttributeJobList = 0x0002000D

// StartOptions describe a process for Start.
type StartOptions struct {
	// Argv0Path is the executable (lpApplicationName); "" lets Windows take
	// it from CommandLine.
	Argv0Path string
	// CommandLine is the full command line, argv[0] included.
	CommandLine string
	// Env is the environment; nil inherits the caller's.
	Env []string
	// Dir is the working directory; "" is the caller's.
	Dir string
	// Token is a primary token to start the process as; 0 runs it as the
	// caller (CreateProcessW instead of CreateProcessAsUserW).
	Token windows.Token
	// Job, if set, holds the process from its creation
	// (PROC_THREAD_ATTRIBUTE_JOB_LIST): no child can escape before it.
	Job *Job
	// Stdin, Stdout, Stderr are the standard handles; 0 leaves one unset.
	// They need not be inheritable: Start passes inheritable duplicates
	// through PROC_THREAD_ATTRIBUTE_HANDLE_LIST, so nothing else leaks.
	// Pseudo-handles (InvalidHandle is also CurrentProcess) are rejected:
	// duplicating one would give the child a real handle to the caller's
	// process, thread or token.
	Stdin, Stdout, Stderr windows.Handle
	// PseudoConsole attaches the process to a ConPTY; the standard
	// handles must then be 0. Without it the process gets a hidden
	// console (CREATE_NO_WINDOW), which console programs need.
	PseudoConsole windows.Handle
	// NewProcessGroup makes the process the root of a new process group,
	// so CtrlBreak can target it.
	NewProcessGroup bool
	// Detached starts the process without any console (DETACHED_PROCESS)
	// instead of a hidden one; it excludes PseudoConsole.
	Detached bool
	// BreakawayFromJob starts the process outside the job of the caller
	// (CREATE_BREAKAWAY_FROM_JOB). It fails with ERROR_ACCESS_DENIED when
	// the caller's job does not allow breakaway.
	BreakawayFromJob bool
}

// Process is a started process.
type Process struct {
	pid uint32

	mu sync.Mutex
	h  windows.Handle
}

// tokenPrivileges are needed by CreateProcessAsUserW; SYSTEM holds them but
// may have them disabled. Enabling is best effort: a missing privilege shows
// as the error of the call itself.
var tokenPrivileges = sync.OnceFunc(func() {
	_ = winapi.EnablePrivileges("SeAssignPrimaryTokenPrivilege")
	_ = winapi.EnablePrivileges("SeIncreaseQuotaPrivilege")
})

// Start creates the process suspended with an attribute list (job,
// inherited handles, pseudo console), then resumes it.
func Start(o StartOptions) (*Process, error) {
	if o.PseudoConsole != 0 && (o.Stdin != 0 || o.Stdout != 0 || o.Stderr != 0) {
		return nil, errors.New("winproc: start: standard handles with a pseudo console")
	}
	if o.PseudoConsole != 0 && o.Detached {
		return nil, errors.New("winproc: start: a detached process with a pseudo console")
	}
	var argv0 *uint16
	if o.Argv0Path != "" {
		p, err := windows.UTF16PtrFromString(o.Argv0Path)
		if err != nil {
			return nil, fmt.Errorf("winproc: start: path: %w", err)
		}
		argv0 = p
	}
	// CreateProcessW may write to the command line buffer: a fresh copy.
	cmdline, err := windows.UTF16FromString(o.CommandLine)
	if err != nil {
		return nil, fmt.Errorf("winproc: start: command line: %w", err)
	}
	var dir *uint16
	if o.Dir != "" {
		p, err := windows.UTF16PtrFromString(o.Dir)
		if err != nil {
			return nil, fmt.Errorf("winproc: start: dir: %w", err)
		}
		dir = p
	}
	var env *uint16
	if o.Env != nil {
		block, err := envBlock(o.Env)
		if err != nil {
			return nil, err
		}
		env = &block[0]
	}

	inherit, closeInherit, err := inheritableCopies(o.Stdin, o.Stdout, o.Stderr)
	if err != nil {
		return nil, err
	}
	defer closeInherit()

	attrs, err := windows.NewProcThreadAttributeList(3)
	if err != nil {
		return nil, fmt.Errorf("winproc: start: attribute list: %w", err)
	}
	defer attrs.Delete()
	var jobs []windows.Handle
	if o.Job != nil {
		h, err := o.Job.handle()
		if err != nil {
			return nil, fmt.Errorf("winproc: start: %w", err)
		}
		jobs = []windows.Handle{h}
		if err := attrs.Update(procThreadAttributeJobList, unsafe.Pointer(&jobs[0]),
			uintptr(len(jobs))*unsafe.Sizeof(jobs[0])); err != nil {
			return nil, fmt.Errorf("winproc: start: job list: %w", err)
		}
	}
	handles := inherit.list()
	if len(handles) > 0 {
		if err := attrs.Update(windows.PROC_THREAD_ATTRIBUTE_HANDLE_LIST, unsafe.Pointer(&handles[0]),
			uintptr(len(handles))*unsafe.Sizeof(handles[0])); err != nil {
			return nil, fmt.Errorf("winproc: start: handle list: %w", err)
		}
	}
	if o.PseudoConsole != 0 {
		if err := winapi.UpdateProcThreadAttributeValue(attrs.List(),
			windows.PROC_THREAD_ATTRIBUTE_PSEUDOCONSOLE, uintptr(o.PseudoConsole)); err != nil {
			return nil, fmt.Errorf("winproc: start: pseudo console: %w", err)
		}
	}

	var si windows.StartupInfoEx
	si.Cb = uint32(unsafe.Sizeof(si))
	si.ProcThreadAttributeList = attrs.List()
	// Always explicit: with a pseudo console the null handles make the
	// console attach its own, otherwise the child could get the caller's
	// standard handles even without inheritance.
	si.Flags = windows.STARTF_USESTDHANDLES
	si.StdInput, si.StdOutput, si.StdErr = inherit.stdin, inherit.stdout, inherit.stderr
	var desktop []uint16
	if o.Token != 0 {
		// "" (not NULL): the process connects to the window station of its
		// own logon session instead of inheriting the service's one, which
		// another user cannot open.
		desktop = []uint16{0}
		si.Desktop = &desktop[0]
	}

	flags := uint32(windows.EXTENDED_STARTUPINFO_PRESENT | windows.CREATE_UNICODE_ENVIRONMENT | windows.CREATE_SUSPENDED)
	switch {
	case o.Detached:
		flags |= windows.DETACHED_PROCESS
	case o.PseudoConsole == 0:
		flags |= windows.CREATE_NO_WINDOW
	}
	if o.NewProcessGroup {
		flags |= windows.CREATE_NEW_PROCESS_GROUP
	}
	if o.BreakawayFromJob {
		flags |= windows.CREATE_BREAKAWAY_FROM_JOB
	}
	var pi windows.ProcessInformation
	if o.Token != 0 {
		tokenPrivileges()
		err = windows.CreateProcessAsUser(o.Token, argv0, &cmdline[0], nil, nil, len(handles) > 0,
			flags, env, dir, &si.StartupInfo, &pi)
	} else {
		err = windows.CreateProcess(argv0, &cmdline[0], nil, nil, len(handles) > 0,
			flags, env, dir, &si.StartupInfo, &pi)
	}
	runtime.KeepAlive(jobs)
	runtime.KeepAlive(handles)
	runtime.KeepAlive(desktop)
	if err != nil {
		return nil, fmt.Errorf("winproc: CreateProcess %s: %w", o.Argv0Path, err)
	}
	defer windows.CloseHandle(pi.Thread) //nolint:errcheck // nothing to do on failure
	if _, err := windows.ResumeThread(pi.Thread); err != nil {
		_ = windows.TerminateProcess(pi.Process, 1)
		_ = windows.CloseHandle(pi.Process)
		return nil, fmt.Errorf("winproc: ResumeThread: %w", err)
	}
	return &Process{pid: pi.ProcessId, h: pi.Process}, nil
}

// envBlock builds a CREATE_UNICODE_ENVIRONMENT block: KEY=VALUE strings,
// each NUL-terminated, then one more NUL.
func envBlock(env []string) ([]uint16, error) {
	var block []uint16
	for _, kv := range env {
		if strings.IndexByte(kv, 0) >= 0 {
			// Only the name: values can be secrets.
			name, _, _ := strings.Cut(kv, "=")
			return nil, fmt.Errorf("winproc: start: NUL in environment variable %q", name)
		}
		block = append(block, utf16.Encode([]rune(kv))...)
		block = append(block, 0)
	}
	if len(env) == 0 {
		block = append(block, 0)
	}
	return append(block, 0), nil
}

// stdHandles are the inheritable duplicates of the standard handles.
type stdHandles struct {
	stdin, stdout, stderr windows.Handle
}

// list returns the distinct non-zero handles for the HANDLE_LIST attribute.
func (s stdHandles) list() []windows.Handle {
	var out []windows.Handle
	for _, h := range []windows.Handle{s.stdin, s.stdout, s.stderr} {
		if h != 0 {
			out = append(out, h)
		}
	}
	return out
}

// inheritableCopies duplicates each non-zero handle as an inheritable one.
// Every slot gets its own duplicate, so the handle list has no repeats even
// when stdout and stderr are the same handle.
func inheritableCopies(stdin, stdout, stderr windows.Handle) (stdHandles, func(), error) {
	var out stdHandles
	var dups []windows.Handle
	closeAll := func() {
		for _, h := range dups {
			_ = windows.CloseHandle(h)
		}
	}
	self := windows.CurrentProcess()
	for _, p := range []struct {
		src windows.Handle
		dst *windows.Handle
	}{{stdin, &out.stdin}, {stdout, &out.stdout}, {stderr, &out.stderr}} {
		if p.src == 0 {
			continue
		}
		if pseudoHandle(p.src) {
			closeAll()
			return stdHandles{}, func() {}, fmt.Errorf("winproc: start: pseudo-handle %#x as a standard handle", uintptr(p.src))
		}
		var d windows.Handle
		if err := windows.DuplicateHandle(self, p.src, self, &d, 0, true, windows.DUPLICATE_SAME_ACCESS); err != nil {
			closeAll()
			return stdHandles{}, func() {}, fmt.Errorf("winproc: start: duplicate handle: %w", err)
		}
		dups = append(dups, d)
		*p.dst = d
	}
	return out, closeAll, nil
}

// pseudoHandle reports a value with the high bit set: InvalidHandle and the
// pseudo-handles of the current process, thread and tokens (-1 .. -6). Real
// user-mode handles never have it.
func pseudoHandle(h windows.Handle) bool {
	return h > windows.Handle(math.MaxInt)
}

// Pid returns the process id.
func (p *Process) Pid() uint32 { return p.pid }

// Handle returns the process handle, valid until Close.
func (p *Process) Handle() windows.Handle {
	p.mu.Lock()
	defer p.mu.Unlock()
	return p.h
}

// Wait waits for the process to exit and returns its exit code (NTSTATUS
// codes such as 0xC0000005 as they are), or ctx.Err().
func (p *Process) Wait(ctx context.Context) (uint32, error) {
	h := p.Handle()
	if h == 0 {
		return 0, errors.New("winproc: process is closed")
	}
	ev, err := windows.CreateEvent(nil, 1, 0, nil)
	if err != nil {
		return 0, fmt.Errorf("winproc: wait: %w", err)
	}
	defer windows.CloseHandle(ev) //nolint:errcheck // nothing to do on failure
	fired := make(chan struct{})
	stop := context.AfterFunc(ctx, func() {
		_ = windows.SetEvent(ev)
		close(fired)
	})
	r, err := windows.WaitForMultipleObjects([]windows.Handle{h, ev}, false, windows.INFINITE)
	// The event must outlive a running AfterFunc.
	if !stop() {
		<-fired
	}
	switch {
	case err != nil:
		return 0, fmt.Errorf("winproc: wait: %w", err)
	case r == windows.WAIT_OBJECT_0:
	default:
		return 0, ctx.Err()
	}
	var code uint32
	if err := windows.GetExitCodeProcess(h, &code); err != nil {
		return 0, fmt.Errorf("winproc: exit code: %w", err)
	}
	return code, nil
}

// Close closes the process handle; the process keeps running. Call it after
// Wait returned.
func (p *Process) Close() error {
	p.mu.Lock()
	defer p.mu.Unlock()
	if p.h == 0 {
		return nil
	}
	err := windows.CloseHandle(p.h)
	p.h = 0
	if err != nil {
		return fmt.Errorf("winproc: close process: %w", err)
	}
	return nil
}
