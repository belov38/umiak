//go:build linux

package shim

import (
	"errors"
	"flag"
	"fmt"
	"io"
	"log/slog"
	"net"
	"os"
	"os/exec"
	"os/signal"
	"path/filepath"
	"strings"
	"sync"
	"sync/atomic"
	"syscall"
	"time"

	"github.com/coreos/go-systemd/v22/daemon"
	"github.com/creack/pty"
	"golang.org/x/sys/unix"

	"github.com/belov38/boat-dev-clone/services/guest-agent/internal/fsutil"
	"github.com/belov38/boat-dev-clone/services/guest-agent/internal/paths"
	"github.com/belov38/boat-dev-clone/services/guest-agent/internal/shimproto"
)

// defaultPath is the search path when the spec environment has no PATH.
const defaultPath = "/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin"

// shimOOMScoreAdj protects the shim from the OOM killer: if it dies, the
// command loses its pipes (spec section 9.3).
const shimOOMScoreAdj = "-900"

// Main runs `sbx-agent shim --id <id> [--layout-root <dir>] [--no-cgroup]`
// with its log on os.Stderr (the unit's journal). See Run.
func Main(args []string) int {
	return Run(args, os.Stderr)
}

// Run is Main with an explicit log writer. It returns the process exit
// code: 0 once the command and its leftovers are done (also after a start
// failure, which is recorded in exit.json), 1 if the shim itself fails
// before it can record anything, 2 on bad arguments.
//
// --layout-root runs against paths.ForRoot (tests and dev runs). --no-cgroup
// skips the cgroup setup: the command runs in the shim's cgroup, its group
// is signalled until the main process is reaped and the shim's descendants
// afterwards (tests without systemd).
func Run(args []string, stderr io.Writer) int {
	log := slog.New(slog.NewTextHandler(stderr, nil))
	fs := flag.NewFlagSet("shim", flag.ContinueOnError)
	fs.SetOutput(stderr)
	id := fs.String("id", "", "command id")
	root := fs.String("layout-root", "", "use the agent layout under this directory")
	noCgroup := fs.Bool("no-cgroup", false, "do not create the payload cgroup")
	if err := fs.Parse(args); err != nil {
		return 2
	}
	if !validID(*id) || fs.NArg() != 0 {
		log.Error("shim: usage: sbx-agent shim --id <id> [--layout-root <dir>] [--no-cgroup]")
		return 2
	}
	l := paths.Default()
	if *root != "" {
		l = paths.ForRoot(*root)
	}
	s := newShim(log.With("command_id", *id), l, *id)
	if err := s.run(!*noCgroup); err != nil {
		s.log.Error("shim failed", "err", err)
		return 1
	}
	return 0
}

// validID reports whether id is a plain file name.
func validID(id string) bool {
	return id != "" && id != "." && id != ".." && !strings.ContainsAny(id, "/\\\x00")
}

// stream is one output stream: a non-blocking read fd and its log file.
type stream struct {
	name string
	file *os.File // append-only log
	fd   int      // read end; -1 before the start
	eof  bool
	// werr is set after the first failed log write, to log it once.
	werr bool
}

// shim is the state of one shim process.
type shim struct {
	log    *slog.Logger
	layout paths.Layout
	id     string
	dir    string
	spec   Spec
	cg     *cgroup

	// Set before the event loop starts and read-only afterwards.
	pid       int
	pidfd     int
	streams   []*stream
	ptyMaster *os.File // keeps the master fd open; nil without a PTY
	ptyFd     int      // master fd; -1 without a PTY
	wakeR     int
	wakeW     int
	oomBase   uint64
	ln        *net.UnixListener
	// selfPid is the root of the process tree searched for leftovers
	// without a cgroup: the shim itself, which is their subreaper.
	selfPid int
	// popErrs counts failed cgroup.events reads in a row (loop only).
	popErrs int

	// reqMu serializes the requests that touch the input state, so applying
	// an input and advancing its seq are atomic.
	reqMu   sync.Mutex
	stdinFd int // write end of the stdin pipe; -1 when none or closed
	seqs    seqTable
	// stdinCloseReq asks whoever holds reqMu to close stdin (set on exit).
	stdinCloseReq atomic.Bool

	// mu guards the state shared between the event loop and the server.
	mu         sync.Mutex
	exited     bool
	mainReaped bool      // the main pid is reaped and may be reused
	killReason string    // reason of the first kill before the exit
	signalled  bool      // a signal request reached the group before the exit
	timeoutAt  time.Time // Spec.TimeoutMs deadline; zero once fired or unset
	hardKillAt time.Time // pending cgroup kill of a Kill with grace
	conns      map[*conn]bool
	closing    bool
}

