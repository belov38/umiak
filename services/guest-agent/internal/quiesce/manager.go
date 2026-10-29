// Package quiesce freezes the machine for consistent snapshots (spec section
// 14): a lease pauses the Docker containers, runs the freeze hooks, syncs
// and FIFREEZEs the block filesystems; Thaw, the in-process timer, the
// watchdog unit, the agent at start and the foreign-freeze probe undo it.
//
// The lease file and the auto-thaw markers live on tmpfs (/run), so the
// agent never writes to a frozen filesystem; the store is frozen before
// FIFREEZE and unfrozen after FITHAW.
package quiesce

import (
	"context"
	"errors"
	"log/slog"
	"os"
	"sync"
	"syscall"
	"time"

	"connectrpc.com/connect"
	"github.com/google/uuid"
	"google.golang.org/protobuf/types/known/timestamppb"

	agentv1 "github.com/belov38/boat-dev-clone/libs/proto/sbx/agent/v1"

	"github.com/belov38/boat-dev-clone/services/guest-agent/internal/docker"
	"github.com/belov38/boat-dev-clone/services/guest-agent/internal/errs"
	"github.com/belov38/boat-dev-clone/services/guest-agent/internal/events"
	"github.com/belov38/boat-dev-clone/services/guest-agent/internal/paths"
	"github.com/belov38/boat-dev-clone/services/guest-agent/internal/store"
)

// Who thawed a lease automatically (quiesce.auto_thawed.by). The agent's
// own lease timer reports ByWatchdog like the watchdog unit (decision 5).
const (
	ByWatchdog   = "watchdog"
	ByAgentStart = "agent_start"
	ByForeign    = "foreign"
)

// Lease bounds and probe defaults (spec 14.2, 14.4).
const (
	DefaultLeaseMs      = 30000
	MaxLeaseMs          = 120000
	DefaultProbeEvery   = 5 * time.Second
	DefaultProbeTimeout = 15 * time.Second
)

// Internal timing.
const (
	// markerPoll is how often an active lease looks for a watchdog marker.
	markerPoll = time.Second
	// syncTimeout bounds the wait for sync(2); a foreign freeze can hang
	// it, FIFREEZE then reports the freeze.
	syncTimeout = 2 * time.Second
	// storeFreezeTimeout bounds SetFrozen(true), which waits for a commit
	// in flight; a commit hanging that long means someone else froze the
	// state filesystem.
	storeFreezeTimeout = 2 * time.Second
	// flushTimeout bounds the store flush after a thaw.
	flushTimeout = 5 * time.Second
	// prunePeriod is how often RunProbe drops expired markers.
	prunePeriod = time.Minute
)

// Mount is a filesystem the agent can freeze.
type Mount struct {
	// Path is the mount point passed to FIFREEZE.
	Path string
	// Source is the device.
	Source string
	// FSType is ext4, xfs or btrfs.
	FSType string
}

// Freezer lists and freezes filesystems. NewFreezer returns the platform
// implementation.
type Freezer interface {
	// Mounts returns the freezable mounts, one per device, deepest first.
	Mounts() ([]Mount, error)
	// Freeze freezes the filesystem at path; an already frozen one fails
	// with an error wrapping syscall.EBUSY.
	Freeze(path string) error
	// Thaw thaws the filesystem at path; one that is not frozen fails with
	// an error wrapping syscall.EINVAL.
	Thaw(path string) error
}

// DockerAPI is the part of the Docker API quiesce uses; *docker.Client
// implements it.
type DockerAPI interface {
	Running(ctx context.Context) ([]string, error)
	Paused(ctx context.Context) ([]string, error)
	Pause(ctx context.Context, id string) error
	Unpause(ctx context.Context, id string) error
}

// Supervisor starts and stops the watchdog unit; supervisor.Supervisor
// implements it.
type Supervisor interface {
	StartWatchdog(ctx context.Context, leaseID string, argv []string) error
	StopWatchdog(ctx context.Context, leaseID string) error
}

var _ DockerAPI = (*docker.Client)(nil)

