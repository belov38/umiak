//go:build windows

package supervisor

import (
	"context"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"slices"
	"sync"

	"golang.org/x/sys/windows"

	"github.com/belov38/boat-dev-clone/services/guest-agent/internal/paths"
	"github.com/belov38/boat-dev-clone/services/guest-agent/internal/shim"
	"github.com/belov38/boat-dev-clone/services/guest-agent/internal/wincmd"
	"github.com/belov38/boat-dev-clone/services/guest-agent/internal/winproc"
)

// watchdogJobPrefix names the job of a quiesce watchdog.
const watchdogJobPrefix = "sbx-wd-"

// windowsSup is the Supervisor on Windows (S9 spec 12.6): a shim is a
// detached process outside the agent's job, its command lives in the
// permanent job `Global\sbx-cmd-<id>`, and the shim's mutex
// `Global\sbx-shim-<id>` tells whether the shim is alive. Nothing of a
// command depends on the agent process, so commands survive its restart.
type windowsSup struct {
	layout paths.Layout

	mu sync.Mutex
	// watchdogs holds the job of each watchdog started by this process.
	watchdogs map[string]*winproc.Job
}

// NewWindows returns the Windows supervisor for the layout l. Shims log to
// shim.log in their command directory.
func NewWindows(l paths.Layout) (Supervisor, error) {
	return &windowsSup{layout: l, watchdogs: make(map[string]*winproc.Job)}, nil
}

var _ SpecLauncher = (*windowsSup)(nil)

// Launch implements Supervisor. A Windows shim takes its spec on stdin
// only: callers use LaunchSpec.
func (s *windowsSup) Launch(context.Context, string, string, []string) error {
	return errors.New("supervisor: the Windows shim needs LaunchSpec")
}

// LaunchSpec implements SpecLauncher: it starts `shimPath shim --id <id>
// extraArgs...` detached (no console, its own process group, outside the
// agent's job), writes spec to its stdin and waits for the READY or FAIL
// line on its stdout. A live shim or an existing job of id is
// ErrUnitExists. If ctx ends first it returns ctx.Err(); the shim goes on.
func (s *windowsSup) LaunchSpec(ctx context.Context, id, shimPath string, extraArgs []string, spec []byte) error {
	if err := checkCommandID(id); err != nil {
		return err
	}
	if exists, err := s.launched(id); err != nil || exists {
		if err == nil {
			err = fmt.Errorf("%w: %s", ErrUnitExists, shim.JobName(id))
		}
		return err
	}
	dir := s.layout.CommandDir(id)
	if err := os.MkdirAll(dir, 0o700); err != nil {
		return fmt.Errorf("supervisor: %w", err)
	}
	logf, err := os.OpenFile(filepath.Join(dir, shim.ShimLog), os.O_WRONLY|os.O_APPEND|os.O_CREATE, 0o600)
	if err != nil {
		return fmt.Errorf("supervisor: shim log: %w", err)
	}
	defer logf.Close() //nolint:errcheck // the shim holds its own handle
	stdinR, stdinW, err := pipe()
	if err != nil {
		return fmt.Errorf("supervisor: shim stdin: %w", err)
	}
	stdoutR, stdoutW, err := pipe()
	if err != nil {
		_ = stdinR.Close()
		_ = stdinW.Close()
		return fmt.Errorf("supervisor: shim stdout: %w", err)
	}
	argv := shimArgv(id, shimPath, extraArgs)
	opts := winproc.StartOptions{
		Argv0Path:        shimPath,
		CommandLine:      wincmd.ComposeArgs(argv),
		Env:              wincmd.MergeEnv(os.Environ(), commandEnv),
		Stdin:            windows.Handle(stdinR.Fd()),
		Stdout:           windows.Handle(stdoutW.Fd()),
		Stderr:           windows.Handle(logf.Fd()),
		NewProcessGroup:  true,
		Detached:         true,
		BreakawayFromJob: true,
	}
	p, err := winproc.Start(opts)
	if errors.Is(err, windows.ERROR_ACCESS_DENIED) {
		// The agent runs in a job that forbids breakaway (a debugger or a
		// test runner, never the service): the shim stays in that job.
		opts.BreakawayFromJob = false
		p, err = winproc.Start(opts)
	}
	_ = stdinR.Close()
	_ = stdoutW.Close()
	if err != nil {
		_ = stdinW.Close()
		_ = stdoutR.Close()
		return fmt.Errorf("supervisor: start shim %s: %w", id, err)
	}
	_ = p.Close()

	// The pipe buffer may be smaller than the spec: write while the shim
	// reads. A shim that dies early breaks the pipe, and readReady sees EOF.
	// Its own copy: the caller clears spec (it holds the environment) when
	// LaunchSpec returns, possibly before the shim read it all.
	buf := slices.Clone(spec)
	go func() {
		_, _ = stdinW.Write(buf)
		_ = stdinW.Close()
		clear(buf)
	}()
	done := make(chan error, 1)
	go func() {
		done <- readReady(stdoutR)
		_ = stdoutR.Close()
	}()
	select {
	case err := <-done:
		if err != nil {
			return fmt.Errorf("supervisor: shim %s: %w", id, err)
		}
		return nil
	case <-ctx.Done():
		return ctx.Err()
	}
}

