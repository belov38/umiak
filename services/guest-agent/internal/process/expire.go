package process

import (
	"context"
	"errors"
	"fmt"
	"os"
	"time"

	"github.com/belov38/boat-dev-clone/services/guest-agent/internal/shim"
	"github.com/belov38/boat-dev-clone/services/guest-agent/internal/store"
)

// startingExpired reports whether rec is a STARTING record older than
// StartingTTL.
func (m *Manager) startingExpired(rec *store.Command) bool {
	return rec.State == StateStarting && m.opts.Now().Sub(rec.CreatedAt) > m.opts.StartingTTL
}

// expireStarting ends the STARTING records among recs that were never
// launched and whose start nobody retried within StartingTTL (the records
// Recover keeps for a retry). It returns how many it ended. Only STARTING
// records are looked at, so a janitor tick stays cheap.
func (m *Manager) expireStarting(recs []*store.Command) int {
	n := 0
	for _, rec := range recs {
		if !m.startingExpired(rec) {
			continue
		}
		ok, err := m.expireOne(rec.ID)
		if err != nil {
			m.warnUnlessClosed("process: expire unretried start", rec.ID, err)
		}
		if ok {
			n++
		}
	}
	return n
}

// expireOne ends the STARTING record of id under its lock if it is still
// expired and was never launched: no unit, no shim.json, no exit.json.
func (m *Manager) expireOne(id string) (bool, error) {
	ctx := m.ctx
	c, err := m.lockEntry(ctx, id)
	if err != nil {
		return false, err
	}
	defer c.unlock()
	rec, ok, err := m.st.GetCommand(id)
	if err != nil || !ok || !m.startingExpired(rec) {
		return false, err
	}
	m.mu.Lock()
	launching := c.mainAlive || c.unitAlive
	if !launching {
		m.loadLiveLocked(c, rec)
	}
	m.mu.Unlock()
	if launching || fileExists(m.cmdPath(id, shim.ShimJSON)) || fileExists(m.cmdPath(id, shim.ExitJSON)) {
		return false, nil
	}
	alive, err := m.unitState(ctx, id)
	if err != nil || alive {
		return false, err
	}
	if err := m.expireLocked(ctx, c); err != nil {
		return false, err
	}
	return true, nil
}

// expireLocked ends an unlaunched STARTING record as EXITED/START_FAILED
// with code 127 and a line in its last stream, emits command.exited and
// removes the stale cmd-spec file. The record lock of c is held.
func (m *Manager) expireLocked(ctx context.Context, c *command) error {
	if err := os.Remove(m.opts.Layout.CmdSpec(c.id)); err != nil && !errors.Is(err, os.ErrNotExist) {
		m.log.Warn("process: remove stale cmd-spec", "id", c.id, "err", err)
	}
	m.log.Warn("process: start was never retried, ending the command", "id", c.id, "ttl", m.opts.StartingTTL)
	return m.recordStartFailedLocked(ctx, c, "start was never retried within "+formatTTL(m.opts.StartingTTL), true)
}

// formatTTL renders whole hours as "24h", anything else as Duration does.
func formatTTL(d time.Duration) string {
	if d > 0 && d%time.Hour == 0 {
		return fmt.Sprintf("%dh", d/time.Hour)
	}
	return d.String()
}
