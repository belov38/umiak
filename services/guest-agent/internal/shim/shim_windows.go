package shim

import (
	"errors"
	"flag"
	"fmt"
	"io"
	"log/slog"
	"net"
	"os"
	"os/signal"
	"path/filepath"
	"strings"
	"sync"
	"sync/atomic"
	"time"
	"unsafe"

	"golang.org/x/sys/windows"

	"github.com/belov38/boat-dev-clone/services/guest-agent/internal/fsutil"
	"github.com/belov38/boat-dev-clone/services/guest-agent/internal/output"
	"github.com/belov38/boat-dev-clone/services/guest-agent/internal/paths"
	"github.com/belov38/boat-dev-clone/services/guest-agent/internal/shimproto"
	"github.com/belov38/boat-dev-clone/services/guest-agent/internal/winapi"
	"github.com/belov38/boat-dev-clone/services/guest-agent/internal/wincmd"
	"github.com/belov38/boat-dev-clone/services/guest-agent/internal/winproc"
)

// Exit codes of the Windows shim.
const (
	exitFailed = 1
	exitUsage  = 2
	// exitAlreadyStarted: another shim owns the command (mutex, shim.json
	// or job exists), the analogue of a loaded systemd unit.
	exitAlreadyStarted = 3
)

// JobName returns the name of the permanent job of command id
// (`Global\sbx-cmd-<id>`, S9 spec 12.6).
func JobName(id string) string {
	return "sbx-cmd-" + id
}

const (
	// systemAccount is the account whose commands run with the shim's own
	// token (spec 12.5).
	systemAccount = "SYSTEM"
	// pipeSize is the buffer of the stdin, stdout and stderr pipes.
	pipeSize = 64 << 10
	// ptyFlushWait bounds the wait for the ConPTY output after its close.
	ptyFlushWait = 2 * time.Second
	// ptyEOFWait bounds how long the shim waits for the ConPTY output to
	// end once the job is empty.
	ptyEOFWait = 5 * time.Second
	// consoleCloseWait bounds the wait for ClosePseudoConsole at the end.
	consoleCloseWait = 5 * time.Second
)

// Main runs `sbx-agent shim --id <id> [--layout-root <dir>]` with its log
// on os.Stderr (shim.log, opened by the supervisor). See Run.
func Main(args []string) int {
	return Run(args, os.Stderr)
}

// Run is Main with an explicit log writer. The spec comes on stdin; the
// shim answers on stdout with one line, ReadyLine once the command runs or
// its start failure is recorded in exit.json, or FailPrefix and the reason
// when it cannot record anything (S9 plan decision 3). It returns 0 once
// the command and its leftovers are done (also after a recorded start
// failure), 1 if it failed before it could record anything, 2 on bad
// arguments and 3 when another shim owns the command.
//
// --layout-root runs against paths.ForRoot (tests and dev runs).
func Run(args []string, stderr io.Writer) int {
	return run(args, os.Stdin, os.Stdout, stderr)
}

func run(args []string, stdin io.Reader, stdout io.Writer, stderr io.Writer) int {
	log := slog.New(slog.NewTextHandler(stderr, nil))
	fs := flag.NewFlagSet("shim", flag.ContinueOnError)
	fs.SetOutput(stderr)
	id := fs.String("id", "", "command id")
	root := fs.String("layout-root", "", "use the agent layout under this directory")
	if err := fs.Parse(args); err != nil {
		return exitUsage
	}
	if !validID(*id) || fs.NArg() != 0 {
		log.Error("shim: usage: sbx-agent shim --id <id> [--layout-root <dir>]")
		return exitUsage
	}
	l := paths.Default()
	if *root != "" {
		l = paths.ForRoot(*root)
	}
	// CTRL_BREAK and CTRL_C must never end the shim, also while it is
	// attached to the console of the command to deliver one.
	signal.Notify(make(chan os.Signal, 1), os.Interrupt)
	s := newShim(log.With("command_id", *id), l, *id, stdout)
	return s.run(stdin)
}

// validID reports whether id is a plain file name. A colon would name an
// alternate data stream of the commands directory.
func validID(id string) bool {
	return id != "" && id != "." && id != ".." && !strings.ContainsAny(id, "/\\:\x00")
}

