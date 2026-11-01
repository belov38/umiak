package quiesce

import (
	"context"
	"errors"
	"io/fs"
	"log/slog"
	"os"
	"os/signal"
	"syscall"
	"time"

	"github.com/belov38/umiak/services/guest-agent/internal/paths"
)

// watchdogGrace delays the watchdog unit past the deadline, so the agent's
// own timer (at the deadline) normally wins and the unit finds the lease
// gone. The unit still thaws well within deadline + 5 s (spec 21, item 11).
const watchdogGrace = time.Second

// Watchdog is `umiak-agent quiesce-watchdog --lease <id>`, run in the
// transient unit umiak-quiesce-watchdog-<id>.service. It sleeps until the
// lease deadline (plus watchdogGrace) or its stop signal, re-reads the lease
// file and, if the
// lease is still there, claims the lease file (renames it), thaws it like
// Thaw, writes an unreported marker for the agent and deletes the claim. It
// returns the exit code: 0 also when the lease is already gone; f and d may
// be nil.
//
// On Windows it runs in the supervisor's watchdog job, which a restarted
// agent cannot stop: it acts only while its lease is still the one in the
// lease file. There it has no freezer and no Docker, so it runs the thaw
// hooks and drops the lease; the secret files are in the agent's memory,
// the agent restores them when it sees the marker.
func Watchdog(l paths.Layout, leaseID string, f Freezer, d DockerAPI) int {
	// SIGTERM (a reboot or poweroff stops every unit) ends the wait: the
	// lease is thawed at once instead of leaving the guest frozen through
	// the shutdown.
	ctx, stop := signal.NotifyContext(context.Background(), syscall.SIGTERM, os.Interrupt)
	defer stop()
	return runWatchdog(ctx, l, leaseID, steps{freezer: f, docker: d, runHook: execHook, log: slog.Default()}, time.Now)
}

// runWatchdog is Watchdog with explicit steps and clock.
func runWatchdog(ctx context.Context, l paths.Layout, leaseID string, s steps, now func() time.Time) int {
	log := s.log.With("lease", leaseID)
	if !validLeaseID(leaseID) {
		log.Error("quiesce watchdog: invalid lease id")
		return 2
	}
	lease, err := readLease(l.QuiesceFile)
	if err != nil {
		log.Error("quiesce watchdog: read lease", "err", err)
		return 1
	}
	if lease == nil || lease.ID != leaseID {
		log.Info("quiesce watchdog: lease already ended")
		return 0
	}
	if wait := lease.Deadline.Add(watchdogGrace).Sub(now()); wait > 0 {
		t := time.NewTimer(wait)
		select {
		case <-ctx.Done():
			t.Stop()
			log.Info("quiesce watchdog: stopped before the deadline, thawing now")
		case <-t.C:
		}
	}
	// The thaw runs to the end also after the stop signal.
	ctx = context.WithoutCancel(ctx)
	// Compare the id before the claim: renaming a lease the agent started
	// meanwhile and giving it back could clobber a newer one.
	lease, err = readLease(l.QuiesceFile)
	if err != nil || lease == nil || lease.ID != leaseID {
		log.Info("quiesce watchdog: lease ended before its deadline")
		return 0
	}
	// Claim the lease file: from here on the agent sees the unit thawing.
	claim := claimPath(l)
	if err := os.Rename(l.QuiesceFile, claim); err != nil {
		if errors.Is(err, fs.ErrNotExist) {
			log.Info("quiesce watchdog: lease ended before its deadline")
			return 0
		}
		log.Error("quiesce watchdog: claim lease", "err", err)
		return 1
	}
	s.thawLease(ctx, lease, nil)
	log.Warn("quiesce watchdog: lease expired, thawed", "mounts", lease.Frozen, "containers", lease.Paused)
	if err := writeMarker(l.QuiesceThawedDir, marker{LeaseID: leaseID, At: now(), By: ByWatchdog, Hooks: lease.Hooks}); err != nil {
		log.Error("quiesce watchdog: write marker", "err", err)
	}
	if err := removeLease(claim); err != nil {
		log.Error("quiesce watchdog: remove lease", "err", err)
		return 1
	}
	return 0
}