// Options configures a Manager. Layout is required; a nil Docker, Freezer
// or Supervisor skips that part. Store and Emit may be set later with
// SetStore (the agent thaws before it opens the store).
type Options struct {
	// Layout gives QuiesceFile, QuiesceThawedDir, QuiesceHooksDir and
	// StateDir.
	Layout paths.Layout
	// Store is frozen for the duration of a filesystem freeze.
	Store *store.Store
	// Docker pauses the running containers.
	Docker DockerAPI
	// Freezer freezes the filesystems.
	Freezer Freezer
	// Supervisor runs the watchdog unit.
	Supervisor Supervisor
	// Emit publishes quiesce.auto_thawed. Events emitted before an
	// emitter is set wait in memory.
	Emit events.Emitter
	// Now is the clock. Default time.Now.
	Now func() time.Time
	// Self is the sbx-agent binary the watchdog unit runs. Default
	// os.Executable().
	Self string
	// ProbeEvery is the foreign-freeze probe period. Default 5s.
	ProbeEvery time.Duration
	// ProbeTimeout is how long a probe write may hang before the agent
	// thaws everything. Default 15s.
	ProbeTimeout time.Duration
	// Log receives failures. Default slog.Default().
	Log *slog.Logger
}

// Manager runs quiesce leases. Its methods are safe for concurrent use.
type Manager struct {
	opts  Options
	steps steps

	// Seams for tests.
	newID       func() string
	syncFS      func()
	probeWrite  func() error
	markerEvery time.Duration

	// opMu serializes Quiesce, Thaw, the automatic thaws and the foreign
	// thaw; it is held for a whole operation.
	opMu sync.Mutex

	mu         sync.Mutex
	cur        *active
	gen        uint64 // incremented by every Quiesce
	st         *store.Store
	emit       events.Emitter
	queued     []*agentv1.QuiesceAutoThawed
	probeDone  chan struct{} // the probe write in flight, or nil
	probeGen   uint64        // gen when the probe in flight started
	lastPruned time.Time
}

// active is the lease in progress. id and deadline never change; lease is
// changed only under opMu.
type active struct {
	id       string
	deadline time.Time
	lease    *Lease

	storeFrozen bool
	watchdog    bool // the watchdog unit was started
	timer       *time.Timer
	stop        chan struct{} // closed when the lease ends
	stopOnce    sync.Once
}

// New returns a Manager for opts.
func New(opts Options) *Manager {
	if opts.Now == nil {
		opts.Now = time.Now
	}
	if opts.Log == nil {
		opts.Log = slog.Default()
	}
	if opts.ProbeEvery <= 0 {
		opts.ProbeEvery = DefaultProbeEvery
	}
	if opts.ProbeTimeout <= 0 {
		opts.ProbeTimeout = DefaultProbeTimeout
	}
	if opts.Self == "" {
		if exe, err := os.Executable(); err == nil {
			opts.Self = exe
		}
	}
	m := &Manager{
		opts:        opts,
		steps:       steps{freezer: opts.Freezer, docker: opts.Docker, runHook: execHook, log: opts.Log},
		newID:       uuid.NewString,
		syncFS:      syncAll,
		markerEvery: markerPoll,
		st:          opts.Store,
		emit:        opts.Emit,
	}
	m.probeWrite = func() error { return writeProbe(opts.Layout.StateDir) }
	return m
}

// SetStore sets the store and the event emitter once the store is open and
// emits the events that waited for an emitter.
func (m *Manager) SetStore(st *store.Store, emit events.Emitter) {
	m.mu.Lock()
	defer m.mu.Unlock()
	m.st, m.emit = st, emit
	if emit == nil {
		return
	}
	for _, ev := range m.queued {
		emit.Emit(events.TypeQuiesceAutoThawed, ev)
	}
	m.queued = nil
}

// store returns the store, or nil.
func (m *Manager) store() *store.Store {
	m.mu.Lock()
	defer m.mu.Unlock()
	return m.st
}

// report emits quiesce.auto_thawed now or once an emitter is set.
func (m *Manager) report(leaseID string, at time.Time, by string) {
	ev := &agentv1.QuiesceAutoThawed{LeaseId: leaseID, At: timestamppb.New(at), By: by}
	m.mu.Lock()
	defer m.mu.Unlock()
	if m.emit == nil {
		m.queued = append(m.queued, ev)
		return
	}
	m.emit.Emit(events.TypeQuiesceAutoThawed, ev)
}