func newShim(log *slog.Logger, l paths.Layout, id string) *shim {
	return &shim{
		log:     log,
		layout:  l,
		id:      id,
		dir:     l.CommandDir(id),
		pidfd:   -1,
		ptyFd:   -1,
		wakeR:   -1,
		wakeW:   -1,
		stdinFd: -1,
		selfPid: os.Getpid(),
		seqs:    newSeqTable(maxSessions),
		conns:   make(map[*conn]bool),
	}
}

// run performs the whole life of the shim (spec section 9.3).
func (s *shim) run(useCgroup bool) error {
	// shim.json is written only by a shim that got this far: another one
	// already ran the command. A second launch must not start it again.
	if _, err := os.Lstat(filepath.Join(s.dir, ShimJSON)); err == nil {
		return fmt.Errorf("shim: %s exists: command %s was already launched", ShimJSON, s.id)
	} else if !errors.Is(err, os.ErrNotExist) {
		return err
	}
	spec, err := ReadSpec(s.layout.CmdSpec(s.id))
	if err != nil {
		return err
	}
	s.spec = spec
	if err := os.MkdirAll(s.dir, 0o700); err != nil {
		return err
	}
	if err := s.openStreams(); err != nil {
		return err
	}
	defer s.closeAll()

	// From here on every failure is a START_FAILED command: the stream files
	// exist to carry the error text.
	startErr := spec.validate(s.id)
	if startErr == nil && useCgroup {
		s.cg, startErr = setupCgroup(s.log)
		if startErr == nil {
			// Baseline before the start: an OOM kill of the main process
			// shows as a growth past it.
			if n, err := s.cg.oomKills(); err == nil {
				s.oomBase = n
			}
		}
	}
	if startErr == nil {
		if err := unix.Prctl(unix.PR_SET_CHILD_SUBREAPER, 1, 0, 0, 0); err != nil {
			startErr = fmt.Errorf("shim: PR_SET_CHILD_SUBREAPER: %w", err)
		}
	}
	if startErr == nil {
		startErr = s.initWake()
	}
	if startErr == nil {
		startErr = s.writeShimFile(ShimFile{State: StateLaunching, AgentVersion: spec.AgentVersion, ShimProto: shimproto.Version})
	}
	if startErr == nil {
		startErr = s.start()
	}
	if startErr != nil {
		return s.startFailed(startErr)
	}
	// The journal stream on fd 2 may break (journald restart); a write
	// there must fail with EPIPE instead of killing the shim. Ignored only
	// after the start: an ignored SIGPIPE would be inherited by the command.
	signal.Ignore(syscall.SIGPIPE)

	startedAt := time.Now()
	if err := os.WriteFile("/proc/self/oom_score_adj", []byte(shimOOMScoreAdj), 0); err != nil {
		s.log.Warn("shim: cannot lower own oom_score_adj", "err", err)
	}
	if err := s.writeShimFile(ShimFile{State: StateRunning, AgentVersion: spec.AgentVersion,
		ShimProto: shimproto.Version, Pid: s.pid, StartedAt: startedAt.UTC()}); err != nil {
		// The process runs; exit.json and the socket still work.
		s.log.Error("shim: write shim.json", "err", err)
	}
	if spec.TimeoutMs > 0 {
		s.timeoutAt = startedAt.Add(time.Duration(spec.TimeoutMs) * time.Millisecond) //nolint:gosec // bounded by the agent
	}
	if err := s.listen(); err != nil {
		// Without the socket the agent cannot send input or signals, but
		// the command still runs to exit.json; cgroup.kill stays possible.
		s.log.Error("shim: listen", "err", err)
	}
	s.notifyReady()
	s.loop()
	return nil
}

