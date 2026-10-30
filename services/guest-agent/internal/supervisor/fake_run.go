package supervisor

import (
	"errors"
	"fmt"
	"maps"
	"net"
	"os"
	"path/filepath"
	"slices"
	"sync"
	"syscall"
	"time"

	"github.com/belov38/boat-dev-clone/services/guest-agent/internal/fsutil"
	"github.com/belov38/boat-dev-clone/services/guest-agent/internal/shim"
	"github.com/belov38/boat-dev-clone/services/guest-agent/internal/shimproto"
)

// Linux signal numbers the fake shim interprets. The fake emulates a Linux
// shim on every OS, so it does not use the host's syscall constants.
const (
	sigKILL  syscall.Signal = 9
	sigTERM  syscall.Signal = 15
	sigCHLD  syscall.Signal = 17
	sigCONT  syscall.Signal = 18
	sigSTOP  syscall.Signal = 19
	sigTSTP  syscall.Signal = 20
	sigTTIN  syscall.Signal = 21
	sigTTOU  syscall.Signal = 22
	sigURG   syscall.Signal = 23
	sigWINCH syscall.Signal = 28
)

// linuxSignalNames are the names of the Linux signals 1..31.
var linuxSignalNames = [...]string{
	1: "SIGHUP", 2: "SIGINT", 3: "SIGQUIT", 4: "SIGILL", 5: "SIGTRAP", 6: "SIGABRT",
	7: "SIGBUS", 8: "SIGFPE", 9: "SIGKILL", 10: "SIGUSR1", 11: "SIGSEGV", 12: "SIGUSR2",
	13: "SIGPIPE", 14: "SIGALRM", 15: "SIGTERM", 16: "SIGSTKFLT", 17: "SIGCHLD",
	18: "SIGCONT", 19: "SIGSTOP", 20: "SIGTSTP", 21: "SIGTTIN", 22: "SIGTTOU",
	23: "SIGURG", 24: "SIGXCPU", 25: "SIGXFSZ", 26: "SIGVTALRM", 27: "SIGPROF",
	28: "SIGWINCH", 29: "SIGIO", 30: "SIGPWR", 31: "SIGSYS",
}

// signalName returns the Linux name of sig, such as "SIGKILL".
func signalName(sig syscall.Signal) string {
	if sig > 0 && int(sig) < len(linuxSignalNames) {
		return linuxSignalNames[sig]
	}
	return fmt.Sprintf("SIG%d", int(sig))
}

// terminates reports whether the default action of sig ends a process.
func terminates(sig syscall.Signal) bool {
	switch sig {
	case sigCHLD, sigCONT, sigURG, sigWINCH, sigSTOP, sigTSTP, sigTTIN, sigTTOU:
		return false
	}
	return true
}

// errShimGone is returned by FakeRun methods once the fake shim has ended.
var errShimGone = errors.New("supervisor: fake shim has ended")

// errAlreadyExited is returned when the main process has already exited.
var errAlreadyExited = errors.New("supervisor: fake command already exited")

// fakeHelloTimeout bounds the hello exchange of a fake shim connection.
const fakeHelloTimeout = 10 * time.Second

// FakeRun is one simulated shim and its command. The test drives the
// command with Write, Exit, ExitWith, Signal and Die and observes the
// requests the shim got with Inputs, Resizes, Kills and Signals.
type FakeRun struct {
	f       *Fake
	id      string
	pid     int
	dir     string
	sock    string
	started time.Time
	wg      sync.WaitGroup

	mu         sync.Mutex
	spec       shim.Spec
	minV, maxV int
	ignoreSigs bool
	failStart  string
	leftovers  bool
	dropped    map[string]uint64 // output lost to a full disk, per stream
	stdinOpen  bool
	seqs       map[string]uint64
	inputs     []FakeInput
	resizes    []FakeResize
	kills      []FakeKill
	signals    []FakeSignal
	killReason string
	signalled  bool
	graceTimer *time.Timer // pending hard kill of a Kill with grace
	graceAt    time.Time   // when graceTimer fires
	exited     bool
	gone       bool
	ln         *net.UnixListener
	conns      map[*fakeConn]bool // value: hello done, receives pushes
	done       chan struct{}
}

// ID returns the command id.
func (r *FakeRun) ID() string { return r.id }

// Pid returns the fake pid of the main process.
func (r *FakeRun) Pid() int { return r.pid }

