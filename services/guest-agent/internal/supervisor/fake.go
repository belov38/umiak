package supervisor

import (
	"context"
	"errors"
	"fmt"
	"slices"
	"sync"
	"syscall"
	"time"

	"github.com/belov38/boat-dev-clone/services/guest-agent/internal/paths"
	"github.com/belov38/boat-dev-clone/services/guest-agent/internal/shimproto"
)

// FakeLaunch is one recorded Launch call.
type FakeLaunch struct {
	ID        string
	ShimPath  string
	ExtraArgs []string
	// Argv is the command line the systemd unit would run.
	Argv []string
	// Spec is the spec passed to LaunchSpec; nil for Launch.
	Spec []byte
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
		l.Spec = slices.Clone(l.Spec)
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
	return f.launch(ctx, id, shimPath, extraArgs, nil)
}

// FakeSpecLauncher is a Fake that also implements SpecLauncher, like the
// Windows supervisor: the spec comes with the launch, not as a CmdSpec file.
type FakeSpecLauncher struct {
	*Fake
}

var _ SpecLauncher = FakeSpecLauncher{}

// LaunchSpec implements SpecLauncher.
func (f FakeSpecLauncher) LaunchSpec(ctx context.Context, id, shimPath string, extraArgs []string, spec []byte) error {
	if spec == nil {
		spec = []byte{}
	}
	return f.launch(ctx, id, shimPath, extraArgs, spec)
}

// launch starts a run of id; spec is the spec of LaunchSpec, nil to read
// the CmdSpec file like the Linux shim.
func (f *Fake) launch(ctx context.Context, id string, shimPath string, extraArgs []string, spec []byte) error {
	f.mu.Lock()
	f.launches = append(f.launches, FakeLaunch{ID: id, ShimPath: shimPath, ExtraArgs: slices.Clone(extraArgs),
		Argv: shimArgv(id, shimPath, extraArgs), Spec: slices.Clone(spec)})
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

	if err := r.start(setup, spec); err != nil {
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
	if err := checkCommandID(id); err != nil {
		return UnitNotFound, err
	}
	f.mu.Lock()
	defer f.mu.Unlock()
	return f.stateLocked(id), nil
}

// KillCgroup implements Supervisor: the command and its leftovers die by
// SIGKILL and the shim ends after recording the exit.
func (f *Fake) KillCgroup(_ context.Context, id string) error {
	if err := checkCommandID(id); err != nil {
		return err
	}
	f.mu.Lock()
	r := f.units[id]
	if r == nil {
		// A unit that exists only through SetState takes the kill and
		// keeps its reported state.
		alive := f.stateLocked(id) != UnitNotFound
		if alive {
			f.cgroupKills[id]++
		}
		f.mu.Unlock()
		if alive {
			return nil
		}
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
	if err := checkCommandID(id); err != nil {
		return err
	}
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
	if len(argv) == 0 {
		return errors.New("supervisor: empty watchdog argv")
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
	if err := checkLeaseID(leaseID); err != nil {
		return err
	}
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
