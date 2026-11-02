//go:build !windows

package main

import (
	"context"
	"encoding/json"
	"fmt"
	"io"
	"log/slog"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"sync"
	"syscall"
	"time"

	"github.com/creack/pty"
	"golang.org/x/sys/unix"

	"github.com/belov38/umiak/services/guest-agent/internal/paths"
	"github.com/belov38/umiak/services/guest-agent/internal/shim"
	"github.com/belov38/umiak/services/guest-agent/internal/shimproto"
	"github.com/belov38/umiak/services/guest-agent/internal/supervisor"
)

// execSupervisor is supervisor.Fake whose shims run their command as a
// host process, standing in for the real shim (Linux only, systemd units
// and cgroups). The fake shim keeps the shim protocol, the stream files and
// exit.json; this runner feeds it:
//   - output of the process goes to the stream files (a PTY from
//     creack/pty for PTY commands);
//   - input, resizes, signals and kills the fake shim applied are forwarded
//     to the process (group); once the fake shim ends, the group is killed;
//   - the exit of the process is recorded (code, or the terminating
//     signal), timeout_ms is enforced like the shim (SIGTERM, then SIGKILL
//     after the grace) with reason TIMEOUT;
//   - a program that cannot start (missing binary or cwd) is START_FAILED
//     with 127 and the message on the last stream.
//
// Limits: every command runs as the harness's OS user (no uid switch, no
// cgroup: leftovers are only killed through the process group), and the
// home of that user is mapped to the scratch directory for cwd and HOME,
// so a login shell never reads the developer's profile. A terminating
// signal or a kill ends the command in the fake shim at once, even if the
// process would have ignored it.
type execSupervisor struct {
	*supervisor.Fake
	layout  paths.Layout
	home    string
	scratch string
	log     *slog.Logger
	wg      sync.WaitGroup
}

func newExecSupervisor(l paths.Layout, home, scratch string, log *slog.Logger) *execSupervisor {
	return &execSupervisor{Fake: supervisor.NewFake(l), layout: l, home: home, scratch: scratch, log: log}
}

// Launch registers the runner of id, then launches the fake shim.
func (s *execSupervisor) Launch(ctx context.Context, id, shimPath string, extraArgs []string) error {
	spec, err := s.readSpec(id)
	if err == nil {
		spec = s.mapHome(spec)
		if msg := startProblem(spec); msg != "" {
			s.Setup(id, func(r *supervisor.FakeRun) { r.FailStart(msg) })
		} else {
			s.Script(id, func(r *supervisor.FakeRun) {
				s.wg.Add(1)
				defer s.wg.Done()
				s.run(r, spec)
			})
		}
	}
	err = s.Fake.Launch(ctx, id, shimPath, extraArgs)
	if err != nil {
		s.log.Warn("launch failed", "id", id, "err", err)
	}
	return err
}

// Close ends every fake shim (their processes are killed) and waits for
// the runners.
func (s *execSupervisor) Close() error {
	err := s.Fake.Close()
	done := make(chan struct{})
	go func() {
		s.wg.Wait()
		close(done)
	}()
	wait(done)
	return err
}

// readSpec reads the spec the agent wrote for the shim (the fake shim
// removes the file when it starts).
func (s *execSupervisor) readSpec(id string) (shim.Spec, error) {
	var spec shim.Spec
	data, err := os.ReadFile(s.layout.CmdSpec(id))
	if err != nil {
		return spec, err
	}
	err = json.Unmarshal(data, &spec)
	return spec, err
}

// mapHome maps the user's home to the scratch directory in cwd and HOME.
func (s *execSupervisor) mapHome(spec shim.Spec) shim.Spec {
	mapPath := func(p string) string {
		if p == s.home {
			return s.scratch
		}
		if rest, ok := strings.CutPrefix(p, s.home+"/"); ok {
			return filepath.Join(s.scratch, rest)
		}
		return p
	}
	spec.Cwd = mapPath(spec.Cwd)
	env := make([]string, len(spec.Env))
	for i, kv := range spec.Env {
		if v, ok := strings.CutPrefix(kv, "HOME="); ok {
			kv = "HOME=" + mapPath(v)
		}
		env[i] = kv
	}
	spec.Env = env
	return spec
}