// openStreams creates the log files: stdout and stderr, or pty.
func (s *shim) openStreams() error {
	names := []string{StdoutFile, StderrFile}
	if s.spec.PTY != nil {
		names = []string{PtyFile}
	}
	for _, name := range names {
		// Append only: retention punches holes at the front while the shim
		// writes, so the file is never truncated or rewritten.
		f, err := os.OpenFile(filepath.Join(s.dir, name), os.O_WRONLY|os.O_APPEND|os.O_CREATE, 0o600)
		if err != nil {
			return err
		}
		s.streams = append(s.streams, &stream{name: name, file: f, fd: -1})
	}
	return nil
}

// initWake creates the pipe the server uses to wake the event loop.
func (s *shim) initWake() error {
	var p [2]int
	if err := unix.Pipe2(p[:], unix.O_NONBLOCK|unix.O_CLOEXEC); err != nil {
		return fmt.Errorf("shim: wake pipe: %w", err)
	}
	s.wakeR, s.wakeW = p[0], p[1]
	return nil
}

func (s *shim) writeShimFile(f ShimFile) error {
	return fsutil.WriteJSONAtomic(filepath.Join(s.dir, ShimJSON), f, 0o600)
}

// start launches the command into the payload cgroup.
func (s *shim) start() error {
	path, err := lookPath(s.spec.Argv[0], s.spec.Env)
	if err != nil {
		return err
	}
	env := append([]string{}, s.spec.Env...)
	if s.spec.PTY != nil && !hasEnv(env, "TERM") {
		term := s.spec.PTY.Term
		if term == "" {
			term = DefaultTerm
		}
		env = append(env, "TERM="+term)
	}
	cmd := &exec.Cmd{Path: path, Args: s.spec.Argv, Env: env, Dir: s.spec.Cwd}
	pidfd := -1
	attr := &syscall.SysProcAttr{PidFD: &pidfd, Credential: credential(s.spec)}
	if s.cg != nil {
		attr.UseCgroupFD = true
		attr.CgroupFD = s.cg.fd
	}
	if s.spec.PTY != nil {
		err = s.startPTY(cmd, attr)
	} else {
		err = s.startPipes(cmd, attr)
	}
	if err != nil {
		return err
	}
	s.pid = cmd.Process.Pid
	s.pidfd = pidfd
	return nil
}

// startPTY runs cmd as a session leader with the PTY slave as its
// controlling terminal.
func (s *shim) startPTY(cmd *exec.Cmd, attr *syscall.SysProcAttr) error {
	attr.Setsid = true
	attr.Setctty = true
	master, tty, err := pty.Open()
	if err != nil {
		return err
	}
	defer func() { _ = tty.Close() }()
	fail := func(err error) error {
		_ = master.Close()
		return err
	}
	if p := s.spec.PTY; p.Cols > 0 && p.Rows > 0 {
		if err := pty.Setsize(master, &pty.Winsize{Cols: p.Cols, Rows: p.Rows}); err != nil {
			return fail(err)
		}
	}
	// The slave belongs to the creator (root); a command of another user
	// reopens it as /dev/stdout or /dev/stderr (/proc/self/fd/N), like after
	// a login, which gives the terminal to the user.
	if s.ownsOther() {
		if err := unix.Fchown(int(tty.Fd()), int(s.spec.UID), -1); err != nil { //nolint:gosec // fd and uid fit in int
			return fail(fmt.Errorf("shim: chown pty: %w", err))
		}
	}
	cmd.Stdin, cmd.Stdout, cmd.Stderr = tty, tty, tty
	cmd.SysProcAttr = attr
	if err := cmd.Start(); err != nil {
		return fail(err)
	}
	// Fd switches the file to blocking mode; the loop needs it non-blocking.
	fd := int(master.Fd()) //nolint:gosec // fd fits in int
	if err := unix.SetNonblock(fd, true); err != nil {
		_ = master.Close()
		return err
	}
	s.ptyMaster = master
	s.ptyFd = fd
	s.streams[0].fd = fd
	return nil
}