// stream is one output stream: the read end of a pipe in non-blocking mode
// and its log file.
type stream struct {
	name string
	file *os.File  // log file, written at its end
	out  io.Writer // writes to file; tests replace it to inject errors
	h    windows.Handle
	// closeH closes h; nil before the start.
	closeH func()
	eof    bool
	// werr is set after the first failed log write, to log it once.
	werr bool
	// dropped counts the bytes lost to a full disk. The loop adds, the
	// server reads.
	dropped atomic.Uint64
}

// shim is the state of one Windows shim process.
type shim struct {
	log    *slog.Logger
	layout paths.Layout
	id     string
	dir    string
	spec   Spec
	stdout io.Writer
	// readyOnce guards the single line on stdout.
	readyOnce sync.Once

	job     *winproc.Job
	token   windows.Token // 0: the command runs with the shim's token
	unload  func()        // unloads the user's profile; nil without one
	script  string        // path of the written Script; "" without one
	streams []*stream
	con     *winproc.PseudoConsole
	ptyIn   windows.Handle // own duplicate of the ConPTY input; 0 without
	proc    *winproc.Process
	pid     int
	wake    windows.Handle // auto-reset event that wakes the loop
	ln      *net.UnixListener
	// popErrs counts failed job queries in a row (loop only).
	popErrs int

	// reqMu serializes the requests that touch the input state, so applying
	// an input and advancing its seq are atomic.
	reqMu sync.Mutex
	stdin windows.Handle // write end of the stdin pipe; 0 when none or closed
	seqs  seqTable
	// stdinCloseReq asks whoever holds reqMu to close stdin (set on exit).
	stdinCloseReq atomic.Bool

	// mu guards the state shared between the event loop and the server.
	mu         sync.Mutex
	exited     bool
	mainExited bool      // the loop saw the main process exit
	terminated bool      // the job was terminated before the main exit was seen
	killReason string    // reason of the first kill before the exit
	signalled  bool      // a signal request reached the command before the exit
	timeoutAt  time.Time // Spec.TimeoutMs deadline; zero once fired or unset
	hardKillAt time.Time // pending job termination of a Kill with grace
	conns      map[*conn]bool
	closing    bool
	jobClosed  bool
	// conClosing is set once ClosePseudoConsole was started; conClosedAt
	// is when, conClosed is closed when it returned.
	conClosing  bool
	conClosedAt time.Time
	conClosed   chan struct{}
}

func newShim(log *slog.Logger, l paths.Layout, id string, stdout io.Writer) *shim {
	return &shim{
		log:       log,
		layout:    l,
		id:        id,
		dir:       l.CommandDir(id),
		stdout:    stdout,
		seqs:      newSeqTable(maxSessions),
		conns:     make(map[*conn]bool),
		conClosed: make(chan struct{}),
	}
}

// ready prints line on stdout once and closes it: the supervisor waits for
// exactly one line.
func (s *shim) ready(line string) {
	s.readyOnce.Do(func() {
		if _, err := io.WriteString(s.stdout, line+"\n"); err != nil {
			s.log.Warn("shim: report readiness", "err", err)
		}
		if c, ok := s.stdout.(io.Closer); ok {
			_ = c.Close()
		}
	})
}

// fail reports a failure before anything was recorded and returns code.
func (s *shim) fail(code int, err error) int {
	s.log.Error("shim failed", "err", err)
	text := strings.ReplaceAll(err.Error(), "\n", " ")
	if code == exitAlreadyStarted {
		text = FailAlreadyStarted + ": " + text
	}
	s.ready(FailPrefix + text)
	return code
}

// run performs the whole life of the shim (S9 spec 12.6).
func (s *shim) run(stdin io.Reader) int {
	spec, err := ReadSpecFrom(stdin)
	if err != nil {
		return s.fail(exitFailed, err)
	}
	s.spec = spec
	release, err := winproc.ShimMutex(s.id)
	if errors.Is(err, winproc.ErrShimExists) {
		return s.fail(exitAlreadyStarted, err)
	}
	if err != nil {
		return s.fail(exitFailed, err)
	}
	defer release()
	// shim.json is written only by a shim that got this far: another one
	// already ran the command. A second launch must not start it again.
	if _, err := os.Lstat(filepath.Join(s.dir, ShimJSON)); err == nil {
		return s.fail(exitAlreadyStarted, fmt.Errorf("%s exists: command %s was already launched", ShimJSON, s.id))
	} else if !errors.Is(err, os.ErrNotExist) {
		return s.fail(exitFailed, err)
	}
	job, err := winproc.CreatePermanentJob(JobName(s.id))
	if errors.Is(err, winproc.ErrJobExists) {
		return s.fail(exitAlreadyStarted, err)
	}
	if err != nil {
		return s.fail(exitFailed, err)
	}
	s.job = job
	if err := os.MkdirAll(s.dir, 0o700); err != nil {
		s.dropJob()
		return s.fail(exitFailed, err)
	}
	if err := s.openStreams(); err != nil {
		s.dropJob()
		return s.fail(exitFailed, err)
	}
	defer s.closeAll()

	// From here on every failure is a START_FAILED command: the stream files
	// exist to carry the error text.
	startErr := spec.validate(s.id)
	if startErr == nil {
		s.wake, startErr = windows.CreateEvent(nil, 0, 0, nil)
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

	startedAt := time.Now()
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
		// the command still runs to exit.json; the job stays reachable.
		s.log.Error("shim: listen", "err", err)
	}
	s.ready(ReadyLine)
	s.loop()
	return 0
}