// current returns the active lease, or nil.
func (m *Manager) current() *active {
	m.mu.Lock()
	defer m.mu.Unlock()
	return m.cur
}

// setCurrent publishes a (nil ends the lease); a new lease bumps gen.
func (m *Manager) setCurrent(a *active) {
	m.mu.Lock()
	defer m.mu.Unlock()
	m.cur = a
	if a != nil {
		m.gen++
	}
}

// Status returns the active lease, or nil.
func (m *Manager) Status() *agentv1.QuiesceStatus {
	a := m.current()
	if a == nil {
		return nil
	}
	return &agentv1.QuiesceStatus{Active: true, LeaseId: a.id, Deadline: timestamppb.New(a.deadline)}
}

// internalErr is the error of a failed quiesce step.
func internalErr(step string, err error) error {
	return errs.New(connect.CodeInternal, errs.Internal, "quiesce: "+step+": "+err.Error())
}

// frozenByOther is the error of a filesystem frozen by someone else.
func frozenByOther(what string) error {
	return errs.New(connect.CodeFailedPrecondition, errs.FrozenByOther, what+" is frozen by someone else")
}

// Quiesce starts a lease of leaseMs (0 means DefaultLeaseMs) in the order of
// spec 14.2: lease file, watchdog unit and timer, Docker pause, freeze
// hooks, sync, store freeze, FIFREEZE. A failing step undoes the earlier
// ones in reverse order.
func (m *Manager) Quiesce(ctx context.Context, leaseMs uint32, docker, fs bool) (*agentv1.QuiesceResponse, error) {
	if leaseMs == 0 {
		leaseMs = DefaultLeaseMs
	}
	if leaseMs > MaxLeaseMs {
		return nil, errs.Newf(connect.CodeInvalidArgument, errs.InvalidArgument, "lease_ms must be in 1..%d", MaxLeaseMs)
	}
	m.opMu.Lock()
	defer m.opMu.Unlock()
	if a := m.current(); a != nil {
		return nil, errs.Newf(connect.CodeFailedPrecondition, errs.AlreadyQuiesced, "already quiesced by lease %s", a.id)
	}
	now := m.opts.Now()
	id := m.newID()
	a := &active{
		id:       id,
		deadline: now.Add(time.Duration(leaseMs) * time.Millisecond),
		stop:     make(chan struct{}),
	}
	a.lease = &Lease{ID: id, Deadline: a.deadline}
	if err := writeLease(m.opts.Layout.QuiesceFile, a.lease); err != nil {
		return nil, internalErr("lease", err)
	}
	m.setCurrent(a)
	res, err := m.freeze(ctx, a, docker, fs)
	if err != nil {
		m.opts.Log.Warn("quiesce failed, rolling back", "lease", id, "err", err)
		m.release(context.WithoutCancel(ctx), a, true)
		return nil, err
	}
	m.opts.Log.Info("quiesced", "lease", id, "deadline", a.deadline,
		"containers", len(res.PausedContainers), "mounts", res.FrozenMounts)
	return res, nil
}