// startProblem returns why the shim could not start spec ("" if it can).
func startProblem(spec shim.Spec) string {
	if st, err := os.Stat(spec.Cwd); err != nil || !st.IsDir() {
		return fmt.Sprintf("chdir %s: no such directory", spec.Cwd)
	}
	if _, err := lookPath(spec); err != nil {
		return err.Error()
	}
	return ""
}

// lookPath resolves argv[0] with the PATH of the spec's environment.
func lookPath(spec shim.Spec) (string, error) {
	prog := spec.Argv[0]
	isExec := func(p string) bool {
		st, err := os.Stat(p)
		return err == nil && !st.IsDir() && st.Mode()&0o111 != 0
	}
	if strings.Contains(prog, "/") {
		if !filepath.IsAbs(prog) {
			prog = filepath.Join(spec.Cwd, prog)
		}
		if isExec(prog) {
			return prog, nil
		}
		return "", fmt.Errorf("exec %s: no such file or directory", spec.Argv[0])
	}
	path := ""
	for _, kv := range spec.Env {
		if v, ok := strings.CutPrefix(kv, "PATH="); ok {
			path = v
		}
	}
	for dir := range strings.SplitSeq(path, ":") {
		if dir == "" {
			continue
		}
		if p := filepath.Join(dir, prog); isExec(p) {
			return p, nil
		}
	}
	return "", fmt.Errorf("exec %s: executable file not found in PATH", prog)
}

// streamWriter appends to one stream file of the fake shim until the
// command has exited there (later output is past the recorded end).
type streamWriter struct {
	r      *supervisor.FakeRun
	stream string
}

func (w streamWriter) Write(p []byte) (int, error) {
	if !w.r.Exited() {
		if err := w.r.Write(w.stream, p); err != nil {
			return 0, err
		}
	}
	return len(p), nil
}

// proc is one running command.
type proc struct {
	r     *supervisor.FakeRun
	spec  shim.Spec
	cmd   *exec.Cmd
	stdin io.WriteCloser // stdin pipe; nil without stdin
	ptmx  *os.File       // PTY master; nil without a PTY

	mu       sync.Mutex
	timedOut bool
	// graceKill is the SIGKILL after the grace of a timeout; stopped once
	// the process is reaped.
	graceKill *time.Timer
	// reaped is set once Wait returned: no timeout signal after it.
	reaped bool
}

// run starts the process, forwards the fake shim's requests to it and
// records its exit.
func (s *execSupervisor) run(r *supervisor.FakeRun, spec shim.Spec) {
	p := &proc{r: r, spec: spec}
	if err := p.start(); err != nil {
		s.log.Warn("start failed", "id", r.ID(), "err", err)
		p.startFailed(s.layout, err)
		return
	}
	var copied chan struct{}
	if p.ptmx != nil {
		copied = make(chan struct{})
		go func() {
			defer close(copied)
			_, _ = io.Copy(streamWriter{r, shim.PtyFile}, p.ptmx)
		}()
	}
	exited := make(chan struct{})
	go p.forward(exited)
	var timer *time.Timer
	if spec.TimeoutMs > 0 {
		timer = time.AfterFunc(time.Duration(spec.TimeoutMs)*time.Millisecond, p.timeout) //nolint:gosec // bounded by the agent
	}

	err := p.cmd.Wait()
	p.mu.Lock()
	p.reaped = true
	if p.graceKill != nil {
		p.graceKill.Stop()
	}
	p.mu.Unlock()
	if timer != nil {
		timer.Stop()
	}
	s.log.Debug("exited", "id", r.ID(), "state", p.cmd.ProcessState)
	if copied != nil {
		// The PTY ends (EIO) once nothing holds its slave side.
		select {
		case <-copied:
		case <-time.After(2 * time.Second):
		}
		_ = p.ptmx.Close()
	}
	close(exited)
	p.recordExit(s.layout, err)
}

