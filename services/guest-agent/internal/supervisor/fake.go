package supervisor

import (
	"context"
	"errors"
	"fmt"
	"net"
	"os"
	"path/filepath"
	"slices"
	"sync"
	"syscall"
	"time"

	"github.com/belov38/boat-dev-clone/services/guest-agent/internal/fsutil"
	"github.com/belov38/boat-dev-clone/services/guest-agent/internal/paths"
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

// FakeLaunch is one recorded Launch call.
type FakeLaunch struct {
	ID        string
	ShimPath  string
	ExtraArgs []string
	// Argv is the command line the systemd unit would run.
	Argv []string
}

// FakeInput is one applied input request.
type FakeInput struct {
	Session    string
	Seq        uint64
	Data       []byte
	CloseStdin bool
}

// FakeResize is one applied resize request.
type FakeResize struct {
	Cols, Rows uint16
}

// FakeKill is one kill request.
type FakeKill struct {
	GraceMs     uint32
	FirstSignal syscall.Signal // as sent; 0 means SIGTERM
	Reason      string
}

// FakeSignal is one signal request.
type FakeSignal struct {
	Sig    syscall.Signal
	Cgroup bool
}

// Fake is an in-process Supervisor for tests. Launch reads the spec like the
// real shim, creates the stream files and shim.json and serves the real shim
// protocol on Layout.ShimSocket(id); the command itself is simulated by a
// FakeRun that the test drives (Write, Exit, Signal, Die) directly or through
// a script registered with Script.
type Fake struct {
	layout paths.Layout

	mu          sync.Mutex
	nextPid     int
	units       map[string]*FakeRun // loaded command units
	last        map[string]*FakeRun // latest run per id, also after its end
	overrides   map[string]UnitState
	setups      map[string]func(*FakeRun)
	scripts     map[string]func(*FakeRun)
	failLaunch  map[string]error
	launches    []FakeLaunch
	cgroupKills map[string]int
	watchdogs   map[string][]string
	failWatch   error
	stops       []string
}

// NewFake returns a Fake working on the layout l.
func NewFake(l paths.Layout) *Fake {
	return &Fake{
		layout:      l,
		nextPid:     1000,
		units:       make(map[string]*FakeRun),
		last:        make(map[string]*FakeRun),
		overrides:   make(map[string]UnitState),
		setups:      make(map[string]func(*FakeRun)),
		scripts:     make(map[string]func(*FakeRun)),
		failLaunch:  make(map[string]error),
		cgroupKills: make(map[string]int),
		watchdogs:   make(map[string][]string),
	}
}

var _ Supervisor = (*Fake)(nil)

// Setup registers fn to configure the run of id before it starts (on every
// later Launch of id): IgnoreSignals, SetLeftovers, SetShimVersions and
// FailStart belong here.
func (f *Fake) Setup(id string, fn func(*FakeRun)) {
	f.mu.Lock()
	defer f.mu.Unlock()
	f.setups[id] = fn
}

// Script registers fn to run in its own goroutine once Launch of id has
// returned (on every later Launch of id). Without a script the command keeps
// running until the test acts on Run(id).
func (f *Fake) Script(id string, fn func(*FakeRun)) {
	f.mu.Lock()
	defer f.mu.Unlock()
	f.scripts[id] = fn
}

// FailLaunch makes the next Launch of id fail with err (wrapped) before the
// shim starts: no shim.json, no unit.
func (f *Fake) FailLaunch(id string, err error) {
	f.mu.Lock()
	defer f.mu.Unlock()
	f.failLaunch[id] = err
}

// SetState makes State report st for id until ClearState, regardless of a
// run. Launch refuses an id whose reported state is not UnitNotFound.
func (f *Fake) SetState(id string, st UnitState) {
	f.mu.Lock()
	defer f.mu.Unlock()
	f.overrides[id] = st
}

// ClearState removes an override set by SetState.
func (f *Fake) ClearState(id string) {
	f.mu.Lock()
	defer f.mu.Unlock()
	delete(f.overrides, id)
}

// Launches returns every Launch call so far, including refused ones.
func (f *Fake) Launches() []FakeLaunch {
	f.mu.Lock()
	defer f.mu.Unlock()
	out := make([]FakeLaunch, len(f.launches))
	for i, l := range f.launches {
		l.ExtraArgs = slices.Clone(l.ExtraArgs)
		l.Argv = slices.Clone(l.Argv)
		out[i] = l
	}
	return out
}

// Run returns the latest run of id, also after it ended; nil if id was
// never started.
func (f *Fake) Run(id string) *FakeRun {
	f.mu.Lock()
	defer f.mu.Unlock()
	return f.last[id]
}

// CgroupKills returns how many KillCgroup calls reached the unit of id.
func (f *Fake) CgroupKills(id string) int {
	f.mu.Lock()
	defer f.mu.Unlock()
	return f.cgroupKills[id]
}

// Stops returns the ids passed to Stop so far.
func (f *Fake) Stops() []string {
	f.mu.Lock()
	defer f.mu.Unlock()
	return slices.Clone(f.stops)
}

// Launch implements Supervisor.
func (f *Fake) Launch(ctx context.Context, id string, shimPath string, extraArgs []string) error {
	f.mu.Lock()
	f.launches = append(f.launches, FakeLaunch{ID: id, ShimPath: shimPath, ExtraArgs: slices.Clone(extraArgs),
		Argv: shimArgv(id, shimPath, extraArgs)})
	if err := checkCommandID(id); err != nil {
		f.mu.Unlock()
		return err
	}
	if err := ctx.Err(); err != nil {
		f.mu.Unlock()
		return err
	}
	if f.stateLocked(id) != UnitNotFound {
		f.mu.Unlock()
		return fmt.Errorf("%w: %s", ErrUnitExists, UnitName(id))
	}
	if err, ok := f.failLaunch[id]; ok {
		delete(f.failLaunch, id)
		f.mu.Unlock()
		return fmt.Errorf("supervisor: start %s: %w", UnitName(id), err)
	}
	f.nextPid++
	r := &FakeRun{
		f:       f,
		id:      id,
		pid:     f.nextPid,
		dir:     f.layout.CommandDir(id),
		sock:    f.layout.ShimSocket(id),
		minV:    shimproto.MinVersion,
		maxV:    shimproto.Version,
		seqs:    make(map[string]uint64),
		conns:   make(map[*fakeConn]bool),
		done:    make(chan struct{}),
		started: time.Now().UTC(),
	}
	setup, script := f.setups[id], f.scripts[id]
	// The unit exists from here on, as with systemd once the job is queued.
	f.units[id] = r
	f.last[id] = r
	f.mu.Unlock()

	if err := r.start(setup); err != nil {
		r.end(false)
		return fmt.Errorf("supervisor: %s failed: %w", UnitName(id), err)
	}
	if script != nil {
		go script(r)
	}
	return nil
}

// stateLocked returns the reported state of id. f.mu is held.
func (f *Fake) stateLocked(id string) UnitState {
	if st, ok := f.overrides[id]; ok {
		return st
	}
	if _, ok := f.units[id]; ok {
		return UnitActive
	}
	return UnitNotFound
}

// unit returns the loaded run of id or nil.
func (f *Fake) unit(id string) *FakeRun {
	f.mu.Lock()
	defer f.mu.Unlock()
	return f.units[id]
}

// unregister drops r once its shim has ended.
func (f *Fake) unregister(r *FakeRun) {
	f.mu.Lock()
	defer f.mu.Unlock()
	if f.units[r.id] == r {
		delete(f.units, r.id)
	}
}

// State implements Supervisor.
func (f *Fake) State(_ context.Context, id string) (UnitState, error) {
	f.mu.Lock()
	defer f.mu.Unlock()
	return f.stateLocked(id), nil
}

// KillCgroup implements Supervisor: the command and its leftovers die by
// SIGKILL and the shim ends after recording the exit.
func (f *Fake) KillCgroup(_ context.Context, id string) error {
	f.mu.Lock()
	r := f.units[id]
	if r == nil {
		f.mu.Unlock()
		return fmt.Errorf("%w: %s", ErrUnitNotFound, UnitName(id))
	}
	f.cgroupKills[id]++
	f.mu.Unlock()
	r.hardKill()
	return nil
}

// Stop implements Supervisor: the unit is stopped with everything in it;
// the shim dies by SIGTERM without recording an exit.
func (f *Fake) Stop(_ context.Context, id string) error {
	f.mu.Lock()
	f.stops = append(f.stops, id)
	f.mu.Unlock()
	if r := f.unit(id); r != nil {
		r.Die()
	}
	return nil
}

// StartWatchdog implements Supervisor; the fake only records argv.
func (f *Fake) StartWatchdog(_ context.Context, leaseID string, argv []string) error {
	if err := checkLeaseID(leaseID); err != nil {
		return err
	}
	f.mu.Lock()
	defer f.mu.Unlock()
	if err := f.failWatch; err != nil {
		f.failWatch = nil
		return fmt.Errorf("supervisor: start %s: %w", WatchdogUnitName(leaseID), err)
	}
	if _, ok := f.watchdogs[leaseID]; ok {
		return fmt.Errorf("%w: %s", ErrUnitExists, WatchdogUnitName(leaseID))
	}
	f.watchdogs[leaseID] = slices.Clone(argv)
	return nil
}

// StopWatchdog implements Supervisor.
func (f *Fake) StopWatchdog(_ context.Context, leaseID string) error {
	f.mu.Lock()
	defer f.mu.Unlock()
	delete(f.watchdogs, leaseID)
	return nil
}

// FailWatchdog makes the next StartWatchdog fail with err (wrapped).
func (f *Fake) FailWatchdog(err error) {
	f.mu.Lock()
	defer f.mu.Unlock()
	f.failWatch = err
}

// Watchdog returns the argv of the active watchdog of leaseID.
func (f *Fake) Watchdog(leaseID string) ([]string, bool) {
	f.mu.Lock()
	defer f.mu.Unlock()
	argv, ok := f.watchdogs[leaseID]
	return slices.Clone(argv), ok
}

// Close ends every fake shim (without recording exits) and waits for their
// goroutines.
func (f *Fake) Close() error {
	f.mu.Lock()
	runs := make([]*FakeRun, 0, len(f.last))
	for _, r := range f.last {
		runs = append(runs, r)
	}
	f.mu.Unlock()
	for _, r := range runs {
		r.end(true)
		r.wg.Wait()
	}
	return nil
}

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
	stdinOpen  bool
	seqs       map[string]uint64
	inputs     []FakeInput
	resizes    []FakeResize
	kills      []FakeKill
	signals    []FakeSignal
	killReason string
	signalled  bool
	graceTimer *time.Timer
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
	r.mu.Unlock()
	if reason == "" {
		reason = shimproto.ReasonNone
	}
	return r.finish(shimproto.ExitFile{Status: shimproto.StatusExited, Code: code, Reason: reason}, true)
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
	case !validSession(m.Session):
		return errReply(shimproto.CodeInvalidArgument, "input session must match [A-Za-z0-9._:-]{1,%d}", maxSessionLen)
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

func checkSignal(sig int) error {
	if sig < 1 || sig > 64 {
		return errors.New("signal out of range")
	}
	return nil
}

// handleKill sends the first signal and kills everything after the grace
// (at once with grace 0). After the exit it acts on leftovers only.
func (r *FakeRun) handleKill(m shimproto.Message) (shimproto.Message, func()) {
	sig := sigTERM
	if m.FirstSignal != 0 {
		if err := checkSignal(m.FirstSignal); err != nil {
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
		// Leftovers get the signal like the main process would.
		if r.diesLocked(sig) || grace == 0 {
			return okReply, r.killLeftovers
		}
		r.armGraceLocked(grace)
		return okReply, nil
	}
	if r.killReason == "" {
		r.killReason = reason
	}
	if r.diesLocked(sig) {
		return okReply, func() { _ = r.finish(r.killedExit(sig), true) }
	}
	if grace == 0 {
		return okReply, r.hardKill
	}
	r.armGraceLocked(grace)
	return okReply, nil
}

// armGraceLocked schedules the hard kill after grace, keeping an earlier
// one. r.mu is held.
func (r *FakeRun) armGraceLocked(grace time.Duration) {
	if r.graceTimer != nil {
		return
	}
	r.graceTimer = time.AfterFunc(grace, r.hardKill)
}

// handleSignal signals the process group, or kills everything with cgroup
// set. After the exit it reaches leftovers only: SIGKILL kills them.
func (r *FakeRun) handleSignal(m shimproto.Message) (shimproto.Message, func()) {
	if err := checkSignal(m.Sig); err != nil {
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
	if r.graceTimer != nil {
		r.graceTimer.Stop()
		r.graceTimer = nil
	}
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

// maxSessionLen is the longest input session id the shim accepts.
const maxSessionLen = 128

// validSession reports whether id matches [A-Za-z0-9._:-]{1,maxSessionLen},
// as the real shim checks it.
func validSession(id string) bool {
	if id == "" || len(id) > maxSessionLen {
		return false
	}
	for i := 0; i < len(id); i++ {
		c := id[i]
		switch {
		case c >= 'a' && c <= 'z', c >= 'A' && c <= 'Z', c >= '0' && c <= '9',
			c == '.', c == '_', c == ':', c == '-':
		default:
			return false
		}
	}
	return true
}