// freeze runs the steps of Quiesce after the lease file is written.
func (m *Manager) freeze(ctx context.Context, a *active, withDocker, withFS bool) (*agentv1.QuiesceResponse, error) {
	l := a.lease
	res := &agentv1.QuiesceResponse{LeaseId: a.id, Deadline: timestamppb.New(a.deadline)}
	save := func() error { return writeLease(m.opts.Layout.QuiesceFile, l) }

	// Watchdog unit and the in-process timer.
	if sv := m.opts.Supervisor; sv != nil {
		argv := []string{m.opts.Self, "quiesce-watchdog", "--lease", a.id}
		if err := sv.StartWatchdog(ctx, a.id, argv); err != nil {
			return nil, internalErr("start watchdog", err)
		}
		a.watchdog = true
	}
	a.timer = time.AfterFunc(a.deadline.Sub(m.opts.Now()), func() { m.autoThaw(a.id, ByWatchdog) }) //nolint:contextcheck // the timer outlives the request
	go m.watchMarker(a)                                                                             //nolint:contextcheck // the watch outlives the request

	// Docker.
	if withDocker && m.opts.Docker != nil {
		dctx, cancel := context.WithTimeout(ctx, dockerBudget)
		defer cancel()
		ids, err := m.opts.Docker.Running(dctx)
		switch {
		case errors.Is(err, docker.ErrNoDaemon):
			m.opts.Log.Info("quiesce: docker is not running, nothing to pause")
		case err != nil:
			return nil, internalErr("list containers", err)
		case len(ids) > 0:
			// Every id is recorded before its pause.
			l.Paused = ids
			if err := save(); err != nil {
				return nil, internalErr("lease", err)
			}
			paused, err := m.steps.pauseAll(dctx, ids)
			res.PausedContainers = paused
			if err != nil {
				return nil, internalErr("pause containers", err)
			}
		}
	}

	// Hooks.
	hooks, err := listHooks(m.opts.Layout.QuiesceHooksDir)
	if err != nil {
		return nil, internalErr("hooks", err)
	}
	for _, h := range hooks {
		l.Hooks = append(l.Hooks, h)
		if err := save(); err != nil {
			return nil, internalErr("lease", err)
		}
		if err := m.steps.runHook(ctx, h, hookFreeze); err != nil {
			return nil, internalErr("freeze hook", err)
		}
	}

	if !withFS || m.opts.Freezer == nil {
		return res, nil
	}
	m.syncBounded()
	mounts, err := m.opts.Freezer.Mounts()
	if err != nil {
		return nil, internalErr("list mounts", err)
	}
	if len(mounts) == 0 {
		return res, nil
	}
	if err := m.freezeStore(a); err != nil {
		return nil, err
	}
	for _, mt := range mounts {
		// Recorded before FIFREEZE, dropped again if it fails: a mount
		// frozen by someone else must not be thawed by the rollback.
		l.Frozen = append(l.Frozen, mt.Path)
		if err := save(); err != nil {
			l.Frozen = l.Frozen[:len(l.Frozen)-1]
			return nil, internalErr("lease", err)
		}
		if err := m.opts.Freezer.Freeze(mt.Path); err != nil {
			l.Frozen = l.Frozen[:len(l.Frozen)-1]
			if serr := save(); serr != nil {
				m.opts.Log.Error("quiesce: write lease", "err", serr)
			}
			if errors.Is(err, syscall.EBUSY) {
				return nil, frozenByOther(mt.Path)
			}
			return nil, internalErr("freeze "+mt.Path, err)
		}
		res.FrozenMounts = append(res.FrozenMounts, mt.Path)
	}
	return res, nil
}

// syncBounded runs sync(2) and waits for it at most syncTimeout.
func (m *Manager) syncBounded() {
	done := make(chan struct{})
	go func() {
		m.syncFS()
		close(done)
	}()
	t := time.NewTimer(syncTimeout)
	defer t.Stop()
	select {
	case <-done:
	case <-t.C:
		m.opts.Log.Warn("quiesce: sync is hanging, continuing")
	}
}

// freezeStore freezes the store for a, waiting at most storeFreezeTimeout.
// A store that cannot freeze in time has a commit hanging on a filesystem
// frozen by someone else: the lease fails with frozen_by_other, and the
// late freeze is undone once it lands unless a lease is active by then.
func (m *Manager) freezeStore(a *active) error {
	st := m.store()
	if st == nil {
		return nil
	}
	done := make(chan struct{})
	go func() {
		st.SetFrozen(true)
		close(done)
	}()
	t := time.NewTimer(storeFreezeTimeout)
	defer t.Stop()
	select {
	case <-done:
		a.storeFrozen = true
		return nil
	case <-t.C:
	}
	go func() {
		<-done
		m.opMu.Lock()
		defer m.opMu.Unlock()
		if m.current() == nil {
			st.SetFrozen(false)
		}
	}()
	return frozenByOther("the state filesystem")
}

