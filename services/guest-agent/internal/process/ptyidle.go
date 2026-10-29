package process

import (
	"context"
	"errors"
	"syscall"
	"time"

	"github.com/belov38/boat-dev-clone/services/guest-agent/internal/shimproto"
	"github.com/belov38/boat-dev-clone/services/guest-agent/internal/supervisor"
)

// armIdleLocked (re)starts the PTY idle timer of c to fire after d. It does
// nothing for a non-PTY command, an exited one or one with an attach open.
// m.mu is held.
func (m *Manager) armIdleLocked(c *command, d time.Duration) {
	if c.idle != nil {
		c.idle.Stop()
		c.idle = nil
	}
	if m.closed || !c.pty || !c.mainAlive || c.attaches > 0 {
		return
	}
	c.idle = time.AfterFunc(d, func() { m.idleExpired(c) })
}

// idleExpired hangs up an idle PTY command (spec 9.4): SIGHUP to the
// session, the cgroup kill after PTYHangupGrace, reason PTY_IDLE. Without a
// shim connection it retries after Poll; an outdated shim gets the cgroup
// kill at once.
func (m *Manager) idleExpired(c *command) {
	m.mu.Lock()
	if m.closed || c.attaches > 0 || !c.mainAlive || !c.pty {
		m.mu.Unlock()
		return
	}
	c.idle = nil
	client, outdated := c.client, c.outdated
	m.wg.Add(1)
	m.mu.Unlock()
	defer m.wg.Done()

	ctx, cancel := context.WithTimeout(m.ctx, shimTimeout)
	defer cancel()
	if client != nil {
		grace := uint32(min(m.opts.PTYHangupGrace.Milliseconds(), int64(^uint32(0)))) //nolint:gosec // clamped
		err := client.Kill(ctx, grace, sigHUP, shimproto.ReasonPTYIdle)
		if err == nil {
			return
		}
		m.log.Warn("process: pty idle kill", "id", c.id, "err", err)
	}
	if outdated {
		if err := m.sup.KillCgroup(ctx, c.id); err != nil && !errors.Is(err, supervisor.ErrUnitNotFound) {
			m.log.Warn("process: pty idle cgroup kill", "id", c.id, "err", err)
		}
		return
	}
	m.mu.Lock()
	m.armIdleLocked(c, m.opts.Poll)
	m.mu.Unlock()
}

// addAttach counts an attach stream of c. The first attach of a PTY command
// stops its idle timer and clears pty_detached_at.
func (m *Manager) addAttach(c *command) {
	m.mu.Lock()
	c.attaches++
	first := c.attaches == 1 && c.pty
	if first {
		if c.idle != nil {
			c.idle.Stop()
			c.idle = nil
		}
		c.detachedAt = time.Time{}
	}
	m.notifyLocked(c)
	m.mu.Unlock()
	if first {
		m.goBackground(func() { m.syncDetached(c) })
	}
}

// dropAttach releases an attach stream. The last detach of a live PTY
// command records pty_detached_at and arms the idle timer.
func (m *Manager) dropAttach(c *command) {
	m.mu.Lock()
	c.attaches--
	last := c.attaches == 0 && c.pty && c.mainAlive
	if last {
		c.detachedAt = m.opts.Now()
		m.armIdleLocked(c, m.opts.PTYIdle)
	}
	m.notifyLocked(c)
	m.mu.Unlock()
	if last {
		m.goBackground(func() { m.syncDetached(c) })
	}
}

// syncDetached writes the current detach time of c (none while attached)
// into its record. Each write takes the latest live value, so writes that
// race each other still end with the right one.
func (m *Manager) syncDetached(c *command) {
	c.recMu.Lock()
	defer c.recMu.Unlock()
	m.mu.Lock()
	at := c.detachedAt
	m.mu.Unlock()
	rec, ok, err := m.st.GetCommand(c.id)
	if err != nil || !ok || rec.State == StateExited {
		return
	}
	switch {
	case at.IsZero() && rec.PTYDetachedAt == nil:
		return
	case at.IsZero():
		rec.PTYDetachedAt = nil
	default:
		t := at.UTC()
		rec.PTYDetachedAt = &t
	}
	if err := m.st.PutCommand(m.ctx, rec); err != nil {
		m.log.Warn("process: record pty detach", "id", c.id, "err", err)
	}
}

// Linux signal numbers used by the agent itself. The agent drives a Linux
// shim, so it does not use the host's syscall constants.
const (
	sigHUP  syscall.Signal = 1
	sigKILL syscall.Signal = 9
)
