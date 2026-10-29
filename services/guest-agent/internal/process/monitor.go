package process

import (
	"context"
	"errors"
	"os"
	"path/filepath"
	"strings"
	"time"

	"google.golang.org/protobuf/types/known/timestamppb"

	agentv1 "github.com/belov38/boat-dev-clone/libs/proto/sbx/agent/v1"

	"github.com/belov38/boat-dev-clone/services/guest-agent/internal/events"
	"github.com/belov38/boat-dev-clone/services/guest-agent/internal/fsutil"
	"github.com/belov38/boat-dev-clone/services/guest-agent/internal/shim"
	"github.com/belov38/boat-dev-clone/services/guest-agent/internal/shimproto"
	"github.com/belov38/boat-dev-clone/services/guest-agent/internal/store"
	"github.com/belov38/boat-dev-clone/services/guest-agent/internal/supervisor"
)

// exitInfo is the end of a command as it goes into the record.
type exitInfo struct {
	status  string // statusExited, statusKilled or statusLost
	reason  string
	signal  string
	code    int32
	endedAt time.Time
	ends    map[string]uint64
}

// exitFromFile converts exit.json.
func exitFromFile(e shimproto.ExitFile, pty bool) exitInfo {
	ex := exitInfo{status: strings.ToUpper(e.Status), reason: e.Reason, signal: e.Signal, code: e.Code,
		endedAt: e.EndedAt.UTC(), ends: map[string]uint64{}}
	if ex.status != statusKilled {
		ex.status = statusExited
	}
	if ex.reason == "" {
		ex.reason = shimproto.ReasonNone
	}
	if pty {
		ex.ends[shim.PtyFile] = nonNeg(e.PtyEnd)
	} else {
		ex.ends[shim.StdoutFile] = nonNeg(e.StdoutEnd)
		ex.ends[shim.StderrFile] = nonNeg(e.StderrEnd)
	}
	return ex
}

func nonNeg(n int64) uint64 {
	if n < 0 {
		return 0
	}
	return uint64(n)
}

// currentEnds returns an exitInfo whose ends are the current log sizes, for
// a command whose shim cannot report them.
func (m *Manager) currentEnds(id string, pty bool) exitInfo {
	ex := exitInfo{endedAt: m.opts.Now().UTC(), ends: map[string]uint64{}}
	for _, s := range streamNames(pty) {
		var size int64
		if fi, err := os.Stat(m.cmdPath(id, s)); err == nil {
			size = fi.Size()
		}
		ex.ends[s] = nonNeg(size)
	}
	return ex
}

// lostExit is the end of a command whose shim is gone.
func (m *Manager) lostExit(id string, pty bool, reason string) exitInfo {
	ex := m.currentEnds(id, pty)
	ex.status, ex.reason = statusLost, reason
	return ex
}

func (m *Manager) cmdPath(id, name string) string {
	return filepath.Join(m.opts.Layout.CommandDir(id), name)
}

// readExit reads exit.json of id.
func (m *Manager) readExit(id string) (shimproto.ExitFile, bool) {
	var e shimproto.ExitFile
	if err := fsutil.ReadJSON(m.cmdPath(id, shim.ExitJSON), &e); err != nil {
		if !errors.Is(err, os.ErrNotExist) {
			m.log.Warn("process: read exit.json", "id", id, "err", err)
		}
		return e, false
	}
	return e, true
}

func (m *Manager) isPTY(c *command) bool {
	m.mu.Lock()
	defer m.mu.Unlock()
	return c.pty
}

// finalizeLocked records the end of the main process: the EXITED record,
// command.exited and, for a PTY, pty.closed. An already exited record is
// left alone. The events are emitted before the record is written, so a
// crash in between repeats them after Recover instead of losing them.
// c.recMu is held.
func (m *Manager) finalizeLocked(ctx context.Context, c *command, ex exitInfo) error {
	rec, ok, err := m.st.GetCommand(c.id)
	if err != nil {
		return err
	}
	if !ok || rec.State == StateExited {
		m.mainExited(c, false)
		return nil
	}
	rec.State = StateExited
	rec.Exit = &store.ExitRecord{Status: ex.status, Reason: ex.reason, Signal: ex.signal, Code: ex.code}
	rec.EndedAt = ex.endedAt
	if rec.EndedAt.IsZero() {
		rec.EndedAt = m.opts.Now().UTC()
	}
	rec.Ends = ex.ends
	m.emitExit(rec)
	if err := m.st.PutCommand(ctx, rec); err != nil {
		return err
	}
	m.mainExited(c, true)
	return nil
}