// release ends a: with thaw it undoes the lease steps first (FITHAW, store
// unfreeze, hooks, unpause); then it stops the timer, the marker watch and
// the watchdog unit and deletes the lease file. opMu is held.
func (m *Manager) release(ctx context.Context, a *active, thaw bool) {
	unfreeze := func() {
		if a.storeFrozen {
			if st := m.store(); st != nil {
				st.SetFrozen(false)
			}
			a.storeFrozen = false
		}
	}
	if thaw {
		m.steps.thawLease(ctx, a.lease, unfreeze)
	} else {
		unfreeze()
	}
	if a.timer != nil {
		a.timer.Stop()
	}
	a.stopOnce.Do(func() { close(a.stop) })
	if a.watchdog {
		if err := m.opts.Supervisor.StopWatchdog(ctx, a.id); err != nil {
			m.opts.Log.Warn("quiesce: stop watchdog", "lease", a.id, "err", err)
		}
	}
	if err := removeLease(m.opts.Layout.QuiesceFile); err != nil {
		m.opts.Log.Error("quiesce: remove lease", "err", err)
	}
	m.setCurrent(nil)
}

// flush waits for the store to write what it buffered during the freeze.
func (m *Manager) flush(ctx context.Context) {
	st := m.store()
	if st == nil {
		return
	}
	ctx, cancel := context.WithTimeout(ctx, flushTimeout)
	defer cancel()
	if err := st.Flush(ctx); err != nil {
		m.opts.Log.Warn("quiesce: flush after thaw", "err", err)
	}
}

// Thaw ends lease leaseID (spec 14.3). An unknown or already ended lease
// succeeds with already_thawed; if it was thawed automatically within
// MarkerTTL, auto_thawed and auto_thawed_at say when.
func (m *Manager) Thaw(ctx context.Context, leaseID string) (*agentv1.ThawResponse, error) {
	m.opMu.Lock()
	defer m.opMu.Unlock()
	now := m.opts.Now()
	a := m.current()
	mk, auto := readMarker(m.opts.Layout.QuiesceThawedDir, leaseID, now)
	if a != nil && a.id == leaseID {
		if !auto {
			m.release(context.WithoutCancel(ctx), a, true)
			m.flush(ctx)
			m.opts.Log.Info("thawed", "lease", leaseID)
			return &agentv1.ThawResponse{}, nil
		}
		// The watchdog unit got there first.
		m.adopt(context.WithoutCancel(ctx), a, mk)
	}
	res := &agentv1.ThawResponse{AlreadyThawed: true}
	if auto {
		res.AutoThawed = true
		res.AutoThawedAt = timestamppb.New(mk.At)
	}
	return res, nil
}

// AutoThaw ends the active lease on behalf of by (ByWatchdog or
// ByAgentStart): the Thaw steps, a marker for later Thaw calls and the
// event quiesce.auto_thawed. Without an active lease it does nothing; a
// lease left by an earlier agent process is handled by Startup.
func (m *Manager) AutoThaw(by string) {
	if a := m.current(); a != nil {
		m.autoThaw(a.id, by)
	}
}

// autoThaw is AutoThaw for lease id only.
func (m *Manager) autoThaw(id, by string) {
	m.opMu.Lock()
	defer m.opMu.Unlock()
	a := m.current()
	if a == nil || a.id != id {
		return
	}
	now := m.opts.Now()
	if mk, ok := readMarker(m.opts.Layout.QuiesceThawedDir, id, now); ok {
		m.adopt(context.Background(), a, mk)
		return
	}
	m.opts.Log.Warn("quiesce lease expired, thawing", "lease", id, "by", by)
	m.release(context.Background(), a, true)
	m.markAndReport(id, m.opts.Now(), by)
	m.flush(context.Background())
}

// markAndReport writes a reported marker for id and emits the event.
func (m *Manager) markAndReport(id string, at time.Time, by string) {
	if validLeaseID(id) {
		if err := writeMarker(m.opts.Layout.QuiesceThawedDir, marker{LeaseID: id, At: at, By: by, Reported: true}); err != nil {
			m.opts.Log.Error("quiesce: write marker", "err", err)
		}
	}
	m.report(id, at, by)
}