// startPipes runs cmd in its own process group with stdout and stderr on
// pipes and stdin on a pipe or /dev/null. The process never gets the log
// file itself: `echo x >/dev/stderr` reopens fd 2, which would truncate it.
func (s *shim) startPipes(cmd *exec.Cmd, attr *syscall.SysProcAttr) (err error) {
	attr.Setpgid = true
	var childEnds []*os.File
	var parentEnds []int
	defer func() {
		for _, f := range childEnds {
			_ = f.Close()
		}
		if err != nil {
			for _, fd := range parentEnds {
				_ = unix.Close(fd)
			}
		}
	}()
	pipe := func(name string) (r, w int, err error) {
		var p [2]int
		if err := unix.Pipe2(p[:], unix.O_CLOEXEC); err != nil {
			return -1, -1, fmt.Errorf("shim: %s pipe: %w", name, err)
		}
		if err := s.chownPipe(p[0]); err != nil {
			_ = unix.Close(p[0])
			_ = unix.Close(p[1])
			return -1, -1, fmt.Errorf("shim: %s pipe: %w", name, err)
		}
		return p[0], p[1], nil
	}
	for i, st := range s.streams {
		r, w, err := pipe(st.name)
		if err != nil {
			return err
		}
		parentEnds = append(parentEnds, r)
		f := os.NewFile(uintptr(w), st.name) //nolint:gosec // fd is non-negative
		childEnds = append(childEnds, f)
		if err := unix.SetNonblock(r, true); err != nil {
			return err
		}
		if i == 0 {
			cmd.Stdout = f
		} else {
			cmd.Stderr = f
		}
	}
	if s.spec.Stdin {
		r, w, err := pipe("stdin")
		if err != nil {
			return err
		}
		parentEnds = append(parentEnds, w)
		f := os.NewFile(uintptr(r), "stdin") //nolint:gosec // fd is non-negative
		childEnds = append(childEnds, f)
		if err := unix.SetNonblock(w, true); err != nil {
			return err
		}
		cmd.Stdin = f
	}
	cmd.SysProcAttr = attr
	if err := cmd.Start(); err != nil {
		return err
	}
	for i, st := range s.streams {
		st.fd = parentEnds[i]
	}
	if s.spec.Stdin {
		s.stdinFd = parentEnds[len(parentEnds)-1]
	}
	return nil
}

// chownPipe gives the pipe of fd to the user of the command. A pipe belongs
// to its creator with mode 0600, and `echo x >/dev/stderr` reopens it through
// /proc/self/fd/2, which checks those permissions: a command of another user
// would get EACCES from a pipe of the root shim. Both ends share the inode.
func (s *shim) chownPipe(fd int) error {
	if !s.ownsOther() {
		return nil
	}
	return unix.Fchown(fd, int(s.spec.UID), int(s.spec.GID)) //nolint:gosec // uid and gid fit in int
}

// ownsOther reports whether the command runs with other credentials than
// the shim, so the descriptors it reopens must be given to it.
func (s *shim) ownsOther() bool {
	return credential(s.spec) != nil && (int(s.spec.UID) != os.Geteuid() || int(s.spec.GID) != os.Getegid()) //nolint:gosec // uid and gid fit in int
}

// credential returns the credentials of the process. A non-root shim (tests)
// cannot call setgroups, so when the spec asks for the shim's own uid and
// gid the process simply inherits them; as root the credentials, including
// the supplementary groups, are always set.
func credential(s Spec) *syscall.Credential {
	if os.Geteuid() != 0 && int(s.UID) == os.Getuid() && int(s.GID) == os.Getgid() {
		return nil
	}
	return &syscall.Credential{Uid: s.UID, Gid: s.GID, Groups: s.Groups}
}

// killGrace returns the grace of the timeout kill.
func (s Spec) killGrace() time.Duration {
	if s.KillGraceMs == 0 {
		return DefaultKillGrace
	}
	return time.Duration(s.KillGraceMs) * time.Millisecond //nolint:gosec // bounded by the agent
}

