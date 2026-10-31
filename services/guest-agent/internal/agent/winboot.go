package agent

// The Windows start (S9 spec 12.3, 11.2). Before the S3 sequence the agent
// waits while Windows Setup runs, then waits for early.json of this boot
// from the startup script `sbx-agent early`, and runs the boot step itself
// when the script did not finish in time. Before that step and before a
// reboot for the computer name it waits for the clone first-boot script
// (firstboot.done), which Windows Setup runs from SetupComplete.cmd while
// the service already runs. The identity is then applied with
// ident.ApplyWindows (ModeService) instead of ident.Apply. Until the boot
// step is done nothing is served; if it fails, the identity phase fails and
// Claim, UpdateSecrets and Process/Start (outside the admin socket) answer
// unavailable identity_not_ready. Once the identity is ready the agent
// starts sshd. The orchestration has no build tag so the darwin tests run
// it with fakes.

import (
	"context"
	"errors"
	"fmt"
	"io/fs"
	"os"
	"strings"
	"time"

	"connectrpc.com/connect"

	agentv1 "github.com/belov38/boat-dev-clone/libs/proto/sbx/agent/v1"

	"github.com/belov38/boat-dev-clone/services/guest-agent/internal/errs"
	"github.com/belov38/boat-dev-clone/services/guest-agent/internal/ident"
	"github.com/belov38/boat-dev-clone/services/guest-agent/internal/paths"
	"github.com/belov38/boat-dev-clone/services/guest-agent/internal/system"
)

// Defaults of the WinBoot timings.
const (
	DefaultSetupPoll  = 5 * time.Second
	DefaultEarlyWait  = 60 * time.Second
	DefaultEarlyPoll  = time.Second
	DefaultRebootWait = 2 * time.Minute

	DefaultFirstBootWait = 5 * time.Minute
	DefaultFirstBootPoll = 2 * time.Second
)

// WinBoot configures the Windows start. Zero timings take the defaults.
type WinBoot struct {
	// Resetter applies the Windows identity. Required.
	Resetter ident.WinResetter
	// SetupInProgress reports a running Windows Setup. Default
	// ident.SetupInProgress.
	SetupInProgress func() bool
	// StartSSH starts the sshd service once the identity is ready; an
	// already running service is not an error. Default: the service
	// control manager on Windows, nothing elsewhere.
	StartSSH func(ctx context.Context) error

	// SetupPoll is the period of the Windows Setup check. Default 5 s.
	SetupPoll time.Duration
	// EarlyWait bounds the wait for early.json of this boot. Default 60 s.
	EarlyWait time.Duration
	// EarlyPoll is the period of the early.json check. Default 1 s.
	EarlyPoll time.Duration
	// RebootWait bounds the wait for a reboot the boot step asked for.
	// Default 2 min.
	RebootWait time.Duration
	// FirstBootWait bounds the wait for the clone first-boot script
	// (firstboot.done) before the boot step and the rename reboot.
	// Default 5 min.
	FirstBootWait time.Duration
	// FirstBootPoll is the period of the firstboot.done check. Default 2 s.
	FirstBootPoll time.Duration
}

// withDefaults fills the defaults and checks the required fields.
func (w WinBoot) withDefaults() (*WinBoot, error) {
	if w.Resetter == nil {
		return nil, errors.New("agent: WinBoot.Resetter is required")
	}
	if w.SetupInProgress == nil {
		w.SetupInProgress = ident.SetupInProgress
	}
	if w.StartSSH == nil {
		w.StartSSH = defaultStartSSH
	}
	if w.SetupPoll <= 0 {
		w.SetupPoll = DefaultSetupPoll
	}
	if w.EarlyWait <= 0 {
		w.EarlyWait = DefaultEarlyWait
	}
	if w.EarlyPoll <= 0 {
		w.EarlyPoll = DefaultEarlyPoll
	}
	if w.RebootWait <= 0 {
		w.RebootWait = DefaultRebootWait
	}
	if w.FirstBootWait <= 0 {
		w.FirstBootWait = DefaultFirstBootWait
	}
	if w.FirstBootPoll <= 0 {
		w.FirstBootPoll = DefaultFirstBootPoll
	}
	return &w, nil
}