// mainExited updates the live state after the end of the main process and
// wakes the waiters if anything changed (always when the record changed).
func (m *Manager) mainExited(c *command, recordChanged bool) {
	m.mu.Lock()
	defer m.mu.Unlock()
	changed := recordChanged || c.mainAlive || c.idle != nil
	c.mainAlive = false
	if c.idle != nil {
		c.idle.Stop()
		c.idle = nil
	}
	if changed {
		m.notifyLocked(c)
	}
}

// emitExit publishes the events of an exited record.
func (m *Manager) emitExit(rec *store.Command) {
	ee := exitEvent(rec)
	m.opts.Emit.Emit(events.TypeCommandExited, &agentv1.CommandExited{
		CommandId: rec.ID,
		Status:    ee.GetStatus(),
		Code:      ee.GetCode(),
		Signal:    ee.GetSignal(),
		Reason:    ee.GetReason(),
		StdoutEnd: ee.GetStdoutEnd(),
		StderrEnd: ee.GetStderrEnd(),
		PtyEnd:    ee.GetPtyEnd(),
		EndedAt:   ee.GetEndedAt(),
	})
	if rec.PTY {
		m.opts.Emit.Emit(events.TypePtyClosed, &agentv1.PtyClosed{CommandId: rec.ID, Reason: ee.GetReason()})
	}
}

// exitEvent is the ExitEvent of an exited record.
func exitEvent(rec *store.Command) *agentv1.ExitEvent {
	ee := &agentv1.ExitEvent{
		StdoutEnd: rec.Ends[shim.StdoutFile],
		StderrEnd: rec.Ends[shim.StderrFile],
		PtyEnd:    rec.Ends[shim.PtyFile],
	}
	if !rec.EndedAt.IsZero() {
		ee.EndedAt = timestamppb.New(rec.EndedAt)
	}
	if e := rec.Exit; e != nil {
		ee.Status = exitStatusEnum(e.Status)
		ee.Code = e.Code
		ee.Signal = e.Signal
		ee.Reason = exitReasonEnum(e.Reason)
	}
	return ee
}

func exitStatusEnum(s string) agentv1.ExitStatus {
	return agentv1.ExitStatus(agentv1.ExitStatus_value["EXIT_STATUS_"+s])
}

func exitReasonEnum(s string) agentv1.ExitReason {
	return agentv1.ExitReason(agentv1.ExitReason_value["EXIT_REASON_"+s])
}

// markRunningLocked moves a STARTING record to RUNNING with the pid and the
// start time of the shim. c.recMu is held.
func (m *Manager) markRunningLocked(ctx context.Context, c *command, pid int, sf shim.ShimFile) error {
	rec, ok, err := m.st.GetCommand(c.id)
	if err != nil || !ok || rec.State != StateStarting {
		return err
	}
	rec.State = StateRunning
	rec.Pid = pid
	rec.StartedAt = sf.StartedAt.UTC()
	if rec.StartedAt.IsZero() {
		rec.StartedAt = m.opts.Now().UTC()
	}
	if err := m.st.PutCommand(ctx, rec); err != nil {
		return err
	}
	m.mu.Lock()
	m.notifyLocked(c)
	m.mu.Unlock()
	return nil
}

// markGone records that the unit of c is gone: no main process, no
// leftovers, no shim.
func (m *Manager) markGone(c *command) {
	m.mu.Lock()
	defer m.mu.Unlock()
	c.unitAlive, c.mainAlive, c.leftovers = false, false, false
	if c.idle != nil {
		c.idle.Stop()
		c.idle = nil
	}
	m.notifyLocked(c)
}

