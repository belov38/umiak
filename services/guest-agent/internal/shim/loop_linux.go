//go:build linux

package shim

import (
	"errors"
	"path/filepath"
	"syscall"
	"time"

	"golang.org/x/sys/unix"

	"github.com/belov38/boat-dev-clone/services/guest-agent/internal/fsutil"
	"github.com/belov38/boat-dev-clone/services/guest-agent/internal/shimproto"
)

const (
	// tick bounds the poll timeout: cgroup.events, orphan reaping and the
	// fallback exit check (no pidfd) run at least this often.
	tick = 250 * time.Millisecond
	// copyBufSize is the size of the copy buffer.
	copyBufSize = 64 << 10
	// readsPerWake bounds the reads of one stream per poll round, so a
	// chatty stream does not starve the others.
	readsPerWake = 16
	// drainLimit bounds the final drain of one stream after the exit: the
	// pipe buffer holds far less, so more means a leftover keeps writing.
	drainLimit = 16 << 20
	// maxPopulatedErrors is how many failed cgroup.events reads in a row
	// (one per tick) make the payload count as empty.
	maxPopulatedErrors = 20
)

// loop is the event loop: it copies output to the log files, detects the
// exit of the main process, runs the kill timers and returns when the
// command and its leftovers are done.
func (s *shim) loop() {
	buf := make([]byte, copyBufSize)
	fds := make([]unix.PollFd, 0, 4)
	idx := make([]*stream, 0, 2)
	mainExited := false
	var lastCheck time.Time
	for {
		fds = append(fds[:0], unix.PollFd{Fd: int32(s.wakeR), Events: unix.POLLIN}) //nolint:gosec // fd fits
		if !mainExited && s.pidfd >= 0 {
			fds = append(fds, unix.PollFd{Fd: int32(s.pidfd), Events: unix.POLLIN}) //nolint:gosec // fd fits
		}
		first := len(fds)
		idx = idx[:0]
		for _, st := range s.streams {
			if !st.eof {
				fds = append(fds, unix.PollFd{Fd: int32(st.fd), Events: unix.POLLIN}) //nolint:gosec // fd fits
				idx = append(idx, st)
			}
		}
		if _, err := unix.Poll(fds, s.pollTimeout()); err != nil && !errors.Is(err, unix.EINTR) {
			s.log.Error("shim: poll", "err", err)
			time.Sleep(tick)
		}
		if fds[0].Revents != 0 {
			s.drainWake()
		}
		for i, st := range idx {
			if fds[first+i].Revents != 0 {
				s.copy(st, buf, readsPerWake*copyBufSize)
			}
		}

		ws, ok := s.reap()
		if ok && !mainExited {
			mainExited = true
			s.onExit(ws, buf)
		}
		s.runTimers()

		if mainExited && time.Since(lastCheck) >= tick {
			lastCheck = time.Now()
			if s.finished(buf) {
				break
			}
		}
	}
	s.shutdown()
}

// pollTimeout returns the poll timeout in milliseconds: the tick or the next
// kill timer, whichever comes first.
func (s *shim) pollTimeout() int {
	d := tick
	now := time.Now()
	s.mu.Lock()
	for _, at := range []time.Time{s.timeoutAt, s.hardKillAt} {
		if !at.IsZero() {
			d = min(d, at.Sub(now))
		}
	}
	s.mu.Unlock()
	if d <= 0 {
		return 0
	}
	// Round up so the timer is due when poll returns.
	return int((d + time.Millisecond - 1) / time.Millisecond)
}

// wake interrupts the poll so the loop picks up a new timer. s.mu is held.
func (s *shim) wake() {
	if s.wakeW >= 0 {
		_, _ = unix.Write(s.wakeW, []byte{1})
	}
}

func (s *shim) drainWake() {
	var b [64]byte
	for {
		n, err := unix.Read(s.wakeR, b[:])
		if n <= 0 || err != nil {
			return
		}
	}
}