// sleepCtx waits for d or until ctx ends.
func sleepCtx(ctx context.Context, d time.Duration) error {
	t := time.NewTimer(d)
	defer t.Stop()
	select {
	case <-ctx.Done():
		return ctx.Err()
	case <-t.C:
		return nil
	}
}

// firstBootPending reports whether the clone first-boot script is installed
// (l.SetupCompleteScript exists) and has not written l.FirstBootDone yet.
// Always false for a layout without these paths (Linux).
func firstBootPending(l paths.Layout) bool {
	if l.SetupCompleteScript == "" || l.FirstBootDone == "" {
		return false
	}
	if _, err := os.Stat(l.SetupCompleteScript); err != nil {
		return false
	}
	_, err := os.Stat(l.FirstBootDone)
	return errors.Is(err, fs.ErrNotExist)
}

// waitFirstBoot polls every poll until the clone first-boot script is done
// (see firstBootPending), at most wait. It reports false on a timeout and
// returns the error of sleep (ctx ended).
func waitFirstBoot(ctx context.Context, l paths.Layout, wait, poll time.Duration,
	now func() time.Time, sleep func(context.Context, time.Duration) error) (bool, error) {
	deadline := now().Add(wait)
	for firstBootPending(l) {
		if !now().Before(deadline) {
			return false, nil
		}
		if err := sleep(ctx, poll); err != nil {
			return false, err
		}
	}
	return true, nil
}

// awaitFirstBoot waits once per run for the clone first-boot script, which
// Windows Setup runs from SetupComplete.cmd while the service already runs:
// a reboot for the computer name would cut it off. A timeout is logged and
// the start goes on.
func (a *agent) awaitFirstBoot(ctx context.Context) error {
	if a.firstBootWaited || !firstBootPending(a.l) {
		return nil
	}
	a.firstBootWaited = true
	w := a.d.WinBoot
	a.log.Info("agent: waiting for the clone first-boot script", "marker", a.l.FirstBootDone, "wait", w.FirstBootWait)
	done, err := waitFirstBoot(ctx, a.l, w.FirstBootWait, w.FirstBootPoll, time.Now, sleepCtx)
	if err != nil {
		return err
	}
	if !done {
		a.log.Warn("agent: the clone first-boot script did not finish in time, going on", "marker", a.l.FirstBootDone, "wait", w.FirstBootWait)
		return nil
	}
	a.log.Info("agent: the clone first-boot script finished")
	return nil
}

// windowsBootStep waits out Windows Setup and the boot step of this boot
// (early.json with a.bootID), running the step in the service when the
// startup script did not write the marker within EarlyWait, or right after
// a Windows Setup the service saw running. A step that
// asked for a reboot is given RebootWait to happen. It returns ctx.Err()
// when the run stops meanwhile, another error when the step failed.
func (a *agent) windowsBootStep(ctx context.Context) error {
	w := a.d.WinBoot
	if w.SetupInProgress() {
		a.log.Info("agent: windows setup is in progress, waiting")
		for w.SetupInProgress() {
			if err := sleepCtx(ctx, w.SetupPoll); err != nil {
				return err
			}
		}
		a.log.Info("agent: windows setup finished")
		// The startup script of this boot ran during Setup and skipped
		// the step (first boot of a clone): no early.json is coming.
		if !ident.EarlyDoneForBoot(a.l.EarlyFile, a.bootID) {
			return a.runEarlyStep(ctx)
		}
		return nil
	}
	deadline := time.Now().Add(w.EarlyWait)
	for !ident.EarlyDoneForBoot(a.l.EarlyFile, a.bootID) {
		if !time.Now().Before(deadline) {
			return a.runEarlyStep(ctx)
		}
		if err := sleepCtx(ctx, w.EarlyPoll); err != nil {
			return err
		}
	}
	return nil
}

// runEarlyStep runs `sbx-agent early` in the service (ModeService).
func (a *agent) runEarlyStep(ctx context.Context) error {
	w := a.d.WinBoot
	if err := a.awaitFirstBoot(ctx); err != nil {
		return err
	}
	a.log.Warn("agent: the startup script did not finish the boot step of this boot, running it in the service")
	if err := ident.EarlyIn(ctx, a.l, a.d.IdentSource, w.Resetter, ident.ModeService); err != nil {
		if ctx.Err() != nil {
			return ctx.Err()
		}
		return fmt.Errorf("agent: boot step: %w", err)
	}
	if ident.EarlyDoneForBoot(a.l.EarlyFile, a.bootID) {
		return nil
	}
	// No marker: the step rebooted for the computer name, or Windows Setup
	// started again.
	a.log.Warn("agent: the boot step asked for a reboot, waiting for it", "wait", w.RebootWait)
	if err := sleepCtx(ctx, w.RebootWait); err != nil {
		return err
	}
	return errors.New("agent: the boot step asked for a reboot that did not happen")
}

