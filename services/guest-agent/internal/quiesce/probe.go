package quiesce

import (
	"context"
	"os"
	"path/filepath"
	"strconv"
	"time"
)

// probeFile is the file the foreign-freeze probe rewrites in StateDir.
const probeFile = ".quiesce-probe"

// writeProbe writes and syncs a small file in dir. On a frozen filesystem
// it blocks until the thaw.
func writeProbe(dir string) error {
	if err := os.MkdirAll(dir, 0o700); err != nil {
		return err
	}
	f, err := os.OpenFile(filepath.Join(dir, probeFile), os.O_WRONLY|os.O_CREATE|os.O_TRUNC, 0o600)
	if err != nil {
		return err
	}
	_, werr := f.WriteString(strconv.FormatInt(time.Now().UnixNano(), 10))
	serr := f.Sync()
	cerr := f.Close()
	switch {
	case werr != nil:
		return werr
	case serr != nil:
		return serr
	default:
		return cerr
	}
}

// RunProbe watches for a foreign freeze until ctx ends (spec 14.4): while
// the agent has no lease of its own, it writes and syncs a probe file in
// StateDir every ProbeEvery; a write that hangs for ProbeTimeout makes it
// FITHAW every block filesystem and emit quiesce.auto_thawed{by: foreign}.
// It also drops expired auto-thaw markers.
func (m *Manager) RunProbe(ctx context.Context) {
	t := time.NewTicker(m.opts.ProbeEvery)
	defer t.Stop()
	for {
		select {
		case <-ctx.Done():
			return
		case <-t.C:
		}
		m.pruneMaybe()
		m.probeAndThaw(ctx)
	}
}

// probeAndThaw runs one probe (or joins the one in flight) and thaws a
// foreign freeze if it hangs for ProbeTimeout. It does nothing while a
// lease of the agent is active.
func (m *Manager) probeAndThaw(ctx context.Context) {
	if m.current() != nil {
		return
	}
	done, gen := m.startProbe()
	t := time.NewTimer(m.opts.ProbeTimeout)
	defer t.Stop()
	select {
	case <-done:
		return
	case <-ctx.Done():
		return
	case <-t.C:
	}
	m.thawForeign(gen)
}

// startProbe starts a probe write unless one is in flight and returns its
// completion channel and the lease generation at its start.
func (m *Manager) startProbe() (<-chan struct{}, uint64) {
	m.mu.Lock()
	defer m.mu.Unlock()
	if m.probeDone != nil {
		if m.cur == nil && m.probeGen != m.gen {
			// The agent's own leases since the probe began have ended: a
			// write still hanging now is not blocked by them.
			m.probeGen = m.gen
		}
		return m.probeDone, m.probeGen
	}
	done := make(chan struct{})
	m.probeDone, m.probeGen = done, m.gen
	go func() {
		if err := m.probeWrite(); err != nil {
			m.opts.Log.Warn("quiesce: probe write failed", "err", err)
		}
		m.mu.Lock()
		m.probeDone = nil
		m.mu.Unlock()
		close(done)
	}()
	return done, m.probeGen
}

// thawForeign thaws every block filesystem after a probe started at lease
// generation gen hung. If a lease of the agent started since then, the
// agent's own freeze may be what blocked the probe, and nothing is done.
// The event is emitted only when a filesystem was actually frozen.
func (m *Manager) thawForeign(gen uint64) {
	m.opMu.Lock()
	defer m.opMu.Unlock()
	m.mu.Lock()
	ours := m.cur != nil || m.gen != gen
	m.mu.Unlock()
	if ours {
		return
	}
	thawed, err := m.steps.thawAllMounts(nil)
	if err != nil {
		m.opts.Log.Error("quiesce: foreign freeze: list mounts", "err", err)
	}
	if len(thawed) == 0 {
		m.opts.Log.Warn("quiesce: probe write hangs but no filesystem was frozen")
		return
	}
	m.opts.Log.Warn("quiesce: thawed a foreign freeze", "mounts", thawed)
	m.report("", m.opts.Now(), ByForeign)
}

// pruneMaybe drops expired markers at most once per prunePeriod.
func (m *Manager) pruneMaybe() {
	now := m.opts.Now()
	m.mu.Lock()
	due := now.Sub(m.lastPruned) >= prunePeriod
	if due {
		m.lastPruned = now
	}
	m.mu.Unlock()
	if due {
		pruneMarkers(m.opts.Layout.QuiesceThawedDir, now)
	}
}