// Spec returns the spec the shim read.
func (r *FakeRun) Spec() shim.Spec {
	r.mu.Lock()
	defer r.mu.Unlock()
	return r.spec
}

// Done is closed when the fake shim has ended (its unit is gone).
func (r *FakeRun) Done() <-chan struct{} { return r.done }

// IgnoreSignals makes the command survive every signal but SIGKILL, so a
// Kill ends it only after the grace.
func (r *FakeRun) IgnoreSignals() {
	r.mu.Lock()
	defer r.mu.Unlock()
	r.ignoreSigs = true
}

// SetLeftovers marks background processes as alive: after the exit of the
// main process the shim keeps running and serving until they are killed.
func (r *FakeRun) SetLeftovers(on bool) {
	r.mu.Lock()
	defer r.mu.Unlock()
	r.leftovers = on
}

// SetDropped records n bytes of stream as dropped on a full disk: the
// status reply and the exit.json of Exit report them with reason
// disk_full, like the real shim after a failed log write.
func (r *FakeRun) SetDropped(stream string, n uint64) {
	r.mu.Lock()
	defer r.mu.Unlock()
	if r.dropped == nil {
		r.dropped = map[string]uint64{}
	}
	r.dropped[stream] = n
}

// truncationLocked returns the OutputTruncated and DroppedBytes of the
// shim. r.mu is held.
func (r *FakeRun) truncationLocked() (string, map[string]uint64) {
	if len(r.dropped) == 0 {
		return "", nil
	}
	return shimproto.TruncatedDiskFull, maps.Clone(r.dropped)
}

// SetShimVersions sets the protocol range the fake shim accepts in hello.
// Call it from Setup.
func (r *FakeRun) SetShimVersions(minV, maxV int) {
	r.mu.Lock()
	defer r.mu.Unlock()
	r.minV, r.maxV = minV, maxV
}

// FailStart makes the start of the command fail with msg like a missing
// binary: the shim writes the error to the command's stderr (or pty),
// exit.json with code 127 and reason START_FAILED, sends READY=1 and ends.
// Call it from Setup.
func (r *FakeRun) FailStart(msg string) {
	r.mu.Lock()
	defer r.mu.Unlock()
	r.failStart = msg
}

// Inputs returns the applied input requests.
func (r *FakeRun) Inputs() []FakeInput {
	r.mu.Lock()
	defer r.mu.Unlock()
	return slices.Clone(r.inputs)
}

// Resizes returns the applied resize requests.
func (r *FakeRun) Resizes() []FakeResize {
	r.mu.Lock()
	defer r.mu.Unlock()
	return slices.Clone(r.resizes)
}

// Kills returns the valid kill requests.
func (r *FakeRun) Kills() []FakeKill {
	r.mu.Lock()
	defer r.mu.Unlock()
	return slices.Clone(r.kills)
}

// Signals returns the valid signal requests.
func (r *FakeRun) Signals() []FakeSignal {
	r.mu.Lock()
	defer r.mu.Unlock()
	return slices.Clone(r.signals)
}

// StdinOpen reports whether the stdin pipe of the command is open.
func (r *FakeRun) StdinOpen() bool {
	r.mu.Lock()
	defer r.mu.Unlock()
	return r.stdinOpen
}

// Exited reports whether the main process has exited.
func (r *FakeRun) Exited() bool {
	r.mu.Lock()
	defer r.mu.Unlock()
	return r.exited
}

// streams returns the stream file names of the command.
func (r *FakeRun) streams() []string {
	if r.spec.PTY != nil {
		return []string{shim.PtyFile}
	}
	return []string{shim.StdoutFile, shim.StderrFile}
}

// Write appends data to a stream file of the command (shim.StdoutFile,
// shim.StderrFile or shim.PtyFile). It works also after the exit, to
// simulate output that reaches the file late.
func (r *FakeRun) Write(stream string, data []byte) error {
	r.mu.Lock()
	ok := slices.Contains(r.streams(), stream)
	r.mu.Unlock()
	if !ok {
		return fmt.Errorf("supervisor: command %s has no %s stream", r.id, stream)
	}
	fh, err := os.OpenFile(filepath.Join(r.dir, stream), os.O_WRONLY|os.O_APPEND, 0)
	if err != nil {
		return err
	}
	_, err = fh.Write(data)
	return errors.Join(err, fh.Close())
}