// applyIdentityWindows is applyIdentity on Windows: after a failed boot
// step the identity phase fails with its error; otherwise the identity is
// applied with ident.ApplyWindows (ModeService), rebooting when the
// computer name is not in effect.
func (a *agent) applyIdentityWindows(ctx context.Context) {
	if a.bootErr != nil {
		a.log.Error("agent: boot step failed, running without identity", "err", a.bootErr)
		a.identity.fail(a.bootErr)
		return
	}
	w := a.d.WinBoot
	id, err := a.readIdentity(ctx)
	if err == nil {
		var changed, reboot bool
		changed, reboot, err = ident.ApplyWindows(ctx, a.l, id, w.Resetter, ident.ModeService)
		if changed {
			a.log.Warn("agent: the machine identity changed after the boot step; the agent reset the identity",
				"machine_id", id.MachineID)
		}
		if err == nil && reboot {
			err = a.awaitFirstBoot(ctx)
		}
		if err == nil && reboot {
			a.log.Warn("agent: the computer name is not in effect, rebooting")
			if rerr := w.Resetter.Reboot("sbx identity changed"); rerr != nil {
				err = fmt.Errorf("agent: reboot for the computer name: %w", rerr)
			} else {
				_ = sleepCtx(ctx, w.RebootWait)
				err = errors.New("agent: the reboot for the computer name did not happen")
			}
			a.bootErr = err
		}
	}
	if err != nil {
		a.log.Error("agent: no machine identity, running without the tunnel", "err", err)
		a.identity.fail(err)
		return
	}
	a.identity.set(id)
}

// bootGate refuses Claim-like calls while the Windows boot step failed.
func (a *agent) bootGate() error {
	if a.d.WinBoot == nil || a.bootErr == nil {
		return nil
	}
	return errs.New(connect.CodeUnavailable, errs.IdentityNotReady, "the boot step of this boot did not complete: "+a.bootErr.Error())
}

// waitSecrets is process.Options.WaitSecrets: the boot gate, then the
// claim's wait for pending secrets. A call on the admin socket skips the
// secrets wait (exec works after PrepareStop) and, for a command run as
// SYSTEM, also the boot gate; a command of another user still needs a
// completed boot step, which wiped the secret files of the last boot.
func (a *agent) waitSecrets(ctx context.Context, spec *agentv1.CommandSpec) error {
	admin := isAdminCall(ctx)
	if !admin || !a.runsAsSystem(spec) {
		if err := a.bootGate(); err != nil {
			return err
		}
	}
	if admin {
		return nil
	}
	return a.claim.WaitSecrets(ctx)
}

// runsAsSystem reports whether spec runs as SYSTEM (or its alias root).
func (a *agent) runsAsSystem(spec *agentv1.CommandSpec) bool {
	u := spec.GetUser()
	if u == "" {
		u = a.cfg.DefaultUser
	}
	return strings.EqualFold(u, "SYSTEM") || u == "root"
}

// startSSH starts sshd in the background on Windows once the identity is
// ready.
func (a *agent) startSSH(ctx context.Context) {
	if a.d.WinBoot == nil {
		return
	}
	a.goBG(func() {
		if err := a.d.WinBoot.StartSSH(ctx); err != nil {
			a.log.Warn("agent: start sshd", "err", err)
			return
		}
		a.log.Info("agent: sshd started")
	})
}

// gatedClaimer is the system.Claimer of the agent: UpdateSecrets passes the
// boot gate first (Claim checks the identity phase itself).
type gatedClaimer struct {
	system.Claimer
	a *agent
}

// UpdateSecrets implements system.Claimer.
func (g gatedClaimer) UpdateSecrets(ctx context.Context, req *agentv1.UpdateSecretsRequest) (*agentv1.UpdateSecretsResponse, error) {
	if err := g.a.bootGate(); err != nil {
		return nil, err
	}
	return g.Claimer.UpdateSecrets(ctx, req)
}
