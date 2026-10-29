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
	c, err := m.lockEntry(ctx, rec.ID)
	if err != nil {
		return err
	}
	defer c.unlock()
	// A PTY without a recorded detach (records of older agents) counts from
	// now: an agent restart drops every attach. The value is persisted below.
	persistDetach := rec.PTY && rec.PTYDetachedAt == nil && rec.State != StateExited
	m.mu.Lock()
	m.loadLiveLocked(c, rec)
	if persistDetach {
		c.detachedAt = m.opts.Now()
	}
	m.mu.Unlock()

	sameBoot := rec.BootID == m.opts.BootID
	switch rec.State {
	case StateExited:
		if !sameBoot {
			return nil
		}
		// Leftovers may still run in the unit. A live shim keeps its
		// socket, so only those records need a unit query.
		if !fileExists(m.opts.Layout.ShimSocket(rec.ID)) {
			return nil
		}
		alive, err := m.unitState(ctx, rec.ID)
		if err != nil {
			return err
		}
		if alive {
			m.setUnit(c, false, false) //nolint:contextcheck // the idle timer outlives Recover
			m.startMonitor(c)          //nolint:contextcheck // the monitor outlives Recover
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
		if err := m.finalizeLocked(ctx, c, ex, true); err != nil {
			return err
		}
		m.markGone(c)
		return nil
	}

	err = m.settleLocked(ctx, c, rec, false)
	if errors.Is(err, errNotLaunched) {
		err = m.finalizeLocked(ctx, c, m.lostExit(rec.ID, rec.PTY, reasonShimLost), true)
		m.markGone(c)
	}
	if err != nil {
		return err
	}
	// The idle timer was armed by setUnit from the detach time.
	if persistDetach {
		m.queueSync(c) //nolint:contextcheck // the write outlives Recover
	}
	return nil
}
