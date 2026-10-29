package update

import (
	"context"
	"crypto/ed25519"
	"errors"
	"log/slog"
	"os"
	"path/filepath"
	"slices"
	"sync"
	"time"

	"connectrpc.com/connect"
	"google.golang.org/protobuf/types/known/timestamppb"

	agentv1 "github.com/belov38/boat-dev-clone/libs/proto/sbx/agent/v1"

	"github.com/belov38/boat-dev-clone/services/guest-agent/internal/errs"
	"github.com/belov38/boat-dev-clone/services/guest-agent/internal/events"
	"github.com/belov38/boat-dev-clone/services/guest-agent/internal/paths"
)

// ConfirmWindow is how long a new version has to connect and serve
// Control/Info before it is rolled back (spec 17.4 step 4).
const ConfirmWindow = 120 * time.Second

// Defaults of the exit after a successful ApplyUpdate.
const (
	DefaultExitDelay   = 200 * time.Millisecond
	DefaultExitWaitMax = 5 * time.Second
)

// Options configures a Manager.
type Options struct {
	// Layout is the agent tree.
	Layout paths.Layout
	// Keys returns the update keys of the running version
	// (current/trust/update-keys.pub). Required.
	Keys func() []ed25519.PublicKey
	// Uploads maps an upload id to the path of the uploaded package
	// (files.Service.UploadPath). Required.
	Uploads func(id string) (string, error)
	// SelfTest runs the selftest of the new binary. Nil runs
	// ExecSelfTest with Schema and ShimProtos.
	SelfTest func(ctx context.Context, bin string) error
	// Exit stops the agent so systemd starts the new current version.
	// Required.
	Exit func()
	// Emit receives update.result. Required.
	Emit events.Emitter
	// Now is the clock. Default time.Now.
	Now func() time.Time
	// Version is the running agent version. Required.
	Version string
	// ShimProtos returns the protocol versions of live shims for the
	// default SelfTest.
	ShimProtos func() []int
	// Schema is the state.db schema for the default SelfTest.
	Schema int
	// ExitDelay is the pause between the end of the ApplyUpdate handler and
	// Exit, for the transport to flush the response. Default 200 ms.
	ExitDelay time.Duration
	// ExitWaitMax bounds the wait for the end of the handler when the
	// request context is never cancelled. Default 5 s.
	ExitWaitMax time.Duration
}

// Manager performs the self-update (spec 17.4): Apply installs an uploaded
// package and restarts into it, CheckPending and Confirm finish or roll back
// the update in the new version. It implements system.Updater.
type Manager struct {
	opts     Options
	exitOnce sync.Once

	mu       sync.Mutex
	applying bool        // Apply switched versions; the agent is about to exit
	pending  *Pending    // unconfirmed update of this version
	timer    *time.Timer // rolls back pending at its deadline
}

// New returns a Manager for opts.
func New(opts Options) (*Manager, error) {
	switch {
	case opts.Keys == nil:
		return nil, errors.New("update: Options.Keys is required")
	case opts.Uploads == nil:
		return nil, errors.New("update: Options.Uploads is required")
	case opts.Exit == nil:
		return nil, errors.New("update: Options.Exit is required")
	case opts.Emit == nil:
		return nil, errors.New("update: Options.Emit is required")
	case opts.Version == "":
		return nil, errors.New("update: Options.Version is required")
	}
	if opts.Now == nil {
		opts.Now = time.Now
	}
	if opts.ExitDelay <= 0 {
		opts.ExitDelay = DefaultExitDelay
	}
	if opts.ExitWaitMax <= 0 {
		opts.ExitWaitMax = DefaultExitWaitMax
	}
	return &Manager{opts: opts}, nil
}