// setUnit records a live unit and whether its main process exited with
// leftovers behind.
func (m *Manager) setUnit(c *command, mainAlive, leftovers bool) {
	m.mu.Lock()
	defer m.mu.Unlock()
	leftovers = leftovers && !mainAlive
	if c.unitAlive && c.mainAlive == mainAlive && c.leftovers == leftovers {
		return
	}
	c.unitAlive, c.mainAlive, c.leftovers = true, mainAlive, leftovers
	m.notifyLocked(c)
}

// unitState returns whether the unit of id is alive.
func (m *Manager) unitState(ctx context.Context, id string) (bool, error) {
	st, err := m.sup.State(ctx, id)
	if err != nil {
		return false, err
	}
	return st == supervisor.UnitActive, nil
}

// settleLocked reconciles a STARTING or RUNNING record with the disk and
// the unit (spec 9.2 step 5 and 9.6): exit.json present → finalize; unit
// alive → monitor; shim.json present (or RUNNING) → LOST/SHIM_LOST.
// A STARTING record without shim.json and without a unit returns
// errNotLaunched and is left alone. c.recMu is held.
func (m *Manager) settleLocked(ctx context.Context, c *command, rec *store.Command) error {
	alive, err := m.unitState(ctx, c.id)
	if err != nil {
		return storeError(err)
	}
	pty := m.isPTY(c)
	if e, ok := m.readExit(c.id); ok {
		dctx, cancel := m.durableCtx(ctx)
		defer cancel()
		if err := m.finalizeLocked(dctx, c, exitFromFile(e, pty)); err != nil {
			return storeError(err)
		}
		if alive {
			// The shim still runs: leftovers or its own shutdown. The
			// monitor asks it.
			m.setUnit(c, false, false)
			m.startMonitor(c) //nolint:contextcheck // the monitor outlives the request
		} else {
			m.markGone(c)
		}
		return nil
	}
	if alive {
		m.setUnit(c, true, false)
		m.startMonitor(c) //nolint:contextcheck // the monitor outlives the request
		return nil
	}
	if rec.State == StateStarting && !fileExists(m.cmdPath(c.id, shim.ShimJSON)) {
		return errNotLaunched
	}
	dctx, cancel := m.durableCtx(ctx)
	defer cancel()
	if err := m.finalizeLocked(dctx, c, m.lostExit(c.id, pty, reasonShimLost)); err != nil {
		return storeError(err)
	}
	m.markGone(c)
	return nil
}

// startMonitor starts the monitor of c unless one runs.
func (m *Manager) startMonitor(c *command) {
	m.mu.Lock()
	defer m.mu.Unlock()
	if m.closed || c.monitoring {
		return
	}
	c.monitoring = true
	m.wg.Add(1)
	go func() {
		defer m.wg.Done()
		m.monitor(c)
		m.mu.Lock()
		c.monitoring = false
		m.mu.Unlock()
	}()
}

// monitorMinGap rate-limits monitor rounds woken by file events.
const monitorMinGap = 20 * time.Millisecond

// monitor follows the shim of c until its unit is gone: it keeps a
// connection open, records the exit and the leftovers, and falls back to
// exit.json and the unit state when the shim cannot be reached. Between
// rounds it waits for a change in the command directory (exit.json) or
// Poll.
func (m *Manager) monitor(c *command) {
	dir := m.opts.Layout.CommandDir(c.id)
	watched := false
	defer func() {
		if watched {
			m.watch.remove(dir)
		}
	}()
	for {
		if !watched {
			watched = m.watch.add(dir)
		}
		m.mu.Lock()
		wake := c.wake
		m.mu.Unlock()
		if m.step(c) {
			return
		}
		select {
		case <-m.ctx.Done():
			return
		case <-wake:
			select {
			case <-m.ctx.Done():
				return
			case <-time.After(monitorMinGap):
			}
		case <-time.After(m.opts.Poll):
		}
	}
}

