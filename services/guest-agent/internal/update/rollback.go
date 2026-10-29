package update

import (
	"errors"
	"fmt"
	"log/slog"
	"os"
	"path/filepath"
	"time"

	"github.com/belov38/boat-dev-clone/services/guest-agent/internal/fsutil"
	"github.com/belov38/boat-dev-clone/services/guest-agent/internal/paths"
)

// agentUnit is the unit Rollback restarts.
const agentUnit = "sbx-agent.service"

// stableFailurePause is how long Rollback waits before restarting a
// version that has no pending update (spec 17.4 step 6).
const stableFailurePause = 30 * time.Second

// Rollback is `sbx-agent rollback [--to v]`, run by
// sbx-agent-rollback.service when sbx-agent.service hits its start limit, or
// by hand through the QEMU guest agent (spec 17.4 step 6, 17.6):
//   - to set: current switches to the installed version to (previous becomes
//     the old current), an unfinished update is abandoned, and the agent is
//     restarted;
//   - a pending update: current goes back to its from version (previous is
//     left alone), to is added to bad-versions, the rollback is recorded for
//     update.result{rolled_back} at the next start and the pending file is
//     deleted;
//   - no pending update: versions stay, Rollback waits 30 s.
//
// The last two then reset the failed state and start the agent again, so a
// broken stable version is restarted forever with a pause instead of
// flipping versions. The start is --no-block: the rollback unit must not
// wait for the agent's readiness, and the agent may fail again and trigger
// this unit anew.
func Rollback(l paths.Layout, to string, systemctl func(args ...string) error, sleep func(time.Duration)) error {
	if to != "" {
		if err := rollbackTo(l, to); err != nil {
			return err
		}
		return restartAgent(systemctl, "restart")
	}
	p, ok, err := readPending(l)
	if err != nil {
		// An unreadable pending file cannot be acted on; keep restarting.
		slog.Error("rollback: cannot read the pending update", "err", err)
	}
	var rerr error
	if ok {
		slog.Warn("rollback: reverting an unconfirmed update", "from", p.From, "to", p.To)
		rerr = revert(l, p, "rolled back after repeated agent failures")
	} else {
		slog.Warn("rollback: no pending update, restarting the agent after a pause", "pause", stableFailurePause)
		sleep(stableFailurePause)
	}
	return errors.Join(rerr, restartAgent(systemctl, "start"))
}

// rollbackTo switches current to the installed version v.
func rollbackTo(l paths.Layout, v string) error {
	if err := ValidVersion(v); err != nil {
		return err
	}
	fi, err := os.Stat(filepath.Join(VersionDir(l, v), BinaryName))
	if err != nil {
		return fmt.Errorf("rollback: version %s is not installed: %w", v, err)
	}
	if !fi.Mode().IsRegular() {
		return fmt.Errorf("rollback: version %s has no agent binary", v)
	}
	cur, err := LinkVersion(l.CurrentLink)
	if err != nil {
		return err
	}
	if cur != v {
		if cur != "" {
			if err := pointLink(l, l.PreviousLink, cur); err != nil {
				return err
			}
		}
		if err := pointLink(l, l.CurrentLink, v); err != nil {
			return err
		}
	}
	p, ok, err := readPending(l)
	if err != nil {
		slog.Warn("rollback: removing an unreadable pending update", "err", err)
	}
	if ok {
		res := rollbackResult{From: p.From, To: p.To, Error: "manual rollback to " + v}
		if err := fsutil.WriteJSONAtomic(rollbackResultFile(l), res, 0o644); err != nil {
			return err
		}
	}
	if ok || err != nil {
		if err := removePending(l); err != nil {
			return err
		}
	}
	slog.Info("rollback: switched version", "from", cur, "to", v)
	return nil
}

// restartAgent clears the start limit of sbx-agent.service and starts (or
// restarts) it without waiting.
func restartAgent(systemctl func(args ...string) error, verb string) error {
	return errors.Join(
		systemctl("reset-failed", agentUnit),
		systemctl(verb, "--no-block", agentUnit),
	)
}