// dropJob removes the permanence of a job that never got a process.
func (s *shim) dropJob() {
	if err := s.job.MakeTemporary(); err != nil {
		s.log.Error("shim: make the job temporary", "err", err)
	}
	_ = s.job.Close()
	s.job = nil
}

// openStreams creates the log files: stdout and stderr, or pty. They are
// shared for reading, writing and deletion (the agent reads them and
// retention punches holes at the front) and sparse (spec 12.9).
func (s *shim) openStreams() error {
	names := []string{StdoutFile, StderrFile}
	if s.spec.PTY != nil {
		names = []string{PtyFile}
	}
	for _, name := range names {
		f, err := openLog(filepath.Join(s.dir, name))
		if err != nil {
			return err
		}
		if err := output.MarkSparse(f); err != nil {
			s.log.Warn("shim: output file stays dense", "stream", name, "err", err)
		}
		s.streams = append(s.streams, &stream{name: name, file: f, out: f})
	}
	return nil
}

// openLog opens or creates path for writing at its end. The file is never
// truncated or rewritten.
func openLog(path string) (*os.File, error) {
	p, err := windows.UTF16PtrFromString(path)
	if err != nil {
		return nil, err
	}
	h, err := windows.CreateFile(p, windows.GENERIC_WRITE|windows.FILE_READ_ATTRIBUTES,
		windows.FILE_SHARE_READ|windows.FILE_SHARE_WRITE|windows.FILE_SHARE_DELETE,
		nil, windows.OPEN_ALWAYS, windows.FILE_ATTRIBUTE_NORMAL, 0)
	if err != nil {
		return nil, &os.PathError{Op: "open", Path: path, Err: err}
	}
	f := os.NewFile(uintptr(h), path)
	if _, err := f.Seek(0, io.SeekEnd); err != nil {
		_ = f.Close()
		return nil, err
	}
	return f, nil
}

func (s *shim) writeShimFile(f ShimFile) error {
	return fsutil.WriteJSONAtomic(filepath.Join(s.dir, ShimJSON), f, 0o600)
}

// start logs the user on and starts the command in the job.
func (s *shim) start() error {
	if s.spec.Desktop {
		return errors.New("desktop sessions are not supported yet")
	}
	env := s.spec.Env
	if env == nil {
		env = []string{}
	}
	if s.spec.PTY != nil {
		// ConPTY speaks xterm-256color whatever the spec asks for.
		if _, ok := wincmd.Lookup(env, "TERM"); !ok {
			env = wincmd.MergeEnv(env, []string{"TERM=" + DefaultTerm})
		}
	}
	sys, err := windows.GetSystemDirectory()
	if err != nil {
		return err
	}
	app, cmdline, err := winCommandLine(s.spec.Argv, env, s.spec.Cwd, sys)
	if err != nil {
		return err
	}
	if err := s.logon(); err != nil {
		return err
	}
	if s.spec.Script != "" {
		if err := s.writeScript(); err != nil {
			return err
		}
	}
	opts := winproc.StartOptions{Argv0Path: app, CommandLine: cmdline, Env: env, Dir: s.spec.Cwd,
		Token: s.token, Job: s.job}
	if s.spec.PTY != nil {
		err = s.startPTY(opts)
	} else {
		err = s.startPipes(opts)
	}
	if err != nil {
		return err
	}
	s.pid = int(s.proc.Pid())
	return nil
}