func (p *proc) start() error {
	path, err := lookPath(p.spec)
	if err != nil {
		return err
	}
	cmd := &exec.Cmd{Path: path, Args: p.spec.Argv, Env: p.spec.Env, Dir: p.spec.Cwd}
	p.cmd = cmd
	if pt := p.spec.PTY; pt != nil {
		if !hasEnv(cmd.Env, "TERM") {
			cmd.Env = append(cmd.Env, "TERM="+pt.Term)
		}
		p.ptmx, err = pty.StartWithSize(cmd, &pty.Winsize{Cols: pt.Cols, Rows: pt.Rows})
		return err
	}
	cmd.SysProcAttr = &syscall.SysProcAttr{Setpgid: true}
	cmd.Stdout = streamWriter{p.r, shim.StdoutFile}
	cmd.Stderr = streamWriter{p.r, shim.StderrFile}
	// Bounds the copy of output held open by leftovers after the exit.
	cmd.WaitDelay = time.Second
	if p.spec.Stdin {
		if p.stdin, err = cmd.StdinPipe(); err != nil {
			return err
		}
	}
	return cmd.Start()
}

func hasEnv(env []string, name string) bool {
	for _, kv := range env {
		if strings.HasPrefix(kv, name+"=") {
			return true
		}
	}
	return false
}

// forward applies new inputs, resizes, signals and kills of the fake shim
// to the process until it exits; once the fake shim ends it kills the
// process group.
func (p *proc) forward(exited <-chan struct{}) {
	var inputs, resizes, signals, kills int
	// Input goes through its own goroutine: a process that does not read
	// its stdin must not hold up signals and kills.
	in := make(chan supervisor.FakeInput, 1024)
	defer close(in)
	go p.writeInput(in)
	t := time.NewTicker(2 * time.Millisecond)
	defer t.Stop()
	for {
	queue:
		for _, x := range p.r.Inputs()[inputs:] {
			select {
			case in <- x:
				inputs++
			default:
				// Full: the rest, in order, on a later tick.
				break queue
			}
		}
		for _, rs := range p.r.Resizes()[resizes:] {
			resizes++
			if p.ptmx != nil {
				_ = pty.Setsize(p.ptmx, &pty.Winsize{Cols: rs.Cols, Rows: rs.Rows})
			}
		}
		for _, sg := range p.r.Signals()[signals:] {
			signals++
			if sg.Cgroup {
				p.kill(unix.SIGKILL)
			} else {
				p.kill(hostSignal(sg.Sig))
			}
		}
		for _, k := range p.r.Kills()[kills:] {
			kills++
			first := k.FirstSignal
			if first == 0 {
				first = linuxSIGTERM
			}
			p.kill(hostSignal(first))
		}
		select {
		case <-exited:
			return
		case <-p.r.Done():
			p.kill(unix.SIGKILL)
			return
		case <-t.C:
		}
	}
}

// writeInput writes inputs in order to the stdin pipe or the PTY. A write
// blocked by a process that does not read ends when Wait closes the pipe
// (or the PTY is closed).
func (p *proc) writeInput(in <-chan supervisor.FakeInput) {
	var w io.Writer
	switch {
	case p.ptmx != nil:
		w = p.ptmx
	case p.stdin != nil:
		w = p.stdin
	}
	for x := range in {
		if w != nil && len(x.Data) > 0 {
			_, _ = w.Write(x.Data)
		}
		if x.CloseStdin && p.stdin != nil {
			_ = p.stdin.Close()
		}
	}
}

// kill signals the process group of the command.
func (p *proc) kill(sig syscall.Signal) {
	if sig == 0 || p.cmd.Process == nil {
		return
	}
	_ = syscall.Kill(-p.cmd.Process.Pid, sig)
}

// timeout is the shim's timeout_ms: SIGTERM, then SIGKILL after the grace.
// Both happen under p.mu with the reaped check, so neither is sent, nor the
// SIGKILL armed, once Wait returned.
func (p *proc) timeout() {
	grace := shim.DefaultKillGrace
	if p.spec.KillGraceMs > 0 {
		grace = time.Duration(p.spec.KillGraceMs) * time.Millisecond //nolint:gosec // bounded by the agent
	}
	p.mu.Lock()
	defer p.mu.Unlock()
	if p.reaped {
		return
	}
	p.timedOut = true
	p.kill(unix.SIGTERM)
	p.graceKill = time.AfterFunc(grace, func() {
		p.mu.Lock()
		defer p.mu.Unlock()
		if !p.reaped {
			p.kill(unix.SIGKILL)
		}
	})
}

