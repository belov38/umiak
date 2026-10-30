package update

import (
	"log/slog"
	"sync"
	"time"

	"github.com/belov38/boat-dev-clone/services/guest-agent/internal/paths"
)

// StartGuard enforces the confirmation deadline of an unconfirmed update of
// the running version from the first step of the agent start (spec 17.4
// step 6). CheckPending runs only after the slow startup steps; a new
// version that hangs before it would never be rolled back. The guard reverts
// at the deadline and calls exit; Stop hands over to CheckPending.
type StartGuard struct {
	l    paths.Layout
	exit func()
	p    Pending

	mu    sync.Mutex
	timer stopper
	done  bool // fired or stopped
	fired bool // reverted (or tried to)
}

// GuardStart reads pending-update.json and, when the running version
// (version, or what current points at) is its target, arms the deadline: an
// expired deadline reverts the update and calls exit at once, a later one
// does so from a timer. Without such an update the guard does nothing. The
// returned guard is never nil.
func GuardStart(l paths.Layout, version string, now func() time.Time, exit func()) *StartGuard {
	return guardStart(l, version, now, exit, realAfterFunc)
}

// guardStart is GuardStart with a replaceable timer.
func guardStart(l paths.Layout, version string, now func() time.Time, exit func(), after func(time.Duration, func()) stopper) *StartGuard {
	g := &StartGuard{l: l, exit: exit}
	p, ok, err := readPending(l)
	if err != nil {
		// CheckPending removes an unreadable file later.
		slog.Warn("update: start guard: read pending update", "err", err)
	}
	if err != nil || !ok || !isTarget(l, p, version) {
		g.done = true
		return g
	}
	g.p = p
	remaining := p.Deadline.Sub(now())
	if remaining <= 0 {
		g.fire()
		return g
	}
	g.mu.Lock()
	g.timer = after(remaining, g.fire)
	g.mu.Unlock()
	return g
}

// fire reverts the guarded update unless the guard was stopped or
// pending-update.json changed meanwhile, then calls exit.
func (g *StartGuard) fire() {
	g.mu.Lock()
	defer g.mu.Unlock()
	if g.done {
		return
	}
	g.done = true
	if !pendingUnchanged(g.l, g.p) {
		return
	}
	g.fired = true
	slog.Error("update: not confirmed before the deadline, rolling back during the start", "from", g.p.From, "to", g.p.To)
	if err := revert(g.l, g.p, "not connected before the deadline"); err != nil {
		slog.Error("update: rollback failed", "err", err)
	}
	g.exit()
}

// Stop disarms the guard. It reports false when the guard already reverted
// the update and called exit.
func (g *StartGuard) Stop() bool {
	g.mu.Lock()
	defer g.mu.Unlock()
	if g.timer != nil {
		g.timer.Stop()
	}
	g.done = true
	return !g.fired
}

// isTarget reports whether the running version is the target of p: its
// version is p.To, or current points at p.To (a binary that reports another
// version must still be confirmed or rolled back by the deadline).
func isTarget(l paths.Layout, p Pending, version string) bool {
	if p.To == version {
		return true
	}
	cur, err := LinkVersion(l.CurrentLink)
	if err != nil {
		slog.Warn("update: cannot read the current link", "err", err)
	}
	return cur == p.To
}

// pendingUnchanged reports whether pending-update.json still holds p. An
// operator may have removed or replaced it (install-package --activate,
// rollback --to) since it was read.
func pendingUnchanged(l paths.Layout, p Pending) bool {
	cur, ok, err := readPending(l)
	if err != nil || !ok {
		return false
	}
	return cur.From == p.From && cur.To == p.To && cur.Deadline.Equal(p.Deadline)
}
