package winproc

import (
	"context"
	"errors"
	"fmt"
	"strings"
	"sync"
	"time"
	"unsafe"

	"golang.org/x/sys/windows"

	"github.com/belov38/boat-dev-clone/services/guest-agent/internal/winapi"
)

var (
	// ErrJobExists means a job with the name already exists (exactly one
	// launch per command, spec 12.6).
	ErrJobExists = errors.New("winproc: job already exists")
	// ErrJobNotFound means there is no job with the name.
	ErrJobNotFound = errors.New("winproc: job not found")
	// ErrNoPermanentPrivilege means the process cannot enable
	// SeCreatePermanentPrivilege (it is not SYSTEM).
	ErrNoPermanentPrivilege = errors.New("winproc: SeCreatePermanentPrivilege not held")
)

// jobAllAccess is JOB_OBJECT_ALL_ACCESS; it includes DELETE, which
// NtMakeTemporaryObject needs.
const jobAllAccess = windows.STANDARD_RIGHTS_REQUIRED | windows.SYNCHRONIZE | 0x3F

// waitEmptyPoll bounds one wait on the completion port: WaitEmpty rechecks
// the context and the process count at least this often.
const waitEmptyPoll = 250 * time.Millisecond

// basicAccounting is JOBOBJECT_BASIC_ACCOUNTING_INFORMATION.
type basicAccounting struct {
	TotalUserTime             int64
	TotalKernelTime           int64
	ThisPeriodTotalUserTime   int64
	ThisPeriodTotalKernelTime int64
	TotalPageFaultCount       uint32
	TotalProcesses            uint32
	ActiveProcesses           uint32
	TotalTerminatedProcesses  uint32
}

// associateCompletionPort is JOBOBJECT_ASSOCIATE_COMPLETION_PORT.
type associateCompletionPort struct {
	CompletionKey  uintptr
	CompletionPort windows.Handle
}

// Job is a job object. Its processes and their descendants stay in it: the
// job has neither JOB_OBJECT_LIMIT_BREAKAWAY_OK nor KILL_ON_JOB_CLOSE, so
// closing the handle (or the shim dying) leaves the processes running.
type Job struct {
	mu   sync.Mutex
	h    windows.Handle
	port windows.Handle // 0 if another handle owner associated its port first
}

// permanentPrivilege enables SeCreatePermanentPrivilege once; SYSTEM holds
// it, other accounts do not.
var permanentPrivilege = sync.OnceValue(func() error {
	return winapi.EnablePrivileges("SeCreatePermanentPrivilege")
})