// Exit ends the main process with code. exit.json gets the stream ends from
// the current file sizes, and connected agents get the exited push. Without
// leftovers the shim ends afterwards.
func (r *FakeRun) Exit(code int32) error {
	r.mu.Lock()
	reason := r.killReason
	truncated, dropped := r.truncationLocked()
	r.mu.Unlock()
	if reason == "" {
		reason = shimproto.ReasonNone
	}
	return r.finish(shimproto.ExitFile{Status: shimproto.StatusExited, Code: code, Reason: reason,
		OutputTruncated: truncated, DroppedBytes: dropped}, true)
}

// ExitWith ends the main process recording e as is (EndedAt defaults to
// now, Status to exited): tests use it for OOM or ends ahead of the files.
func (r *FakeRun) ExitWith(e shimproto.ExitFile) error {
	if e.Status == "" {
		e.Status = shimproto.StatusExited
	}
	return r.finish(e, false)
}

// Signal delivers sig to the main process as if sent from outside the
// shim. A terminating signal ends it (SIGKILL always, others unless
// IgnoreSignals); the others are recorded only.
func (r *FakeRun) Signal(sig syscall.Signal) error {
	r.mu.Lock()
	if r.exited {
		r.mu.Unlock()
		return errAlreadyExited
	}
	dies := r.diesLocked(sig)
	r.mu.Unlock()
	if !dies {
		return nil
	}
	return r.finish(r.killedExit(sig), true)
}

// Die simulates the death of the shim and the command (OOM, a bug or a
// stop of the unit): connections close, the socket file stays behind
// unconnectable, the unit is gone and no exit.json is written.
func (r *FakeRun) Die() {
	r.end(true)
}

// diesLocked reports whether sig ends the target process. r.mu is held.
func (r *FakeRun) diesLocked(sig syscall.Signal) bool {
	if sig == sigKILL {
		return true
	}
	return terminates(sig) && !r.ignoreSigs
}

// killedExit returns the exit record of a death by sig.
func (r *FakeRun) killedExit(sig syscall.Signal) shimproto.ExitFile {
	r.mu.Lock()
	defer r.mu.Unlock()
	reason := shimproto.ReasonNone
	switch {
	case r.killReason != "":
		reason = r.killReason
	case r.signalled:
		reason = shimproto.ReasonSignal
	}
	return shimproto.ExitFile{Status: shimproto.StatusKilled, Code: 128 + int32(sig), Signal: signalName(sig), Reason: reason} //nolint:gosec // sig is 1..64
}

// start reads the spec, creates the files and the socket; it returns an
// error when the shim would fail before READY=1.
func (r *FakeRun) start(setup func(*FakeRun)) error {
	spec, err := shim.ReadSpec(r.f.layout.CmdSpec(r.id))
	if err != nil {
		return err
	}
	if spec.ID != r.id {
		return fmt.Errorf("spec id %q does not match %q", spec.ID, r.id)
	}
	r.mu.Lock()
	r.spec = spec
	r.stdinOpen = spec.Stdin && spec.PTY == nil
	r.mu.Unlock()
	if err := os.MkdirAll(r.dir, 0o700); err != nil {
		return err
	}
	for _, name := range r.streams() {
		fh, err := os.OpenFile(filepath.Join(r.dir, name), os.O_WRONLY|os.O_APPEND|os.O_CREATE, 0o600)
		if err != nil {
			return err
		}
		_ = fh.Close()
	}
	if setup != nil {
		setup(r)
	}
	if err := r.writeShimFile(shim.ShimFile{State: shim.StateLaunching, AgentVersion: spec.AgentVersion, ShimProto: shimproto.Version}); err != nil {
		return err
	}

	r.mu.Lock()
	failMsg := r.failStart
	r.mu.Unlock()
	if failMsg != "" {
		streams := r.streams()
		if err := r.Write(streams[len(streams)-1], []byte("sbx-agent: cannot start command: "+failMsg+"\n")); err != nil {
			return err
		}
		// READY=1 follows exit.json; the shim then ends.
		return r.finish(shimproto.ExitFile{Status: shimproto.StatusExited, Code: 127,
			Reason: shimproto.ReasonStartFailed, StartFailed: failMsg}, true)
	}

	if err := r.writeShimFile(shim.ShimFile{State: shim.StateRunning, AgentVersion: spec.AgentVersion,
		ShimProto: shimproto.Version, Pid: r.pid, StartedAt: r.started}); err != nil {
		return err
	}
	return r.listen()
}

func (r *FakeRun) writeShimFile(sf shim.ShimFile) error {
	return fsutil.WriteJSONAtomic(filepath.Join(r.dir, shim.ShimJSON), sf, 0o600)
}