// step runs one round of the monitor and reports whether it is done.
func (m *Manager) step(c *command) bool {
	ctx := m.ctx
	if ctx.Err() != nil {
		return true
	}
	alive, err := m.unitState(ctx, c.id)
	if err != nil {
		m.log.Warn("process: unit state", "id", c.id, "err", err)
		return false
	}
	pty := m.isPTY(c)
	e, hasExit := m.readExit(c.id)
	if !alive {
		m.settleGone(c, e, hasExit, pty)
		return true
	}
	dctx, cancel := context.WithTimeout(ctx, dialTimeout)
	client, err := shimproto.Dial(dctx, m.opts.Layout.ShimSocket(c.id))
	cancel()
	if err != nil {
		var perr *shimproto.Error
		outdated := errors.As(err, &perr) && perr.Code == shimproto.CodeShimOutdated
		if outdated {
			m.mu.Lock()
			c.outdated = true
			m.mu.Unlock()
		}
		if hasExit {
			// An outdated shim cannot report leftovers: its live unit is
			// the best evidence. Otherwise the shim is just shutting down.
			m.finalize(c, exitFromFile(e, pty))
			m.setUnit(c, false, outdated)
		}
		return false
	}
	m.serve(c, client)
	return false
}

// settleGone handles a unit that is gone: finalize from exit.json, or
// LOST/SHIM_LOST, or nothing for a STARTING record that never launched.
func (m *Manager) settleGone(c *command, e shimproto.ExitFile, hasExit, pty bool) {
	if hasExit {
		m.finalize(c, exitFromFile(e, pty))
		m.markGone(c)
		return
	}
	c.recMu.Lock()
	rec, ok, err := m.st.GetCommand(c.id)
	if err == nil && ok && rec.State != StateExited {
		if rec.State == StateStarting && !fileExists(m.cmdPath(c.id, shim.ShimJSON)) {
			c.recMu.Unlock()
			m.markGone(c)
			return
		}
		if err := m.finalizeLocked(m.ctx, c, m.lostExit(c.id, pty, reasonShimLost)); err != nil {
			m.log.Warn("process: record lost command", "id", c.id, "err", err)
		}
	}
	c.recMu.Unlock()
	m.markGone(c)
}

// finalize is finalizeLocked for background callers.
func (m *Manager) finalize(c *command, ex exitInfo) {
	c.recMu.Lock()
	defer c.recMu.Unlock()
	if err := m.finalizeLocked(m.ctx, c, ex); err != nil {
		m.log.Warn("process: record exit", "id", c.id, "err", err)
	}
}

// serve uses one shim connection until it closes.
func (m *Manager) serve(c *command, client *shimproto.Client) {
	m.mu.Lock()
	c.client, c.outdated = client, false
	m.notifyLocked(c)
	m.mu.Unlock()
	defer func() {
		m.mu.Lock()
		if c.client == client {
			c.client = nil
		}
		m.mu.Unlock()
		_ = client.Close()
	}()

	pty := m.isPTY(c)
	st, err := m.status(client)
	if err != nil {
		return
	}
	if st.Exited {
		m.exitedWith(c, client, nil, pty, st.Leftovers)
	} else {
		var sf shim.ShimFile
		_ = fsutil.ReadJSON(m.cmdPath(c.id, shim.ShimJSON), &sf)
		c.recMu.Lock()
		if err := m.markRunningLocked(m.ctx, c, st.Pid, sf); err != nil {
			m.log.Warn("process: record running command", "id", c.id, "err", err)
		}
		c.recMu.Unlock()
		m.setUnit(c, true, false)
	}
	for {
		select {
		case e := <-client.Exited():
			m.exitedWith(c, client, &e, pty, false)
		case <-client.Done():
			select {
			case e := <-client.Exited():
				m.exitedWith(c, client, &e, pty, false)
			default:
			}
			return
		case <-m.ctx.Done():
			return
		}
	}
}

// exitedWith records the exit reported by the shim (e, or exit.json when
// e is nil) and asks the shim about leftovers unless known.
func (m *Manager) exitedWith(c *command, client *shimproto.Client, e *shimproto.ExitFile, pty, leftovers bool) {
	if e == nil {
		f, ok := m.readExit(c.id)
		if !ok {
			return
		}
		e = &f
	} else if st, err := m.status(client); err == nil {
		leftovers = st.Leftovers
	}
	m.finalize(c, exitFromFile(*e, pty))
	m.setUnit(c, false, leftovers)
}

func (m *Manager) status(client *shimproto.Client) (shimproto.Status, error) {
	ctx, cancel := context.WithTimeout(m.ctx, shimTimeout)
	defer cancel()
	return client.Status(ctx)
}