// lookPath resolves a program without a slash in the PATH of env.
func lookPath(prog string, env []string) (string, error) {
	if strings.Contains(prog, "/") {
		return prog, nil
	}
	search := defaultPath
	for _, kv := range env {
		if v, ok := strings.CutPrefix(kv, "PATH="); ok {
			search = v // the first one wins, as with getenv
			break
		}
	}
	for _, dir := range filepath.SplitList(search) {
		if dir == "" {
			dir = "."
		}
		p := filepath.Join(dir, prog)
		if fi, err := os.Stat(p); err == nil && fi.Mode().IsRegular() && fi.Mode()&0o111 != 0 {
			return p, nil
		}
	}
	return "", fmt.Errorf("exec: %q: executable file not found in $PATH", prog)
}

func hasEnv(env []string, key string) bool {
	for _, kv := range env {
		if strings.HasPrefix(kv, key+"=") {
			return true
		}
	}
	return false
}

// startFailed records a start failure: the error text goes to the command's
// stderr (or pty) stream and exit.json gets code 127, reason START_FAILED.
func (s *shim) startFailed(cause error) error {
	s.log.Warn("shim: start failed", "err", cause)
	st := s.streams[len(s.streams)-1] // stderr, or the only pty stream
	if _, err := fmt.Fprintf(st.file, "sbx-agent: cannot start command: %v\n", cause); err != nil {
		s.log.Error("shim: write start error", "err", err)
	}
	e := ExitFile{
		Status:      shimproto.StatusExited,
		Code:        127,
		Reason:      shimproto.ReasonStartFailed,
		EndedAt:     time.Now().UTC(),
		StartFailed: cause.Error(),
	}
	s.setEnds(&e)
	if err := fsutil.WriteJSONAtomic(filepath.Join(s.dir, ExitJSON), e, 0o600); err != nil {
		return fmt.Errorf("shim: write exit.json: %w", err)
	}
	s.notifyReady()
	return nil
}

// setEnds fills the stream ends of e from the log file sizes.
func (s *shim) setEnds(e *ExitFile) {
	for _, st := range s.streams {
		fi, err := st.file.Stat()
		if err != nil {
			s.log.Error("shim: stat log", "stream", st.name, "err", err)
			continue
		}
		switch st.name {
		case StdoutFile:
			e.StdoutEnd = fi.Size()
		case StderrFile:
			e.StderrEnd = fi.Size()
		case PtyFile:
			e.PtyEnd = fi.Size()
		}
	}
}

// notifyReady sends READY=1 to systemd; without NOTIFY_SOCKET it is a no-op.
func (s *shim) notifyReady() {
	if _, err := daemon.SdNotify(false, daemon.SdNotifyReady); err != nil {
		s.log.Warn("shim: sd_notify", "err", err)
	}
}

// unlockReq releases reqMu, first closing stdin if the exit asked for it.
// Unlock comes before the check, so either this holder or the exit path
// (TryLock after setting the request) closes it.
func (s *shim) unlockReq() {
	s.reqMu.Unlock()
	if s.stdinCloseReq.Load() && s.reqMu.TryLock() {
		if s.stdinFd >= 0 {
			_ = unix.Close(s.stdinFd)
			s.stdinFd = -1
		}
		s.reqMu.Unlock()
	}
}

// closeAll releases every descriptor at the end of the shim.
func (s *shim) closeAll() {
	s.reqMu.Lock()
	defer s.reqMu.Unlock()
	if s.stdinFd >= 0 {
		_ = unix.Close(s.stdinFd)
		s.stdinFd = -1
	}
	for _, st := range s.streams {
		if st.fd >= 0 && st.fd != s.ptyFd {
			_ = unix.Close(st.fd)
		}
		st.fd = -1
		_ = st.file.Close()
	}
	if s.ptyMaster != nil {
		_ = s.ptyMaster.Close()
		s.ptyFd = -1
	}
	// A late kill request reads wakeW under mu.
	s.mu.Lock()
	for _, fd := range []int{s.pidfd, s.wakeR, s.wakeW} {
		if fd >= 0 {
			_ = unix.Close(fd)
		}
	}
	s.pidfd, s.wakeR, s.wakeW = -1, -1, -1
	s.mu.Unlock()
	if s.cg != nil {
		_ = unix.Close(s.cg.fd)
	}
}
