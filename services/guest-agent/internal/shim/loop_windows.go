package shim

import (
	"errors"
	"path/filepath"
	"time"

	"golang.org/x/sys/windows"

	"github.com/belov38/boat-dev-clone/services/guest-agent/internal/fsutil"
	"github.com/belov38/boat-dev-clone/services/guest-agent/internal/shimproto"
	"github.com/belov38/boat-dev-clone/services/guest-agent/internal/winproc"
)

const (
	// tick is how often the job is recounted once the main process exited.
	tick = 250 * time.Millisecond
	// minIdle and maxIdle bound the wait of an idle round. Anonymous pipes
	// cannot be waited on, so the loop polls them; the wait doubles while
	// nothing arrives and resets after data or a wake-up.
	minIdle = 2 * time.Millisecond
	maxIdle = 50 * time.Millisecond
	// copyBufSize is the size of the copy buffer.
	copyBufSize = 64 << 10
	// readsPerWake bounds the reads of one stream per round, so a chatty
	// stream does not starve the others.
	readsPerWake = 16
	// drainLimit bounds the final drain of one stream after the exit: the
	// pipe buffer holds far less, so more means a leftover keeps writing.
	drainLimit = 16 << 20
	// maxJobErrors is how many failed job queries in a row (one per tick)
	// make the job count as empty.
	maxJobErrors = 20
	// ctrlC is the input byte that makes the ConPTY raise CTRL_C_EVENT.
	ctrlC = 0x03
)

// loop is the event loop: it copies output to the log files, detects the
// exit of the main process, runs the kill timers and returns when the
// command and its leftovers are done.
func (s *shim) loop() {
	buf := make([]byte, copyBufSize)
	idle := minIdle
	mainExited := false
	var lastCheck time.Time
	for {
		progress := false
		for _, st := range s.streams {
			if !st.eof && s.copy(st, buf, readsPerWake*copyBufSize) > 0 {
				progress = true
			}
		}
		if !mainExited {
			if code, ok := s.pollExit(); ok {
				mainExited = true
				s.onExit(code, buf)
				progress = true
			}
		}
		s.runTimers()

		if mainExited && time.Since(lastCheck) >= tick {
			lastCheck = time.Now()
			if s.finished(buf) {
				break
			}
		}
		if progress {
			idle = minIdle
			continue
		}
		if s.waitIdle(idle, mainExited) {
			idle = minIdle
		} else {
			idle = min(2*idle, maxIdle)
		}
	}
	s.shutdown()
}

// waitIdle waits up to idle (less when a timer is due) for the wake event
// or the exit of the main process. It reports whether something woke it.
func (s *shim) waitIdle(idle time.Duration, mainExited bool) bool {
	d := idle
	now := time.Now()
	s.mu.Lock()
	for _, at := range []time.Time{s.timeoutAt, s.hardKillAt} {
		if !at.IsZero() {
			d = min(d, at.Sub(now))
		}
	}
	s.mu.Unlock()
	if d <= 0 {
		return true
	}
	handles := []windows.Handle{s.wake}
	if !mainExited {
		handles = append(handles, s.proc.Handle())
	}
	// Round up so the timer is due when the wait returns.
	ms := uint32((d + time.Millisecond - 1) / time.Millisecond) //nolint:gosec // at most maxIdle
	r, err := windows.WaitForMultipleObjects(handles, false, ms)
	if err != nil {
		s.log.Error("shim: wait", "err", err)
		time.Sleep(d)
		return false
	}
	return r != uint32(windows.WAIT_TIMEOUT)
}

// wakeLocked interrupts the wait so the loop picks up a new timer. s.mu is
// held.
func (s *shim) wakeLocked() {
	if s.wake != 0 {
		_ = windows.SetEvent(s.wake)
	}
}

// pollExit reports the exit code of the main process once it exited.
// mainExited is set under mu with it, so a kill knows whether the job
// termination came before the exit.
func (s *shim) pollExit() (uint32, bool) {
	s.mu.Lock()
	defer s.mu.Unlock()
	h := s.proc.Handle()
	r, err := windows.WaitForSingleObject(h, 0)
	if err != nil || r != windows.WAIT_OBJECT_0 {
		return 0, false
	}
	var code uint32
	if err := windows.GetExitCodeProcess(h, &code); err != nil {
		s.log.Error("shim: exit code", "err", err)
		code = terminateCode
	}
	s.mainExited = true
	return code, true
}