// CreatePermanentJob creates the job name (e.g. "sbx-cmd-<id>") in the
// global namespace with OBJ_PERMANENT: it outlives all its handles until
// MakeTemporary or a reboot, so the agent finds it by name after the shim
// died (spec 12.6). The Win32 name `Global\<name>` (OpenJob) is the NT path
// `\BaseNamedObjects\<name>`. An existing job is ErrJobExists.
func CreatePermanentJob(name string) (*Job, error) {
	if err := checkName(name); err != nil {
		return nil, err
	}
	if err := permanentPrivilege(); err != nil {
		return nil, fmt.Errorf("%w: %w", ErrNoPermanentPrivilege, err)
	}
	path, err := windows.NewNTUnicodeString(`\BaseNamedObjects\` + name)
	if err != nil {
		return nil, fmt.Errorf("winproc: job name %q: %w", name, err)
	}
	oa := windows.OBJECT_ATTRIBUTES{
		ObjectName: path,
		Attributes: windows.OBJ_PERMANENT | windows.OBJ_CASE_INSENSITIVE,
	}
	oa.Length = uint32(unsafe.Sizeof(oa))
	h, err := winapi.NtCreateJobObject(jobAllAccess, &oa)
	switch {
	case errors.Is(err, windows.STATUS_OBJECT_NAME_COLLISION):
		return nil, fmt.Errorf("%w: %s", ErrJobExists, name)
	case errors.Is(err, windows.STATUS_PRIVILEGE_NOT_HELD):
		return nil, fmt.Errorf("%w: %w", ErrNoPermanentPrivilege, err)
	case err != nil:
		return nil, fmt.Errorf("winproc: NtCreateJobObject %s: %w", name, err)
	}
	j := &Job{h: h}
	if err := j.associatePort(); err != nil {
		// The object is permanent: drop that before closing the only handle.
		_ = winapi.NtMakeTemporaryObject(h)
		_ = windows.CloseHandle(h)
		return nil, fmt.Errorf("winproc: job %s: %w", name, err)
	}
	return j, nil
}

// CreateJob creates an ordinary job that disappears with its last handle:
// named `Global\<name>`, or unnamed when name is "". An existing job is
// ErrJobExists.
func CreateJob(name string) (*Job, error) {
	var n *uint16
	if name != "" {
		if err := checkName(name); err != nil {
			return nil, err
		}
		p, err := windows.UTF16PtrFromString(`Global\` + name)
		if err != nil {
			return nil, fmt.Errorf("winproc: job name %q: %w", name, err)
		}
		n = p
	}
	h, err := windows.CreateJobObject(nil, n)
	if errors.Is(err, windows.ERROR_ALREADY_EXISTS) {
		_ = windows.CloseHandle(h)
		return nil, fmt.Errorf("%w: %s", ErrJobExists, name)
	}
	if err != nil {
		return nil, fmt.Errorf("winproc: CreateJobObject %s: %w", name, err)
	}
	j := &Job{h: h}
	if err := j.associatePort(); err != nil {
		_ = windows.CloseHandle(h)
		return nil, fmt.Errorf("winproc: job %s: %w", name, err)
	}
	return j, nil
}

// OpenJob opens the job name (`Global\<name>`) created by this or another
// process. A missing job is ErrJobNotFound.
func OpenJob(name string) (*Job, error) {
	if err := checkName(name); err != nil {
		return nil, err
	}
	h, err := winapi.OpenJobObject(jobAllAccess, false, `Global\`+name)
	if errors.Is(err, windows.ERROR_FILE_NOT_FOUND) {
		return nil, fmt.Errorf("%w: %s", ErrJobNotFound, name)
	}
	if err != nil {
		return nil, fmt.Errorf("winproc: OpenJobObject %s: %w", name, err)
	}
	j := &Job{h: h}
	// A job takes one completion port; the creator usually has it. Then
	// WaitEmpty polls.
	_ = j.associatePort()
	return j, nil
}

// checkName accepts a plain object name: no namespace prefix, no path.
func checkName(name string) error {
	if name == "" || strings.ContainsAny(name, `\/`) || len(name) > 200 {
		return fmt.Errorf("winproc: bad object name %q", name)
	}
	return nil
}

// associatePort creates a completion port and associates it with the job
// for JOB_OBJECT_MSG_ACTIVE_PROCESS_ZERO.
func (j *Job) associatePort() error {
	port, err := windows.CreateIoCompletionPort(windows.InvalidHandle, 0, 0, 1)
	if err != nil {
		return fmt.Errorf("CreateIoCompletionPort: %w", err)
	}
	info := associateCompletionPort{CompletionKey: 1, CompletionPort: port}
	if _, err := windows.SetInformationJobObject(j.h, windows.JobObjectAssociateCompletionPortInformation,
		uintptr(unsafe.Pointer(&info)), uint32(unsafe.Sizeof(info))); err != nil {
		_ = windows.CloseHandle(port)
		return fmt.Errorf("associate completion port: %w", err)
	}
	j.port = port
	return nil
}

// Handle returns the job handle, valid until Close.
func (j *Job) Handle() windows.Handle {
	j.mu.Lock()
	defer j.mu.Unlock()
	return j.h
}

// handle returns the open handle or an error after Close.
func (j *Job) handle() (windows.Handle, error) {
	j.mu.Lock()
	defer j.mu.Unlock()
	if j.h == 0 {
		return 0, errors.New("winproc: job is closed")
	}
	return j.h, nil
}

// ActiveProcesses returns the number of processes in the job.
func (j *Job) ActiveProcesses() (uint32, error) {
	h, err := j.handle()
	if err != nil {
		return 0, err
	}
	var info basicAccounting
	if err := windows.QueryInformationJobObject(h, windows.JobObjectBasicAccountingInformation,
		uintptr(unsafe.Pointer(&info)), uint32(unsafe.Sizeof(info)), nil); err != nil {
		return 0, fmt.Errorf("winproc: query job: %w", err)
	}
	return info.ActiveProcesses, nil
}

// Terminate ends every process of the job with exit code code.
func (j *Job) Terminate(code uint32) error {
	h, err := j.handle()
	if err != nil {
		return err
	}
	if err := windows.TerminateJobObject(h, code); err != nil {
		return fmt.Errorf("winproc: TerminateJobObject: %w", err)
	}
	return nil
}

// MakeTemporary clears OBJ_PERMANENT: the job disappears when its last
// handle is closed. On an ordinary job it does nothing.
func (j *Job) MakeTemporary() error {
	h, err := j.handle()
	if err != nil {
		return err
	}
	if err := winapi.NtMakeTemporaryObject(h); err != nil {
		return fmt.Errorf("winproc: NtMakeTemporaryObject: %w", err)
	}
	return nil
}

// WaitEmpty returns when the job has no processes, or ctx.Err(). It uses
// the job's completion port when this Job owns it, and polls otherwise.
func (j *Job) WaitEmpty(ctx context.Context) error {
	for {
		n, err := j.ActiveProcesses()
		if err != nil {
			return err
		}
		if n == 0 {
			return nil
		}
		if err := ctx.Err(); err != nil {
			return err
		}
		j.mu.Lock()
		port := j.port
		j.mu.Unlock()
		if port == 0 {
			t := time.NewTimer(waitEmptyPoll)
			select {
			case <-ctx.Done():
				t.Stop()
				return ctx.Err()
			case <-t.C:
			}
			continue
		}
		// The port gets JOB_OBJECT_MSG_ACTIVE_PROCESS_ZERO when the last
		// process exits. Any message (new or exited process, a stale zero
		// from an earlier wait) or the timeout leads to a recount.
		var msg uint32
		var key uintptr
		var ov *windows.Overlapped
		err = windows.GetQueuedCompletionStatus(port, &msg, &key, &ov, uint32(waitEmptyPoll/time.Millisecond))
		if err != nil && !errors.Is(err, windows.WAIT_TIMEOUT) {
			return fmt.Errorf("winproc: job completion port: %w", err)
		}
	}
}

// Close closes the handles of the job. A permanent job stays; an ordinary
// one disappears with its last handle. The processes keep running.
func (j *Job) Close() error {
	j.mu.Lock()
	defer j.mu.Unlock()
	if j.h == 0 {
		return nil
	}
	if j.port != 0 {
		_ = windows.CloseHandle(j.port)
		j.port = 0
	}
	err := windows.CloseHandle(j.h)
	j.h = 0
	if err != nil {
		return fmt.Errorf("winproc: close job: %w", err)
	}
	return nil
}
