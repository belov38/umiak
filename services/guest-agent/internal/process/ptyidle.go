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
	c.idleGen++
	gen := c.idleGen
	c.idle = time.AfterFunc(d, func() { m.idleExpired(c, gen) })
}

// ensureIdleLocked arms the idle timer of a live, detached PTY command
// that has none, counting from the recorded detach (the creation time for a
// PTY that was never attached). m.mu is held.
func (m *Manager) ensureIdleLocked(c *command) {
	if c.idle != nil {
		return
	}
	d := m.opts.PTYIdle
	if !c.detachedAt.IsZero() {
		d = max(c.detachedAt.Add(m.opts.PTYIdle).Sub(m.opts.Now()), 0)
	}
	m.armIdleLocked(c, d)
}

// idleExpired hangs up an idle PTY command (spec 9.4): SIGHUP to the
// session, the cgroup kill after PTYHangupGrace, reason PTY_IDLE. Without a
// shim connection it retries after Poll; an outdated shim gets the cgroup
// kill at once. gen identifies the timer that fired; a timer stopped or
// replaced after it fired does nothing.
func (m *Manager) idleExpired(c *command, gen uint64) {
	m.mu.Lock()
	if c.idle == nil || c.idleGen != gen {
		m.mu.Unlock()
		return
	}
	c.idle = nil
	if m.closed || c.attaches > 0 || !c.mainAlive || !c.pty {
		m.mu.Unlock()
		return
	}
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
		m.warnUnlessClosed("process: pty idle kill", c.id, err)
	}
	if outdated {
		if err := m.sup.KillCgroup(ctx, c.id); err != nil && !errors.Is(err, supervisor.ErrUnitNotFound) {
			m.warnUnlessClosed("process: pty idle cgroup kill", c.id, err)
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
		m.queueSync(c)
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
		m.queueSync(c)
	}
}

// queueSync schedules syncDetached for c unless one is already queued, so
// attach churn does not pile up goroutines (they would all wait on the
// record lock during a freeze).
func (m *Manager) queueSync(c *command) {
	m.mu.Lock()
	if m.closed || c.syncing {
		m.mu.Unlock()
		return
	}
	c.syncing = true
	m.wg.Add(1)
	m.mu.Unlock()
	go func() {
		defer m.wg.Done()
		m.syncDetached(c)
	}()
}

// syncDetached writes the current detach time of c (none while attached)
// into its record. The queued flag is cleared before the value is read, so
// a change after that read queues another write.
func (m *Manager) syncDetached(c *command) {
	locked := m.lockLive(c)
	m.mu.Lock()
	c.syncing = false
	at := c.detachedAt
	m.mu.Unlock()
	if !locked {
		return
	}
	defer c.unlock()
	rec, ok, err := m.st.GetCommand(c.id)
	if err != nil || !ok || rec.State == StateExited {
		return
	}
	switch {
	case at.IsZero() && rec.PTYDetachedAt == nil:
		return
	case at.IsZero():
		rec.PTYDetachedAt = nil
	case rec.PTYDetachedAt != nil && rec.PTYDetachedAt.Equal(at):
		return
	default:
		t := at.UTC()
		rec.PTYDetachedAt = &t
	}
	if err := m.st.PutCommand(m.ctx, rec); err != nil {
		m.warnUnlessClosed("process: record pty detach", c.id, err)
	}
}

// Linux signal numbers used by the agent itself. The agent drives a Linux
// shim, so it does not use the host's syscall constants.
const (
	sigHUP  syscall.Signal = 1
	sigKILL syscall.Signal = 9
)