// recordExit writes the exit of the process to the fake shim. An exit the
// fake shim recorded already (a signal or kill it applied) stays.
func (p *proc) recordExit(l paths.Layout, waitErr error) {
	ps := p.cmd.ProcessState
	if ps == nil {
		p.startFailed(l, waitErr)
		return
	}
	ws, _ := ps.Sys().(syscall.WaitStatus)
	p.mu.Lock()
	timedOut := p.timedOut
	p.mu.Unlock()
	switch {
	case timedOut:
		e := ends(l, p.r.ID(), p.spec.PTY != nil)
		e.Reason = shimproto.ReasonTimeout
		e.Status, e.Code = shimproto.StatusExited, int32(ws.ExitStatus()) //nolint:gosec // an exit status
		if ws.Signaled() {
			n := linuxSignal(ws.Signal())
			e.Status, e.Code, e.Signal = shimproto.StatusKilled, 128+int32(n), linuxSignalNames[n] //nolint:gosec // 1..31
		}
		_ = p.r.ExitWith(e)
	case ws.Signaled():
		_ = p.r.Signal(syscall.Signal(linuxSignal(ws.Signal())))
	default:
		_ = p.r.Exit(int32(ws.ExitStatus())) //nolint:gosec // an exit status
	}
}

// startFailed records a start error like the shim: the message on the last
// stream, 127, START_FAILED.
func (p *proc) startFailed(l paths.Layout, err error) {
	if p.r.Exited() {
		return
	}
	stream := shim.StderrFile
	if p.spec.PTY != nil {
		stream = shim.PtyFile
	}
	_ = p.r.Write(stream, []byte("umiak-agent: cannot start command: "+err.Error()+"\n"))
	e := ends(l, p.r.ID(), p.spec.PTY != nil)
	e.Code, e.Reason, e.StartFailed = 127, shimproto.ReasonStartFailed, err.Error()
	_ = p.r.ExitWith(e)
}

// ends returns an ExitFile with the stream ends from the file sizes.
func ends(l paths.Layout, id string, isPTY bool) shimproto.ExitFile {
	size := func(name string) int64 {
		st, err := os.Stat(filepath.Join(l.CommandDir(id), name))
		if err != nil {
			return 0
		}
		return st.Size()
	}
	e := shimproto.ExitFile{EndedAt: time.Now().UTC()}
	if isPTY {
		e.PtyEnd = size(shim.PtyFile)
	} else {
		e.StdoutEnd, e.StderrEnd = size(shim.StdoutFile), size(shim.StderrFile)
	}
	return e
}

// Signals: the fake shim speaks Linux numbers, the host may differ (darwin).

const linuxSIGTERM syscall.Signal = 15

// linuxSignalNames are the names of the Linux signals 1..31.
var linuxSignalNames = [...]string{
	1: "SIGHUP", 2: "SIGINT", 3: "SIGQUIT", 4: "SIGILL", 5: "SIGTRAP", 6: "SIGABRT",
	7: "SIGBUS", 8: "SIGFPE", 9: "SIGKILL", 10: "SIGUSR1", 11: "SIGSEGV", 12: "SIGUSR2",
	13: "SIGPIPE", 14: "SIGALRM", 15: "SIGTERM", 16: "SIGSTKFLT", 17: "SIGCHLD",
	18: "SIGCONT", 19: "SIGSTOP", 20: "SIGTSTP", 21: "SIGTTIN", 22: "SIGTTOU",
	23: "SIGURG", 24: "SIGXCPU", 25: "SIGXFSZ", 26: "SIGVTALRM", 27: "SIGPROF",
	28: "SIGWINCH", 29: "SIGIO", 30: "SIGPWR", 31: "SIGSYS",
}

// hostSignal maps a Linux signal number to the host's; 0 when the host has
// no such signal.
func hostSignal(linux syscall.Signal) syscall.Signal {
	if linux <= 0 || int(linux) >= len(linuxSignalNames) {
		return 0
	}
	return unix.SignalNum(linuxSignalNames[linux])
}

// linuxSignal maps a host signal to its Linux number (SIGKILL if unknown).
func linuxSignal(host syscall.Signal) int {
	name := unix.SignalName(host)
	for n, s := range linuxSignalNames {
		if s != "" && s == name {
			return n
		}
	}
	return 9
}