// Apply implements system.Updater: spec 17.4 steps 2-5. The package of
// uploadID is unpacked and verified with the keys of the running version,
// placed in versions/<v> and self-tested; then pending-update.json is
// written and previous/current are switched. After the response the agent
// exits (see exitAfter); systemd starts the new version.
//
// Errors: update_in_progress (failed_precondition) while an update is
// unconfirmed; bad_version for the running version (invalid_argument) or a
// version in bad-versions without allowBad (failed_precondition);
// signature_invalid and invalid_argument for a bad package.
func (m *Manager) Apply(ctx context.Context, uploadID string, allowBad bool) (*agentv1.ApplyUpdateResponse, error) {
	m.mu.Lock()
	defer m.mu.Unlock()
	l := m.opts.Layout
	if m.applying {
		return nil, updateInProgress()
	}
	if _, ok, err := readPending(l); err != nil || ok {
		return nil, updateInProgress()
	}
	pkgPath, err := m.opts.Uploads(uploadID)
	if err != nil {
		return nil, err
	}

	pkgDir, cleanup, man, err := stage(l, pkgPath, m.opts.Keys())
	if err != nil {
		return nil, err
	}
	defer cleanup()
	from, to := m.opts.Version, man.Version
	if to == from {
		return nil, errs.Newf(connect.CodeInvalidArgument, errs.BadVersion, "version %s is already running", to)
	}
	if !allowBad {
		bad, err := readBadVersions(l)
		if err != nil {
			return nil, errs.Newf(connect.CodeInternal, errs.Internal, "read bad versions: %v", err)
		}
		if slices.Contains(bad, to) {
			return nil, errs.Newf(connect.CodeFailedPrecondition, errs.BadVersion, "version %s was rolled back before; set allow_bad_version to retry it", to)
		}
	}
	// Rollback needs the running version on disk.
	if fi, err := os.Stat(filepath.Join(VersionDir(l, from), BinaryName)); err != nil || !fi.Mode().IsRegular() {
		return nil, errs.Newf(connect.CodeFailedPrecondition, errs.FailedPrecondition, "running version %s is not installed in %s", from, l.VersionsDir)
	}

	created, err := placeVersion(l, pkgDir, man, m.opts.Keys())
	if err != nil {
		return nil, errs.Newf(connect.CodeInternal, errs.Internal, "install version %s: %v", to, err)
	}
	dropNew := func() {
		if created {
			if err := os.RemoveAll(VersionDir(l, to)); err != nil {
				slog.Warn("update: cannot remove rejected version", "version", to, "err", err)
			}
		}
	}
	if err := m.selfTest(ctx, filepath.Join(VersionDir(l, to), BinaryName)); err != nil {
		dropNew()
		return nil, errs.Newf(connect.CodeFailedPrecondition, errs.FailedPrecondition, "selftest of version %s failed: %v", to, err)
	}

	p := Pending{From: from, To: to, Deadline: m.opts.Now().Add(ConfirmWindow).UTC()}
	if err := writePending(l, p); err != nil {
		dropNew()
		return nil, errs.Newf(connect.CodeInternal, errs.Internal, "write pending update: %v", err)
	}
	if err := m.switchTo(p); err != nil {
		if rerr := pointLink(l, l.CurrentLink, from); rerr != nil {
			slog.Error("update: cannot restore current", "version", from, "err", rerr)
		}
		if rerr := removePending(l); rerr != nil {
			slog.Error("update: cannot remove pending update", "err", rerr)
		}
		return nil, errs.Newf(connect.CodeInternal, errs.Internal, "switch to version %s: %v", to, err)
	}
	m.applying = true
	slog.Info("update: switched version, restarting", "from", from, "to", to, "deadline", p.Deadline)
	go m.exitAfter(ctx)
	return &agentv1.ApplyUpdateResponse{From: from, To: to}, nil
}

// switchTo points previous at p.From and current at p.To.
func (m *Manager) switchTo(p Pending) error {
	l := m.opts.Layout
	if err := pointLink(l, l.PreviousLink, p.From); err != nil {
		return err
	}
	return pointLink(l, l.CurrentLink, p.To)
}

// selfTest runs the configured or the default selftest.
func (m *Manager) selfTest(ctx context.Context, bin string) error {
	if m.opts.SelfTest != nil {
		ctx, cancel := context.WithTimeout(ctx, SelfTestTimeout)
		defer cancel()
		return m.opts.SelfTest(ctx, bin)
	}
	var protos []int
	if m.opts.ShimProtos != nil {
		protos = m.opts.ShimProtos()
	}
	return ExecSelfTest(ctx, bin, m.opts.Schema, protos)
}

// exitAfter calls Exit once the ApplyUpdate response is out. The handler's
// ctx is the HTTP/2 request context, which net/http cancels when ServeHTTP
// returns, that is after the Connect handler and its interceptors (the
// request cache included) have written the response. ExitDelay then gives
// the HTTP/2 write loop time to flush the frames to the tunnel. If the
// context is never cancelled (a transport that does not), ExitWaitMax caps
// the wait.
func (m *Manager) exitAfter(ctx context.Context) {
	wait := time.NewTimer(m.opts.ExitWaitMax)
	defer wait.Stop()
	select {
	case <-ctx.Done():
	case <-wait.C:
	}
	time.Sleep(m.opts.ExitDelay)
	m.exit()
}

// exit calls Options.Exit at most once.
func (m *Manager) exit() {
	m.exitOnce.Do(m.opts.Exit)
}