// copy moves up to limit bytes (0 = until EAGAIN) from the stream to its log
// file. EOF on a pipe and EIO on a PTY master (no slave left) end the stream.
func (s *shim) copy(st *stream, buf []byte, limit int) {
	total := 0
	for limit == 0 || total < limit {
		n, err := unix.Read(st.fd, buf)
		if n > 0 {
			total += n
			if _, werr := st.file.Write(buf[:n]); werr != nil && !st.werr {
				st.werr = true
				s.log.Error("shim: write log, output lost", "stream", st.name, "err", werr)
			}
		}
		switch {
		case err == nil && n == 0:
			st.eof = true
			return
		case err == nil:
		case errors.Is(err, unix.EINTR):
		case errors.Is(err, unix.EAGAIN):
			return
		case errors.Is(err, unix.EIO):
			st.eof = true
			return
		default:
			s.log.Error("shim: read stream", "stream", st.name, "err", err)
			st.eof = true
			return
		}
	}
}

// reap collects every exited child: the main process and orphans adopted as
// subreaper, so leftovers never stay zombies. It returns the wait status of
// the main process if it was reaped in this call. mainReaped is set under
// mu together with the reap, so a request never signals the group of a
// reaped (reusable) pid.
func (s *shim) reap() (ws unix.WaitStatus, ok bool) {
	s.mu.Lock()
	defer s.mu.Unlock()
	for {
		var st unix.WaitStatus
		pid, err := unix.Wait4(-1, &st, unix.WNOHANG, nil)
		if errors.Is(err, unix.EINTR) {
			continue
		}
		if err != nil || pid <= 0 {
			return ws, ok
		}
		if pid == s.pid && !s.mainReaped {
			s.mainReaped = true
			ws, ok = st, true
		}
	}
}

// onExit records the exit of the main process: drain what it wrote, take
// the ends, write exit.json and tell the connected agents.
func (s *shim) onExit(ws unix.WaitStatus, buf []byte) {
	// Everything the process wrote before it exited is in the pipe or PTY
	// buffer now.
	for _, st := range s.streams {
		if !st.eof {
			s.copy(st, buf, drainLimit)
		}
	}
	e := ExitFile{Status: shimproto.StatusExited, EndedAt: time.Now().UTC()}
	s.setEnds(&e)

	oom := false
	if ws.Signaled() {
		sig := ws.Signal()
		e.Status = shimproto.StatusKilled
		e.Code = 128 + int32(sig)
		e.Signal = unix.SignalName(sig)
		if sig == syscall.SIGKILL && s.cg != nil {
			if n, err := s.cg.oomKills(); err == nil && n > s.oomBase {
				oom = true
			}
		}
	} else {
		e.Code = int32(ws.ExitStatus()) //nolint:gosec // 0..255
	}

	s.mu.Lock()
	switch {
	case oom:
		e.Reason = shimproto.ReasonOOM
	case s.killReason != "":
		e.Reason = s.killReason
	case ws.Signaled() && s.signalled:
		e.Reason = shimproto.ReasonSignal
	default:
		e.Reason = shimproto.ReasonNone
	}
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
	s.log.Info("shim: command exited", "status", e.Status, "code", e.Code, "signal", e.Signal, "reason", e.Reason)

	for _, c := range conns {
		if err := c.send(shimproto.Message{Type: shimproto.TypeExited, Exit: &e}); err != nil {
			_ = c.c.Close()
		}
	}

	// Input is refused from now on; leftovers reading stdin get EOF.
	s.reqMu.Lock()
	if s.stdinFd >= 0 {
		_ = unix.Close(s.stdinFd)
		s.stdinFd = -1
	}
	s.reqMu.Unlock()
}

// runTimers fires the timeout and the cgroup kill after a grace.
func (s *shim) runTimers() {
	now := time.Now()
	s.mu.Lock()
	defer s.mu.Unlock()
	if !s.timeoutAt.IsZero() && !now.Before(s.timeoutAt) {
		s.timeoutAt = time.Time{}
		if !s.exited {
			s.log.Info("shim: timeout, killing the command")
			s.killLocked(syscall.SIGTERM, s.spec.killGrace(), shimproto.ReasonTimeout)
		}
	}
	if !s.hardKillAt.IsZero() && !now.Before(s.hardKillAt) {
		s.hardKillAt = time.Time{}
		s.hardKillLocked()
	}
}

