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

// waitEmptyPoll is how often WaitEmpty recounts the processes without a
// notification from the completion port.
const waitEmptyPoll = 250 * time.Millisecond

// Completion keys: job messages, and the request to stop draining.
const (
	keyJob  = 1
	keyQuit = 2
)

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
//
// A created job owns the job's completion port (a job takes only one). A
// goroutine drains it for the whole life of the Job, so the queue of job
// messages does not grow with every process a long command spawns, and
// wakes WaitEmpty on each message. Close stops it. An opened job has no
// port and WaitEmpty polls.
type Job struct {
	mu      sync.Mutex
	h       windows.Handle
	port    windows.Handle // 0 for an opened job
	notify  chan struct{}  // a job message arrived; nil without a port
	drained chan struct{}  // closed when the drain goroutine ends
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
	var win32 string
	if name != "" {
		if err := checkName(name); err != nil {
			return nil, err
		}
		win32 = `Global\` + name
	}
	h, existed, err := winapi.CreateJobObject(win32)
	if existed {
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
// process. It never takes the completion port: a live shim may own it. A
// missing job is ErrJobNotFound.
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
	return &Job{h: h}, nil
}

// checkName accepts a plain object name: no namespace prefix, no path.
func checkName(name string) error {
	if name == "" || strings.ContainsAny(name, `\/`) || len(name) > 200 {
		return fmt.Errorf("winproc: bad object name %q", name)
	}
	return nil
}

// associatePort creates a completion port, associates it with the job
// (JOB_OBJECT_MSG_ACTIVE_PROCESS_ZERO and the other job messages) and
// starts draining it.
func (j *Job) associatePort() error {
	port, err := windows.CreateIoCompletionPort(windows.InvalidHandle, 0, 0, 1)
	if err != nil {
		return fmt.Errorf("CreateIoCompletionPort: %w", err)
	}
	info := associateCompletionPort{CompletionKey: keyJob, CompletionPort: port}
	if _, err := windows.SetInformationJobObject(j.h, windows.JobObjectAssociateCompletionPortInformation,
		uintptr(unsafe.Pointer(&info)), uint32(unsafe.Sizeof(info))); err != nil {
		_ = windows.CloseHandle(port)
		return fmt.Errorf("associate completion port: %w", err)
	}
	j.port = port
	j.notify = make(chan struct{}, 1)
	j.drained = make(chan struct{})
	go drain(port, j.notify, j.drained)
	return nil
}

// drain dequeues the messages of port until keyQuit or a port failure and
// signals each job message on notify without blocking.
func drain(port windows.Handle, notify chan<- struct{}, drained chan<- struct{}) {
	defer close(drained)
	for {
		var msg uint32
		var key uintptr
		var ov *windows.Overlapped
		if err := windows.GetQueuedCompletionStatus(port, &msg, &key, &ov, windows.INFINITE); err != nil {
			return
		}
		if key == keyQuit {
			return
		}
		select {
		case notify <- struct{}{}:
		default:
		}
	}
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

// ProcessIDs returns the ids of the processes in the job.
func (j *Job) ProcessIDs() ([]uint32, error) {
	h, err := j.handle()
	if err != nil {
		return nil, err
	}
	// JOBOBJECT_BASIC_PROCESS_ID_LIST: two DWORD counts (8 bytes), then
	// ULONG_PTR ids. Grow until the list fits; processes may join meanwhile.
	hdrWords := 8 / int(unsafe.Sizeof(uintptr(0)))
	n := 64
	for {
		buf := make([]uintptr, hdrWords+n)
		err := windows.QueryInformationJobObject(h, windows.JobObjectBasicProcessIdList,
			uintptr(unsafe.Pointer(&buf[0])), uint32(len(buf))*uint32(unsafe.Sizeof(buf[0])), nil)
		if err != nil && !errors.Is(err, windows.ERROR_MORE_DATA) {
			return nil, fmt.Errorf("winproc: job process list: %w", err)
		}
		hdr := (*[2]uint32)(unsafe.Pointer(&buf[0]))
		assigned, listed := int(hdr[0]), int(hdr[1])
		if err == nil && listed <= n {
			ids := make([]uint32, listed)
			for i := range listed {
				ids[i] = uint32(buf[hdrWords+i]) //nolint:gosec // process ids are 32-bit
			}
			return ids, nil
		}
		n = max(2*n, assigned+16)
	}
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

// WaitEmpty returns when the job has no processes, or ctx.Err(). A created
// job wakes on its port's messages (JOB_OBJECT_MSG_ACTIVE_PROCESS_ZERO when
// the last process exits); an opened one polls every waitEmptyPoll.
func (j *Job) WaitEmpty(ctx context.Context) error {
	j.mu.Lock()
	notify := j.notify
	j.mu.Unlock()
	for {
		n, err := j.ActiveProcesses()
		if err != nil {
			return err
		}
		if n == 0 {
			return nil
		}
		// Any message (a new or exited process, a stale zero from an
		// earlier wait) or the timer leads to a recount; the timer also
		// covers a notification taken by a concurrent WaitEmpty.
		t := time.NewTimer(waitEmptyPoll)
		select {
		case <-ctx.Done():
			t.Stop()
			return ctx.Err()
		case <-notify:
			t.Stop()
		case <-t.C:
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
		// Let drain return before the port handle goes, so it never waits
		// on a closed (or reused) handle value.
		if err := windows.PostQueuedCompletionStatus(j.port, 0, keyQuit, nil); err != nil {
			_ = windows.CloseHandle(j.port)
			<-j.drained
		} else {
			<-j.drained
			_ = windows.CloseHandle(j.port)
		}
		j.port = 0
	}
	err := windows.CloseHandle(j.h)
	j.h = 0
	if err != nil {
		return fmt.Errorf("winproc: close job: %w", err)
	}
	return nil
}