// copy moves up to limit bytes (0 = until the pipe is empty) from the
// stream to its log file and returns how many. A broken pipe (no writer
// left) ends the stream.
func (s *shim) copy(st *stream, buf []byte, limit int) int {
	total := 0
	for limit == 0 || total < limit {
		var n uint32
		err := windows.ReadFile(st.h, buf, &n, nil)
		if n > 0 {
			total += int(n)
			s.writeLog(st, buf[:n])
		}
		switch {
		case err == nil && n == 0:
			// A zero-length write of the other side.
			return total
		case err == nil:
		case errors.Is(err, windows.ERROR_NO_DATA):
			return total
		case errors.Is(err, windows.ERROR_BROKEN_PIPE), errors.Is(err, windows.ERROR_PIPE_NOT_CONNECTED):
			st.eof = true
			return total
		default:
			s.log.Error("shim: read stream", "stream", st.name, "err", err)
			st.eof = true
			return total
		}
	}
	return total
}

// onExit records the exit of the main process: drain what it wrote (for a
// PTY close the console and read what it flushes), take the ends, write
// exit.json and tell the connected agents.
func (s *shim) onExit(code uint32, buf []byte) {
	for _, st := range s.streams {
		if !st.eof {
			s.copy(st, buf, drainLimit)
		}
	}
	if s.con != nil {
		s.mu.Lock()
		s.closeConsoleLocked()
		s.mu.Unlock()
		s.drainPTY(buf)
	}
	s.removeScript()

	e := ExitFile{EndedAt: time.Now().UTC()}
	s.setEnds(&e)
	s.mu.Lock()
	e.Status, e.Code, e.Reason = winExit(code, s.terminated, s.killReason, s.signalled)
	s.mu.Unlock()

	if err := fsutil.WriteJSONAtomic(filepath.Join(s.dir, ExitJSON), e, 0o600); err != nil {
		// The agent still gets the push; after its restart the command is LOST.
		s.log.Error("shim: write exit.json", "err", err)
	}

	s.mu.Lock()
	s.exited = true
	s.timeoutAt = time.Time{}
	var conns []*conn
	for c, ready := range s.conns {
		if ready {
			conns = append(conns, c)
		}
	}
	if s.spec.KillLeftovers {
		s.hardKillLocked()
	}
	s.mu.Unlock()
	s.log.Info("shim: command exited", "status", e.Status, "code", e.Code, "reason", e.Reason)

	for _, c := range conns {
		if err := c.send(shimproto.Message{Type: shimproto.TypeExited, Exit: &e}); err != nil {
			_ = c.c.Close()
		}
	}

	// Input is refused from now on; leftovers reading stdin get EOF. An
	// input stuck on a full pipe holds reqMu: it sees the request, gives up
	// and closes stdin itself, so the loop never waits for it.
	s.stdinCloseReq.Store(true)
	if s.reqMu.TryLock() {
		s.unlockReq()
	}
}

// drainPTY copies the ConPTY output after ClosePseudoConsole until the
// console host closes it, at most ptyFlushWait.
func (s *shim) drainPTY(buf []byte) {
	st := s.streams[0]
	deadline := time.Now().Add(ptyFlushWait)
	for !st.eof && time.Now().Before(deadline) {
		if s.copy(st, buf, drainLimit) == 0 && !st.eof {
			time.Sleep(minIdle)
		}
	}
}

// runTimers fires the timeout and the job termination after a grace.
func (s *shim) runTimers() {
	now := time.Now()
	s.mu.Lock()
	defer s.mu.Unlock()
	if !s.timeoutAt.IsZero() && !now.Before(s.timeoutAt) {
		s.timeoutAt = time.Time{}
		if !s.exited {
			s.log.Info("shim: timeout, killing the command")
			s.killLocked(sigTERM, s.spec.killGrace(), shimproto.ReasonTimeout)
		}
	}
	if !s.hardKillAt.IsZero() && !now.Before(s.hardKillAt) {
		s.hardKillAt = time.Time{}
		s.hardKillLocked()
	}
}