// listen opens the shim socket and starts accepting agent connections.
func (r *FakeRun) listen() error {
	dir := filepath.Dir(r.sock)
	if err := os.MkdirAll(dir, 0o700); err != nil {
		return err
	}
	if err := os.Remove(r.sock); err != nil && !errors.Is(err, os.ErrNotExist) {
		return err
	}
	ln, err := net.ListenUnix("unix", &net.UnixAddr{Name: r.sock, Net: "unix"})
	if err != nil {
		return err
	}
	r.mu.Lock()
	if r.gone {
		r.mu.Unlock()
		_ = ln.Close()
		return errShimGone
	}
	r.ln = ln
	r.wg.Add(1)
	r.mu.Unlock()
	go r.accept(ln)
	return nil
}

func (r *FakeRun) accept(ln *net.UnixListener) {
	defer r.wg.Done()
	for {
		c, err := ln.Accept()
		if err != nil {
			return
		}
		fc := &fakeConn{c: c}
		r.mu.Lock()
		if r.gone {
			r.mu.Unlock()
			_ = c.Close()
			return
		}
		r.conns[fc] = false
		r.wg.Add(1)
		r.mu.Unlock()
		go r.serve(fc)
	}
}

// fakeConn is one agent connection of a fake shim.
type fakeConn struct {
	c   net.Conn
	wmu sync.Mutex
}

func (c *fakeConn) send(m shimproto.Message) error {
	c.wmu.Lock()
	defer c.wmu.Unlock()
	_ = c.c.SetWriteDeadline(time.Now().Add(5 * time.Second))
	return shimproto.Write(c.c, m)
}

// serve answers requests one at a time. A request whose effect ends the
// command runs that effect after its reply is sent, so the reply is never
// lost to the shutdown it causes.
func (r *FakeRun) serve(fc *fakeConn) {
	defer r.wg.Done()
	defer func() {
		r.mu.Lock()
		delete(r.conns, fc)
		r.mu.Unlock()
		_ = fc.c.Close()
	}()
	r.mu.Lock()
	minV, maxV := r.minV, r.maxV
	r.mu.Unlock()
	_ = fc.c.SetDeadline(time.Now().Add(fakeHelloTimeout))
	if _, err := shimproto.Accept(fc.c, minV, maxV); err != nil {
		return
	}
	_ = fc.c.SetDeadline(time.Time{})
	r.mu.Lock()
	if _, ok := r.conns[fc]; ok {
		r.conns[fc] = true
	}
	r.mu.Unlock()
	for {
		m, err := shimproto.Read(fc.c)
		if err != nil {
			return
		}
		reply, after := r.handle(m)
		reply.ID = m.ID
		if err := fc.send(reply); err != nil {
			return
		}
		if after != nil {
			after()
		}
	}
}

func errReply(code, format string, args ...any) shimproto.Message {
	return shimproto.Message{Type: shimproto.TypeError, Code: code, Text: fmt.Sprintf(format, args...)}
}

var okReply = shimproto.Message{Type: shimproto.TypeOK}

// handle answers one request like the real shim (internal/shim
// server_linux.go) and returns an action to run after the reply.
func (r *FakeRun) handle(m shimproto.Message) (shimproto.Message, func()) {
	switch m.Type {
	case shimproto.TypeStatus:
		return r.handleStatus(), nil
	case shimproto.TypeInput:
		return r.handleInput(m), nil
	case shimproto.TypeResize:
		return r.handleResize(m), nil
	case shimproto.TypeKill:
		return r.handleKill(m)
	case shimproto.TypeSignal:
		return r.handleSignal(m)
	case shimproto.TypeHello:
		return errReply(shimproto.CodeInvalidArgument, "hello already done"), nil
	default:
		return errReply(shimproto.CodeUnknownType, "unknown message type %q", m.Type), nil
	}
}

func (r *FakeRun) handleStatus() shimproto.Message {
	r.mu.Lock()
	defer r.mu.Unlock()
	reply := shimproto.Message{Type: shimproto.TypeStatusReply, Pid: r.pid, State: shimproto.StateRunning,
		LastSeq: make(map[string]uint64, len(r.seqs))}
	reply.OutputTruncated, reply.DroppedBytes = r.truncationLocked()
	for k, v := range r.seqs {
		reply.LastSeq[k] = v
	}
	if r.exited {
		reply.State = shimproto.StateExited
		reply.Exited = true
		reply.Leftovers = r.leftovers
	}
	return reply
}