// finished reports whether the shim may exit after the main process has
// exited: with a cgroup when the payload is empty (one last drain picks up
// the final leftover output), without one when every stream is at EOF. A
// cgroup.events that stays unreadable for maxPopulatedErrors checks counts
// as empty, so a broken cgroup cannot keep the shim forever.
func (s *shim) finished(buf []byte) bool {
	if s.cg != nil {
		populated, err := s.cg.populated()
		if err != nil {
			s.popErrs++
			if s.popErrs < maxPopulatedErrors {
				return false
			}
			s.log.Error("shim: cgroup.events unreadable, treating the payload as empty", "err", err)
			populated = false
		}
		if populated {
			s.popErrs = 0
			return false
		}
		for _, st := range s.streams {
			if !st.eof {
				s.copy(st, buf, drainLimit)
			}
		}
		return true
	}
	for _, st := range s.streams {
		if !st.eof {
			return false
		}
	}
	return true
}

// killLocked sends sig to the command and schedules the hard kill after
// grace (now when grace is 0). Before the exit the first kill sets the exit
// reason. After the exit it acts on leftovers only and is a no-op without
// them (spec section 9.5). s.mu is held.
func (s *shim) killLocked(sig syscall.Signal, grace time.Duration, reason string) {
	if s.exited {
		if !s.leftoversLocked() {
			return
		}
	} else if s.killReason == "" {
		s.killReason = reason
	}
	s.signalLocked(sig)
	at := time.Now().Add(grace)
	if s.hardKillAt.IsZero() || at.Before(s.hardKillAt) {
		s.hardKillAt = at
	}
	s.wake()
}

// signalLocked sends sig to the process group of the main process while it
// is not reaped, afterwards to each leftover process. s.mu is held.
func (s *shim) signalLocked(sig syscall.Signal) {
	if !s.mainReaped {
		// Not reaped yet (at worst a zombie): the pid and its group id
		// cannot be reused.
		if err := unix.Kill(-s.pid, sig); err != nil && !errors.Is(err, unix.ESRCH) {
			s.log.Warn("shim: signal process group", "signal", unix.SignalName(sig), "err", err)
		}
		return
	}
	s.signalLeftovers(sig)
}

// signalLeftovers signals every process of the command one by one: the
// payload members with a cgroup, the shim's descendants without one. It
// returns how many were signalled.
func (s *shim) signalLeftovers(sig syscall.Signal) int {
	var pids []int
	var owned func(int) bool
	var err error
	if s.cg != nil {
		pids, err = s.cg.procs()
		owned = s.cg.contains
	} else {
		pids, err = descendants(s.selfPid)
		owned = func(pid int) bool { return isDescendant(pid, s.selfPid) }
	}
	if err != nil {
		s.log.Warn("shim: list leftovers", "err", err)
		return 0
	}
	n := 0
	for _, pid := range pids {
		if signalPid(pid, sig, owned) {
			n++
		}
	}
	return n
}

// hardKillLocked kills the whole command: cgroup.kill on the payload, or
// SIGKILL to every process of the command without a cgroup (or if
// cgroup.kill fails). s.mu is held.
func (s *shim) hardKillLocked() {
	if s.cg != nil {
		err := s.cg.kill()
		if err == nil {
			return
		}
		s.log.Warn("shim: cgroup.kill failed, killing process by process", "err", err)
	}
	if !s.mainReaped {
		if err := unix.Kill(-s.pid, syscall.SIGKILL); err != nil && !errors.Is(err, unix.ESRCH) {
			s.log.Warn("shim: kill process group", "err", err)
		}
	}
	// Also catches processes that left the group (setsid).
	s.signalLeftovers(syscall.SIGKILL)
}

// leftoversLocked reports whether processes of the command are still alive
// after the main process exited. s.mu is held.
func (s *shim) leftoversLocked() bool {
	if s.cg != nil {
		populated, err := s.cg.populated()
		return err == nil && populated
	}
	pids, err := descendants(s.selfPid)
	return err == nil && len(pids) > 0
}