// CheckPending runs at agent start before the tunnel connects (spec 6 step
// 2.4, 17.4 step 6). It removes leftovers of an interrupted install and
// reports a rollback recorded by a previous run as update.result
// {rolled_back}. If this version is the unconfirmed target of an update, an
// expired deadline reverts the update and exits; otherwise a timer does the
// same at the deadline unless Confirm comes first. A pending update for
// another version (an interrupted switch) is dropped and reported as rolled
// back.
func (m *Manager) CheckPending(ctx context.Context) error {
	l := m.opts.Layout
	if err := CleanTemp(l); err != nil {
		slog.Warn("update: cannot clean temporary install files", "err", err)
	}
	reported := m.reportRollback()

	p, ok, err := readPending(l)
	if err != nil {
		slog.Error("update: unreadable pending update, removing it", "err", err)
		return removePending(l)
	}
	if !ok {
		return nil
	}
	if p.To != m.opts.Version {
		slog.Warn("update: pending update is not for this version, dropping it", "from", p.From, "to", p.To, "running", m.opts.Version)
		if err := removePending(l); err != nil {
			return err
		}
		if !reported {
			m.opts.Emit.Emit(events.TypeUpdateResult, &agentv1.UpdateResult{
				From: p.From, To: p.To, RolledBack: true, Error: "the new version did not start",
			})
		}
		return nil
	}

	m.mu.Lock()
	defer m.mu.Unlock()
	remaining := p.Deadline.Sub(m.opts.Now())
	if remaining <= 0 {
		m.revertLocked(p)
		return nil
	}
	m.pending = &p
	m.timer = time.AfterFunc(remaining, m.deadlineExpired)
	go func() {
		<-ctx.Done()
		m.mu.Lock()
		defer m.mu.Unlock()
		if m.timer != nil {
			m.timer.Stop()
		}
	}()
	slog.Info("update: waiting for confirmation", "from", p.From, "to", p.To, "deadline", p.Deadline)
	return nil
}

// reportRollback emits update.result for a recorded rollback and deletes the
// record. It reports whether there was one.
func (m *Manager) reportRollback() bool {
	l := m.opts.Layout
	var r rollbackResult
	err := readRollbackResult(l, &r)
	if errors.Is(err, os.ErrNotExist) {
		return false
	}
	if err == nil {
		m.opts.Emit.Emit(events.TypeUpdateResult, &agentv1.UpdateResult{
			From: r.From, To: r.To, RolledBack: true, Error: r.Error,
		})
	} else {
		slog.Warn("update: unreadable rollback record", "err", err)
	}
	if err := os.Remove(rollbackResultFile(l)); err != nil {
		slog.Warn("update: cannot remove rollback record", "err", err)
	}
	return err == nil
}

// deadlineExpired is the confirmation timer.
func (m *Manager) deadlineExpired() {
	m.mu.Lock()
	defer m.mu.Unlock()
	if m.pending == nil {
		return
	}
	m.revertLocked(*m.pending)
}

// revertLocked reverts an unconfirmed update of this version and exits, so
// the old version starts and reports update.result{rolled_back}. Exit runs
// under the lock and must not call back into the Manager.
func (m *Manager) revertLocked(p Pending) {
	slog.Error("update: not confirmed before the deadline, rolling back", "from", p.From, "to", p.To)
	if err := revert(m.opts.Layout, p, "not connected before the deadline"); err != nil {
		slog.Error("update: rollback failed", "err", err)
	}
	m.pending = nil
	m.timer = nil
	m.exit()
}

// Confirm finishes the update of this version: call it after the first
// tunnel connection served Control/Info (spec 17.4 step 6). It deletes
// pending-update.json and emits update.result{ok}. Without a pending update
// it does nothing; a failed delete keeps the update pending, so a later
// Confirm retries.
func (m *Manager) Confirm() {
	m.mu.Lock()
	defer m.mu.Unlock()
	if m.pending == nil {
		return
	}
	if m.timer != nil {
		m.timer.Stop()
	}
	if err := removePending(m.opts.Layout); err != nil {
		slog.Error("update: cannot confirm the update", "err", err)
		return
	}
	p := *m.pending
	m.pending, m.timer = nil, nil
	slog.Info("update: confirmed", "from", p.From, "to", p.To)
	m.opts.Emit.Emit(events.TypeUpdateResult, &agentv1.UpdateResult{From: p.From, To: p.To, Ok: true})
}

// Status implements system.Updater: the pending update and the bad
// versions, or nil when there are neither.
func (m *Manager) Status() *agentv1.UpdateStatus {
	l := m.opts.Layout
	st := &agentv1.UpdateStatus{}
	if p, ok, err := readPending(l); err == nil && ok {
		st.Pending, st.From, st.To, st.Deadline = true, p.From, p.To, timestamppb.New(p.Deadline)
	}
	if bad, err := readBadVersions(l); err == nil {
		st.BadVersions = bad
	}
	if !st.GetPending() && len(st.GetBadVersions()) == 0 {
		return nil
	}
	return st
}

// updateInProgress is the error of an Apply during an unconfirmed update.
func updateInProgress() *connect.Error {
	return errs.New(connect.CodeFailedPrecondition, errs.UpdateInProgress, "an agent update is in progress")
}