func (r *FakeRun) handleInput(m shimproto.Message) shimproto.Message {
	r.mu.Lock()
	defer r.mu.Unlock()
	pty := r.spec.PTY != nil
	switch {
	case r.exited:
		return errReply(shimproto.CodeCommandExited, "command exited")
	case !shimproto.ValidSession(m.Session):
		return errReply(shimproto.CodeInvalidArgument, "input session must match [A-Za-z0-9._:-]{1,%d}", shimproto.MaxSessionLen)
	case m.CloseStdin && pty:
		return errReply(shimproto.CodeFailedPrecondition, "close_stdin does not apply to a pty, send ^D")
	case m.Seq <= r.seqs[m.Session]:
		return shimproto.Message{Type: shimproto.TypeInputReply, Applied: false}
	case len(m.Data) > 0 && !pty && !r.stdinOpen:
		return errReply(shimproto.CodeFailedPrecondition, "stdin is not open")
	}
	r.inputs = append(r.inputs, FakeInput{Session: m.Session, Seq: m.Seq, Data: slices.Clone(m.Data), CloseStdin: m.CloseStdin})
	if m.CloseStdin {
		r.stdinOpen = false
	}
	r.seqs[m.Session] = m.Seq
	return shimproto.Message{Type: shimproto.TypeInputReply, Applied: true}
}

func (r *FakeRun) handleResize(m shimproto.Message) shimproto.Message {
	r.mu.Lock()
	defer r.mu.Unlock()
	switch {
	case r.exited:
		return errReply(shimproto.CodeCommandExited, "command exited")
	case r.spec.PTY == nil:
		return errReply(shimproto.CodeFailedPrecondition, "command has no pty")
	case m.Cols == 0 || m.Rows == 0:
		return errReply(shimproto.CodeInvalidArgument, "cols and rows must be positive")
	}
	r.resizes = append(r.resizes, FakeResize{Cols: m.Cols, Rows: m.Rows})
	return okReply
}

// handleKill sends the first signal and kills everything after the grace
// (at once with grace 0), like the real shim's killLocked: the hard kill is
// scheduled also when the first signal ends the main process, so it reaches
// the leftovers. After the exit it acts on leftovers only.
func (r *FakeRun) handleKill(m shimproto.Message) (shimproto.Message, func()) {
	sig := sigTERM
	if m.FirstSignal != 0 {
		if err := shimproto.CheckSignal(m.FirstSignal); err != nil {
			return errReply(shimproto.CodeInvalidArgument, "first_signal %d: %v", m.FirstSignal, err), nil
		}
		sig = syscall.Signal(m.FirstSignal)
	}
	reason := m.Reason
	switch reason {
	case "":
		reason = shimproto.ReasonSignal
	case shimproto.ReasonSignal, shimproto.ReasonTimeout, shimproto.ReasonPTYIdle:
	default:
		return errReply(shimproto.CodeInvalidArgument, "kill reason %q", m.Reason), nil
	}
	grace := time.Duration(m.GraceMs) * time.Millisecond

	r.mu.Lock()
	defer r.mu.Unlock()
	r.kills = append(r.kills, FakeKill{GraceMs: m.GraceMs, FirstSignal: syscall.Signal(m.FirstSignal), Reason: m.Reason})
	if r.exited {
		if !r.leftovers {
			return okReply, nil
		}
	} else if r.killReason == "" {
		r.killReason = reason
	}
	// The first signal: the main process, or the leftovers after the exit.
	var first func()
	switch {
	case !r.diesLocked(sig):
	case r.exited:
		first = r.killLeftovers
	default:
		first = func() { _ = r.finish(r.killedExit(sig), true) }
	}
	if grace > 0 {
		r.armGraceLocked(grace)
		return okReply, first
	}
	return okReply, func() {
		if first != nil {
			first()
		}
		r.hardKill()
	}
}

// armGraceLocked schedules the hard kill after grace unless one is already
// due earlier. The timer outlives the exit of the main process, so it kills
// the leftovers. r.mu is held.
func (r *FakeRun) armGraceLocked(grace time.Duration) {
	at := time.Now().Add(grace)
	if r.graceTimer != nil {
		if !at.Before(r.graceAt) {
			return
		}
		r.graceTimer.Stop()
	}
	r.graceAt = at
	r.graceTimer = time.AfterFunc(grace, r.hardKill)
}