// logon gets the token of the command: none (the shim's own) for SYSTEM,
// else the elevated token of the account with its password from LSA and
// its loaded profile (spec 12.5).
func (s *shim) logon() error {
	switch {
	case strings.EqualFold(s.spec.User, systemAccount):
		return nil
	case s.spec.User == "":
		return errors.New("shim: spec names no user")
	}
	pw, err := winapi.LsaRetrieve(winapi.SecretUserPassword)
	if err != nil {
		return fmt.Errorf("shim: password of %s: %w", s.spec.User, err)
	}
	t, err := winapi.LogonUserToken(s.spec.User, pw)
	clear(pw)
	if err != nil {
		return err
	}
	s.token = t
	unload, err := winapi.LoadProfile(t, s.spec.User)
	if err != nil {
		// The command still runs, without its HKCU.
		s.log.Warn("shim: load profile", "user", s.spec.User, "err", err)
		return nil
	}
	s.unload = unload
	return nil
}

// writeScript writes Spec.Script to the command directory, readable by the
// command's user only besides SYSTEM (ruling R7b): the directory itself is
// SYSTEM-only, bypass traverse checking lets the user open the file by its
// full path.
func (s *shim) writeScript() error {
	sddl := "D:P(A;;FA;;;SY)"
	if s.token != 0 {
		tu, err := s.token.GetTokenUser()
		if err != nil {
			return fmt.Errorf("shim: script owner: %w", err)
		}
		sddl += "(A;;FR;;;" + tu.User.Sid.String() + ")"
	}
	sd, err := windows.SecurityDescriptorFromString(sddl)
	if err != nil {
		return fmt.Errorf("shim: script ACL: %w", err)
	}
	path := filepath.Join(s.dir, wincmd.ScriptFile)
	p, err := windows.UTF16PtrFromString(path)
	if err != nil {
		return err
	}
	sa := windows.SecurityAttributes{SecurityDescriptor: sd}
	sa.Length = uint32(unsafe.Sizeof(sa))
	h, err := windows.CreateFile(p, windows.GENERIC_WRITE, 0, &sa, windows.CREATE_ALWAYS, windows.FILE_ATTRIBUTE_NORMAL, 0)
	if err != nil {
		return fmt.Errorf("shim: create %s: %w", path, err)
	}
	s.script = path
	f := os.NewFile(uintptr(h), path)
	_, werr := io.WriteString(f, s.spec.Script)
	if cerr := f.Close(); werr == nil {
		werr = cerr
	}
	if werr != nil {
		return fmt.Errorf("shim: write %s: %w", path, werr)
	}
	return nil
}

// killGrace returns the grace of the timeout kill.
func (s Spec) killGrace() time.Duration {
	if s.KillGraceMs == 0 {
		return DefaultKillGrace
	}
	return time.Duration(s.KillGraceMs) * time.Millisecond //nolint:gosec // bounded by the agent
}

// removeScript deletes the script file once the command no longer needs it.
func (s *shim) removeScript() {
	if s.script == "" {
		return
	}
	if err := os.Remove(s.script); err != nil && !errors.Is(err, os.ErrNotExist) {
		s.log.Warn("shim: remove script", "err", err)
	}
	s.script = ""
}

// newPipe creates a pipe whose end ours (the read end when readSide) is
// non-blocking, so the loop and the input never wait on it.
func newPipe(readSide bool) (r, w windows.Handle, err error) {
	if err := windows.CreatePipe(&r, &w, nil, pipeSize); err != nil {
		return 0, 0, fmt.Errorf("shim: pipe: %w", err)
	}
	ours := w
	if readSide {
		ours = r
	}
	if err := setNonblocking(ours); err != nil {
		_ = windows.CloseHandle(r)
		_ = windows.CloseHandle(w)
		return 0, 0, err
	}
	return r, w, nil
}

// setNonblocking switches the pipe handle h to PIPE_NOWAIT: ReadFile
// returns ERROR_NO_DATA instead of waiting, WriteFile writes what fits.
func setNonblocking(h windows.Handle) error {
	mode := uint32(windows.PIPE_READMODE_BYTE | windows.PIPE_NOWAIT)
	if err := windows.SetNamedPipeHandleState(h, &mode, nil, nil); err != nil {
		return fmt.Errorf("shim: non-blocking pipe: %w", err)
	}
	return nil
}