// adopt ends a after the watchdog unit thawed it (marker mk): the store is
// unfrozen, the lease forgotten and the event emitted unless reported.
// opMu is held.
func (m *Manager) adopt(ctx context.Context, a *active, mk marker) {
	m.opts.Log.Warn("quiesce lease thawed by the watchdog unit", "lease", a.id, "at", mk.At)
	m.release(ctx, a, false)
	m.reportMarker(mk)
}

// reportMarker emits the event of an unreported marker and marks it.
func (m *Manager) reportMarker(mk marker) {
	if mk.Reported {
		return
	}
	m.report(mk.LeaseID, mk.At, mk.By)
	mk.Reported = true
	if err := writeMarker(m.opts.Layout.QuiesceThawedDir, mk); err != nil {
		m.opts.Log.Error("quiesce: write marker", "err", err)
	}
}

// watchMarker polls for the watchdog unit's marker of a until a ends.
func (m *Manager) watchMarker(a *active) {
	t := time.NewTicker(m.markerEvery)
	defer t.Stop()
	for {
		select {
		case <-a.stop:
			return
		case <-t.C:
		}
		if _, ok := readMarker(m.opts.Layout.QuiesceThawedDir, a.id, m.opts.Now()); !ok {
			continue
		}
		m.opMu.Lock()
		if cur := m.current(); cur == a {
			if mk, ok := readMarker(m.opts.Layout.QuiesceThawedDir, a.id, m.opts.Now()); ok {
				m.adopt(context.Background(), a, mk)
			}
		}
		m.opMu.Unlock()
		return
	}
}

// Startup runs before the agent writes to disk (spec 6, step 2.1): a lease
// left by an earlier agent process is thawed with by agent_start; without
// one, a probe write that hangs for ProbeTimeout thaws a foreign freeze.
// Then markers the watchdog unit wrote while the agent was down are
// reported.
func (m *Manager) Startup(ctx context.Context) {
	m.opMu.Lock()
	l, err := readLease(m.opts.Layout.QuiesceFile)
	switch {
	case err != nil:
		// The lease is unreadable: thaw every mount and container.
		m.opts.Log.Error("quiesce: lease left by an earlier run is unreadable, thawing everything", "err", err)
		if _, ferr := m.steps.thawAllMounts(nil); ferr != nil {
			m.opts.Log.Error("quiesce: thaw mounts", "err", ferr)
		}
		m.unpauseAllPaused(ctx)
		if rerr := removeLease(m.opts.Layout.QuiesceFile); rerr != nil {
			m.opts.Log.Error("quiesce: remove lease", "err", rerr)
		}
		m.report("", m.opts.Now(), ByAgentStart)
	case l != nil:
		m.opts.Log.Warn("quiesce lease left by an earlier run, thawing", "lease", l.ID)
		m.steps.thawLease(ctx, l, nil)
		if m.opts.Supervisor != nil && validLeaseID(l.ID) {
			if serr := m.opts.Supervisor.StopWatchdog(ctx, l.ID); serr != nil {
				m.opts.Log.Warn("quiesce: stop watchdog", "lease", l.ID, "err", serr)
			}
		}
		if rerr := removeLease(m.opts.Layout.QuiesceFile); rerr != nil {
			m.opts.Log.Error("quiesce: remove lease", "err", rerr)
		}
		m.markAndReport(l.ID, m.opts.Now(), ByAgentStart)
	}
	m.opMu.Unlock()
	if l == nil && err == nil {
		m.probeAndThaw(ctx)
	}
	for _, mk := range listMarkers(m.opts.Layout.QuiesceThawedDir, m.opts.Now()) {
		m.reportMarker(mk)
	}
}

// unpauseAllPaused unpauses every paused container.
func (m *Manager) unpauseAllPaused(ctx context.Context) {
	if m.opts.Docker == nil {
		return
	}
	dctx, cancel := context.WithTimeout(ctx, dockerBudget)
	defer cancel()
	ids, err := m.opts.Docker.Paused(dctx)
	if err != nil {
		if !errors.Is(err, docker.ErrNoDaemon) {
			m.opts.Log.Warn("quiesce: list paused containers", "err", err)
		}
		return
	}
	m.steps.unpauseAll(ctx, ids)
}