// handleSignal signals the process group, or kills everything with cgroup
// set. After the exit it reaches leftovers only: SIGKILL kills them.
func (r *FakeRun) handleSignal(m shimproto.Message) (shimproto.Message, func()) {
	if err := shimproto.CheckSignal(m.Sig); err != nil {
		return errReply(shimproto.CodeInvalidArgument, "sig %d: %v", m.Sig, err), nil
	}
	sig := syscall.Signal(m.Sig)
	r.mu.Lock()
	defer r.mu.Unlock()
	r.signals = append(r.signals, FakeSignal{Sig: sig, Cgroup: m.Cgroup})
	if r.exited {
		if r.leftovers && (m.Cgroup || r.diesLocked(sig)) {
			return okReply, r.killLeftovers
		}
		return okReply, nil
	}
	r.signalled = true
	switch {
	case m.Cgroup:
		return okReply, r.hardKill
	case r.diesLocked(sig):
		return okReply, func() { _ = r.finish(r.killedExit(sig), true) }
	}
	return okReply, nil
}

// hardKill is cgroup.kill of the payload: the main process (if alive) and
// the leftovers die by SIGKILL.
func (r *FakeRun) hardKill() {
	r.mu.Lock()
	if r.gone {
		r.mu.Unlock()
		return
	}
	r.leftovers = false
	exited := r.exited
	r.mu.Unlock()
	if exited {
		r.end(false)
		return
	}
	_ = r.finish(r.killedExit(sigKILL), true)
}

// killLeftovers ends the leftovers after the exit; the shim then ends.
func (r *FakeRun) killLeftovers() {
	r.mu.Lock()
	if r.gone || !r.exited {
		r.mu.Unlock()
		return
	}
	r.leftovers = false
	r.mu.Unlock()
	r.end(false)
}

// finish records the exit of the main process: exit.json (with ends from
// the file sizes when fillEnds), the exited push, and the end of the shim
// unless leftovers remain.
func (r *FakeRun) finish(e shimproto.ExitFile, fillEnds bool) error {
	r.mu.Lock()
	if r.gone {
		r.mu.Unlock()
		return errShimGone
	}
	if r.exited {
		r.mu.Unlock()
		return errAlreadyExited
	}
	if fillEnds {
		r.setEndsLocked(&e)
	}
	if e.EndedAt.IsZero() {
		e.EndedAt = time.Now().UTC()
	}
	if err := fsutil.WriteJSONAtomic(filepath.Join(r.dir, shim.ExitJSON), e, 0o600); err != nil {
		r.mu.Unlock()
		return err
	}
	r.exited = true
	r.stdinOpen = false
	// A pending hard kill stays armed: it still kills the leftovers.
	if r.spec.KillLeftovers {
		r.leftovers = false
	}
	var ready []*fakeConn
	for c, ok := range r.conns {
		if ok {
			ready = append(ready, c)
		}
	}
	ends := !r.leftovers
	r.mu.Unlock()

	for _, c := range ready {
		if err := c.send(shimproto.Message{Type: shimproto.TypeExited, Exit: &e}); err != nil {
			_ = c.c.Close()
		}
	}
	if ends {
		r.end(false)
	}
	return nil
}

// setEndsLocked fills the stream ends of e from the file sizes. r.mu is
// held.
func (r *FakeRun) setEndsLocked(e *shimproto.ExitFile) {
	for _, name := range r.streams() {
		fi, err := os.Stat(filepath.Join(r.dir, name))
		if err != nil {
			continue
		}
		switch name {
		case shim.StdoutFile:
			e.StdoutEnd = fi.Size()
		case shim.StderrFile:
			e.StderrEnd = fi.Size()
		case shim.PtyFile:
			e.PtyEnd = fi.Size()
		}
	}
}

// end stops the fake shim: the listener and every connection close and the
// unit is gone. crashed leaves the socket file behind, as a killed shim
// does.
func (r *FakeRun) end(crashed bool) {
	r.mu.Lock()
	if r.gone {
		r.mu.Unlock()
		return
	}
	r.gone = true
	if r.graceTimer != nil {
		r.graceTimer.Stop()
		r.graceTimer = nil
	}
	ln := r.ln
	conns := make([]*fakeConn, 0, len(r.conns))
	for c := range r.conns {
		conns = append(conns, c)
	}
	r.mu.Unlock()
	if ln != nil {
		ln.SetUnlinkOnClose(!crashed)
		_ = ln.Close()
	}
	for _, c := range conns {
		_ = c.c.Close()
	}
	r.f.unregister(r)
	close(r.done)
}