// pipe returns a pipe whose handles are not inheritable (os.Pipe's are):
// a process the agent starts meanwhile must not keep the shim's stdin open.
// winproc.Start hands the shim its own inheritable duplicates.
func pipe() (r, w *os.File, err error) {
	var rh, wh windows.Handle
	if err := windows.CreatePipe(&rh, &wh, nil, 0); err != nil {
		return nil, nil, err
	}
	return os.NewFile(uintptr(rh), "|0"), os.NewFile(uintptr(wh), "|1"), nil
}

// commandEnv keeps the shim small: it holds pipes and a socket, nothing
// else (spec section 9.7).
var commandEnv = []string{"GOGC=50", "GOMEMLIMIT=6MiB"}

// launched reports whether command id has a live shim or a job. An empty
// job without a shim and without shim.json or exit.json is the leftover of
// a shim that died before it launched anything: its permanence is dropped
// so the launch can go on instead of failing until a reboot.
func (s *windowsSup) launched(id string) (bool, error) {
	if winproc.ShimAlive(id) {
		return true, nil
	}
	j, err := winproc.OpenJob(shim.JobName(id))
	if errors.Is(err, winproc.ErrJobNotFound) {
		return false, nil
	}
	if err != nil {
		return false, fmt.Errorf("supervisor: %w", err)
	}
	defer j.Close() //nolint:errcheck // nothing to do on failure
	if n, err := j.ActiveProcesses(); err != nil || n > 0 || s.traced(id) || winproc.ShimAlive(id) {
		return true, nil //nolint:nilerr // an unqueryable job counts as launched
	}
	if err := j.MakeTemporary(); err != nil {
		return true, fmt.Errorf("supervisor: reclaim the job of %s: %w", id, err)
	}
	return false, nil
}

// traced reports whether the command directory of id has shim.json or
// exit.json: a shim got far enough to own the command.
func (s *windowsSup) traced(id string) bool {
	for _, name := range []string{shim.ShimJSON, shim.ExitJSON} {
		if _, err := os.Lstat(filepath.Join(s.layout.CommandDir(id), name)); !errors.Is(err, os.ErrNotExist) {
			return true
		}
	}
	return false
}

// State implements Supervisor (S9 plan decision 5): a live shim or a job
// with processes is UnitActive, an empty job UnitInactive, no job
// UnitNotFound.
func (s *windowsSup) State(_ context.Context, id string) (UnitState, error) {
	if err := checkCommandID(id); err != nil {
		return UnitNotFound, err
	}
	if winproc.ShimAlive(id) {
		return UnitActive, nil
	}
	j, err := winproc.OpenJob(shim.JobName(id))
	if errors.Is(err, winproc.ErrJobNotFound) {
		// The shim may have created both between the two checks.
		if winproc.ShimAlive(id) {
			return UnitActive, nil
		}
		return UnitNotFound, nil
	}
	if err != nil {
		return UnitNotFound, fmt.Errorf("supervisor: state of %s: %w", id, err)
	}
	defer j.Close() //nolint:errcheck // nothing to do on failure
	n, err := j.ActiveProcesses()
	if err != nil {
		return UnitNotFound, fmt.Errorf("supervisor: state of %s: %w", id, err)
	}
	if n > 0 {
		return UnitActive, nil
	}
	return UnitInactive, nil
}