// startPipes runs the command in its own process group (for CTRL_BREAK)
// with stdout and stderr on pipes and stdin on a pipe or NUL. The process
// gets a hidden console, never the log files.
func (s *shim) startPipes(opts winproc.StartOptions) (err error) {
	var childEnds, ourEnds []windows.Handle
	defer func() {
		for _, h := range childEnds {
			_ = windows.CloseHandle(h)
		}
		if err != nil {
			for _, h := range ourEnds {
				_ = windows.CloseHandle(h)
			}
		}
	}()
	for range s.streams {
		r, w, err := newPipe(true)
		if err != nil {
			return err
		}
		ourEnds = append(ourEnds, r)
		childEnds = append(childEnds, w)
	}
	opts.Stdout, opts.Stderr = childEnds[0], childEnds[1]
	var stdinW windows.Handle
	if s.spec.Stdin {
		r, w, err := newPipe(false)
		if err != nil {
			return err
		}
		ourEnds = append(ourEnds, w)
		childEnds = append(childEnds, r)
		opts.Stdin, stdinW = r, w
	} else {
		nul, err := openNul()
		if err != nil {
			return err
		}
		childEnds = append(childEnds, nul)
		opts.Stdin = nul
	}
	opts.NewProcessGroup = true
	p, err := winproc.Start(opts)
	if err != nil {
		return err
	}
	s.proc = p
	for i, st := range s.streams {
		h := ourEnds[i]
		st.h = h
		st.closeH = func() { _ = windows.CloseHandle(h) }
	}
	s.stdin = stdinW
	return nil
}

// openNul opens NUL for reading, the stdin of a command without one.
func openNul() (windows.Handle, error) {
	p, err := windows.UTF16PtrFromString("NUL")
	if err != nil {
		return 0, err
	}
	h, err := windows.CreateFile(p, windows.GENERIC_READ, windows.FILE_SHARE_READ|windows.FILE_SHARE_WRITE,
		nil, windows.OPEN_EXISTING, windows.FILE_ATTRIBUTE_NORMAL, 0)
	if err != nil {
		return 0, fmt.Errorf("shim: open NUL: %w", err)
	}
	return h, nil
}

// startPTY runs the command on a ConPTY sized from the spec. It is not a
// new process group: CTRL_C from the 0x03 input byte must reach it.
func (s *shim) startPTY(opts winproc.StartOptions) error {
	cols, rows := s.spec.PTY.Cols, s.spec.PTY.Rows
	if cols == 0 {
		cols = 80
	}
	if rows == 0 {
		rows = 24
	}
	con, err := winproc.NewPseudoConsole(cols, rows)
	if err != nil {
		return err
	}
	drop := func() {
		_ = con.Close()
		_ = con.Out.Close()
	}
	out, okOut := con.Out.(*os.File)
	in, okIn := con.In.(*os.File)
	if !okOut || !okIn {
		drop()
		return errors.New("shim: pseudo console pipes are not files")
	}
	outH := windows.Handle(out.Fd())
	// Own duplicate of the input: PseudoConsole.Close closes In, and a late
	// input must then fail on a dead pipe, not use a reused handle value.
	self := windows.CurrentProcess()
	var inH windows.Handle
	if err := windows.DuplicateHandle(self, windows.Handle(in.Fd()), self, &inH, 0, false, windows.DUPLICATE_SAME_ACCESS); err != nil {
		drop()
		return fmt.Errorf("shim: duplicate pty input: %w", err)
	}
	fail := func(err error) error {
		drop()
		_ = windows.CloseHandle(inH)
		return err
	}
	if err := setNonblocking(outH); err != nil {
		return fail(err)
	}
	if err := setNonblocking(inH); err != nil {
		return fail(err)
	}
	opts.PseudoConsole = con.Handle()
	p, err := winproc.Start(opts)
	if err != nil {
		return fail(err)
	}
	s.proc = p
	s.con = con
	s.ptyIn = inH
	s.streams[0].h = outH
	s.streams[0].closeH = func() { _ = con.Out.Close() }
	return nil
}

// startFailed records a start failure: the error text goes to the command's
// stderr (or pty) stream and exit.json gets code 127, reason START_FAILED.
func (s *shim) startFailed(cause error) int {
	s.log.Warn("shim: start failed", "err", cause)
	s.removeScript()
	st := s.streams[len(s.streams)-1] // stderr, or the only pty stream
	s.writeLog(st, fmt.Appendf(nil, "sbx-agent: cannot start command: %v\n", cause))
	e := ExitFile{
		Status:      shimproto.StatusExited,
		Code:        127,
		Reason:      shimproto.ReasonStartFailed,
		EndedAt:     time.Now().UTC(),
		StartFailed: cause.Error(),
	}
	s.setEnds(&e)
	if err := fsutil.WriteJSONAtomic(filepath.Join(s.dir, ExitJSON), e, 0o600); err != nil {
		return s.fail(exitFailed, fmt.Errorf("shim: write exit.json: %w", err))
	}
	s.ready(ReadyLine)
	return 0
}

