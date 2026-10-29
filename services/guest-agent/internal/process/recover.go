package process

import (
	"context"
	"errors"
	"fmt"

	"github.com/belov38/boat-dev-clone/services/guest-agent/internal/store"
)

// Recover rebuilds the live state from the records after an agent start
// (spec 6 step 3 and 9.6). After a reboot (another boot id) every STARTING
// or RUNNING command without exit.json is LOST/REBOOT. Within the same boot
// each command is finalized from exit.json, reconnected to its live unit,
// or marked LOST/SHIM_LOST. PTY idle timers resume from pty_detached_at.
func (m *Manager) Recover(ctx context.Context) error {
	var recs []*store.Command
	// Collect first: writing while a bbolt read transaction is open can
	// block the writer.
	if err := m.st.ListCommands(func(c *store.Command) bool {
		recs = append(recs, c)
		return true
	}); err != nil {
		return fmt.Errorf("process: recover: %w", err)
	}
	var errList []error
	for _, rec := range recs {
		if err := m.recoverOne(ctx, rec); err != nil {
			errList = append(errList, fmt.Errorf("command %s: %w", rec.ID, err))
		}
	}
	return errors.Join(errList...)
}

func (m *Manager) recoverOne(ctx context.Context, rec *store.Command) error {
	c := m.entry(rec.ID)
	c.recMu.Lock()
	defer c.recMu.Unlock()
	m.mu.Lock()
	c.pty = rec.PTY
	if rec.PTYDetachedAt != nil {
		c.detachedAt = *rec.PTYDetachedAt
	}
	m.mu.Unlock()

	sameBoot := rec.BootID == m.opts.BootID
	switch rec.State {
	case StateExited:
		if !sameBoot {
			return nil
		}
		// Leftovers may still run in the unit.
		alive, err := m.unitState(ctx, rec.ID)
		if err != nil {
			return err
		}
		if alive {
			m.setUnit(c, false, false)
			m.startMonitor(c) //nolint:contextcheck // the monitor outlives Recover
		}
		return nil
	case StateStarting, StateRunning:
	default:
		return fmt.Errorf("unknown state %q", rec.State)
	}

	if !sameBoot {
		ex := m.lostExit(rec.ID, rec.PTY, reasonReboot)
		if e, ok := m.readExit(rec.ID); ok {
			ex = exitFromFile(e, rec.PTY)
		}
		if err := m.finalizeLocked(ctx, c, ex); err != nil {
			return err
		}
		m.markGone(c)
		return nil
	}

	err := m.settleLocked(ctx, c, rec)
	if errors.Is(err, errNotLaunched) {
		err = m.finalizeLocked(ctx, c, m.lostExit(rec.ID, rec.PTY, reasonShimLost))
		m.markGone(c)
	}
	if err != nil {
		return err
	}
	m.restoreIdle(c, rec) //nolint:contextcheck // the idle timer outlives Recover
	return nil
}

// restoreIdle arms the PTY idle timer of a recovered command: from the
// recorded detach, or from now when none is recorded (an agent restart
// drops every attach, so it counts as a detach).
func (m *Manager) restoreIdle(c *command, rec *store.Command) {
	m.mu.Lock()
	defer m.mu.Unlock()
	if !c.pty || !c.mainAlive {
		return
	}
	now := m.opts.Now()
	after := m.opts.PTYIdle
	if rec.PTYDetachedAt != nil {
		after = max(rec.PTYDetachedAt.Add(m.opts.PTYIdle).Sub(now), 0)
	} else {
		c.detachedAt = now
	}
	m.armIdleLocked(c, after)
}
