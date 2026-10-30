// Package quiesce freezes the machine for consistent snapshots (spec section
// 14): a lease pauses the Docker containers, runs the freeze hooks, syncs
// and FIFREEZEs the block filesystems; Thaw, the in-process timer, the
// watchdog unit, the agent at start and the foreign-freeze probe undo it.
//
// The lease file and the auto-thaw markers live on tmpfs (/run), so the
// agent never writes to a frozen filesystem; the store is frozen before
// FIFREEZE and unfrozen after FITHAW.
//
// On Windows (S9 spec 12.10) VSS freezes the filesystems after Quiesce
// returns: a lease runs the hooks and, for a saved snapshot, wipes the
// secret files, which every thaw restores from the agent's memory.
package quiesce

import (
	"context"
	"errors"
	"log/slog"
	"os"
	"slices"
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
// own lease timer reports ByWatchdog like the watchdog unit (decision 5);
// ByAgentStop is an agent that stops (reboot, poweroff, restart) during a
// lease.
const (
	ByWatchdog   = "watchdog"
	ByAgentStart = "agent_start"
	ByAgentStop  = "agent_stop"
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
	// in flight; a commit hanging that long probably hangs on a filesystem
	// frozen by someone else.
	storeFreezeTimeout = 2 * time.Second
	// unitMarkerWait is how long a thaw waits for the marker of a watchdog
	// unit that already claimed the lease file.
	unitMarkerWait = 2 * time.Second
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

// frozenStore is the part of *store.Store a lease uses.
type frozenStore interface {
	SetFrozen(frozen bool)
	Flush(ctx context.Context) error
}

// SecretFiles wipes and restores the secret files for a snapshot;
// *claim.Manager implements it.
type SecretFiles interface {
	// WipeSecretFiles overwrites and deletes the secret files. A file held
	// open makes it fail with an error matching errs.ErrSecretInUse.
	WipeSecretFiles() (wiped bool, err error)
	// RestoreSecretFiles writes the files back from memory.
	RestoreSecretFiles() error
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
	// Secrets wipes the secret files for Quiesce with wipe_secret_files
	// where WipesSecretFiles; nil skips the wipe. May be set later with
	// SetSecrets (the claim manager starts after quiesce).
	Secrets SecretFiles
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
	newID              func() string
	syncFS             func()
	probeWrite         func() error
	markerEvery        time.Duration
	freezeBudget       time.Duration
	storeFreezeTimeout time.Duration
	unitMarkerWait     time.Duration
	// Platform behaviour, freezesFS and WipesSecretFiles by default.
	fsFreeze    bool // fs freeze and Docker pause; false refuses fs=true
	wipeSecrets bool // wipe_secret_files is honoured

	// opMu serializes Quiesce, Thaw, the automatic thaws and the foreign
	// thaw; it is held for a whole operation.
	opMu sync.Mutex

	mu         sync.Mutex
	cur        *active
	gen        uint64      // incremented by every Quiesce
	st         frozenStore // nil without a store
	emit       events.Emitter
	secrets    SecretFiles // nil without a secret store
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
		opts:               opts,
		steps:              steps{freezer: opts.Freezer, docker: opts.Docker, runHook: execHook, log: opts.Log},
		newID:              uuid.NewString,
		syncFS:             syncAll,
		markerEvery:        markerPoll,
		freezeBudget:       freezeBudget,
		storeFreezeTimeout: storeFreezeTimeout,
		unitMarkerWait:     unitMarkerWait,
		fsFreeze:           freezesFS,
		wipeSecrets:        WipesSecretFiles,
		emit:               opts.Emit,
		secrets:            opts.Secrets,
	}
	if opts.Store != nil {
		m.st = opts.Store
	}
	m.probeWrite = func() error { return writeProbe(opts.Layout.StateDir) }
	return m
}

// SetStore sets the store and the event emitter once the store is open and
// emits the events that waited for an emitter.
func (m *Manager) SetStore(st *store.Store, emit events.Emitter) {
	m.mu.Lock()
	defer m.mu.Unlock()
	m.st, m.emit = nil, emit
	if st != nil {
		m.st = st
	}
	if emit == nil {
		return
	}
	for _, ev := range m.queued {
		emit.Emit(events.TypeQuiesceAutoThawed, ev)
	}
	m.queued = nil
}

// SetSecrets sets the secret file store once the claim manager exists.
func (m *Manager) SetSecrets(s SecretFiles) {
	m.mu.Lock()
	defer m.mu.Unlock()
	m.secrets = s
}

// secretFiles returns the secret file store, or nil.
func (m *Manager) secretFiles() SecretFiles {
	m.mu.Lock()
	defer m.mu.Unlock()
	return m.secrets
}

// store returns the store, or nil.
func (m *Manager) store() frozenStore {
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

// leaseExpired is the error of a Quiesce that ran into its lease deadline
// or found its lease thawed by the watchdog unit.
func leaseExpired(id string) error {
	return errs.New(connect.CodeAborted, errs.LeaseExpired, "quiesce: lease "+id+" expired before the freeze completed")
}

// frozenByOther is the error of a filesystem frozen by someone else.
func frozenByOther(what string) error {
	return errs.New(connect.CodeFailedPrecondition, errs.FrozenByOther, what+" is frozen by someone else")
}

// Quiesce starts a lease of leaseMs (0 means DefaultLeaseMs) in the order of
// spec 14.2: lease file, watchdog unit and timer, Docker pause, freeze
// hooks, secret file wipe, sync, store freeze, FIFREEZE. A failing step
// undoes the earlier ones in reverse order. Without the fs freeze
// (Windows) fs=true fails with fs_freeze_unsupported and docker is
// ignored; wipeSecretFiles is ignored where the platform does not wipe
// (Linux: the secrets are on a tmpfs).
func (m *Manager) Quiesce(ctx context.Context, leaseMs uint32, docker, fs, wipeSecretFiles bool) (*agentv1.QuiesceResponse, error) {
	if leaseMs == 0 {
		leaseMs = DefaultLeaseMs
	}
	if leaseMs > MaxLeaseMs {
		return nil, errs.Newf(connect.CodeInvalidArgument, errs.InvalidArgument, "lease_ms must be in 1..%d", MaxLeaseMs)
	}
	if !m.fsFreeze {
		if fs {
			return nil, errs.New(connect.CodeFailedPrecondition, errs.FsFreezeUnsupported,
				"quiesce: the agent cannot freeze filesystems on this platform; freeze them with the QEMU guest agent (VSS)")
		}
		docker = false
	}
	wipe := wipeSecretFiles && m.wipeSecrets
	if wipe && m.secretFiles() == nil {
		// Before the claim manager is up: a snapshot taken now could hold
		// secret files from an earlier run.
		return nil, errs.New(connect.CodeUnavailable, errs.Internal,
			"quiesce: wipe_secret_files: the secret store is not ready yet")
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
	res, err := m.freeze(ctx, a, docker, fs, wipe)
	if err != nil {
		m.opts.Log.Warn("quiesce failed, rolling back", "lease", id, "err", err)
		rctx := context.WithoutCancel(ctx)
		if m.unitFired(a.id) {
			// The watchdog unit took the lease: undo what it did not see.
			// The lease was never handed out, so its marker is not
			// reported as an event.
			mk, ok := m.waitMarker(a.id)
			m.thawAfterUnit(rctx, a, mk)
			m.release(rctx, a, false)
			if ok {
				m.silenceMarker(mk)
			}
		} else {
			m.release(rctx, a, true)
		}
		return nil, err
	}
	m.opts.Log.Info("quiesced", "lease", id, "deadline", a.deadline,
		"containers", len(res.PausedContainers), "mounts", res.FrozenMounts)
	return res, nil
}

// freeze runs the steps of Quiesce after the lease file is written. The
// watchdog start and the docker, hook, wipe, sync, store and FIFREEZE steps
// end by freezeBudget or the lease deadline, whichever comes first, and stop early if the watchdog
// unit took the lease: a Quiesce never runs past its own deadline.
func (m *Manager) freeze(ctx context.Context, a *active, withDocker, withFS, wipe bool) (*agentv1.QuiesceResponse, error) {
	l := a.lease
	res := &agentv1.QuiesceResponse{LeaseId: a.id, Deadline: timestamppb.New(a.deadline)}
	save := func() error { return writeLease(m.opts.Layout.QuiesceFile, l) }

	// The budget counts from here: a slow watchdog unit start eats into it.
	cutoff := m.opts.Now().Add(m.freezeBudget)
	var cutoffErr error = errs.Newf(connect.CodeDeadlineExceeded, errs.QuiesceTimeout,
		"quiesce: the freeze steps took longer than %s", m.freezeBudget)
	if !a.deadline.After(cutoff) {
		cutoff, cutoffErr = a.deadline, leaseExpired(a.id)
	}

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

	ctx, cancel := context.WithDeadline(ctx, cutoff)
	defer cancel()
	check := func() error {
		if m.unitFired(a.id) {
			return leaseExpired(a.id)
		}
		if !m.opts.Now().Before(cutoff) {
			return cutoffErr
		}
		return nil
	}
	// fail reports a failed step; a step cut short by the cutoff or by the
	// watchdog unit reports that instead.
	fail := func(step string, err error) error {
		if cerr := check(); cerr != nil {
			return cerr
		}
		return internalErr(step, err)
	}

	// Docker.
	if withDocker && m.opts.Docker != nil {
		if err := check(); err != nil {
			return nil, err
		}
		dctx, dcancel := context.WithTimeout(ctx, dockerBudget)
		defer dcancel()
		ids, err := m.opts.Docker.Running(dctx)
		switch {
		case errors.Is(err, docker.ErrNoDaemon):
			m.opts.Log.Info("quiesce: docker is not running, nothing to pause")
		case err != nil:
			return nil, fail("list containers", err)
		case len(ids) > 0:
			// Every id is recorded before its pause.
			l.Paused = ids
			if err := save(); err != nil {
				return nil, internalErr("lease", err)
			}
			paused, err := m.steps.pauseAll(dctx, ids)
			res.PausedContainers = paused
			if err != nil {
				return nil, fail("pause containers", err)
			}
		}
	}

	// Hooks.
	hooks, err := listHooks(m.opts.Layout.QuiesceHooksDir)
	if err != nil {
		return nil, internalErr("hooks", err)
	}
	for _, h := range hooks {
		if err := check(); err != nil {
			return nil, err
		}
		l.Hooks = append(l.Hooks, h)
		if err := save(); err != nil {
			return nil, internalErr("lease", err)
		}
		if err := m.steps.runHook(ctx, h, hookFreeze); err != nil {
			return nil, fail("freeze hook", err)
		}
	}

	// Secret files, after the hooks: a hook may stop what holds them open.
	if sec := m.secretFiles(); wipe && sec != nil {
		if err := check(); err != nil {
			return nil, err
		}
		// Recorded before the wipe: every thaw restores them.
		l.SecretsWiped = true
		if err := save(); err != nil {
			return nil, internalErr("lease", err)
		}
		if _, err := sec.WipeSecretFiles(); err != nil {
			if errors.Is(err, errs.ErrSecretInUse) {
				return nil, errs.New(connect.CodeFailedPrecondition, errs.SecretsInUse,
					"quiesce: a secret file is held open by a process, stop the sandbox before the snapshot: "+err.Error())
			}
			return nil, fail("wipe secret files", err)
		}
	}

	if !withFS || m.opts.Freezer == nil {
		return res, check()
	}
	if err := check(); err != nil {
		return nil, err
	}
	m.syncBounded(ctx)
	mounts, err := m.opts.Freezer.Mounts()
	if err != nil {
		return nil, fail("list mounts", err)
	}
	if len(mounts) == 0 {
		return res, check()
	}
	if err := check(); err != nil {
		return nil, err
	}
	if err := m.freezeStore(ctx, a); err != nil {
		if cerr := check(); cerr != nil {
			return nil, cerr
		}
		return nil, err
	}
	for _, mt := range mounts {
		if err := check(); err != nil {
			return nil, err
		}
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
			return nil, fail("freeze "+mt.Path, err)
		}
		res.FrozenMounts = append(res.FrozenMounts, mt.Path)
	}
	if err := check(); err != nil {
		return nil, err
	}
	return res, nil
}

// syncBounded runs sync(2) and waits for it at most syncTimeout or until
// ctx ends.
func (m *Manager) syncBounded(ctx context.Context) {
	done := make(chan struct{})
	go func() {
		m.syncFS()
		close(done)
	}()
	t := time.NewTimer(syncTimeout)
	defer t.Stop()
	select {
	case <-done:
	case <-ctx.Done():
	case <-t.C:
		m.opts.Log.Warn("quiesce: sync is hanging, continuing")
	}
}

// freezeStore freezes the store for a, waiting at most storeFreezeTimeout
// or until ctx ends. A store that cannot freeze in time has a commit
// hanging, most likely on a filesystem frozen by someone else: the lease
// fails with unavailable/store_busy, and the late freeze is undone once it
// lands unless the lease active by then froze the store itself.
func (m *Manager) freezeStore(ctx context.Context, a *active) error {
	st := m.store()
	if st == nil {
		return nil
	}
	done := make(chan struct{})
	go func() {
		st.SetFrozen(true)
		close(done)
	}()
	t := time.NewTimer(m.storeFreezeTimeout)
	defer t.Stop()
	select {
	case <-done:
		a.storeFrozen = true
		return nil
	case <-ctx.Done():
	case <-t.C:
	}
	go func() {
		<-done
		m.opMu.Lock()
		defer m.opMu.Unlock()
		if cur := m.current(); cur == nil || !cur.storeFrozen {
			st.SetFrozen(false)
		}
	}()
	return errs.Newf(connect.CodeUnavailable, errs.StoreBusy,
		"quiesce: the state store did not stop writing within %s (a commit hangs; the filesystem may be frozen by someone else)",
		m.storeFreezeTimeout)
}

// unitFired reports whether the watchdog unit of lease id claimed the lease
// file or left its marker.
func (m *Manager) unitFired(id string) bool {
	if _, ok := readMarker(m.opts.Layout.QuiesceThawedDir, id, m.opts.Now()); ok {
		return true
	}
	l, err := readLease(claimPath(m.opts.Layout))
	return err == nil && l != nil && l.ID == id
}

// waitMarker waits up to unitMarkerWait for the marker of lease id.
func (m *Manager) waitMarker(id string) (marker, bool) {
	deadline := time.Now().Add(m.unitMarkerWait)
	for {
		if mk, ok := readMarker(m.opts.Layout.QuiesceThawedDir, id, m.opts.Now()); ok {
			return mk, true
		}
		if time.Now().After(deadline) {
			return marker{}, false
		}
		time.Sleep(10 * time.Millisecond)
	}
}

// awaitUnitMarker returns the watchdog unit's marker of a. If there is none
// yet but the unit already claimed the lease file (it is thawing right
// now), it waits up to unitMarkerWait for it.
func (m *Manager) awaitUnitMarker(a *active) (marker, bool) {
	if mk, ok := readMarker(m.opts.Layout.QuiesceThawedDir, a.id, m.opts.Now()); ok {
		return mk, true
	}
	if !a.watchdog {
		return marker{}, false
	}
	if _, err := os.Stat(m.opts.Layout.QuiesceFile); err == nil {
		return marker{}, false
	}
	return m.waitMarker(a.id)
}

// restoreSecrets writes back the secret files a wiped. A failure is
// logged and the thaw goes on: the claim manager has set the secrets phase
// pending, so the control plane sends the secrets again.
func (m *Manager) restoreSecrets(a *active) {
	if !a.lease.SecretsWiped {
		return
	}
	sec := m.secretFiles()
	if sec == nil {
		return
	}
	if err := sec.RestoreSecretFiles(); err != nil {
		m.opts.Log.Error("quiesce: restore secret files", "lease", a.id, "err", err)
	}
}

// thawAfterUnit completes the watchdog unit's thaw of a (marker mk, zero if
// the unit left none). The unit thawed what it read from the lease file,
// and the agent may have frozen, paused or run more after that read: FITHAW
// and unpause are repeated from the in-memory lease (EINVAL and "not
// paused" are harmless), hooks the unit did not thaw get thaw now.
func (m *Manager) thawAfterUnit(ctx context.Context, a *active, mk marker) {
	m.steps.thawMounts(a.lease.Frozen)
	// The unit cannot restore the secret files: they are in our memory.
	m.restoreSecrets(a)
	for _, h := range slices.Backward(a.lease.Hooks) {
		if slices.Contains(mk.Hooks, h) {
			continue
		}
		if err := m.steps.runHook(ctx, h, hookThaw); err != nil {
			m.opts.Log.Warn("quiesce: thaw hook failed", "hook", h, "err", err)
		}
	}
	m.steps.unpauseAll(ctx, a.lease.Paused)
}

// release ends a: with thaw it undoes the lease steps first (FITHAW, store
// unfreeze, secret file restore, hooks, unpause); then it stops the timer
// and the marker watch, deletes the lease file, stops the watchdog unit and
// deletes the unit's claim of a. opMu is held.
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
		m.steps.thawLease(ctx, a.lease, func() {
			unfreeze()
			m.restoreSecrets(a)
		})
	} else {
		unfreeze()
	}
	if a.timer != nil {
		a.timer.Stop()
	}
	a.stopOnce.Do(func() { close(a.stop) })
	// The lease file goes before the unit stop: the unit thaws on its stop
	// signal while the file is there.
	if err := removeLease(m.opts.Layout.QuiesceFile); err != nil {
		m.opts.Log.Error("quiesce: remove lease", "err", err)
	}
	if a.watchdog {
		if err := m.opts.Supervisor.StopWatchdog(ctx, a.id); err != nil {
			m.opts.Log.Warn("quiesce: stop watchdog", "lease", a.id, "err", err)
		}
		// A unit stopped mid-thaw leaves its claim of a; the thaw above
		// covered it, so the next start must not thaw it again.
		if l, err := readLease(claimPath(m.opts.Layout)); err == nil && l != nil && l.ID == a.id {
			if err := removeLease(claimPath(m.opts.Layout)); err != nil {
				m.opts.Log.Error("quiesce: remove watchdog claim", "err", err)
			}
		}
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
	var (
		mk   marker
		auto bool
	)
	if a := m.current(); a != nil && a.id == leaseID {
		mk, auto = m.awaitUnitMarker(a)
		if !auto {
			m.release(context.WithoutCancel(ctx), a, true)
			m.flush(ctx)
			m.opts.Log.Info("thawed", "lease", leaseID)
			return &agentv1.ThawResponse{}, nil
		}
		// The watchdog unit got there first.
		m.adopt(context.WithoutCancel(ctx), a, mk)
	} else {
		mk, auto = readMarker(m.opts.Layout.QuiesceThawedDir, leaseID, m.opts.Now())
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
	if mk, ok := m.awaitUnitMarker(a); ok {
		m.adopt(context.Background(), a, mk)
		return
	}
	m.release(context.Background(), a, true)
	m.opts.Log.Warn("quiesce lease expired, thawed", "lease", id, "by", by)
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

// adopt ends a after the watchdog unit thawed it (marker mk): what the unit
// did not see is thawed too, the store is unfrozen, the lease forgotten and
// the event emitted unless reported. opMu is held.
func (m *Manager) adopt(ctx context.Context, a *active, mk marker) {
	m.thawAfterUnit(ctx, a, mk)
	m.release(ctx, a, false)
	m.opts.Log.Warn("quiesce lease thawed by the watchdog unit", "lease", a.id, "at", mk.At)
	m.reportMarker(mk)
}

// silenceMarker marks mk reported without an event.
func (m *Manager) silenceMarker(mk marker) {
	if mk.Reported {
		return
	}
	mk.Reported = true
	if err := writeMarker(m.opts.Layout.QuiesceThawedDir, mk); err != nil {
		m.opts.Log.Error("quiesce: write marker", "err", err)
	}
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
	if l == nil && err == nil {
		// A watchdog unit that died while thawing leaves its claim.
		l, err = readLease(claimPath(m.opts.Layout))
	}
	removeBoth := func() {
		for _, p := range []string{m.opts.Layout.QuiesceFile, claimPath(m.opts.Layout)} {
			if rerr := removeLease(p); rerr != nil {
				m.opts.Log.Error("quiesce: remove lease", "err", rerr)
			}
		}
	}
	switch {
	case err != nil:
		// The lease is unreadable: thaw every mount and container.
		thawed, ferr := m.steps.thawAllMounts(nil)
		if ferr != nil {
			m.opts.Log.Error("quiesce: thaw mounts", "err", ferr)
		}
		unpaused := m.unpauseAllPaused(ctx)
		removeBoth()
		m.opts.Log.Error("quiesce: lease left by an earlier run was unreadable, thawed everything",
			"err", err, "mounts", thawed, "containers", unpaused)
		if len(thawed) > 0 || len(unpaused) > 0 {
			m.report("", m.opts.Now(), ByAgentStart)
		}
	case l != nil:
		m.steps.thawLease(ctx, l, nil)
		if m.opts.Supervisor != nil && validLeaseID(l.ID) {
			if serr := m.opts.Supervisor.StopWatchdog(ctx, l.ID); serr != nil {
				m.opts.Log.Warn("quiesce: stop watchdog", "lease", l.ID, "err", serr)
			}
		}
		removeBoth()
		m.opts.Log.Warn("quiesce lease left by an earlier run, thawed", "lease", l.ID)
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

// unpauseAllPaused unpauses every paused container and returns their ids.
func (m *Manager) unpauseAllPaused(ctx context.Context) []string {
	if m.opts.Docker == nil {
		return nil
	}
	dctx, cancel := context.WithTimeout(ctx, dockerBudget)
	defer cancel()
	ids, err := m.opts.Docker.Paused(dctx)
	if err != nil {
		if !errors.Is(err, docker.ErrNoDaemon) {
			m.opts.Log.Warn("quiesce: list paused containers", "err", err)
		}
		return nil
	}
	m.steps.unpauseAll(ctx, ids)
	return ids
}