// setEnds fills the stream ends of e from the log file sizes, and the
// output lost to a full disk.
func (s *shim) setEnds(e *ExitFile) {
	e.OutputTruncated, e.DroppedBytes = s.truncation()
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

// writeLog appends p to the log of st. A failed write never blocks the
// stream: the loop keeps reading the pipe and drops what the file does not
// take. Bytes dropped on a full disk are counted for OutputTruncated.
func (s *shim) writeLog(st *stream, p []byte) {
	n, err := st.out.Write(p)
	if err == nil {
		return
	}
	if errors.Is(err, windows.ERROR_DISK_FULL) || errors.Is(err, windows.ERROR_HANDLE_DISK_FULL) {
		st.dropped.Add(uint64(len(p) - max(n, 0))) //nolint:gosec // n <= len(p)
	}
	if !st.werr {
		st.werr = true
		s.log.Error("shim: write log, output lost", "stream", st.name, "err", err)
	}
}

// truncation reports the output lost to a full disk: TruncatedDiskFull and
// the dropped bytes per stream, or nothing.
func (s *shim) truncation() (string, map[string]uint64) {
	var dropped map[string]uint64
	for _, st := range s.streams {
		if n := st.dropped.Load(); n > 0 {
			if dropped == nil {
				dropped = make(map[string]uint64, len(s.streams))
			}
			dropped[st.name] = n
		}
	}
	if dropped == nil {
		return "", nil
	}
	return shimproto.TruncatedDiskFull, dropped
}

// unlockReq releases reqMu, first closing stdin if the exit asked for it.
// Unlock comes before the check, so either this holder or the exit path
// (TryLock after setting the request) closes it.
func (s *shim) unlockReq() {
	s.reqMu.Unlock()
	if s.stdinCloseReq.Load() && s.reqMu.TryLock() {
		if s.stdin != 0 {
			_ = windows.CloseHandle(s.stdin)
			s.stdin = 0
		}
		s.reqMu.Unlock()
	}
}

// closeAll releases everything at the end of the shim: the job (made
// temporary when empty), the pipes and the pseudo console, the process,
// the token and the profile.
func (s *shim) closeAll() {
	s.removeScript()
	// An input uses stdin and the pty input under reqMu, a late kill or
	// signal the job, the pty input and the console under mu; jobClosed
	// turns the latter into no-ops.
	s.reqMu.Lock()
	s.mu.Lock()
	s.jobClosed = true
	for _, h := range []*windows.Handle{&s.stdin, &s.ptyIn} {
		if *h != 0 {
			_ = windows.CloseHandle(*h)
			*h = 0
		}
	}
	if s.con != nil && !s.conClosing {
		s.closeConsoleLocked()
	}
	closing := s.conClosing
	if s.job != nil {
		if n, err := s.job.ActiveProcesses(); err == nil && n == 0 {
			if err := s.job.MakeTemporary(); err != nil {
				s.log.Error("shim: make the job temporary", "err", err)
			}
		} else {
			s.log.Warn("shim: leaving the permanent job behind", "processes", n, "err", err)
		}
		_ = s.job.Close()
		s.job = nil
	}
	s.mu.Unlock()
	s.reqMu.Unlock()

	for _, st := range s.streams {
		if st.closeH != nil {
			st.closeH()
			st.closeH = nil
		}
		_ = st.file.Close()
	}
	if closing {
		// The output pipe is closed: a console host still flushing gives up.
		select {
		case <-s.conClosed:
		case <-time.After(consoleCloseWait):
			s.log.Warn("shim: ClosePseudoConsole does not return")
		}
	}
	if s.proc != nil {
		_ = s.proc.Close()
	}
	s.mu.Lock()
	if s.wake != 0 {
		_ = windows.CloseHandle(s.wake)
		s.wake = 0
	}
	s.mu.Unlock()
	if s.unload != nil {
		s.unload()
	}
	if s.token != 0 {
		_ = s.token.Close()
	}
}