// finished reports whether the shim may exit after the main process has
// exited: when the job is empty, after one last drain; a PTY also waits
// (at most ptyEOFWait) for the console output to end. A job that stays
// unqueryable for maxJobErrors checks counts as empty, so a broken handle
// cannot keep the shim forever.
func (s *shim) finished(buf []byte) bool {
	n, err := s.job.ActiveProcesses()
	if err != nil {
		s.popErrs++
		if s.popErrs < maxJobErrors {
			return false
		}
		s.log.Error("shim: job unqueryable, treating it as empty", "err", err)
		n = 0
	}
	if n > 0 {
		s.popErrs = 0
		return false
	}
	for _, st := range s.streams {
		if !st.eof {
			s.copy(st, buf, drainLimit)
		}
	}
	if s.con != nil && !s.streams[0].eof {
		s.mu.Lock()
		since := time.Since(s.conClosedAt)
		s.mu.Unlock()
		return since >= ptyEOFWait
	}
	return true
}

// killLocked sends sig to the command and schedules the job termination
// after grace (now when grace is 0). Before the exit the first kill sets
// the exit reason. After the exit it acts on leftovers only and is a no-op
// without them. sig is supported (winSignalAction). s.mu is held.
func (s *shim) killLocked(sig int, grace time.Duration, reason string) {
	if s.exited {
		if !s.leftoversLocked() {
			return
		}
	} else if s.killReason == "" {
		s.killReason = reason
	}
	if err := s.signalLocked(sig); err != nil {
		s.log.Warn("shim: kill signal", "signal", sig, "err", err)
	}
	at := time.Now().Add(grace)
	if s.hardKillAt.IsZero() || at.Before(s.hardKillAt) {
		s.hardKillAt = at
	}
	s.wakeLocked()
}

// signalLocked delivers sig (S9 spec 12.6): SIGKILL terminates the job,
// SIGHUP closes the pseudo console, SIGINT and SIGTERM are CTRL_BREAK to
// the process group of the main process, or 0x03 into the ConPTY.
// s.mu is held.
func (s *shim) signalLocked(sig int) error {
	act, err := winSignalAction(sig, s.con != nil)
	if err != nil {
		return err
	}
	if s.jobClosed {
		return nil
	}
	switch act {
	case winTerminate:
		s.hardKillLocked()
	case winHangup:
		s.closeConsoleLocked()
	case winSoft:
		s.softLocked()
	}
	return nil
}

// softLocked is the soft stage of a kill. The pid of the main process is
// never reused while the shim holds its handle, so its group id stays
// valid after the exit: leftovers of that group are reached through the
// console of one of them. s.mu is held.
func (s *shim) softLocked() {
	if s.con != nil {
		if s.conClosing {
			return
		}
		var n uint32
		if err := windows.WriteFile(s.ptyIn, []byte{ctrlC}, &n, nil); err != nil || n != 1 {
			s.log.Warn("shim: ^C into the pty", "written", n, "err", err)
		}
		return
	}
	group := uint32(s.pid) //nolint:gosec // a Windows pid
	if !s.mainExited {
		if err := winproc.CtrlBreak(group); err != nil {
			s.log.Warn("shim: CTRL_BREAK", "err", err)
		}
		return
	}
	pids, err := s.job.ProcessIDs()
	if err != nil {
		s.log.Warn("shim: list leftovers", "err", err)
		return
	}
	for _, pid := range pids {
		if err := winproc.CtrlBreakGroup(pid, group); err == nil {
			return
		}
	}
	s.log.Warn("shim: CTRL_BREAK reached no leftover", "processes", len(pids))
}

// closeConsoleLocked starts ClosePseudoConsole once, in the background: it
// waits for the console host to flush, which needs the loop to keep
// reading the output. s.mu is held.
func (s *shim) closeConsoleLocked() {
	if s.con == nil || s.conClosing {
		return
	}
	s.conClosing = true
	s.conClosedAt = time.Now()
	con := s.con
	go func() {
		_ = con.Close()
		close(s.conClosed)
	}()
}

// hardKillLocked terminates every process of the job. A termination before
// the loop saw the main exit makes the exit KILLED. s.mu is held.
func (s *shim) hardKillLocked() {
	if s.jobClosed {
		return
	}
	if !s.mainExited {
		s.terminated = true
	}
	if err := s.job.Terminate(terminateCode); err != nil {
		s.log.Warn("shim: terminate the job", "err", err)
	}
}

// leftoversLocked reports whether processes of the command are still alive
// after the main process exited. s.mu is held.
func (s *shim) leftoversLocked() bool {
	if s.jobClosed {
		return false
	}
	n, err := s.job.ActiveProcesses()
	return err == nil && n > 0
}