// KillCgroup implements Supervisor: it terminates the job of command id,
// found by name also after its shim died.
func (s *windowsSup) KillCgroup(_ context.Context, id string) error {
	if err := checkCommandID(id); err != nil {
		return err
	}
	j, err := winproc.OpenJob(shim.JobName(id))
	if errors.Is(err, winproc.ErrJobNotFound) {
		return fmt.Errorf("%w: %s", ErrUnitNotFound, shim.JobName(id))
	}
	if err != nil {
		return fmt.Errorf("supervisor: kill %s: %w", id, err)
	}
	defer j.Close() //nolint:errcheck // nothing to do on failure
	if err := j.Terminate(1); err != nil {
		return fmt.Errorf("supervisor: kill %s: %w", id, err)
	}
	return nil
}

// Stop implements Supervisor: it terminates the job of command id and drops
// its permanence, so it disappears with the last handle. A missing job is
// not an error.
func (s *windowsSup) Stop(_ context.Context, id string) error {
	if err := checkCommandID(id); err != nil {
		return err
	}
	j, err := winproc.OpenJob(shim.JobName(id))
	if errors.Is(err, winproc.ErrJobNotFound) {
		return nil
	}
	if err != nil {
		return fmt.Errorf("supervisor: stop %s: %w", id, err)
	}
	defer j.Close() //nolint:errcheck // nothing to do on failure
	return errors.Join(j.Terminate(1), j.MakeTemporary())
}

// StartWatchdog implements Supervisor: argv runs detached in the ordinary
// job `Global\sbx-wd-<lease>`, whose handle the supervisor keeps. The job
// has no KILL_ON_JOB_CLOSE: the watchdog outlives the agent, which is its
// point. A running watchdog of leaseID is ErrUnitExists; a finished one is
// replaced.
func (s *windowsSup) StartWatchdog(_ context.Context, leaseID string, argv []string) error {
	if err := checkLeaseID(leaseID); err != nil {
		return err
	}
	if len(argv) == 0 {
		return errors.New("supervisor: empty watchdog argv")
	}
	s.mu.Lock()
	defer s.mu.Unlock()
	name := watchdogJobPrefix + leaseID
	if old, ok := s.watchdogs[leaseID]; ok {
		if n, err := old.ActiveProcesses(); err != nil || n > 0 {
			return fmt.Errorf("%w: %s", ErrUnitExists, name)
		}
		_ = old.Close()
		delete(s.watchdogs, leaseID)
	}
	j, err := winproc.CreateJob(name)
	if errors.Is(err, winproc.ErrJobExists) {
		return fmt.Errorf("%w: %s", ErrUnitExists, name)
	}
	if err != nil {
		return fmt.Errorf("supervisor: watchdog %s: %w", leaseID, err)
	}
	opts := winproc.StartOptions{Argv0Path: argv[0], CommandLine: wincmd.ComposeArgs(argv), Job: j,
		Detached: true, BreakawayFromJob: true}
	p, err := winproc.Start(opts)
	if errors.Is(err, windows.ERROR_ACCESS_DENIED) {
		opts.BreakawayFromJob = false
		p, err = winproc.Start(opts)
	}
	if err != nil {
		_ = j.Close()
		return fmt.Errorf("supervisor: start watchdog %s: %w", leaseID, err)
	}
	_ = p.Close()
	s.watchdogs[leaseID] = j
	return nil
}

// StopWatchdog implements Supervisor: it terminates the watchdog job of
// leaseID. A watchdog this process does not know (started before an agent
// restart: its job vanished with the old handle) is not an error.
func (s *windowsSup) StopWatchdog(_ context.Context, leaseID string) error {
	if err := checkLeaseID(leaseID); err != nil {
		return err
	}
	s.mu.Lock()
	j, ok := s.watchdogs[leaseID]
	delete(s.watchdogs, leaseID)
	s.mu.Unlock()
	if !ok {
		var err error
		j, err = winproc.OpenJob(watchdogJobPrefix + leaseID)
		if errors.Is(err, winproc.ErrJobNotFound) {
			return nil
		}
		if err != nil {
			return fmt.Errorf("supervisor: stop watchdog %s: %w", leaseID, err)
		}
	}
	defer j.Close() //nolint:errcheck // nothing to do on failure
	if err := j.Terminate(1); err != nil {
		return fmt.Errorf("supervisor: stop watchdog %s: %w", leaseID, err)
	}
	return nil
}

// Close implements Supervisor: it closes the watchdog jobs; the watchdogs
// keep running.
func (s *windowsSup) Close() error {
	s.mu.Lock()
	defer s.mu.Unlock()
	for id, j := range s.watchdogs {
		_ = j.Close()
		delete(s.watchdogs, id)
	}
	return nil
}
