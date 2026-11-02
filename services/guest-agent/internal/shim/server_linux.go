//go:build linux

package shim

import (
	"errors"
	"net"
	"os"
	"syscall"
	"time"

	"golang.org/x/sys/unix"

	"github.com/belov38/umiak/services/guest-agent/internal/shimproto"
)

// inputPollSlice bounds one wait for POLLOUT, so a blocked input notices
// the exit of the command quickly.
const inputPollSlice = 50 * time.Millisecond

// listen opens ShimSocket(id): directory 0700, socket 0600.
func (s *shim) listen() error {
	dir := s.layout.ShimSockDir
	if err := os.MkdirAll(dir, 0o700); err != nil {
		return err
	}
	if err := os.Chmod(dir, 0o700); err != nil {
		return err
	}
	path := s.layout.ShimSocket(s.id)
	if err := os.Remove(path); err != nil && !errors.Is(err, os.ErrNotExist) {
		return err
	}
	ln, err := net.ListenUnix("unix", &net.UnixAddr{Name: path, Net: "unix"})
	if err != nil {
		return err
	}
	ln.SetUnlinkOnClose(true)
	if err := os.Chmod(path, 0o600); err != nil {
		_ = ln.Close()
		return err
	}
	s.ln = ln
	go s.accept(ln)
	return nil
}

// handleInput applies an input once per (session, seq): a seq not above the
// last applied one of the session is a duplicate (spec section 9.4).
func (s *shim) handleInput(m shimproto.Message) shimproto.Message {
	s.reqMu.Lock()
	defer s.unlockReq()
	if s.isExited() {
		return errReply(shimproto.CodeCommandExited, "command exited")
	}
	if !shimproto.ValidSession(m.Session) {
		return errReply(shimproto.CodeInvalidArgument, "input session must match [A-Za-z0-9._:-]{1,%d}", shimproto.MaxSessionLen)
	}
	if m.CloseStdin && s.ptyFd >= 0 {
		return errReply(shimproto.CodeFailedPrecondition, "close_stdin does not apply to a pty, send ^D")
	}
	if m.Seq <= s.seqs.last(m.Session) {
		return shimproto.Message{Type: shimproto.TypeInputReply, Applied: false}
	}
	fd := s.stdinFd
	if s.ptyFd >= 0 {
		fd = s.ptyFd
	}
	if len(m.Data) > 0 {
		if fd < 0 {
			return errReply(shimproto.CodeFailedPrecondition, "stdin is not open")
		}
		n, err := writeAll(fd, m.Data, inputTimeout, s.stdinCloseReq.Load)
		if err != nil {
			if n > 0 {
				// Part of the data reached the process: a retry must not
				// write it again.
				s.seqs.set(m.Session, m.Seq)
			}
			code := shimproto.CodeInternal
			if errors.Is(err, errInputAborted) {
				code = shimproto.CodeCommandExited
			}
			r := errReply(code, "input: wrote %d of %d bytes: %v", n, len(m.Data), err)
			r.Written = uint64(n) //nolint:gosec // n >= 0
			return r
		}
	}
	if m.CloseStdin && s.stdinFd >= 0 {
		_ = unix.Close(s.stdinFd)
		s.stdinFd = -1
	}
	s.seqs.set(m.Session, m.Seq)
	return shimproto.Message{Type: shimproto.TypeInputReply, Applied: true}
}

// writeAll writes data to a non-blocking fd, waiting for POLLOUT up to
// timeout in total. It gives up with errInputAborted once abort reports true.
func writeAll(fd int, data []byte, timeout time.Duration, abort func() bool) (int, error) {
	deadline := time.Now().Add(timeout)
	done := 0
	for done < len(data) {
		n, err := unix.Write(fd, data[done:])
		if n > 0 {
			done += n
		}
		switch {
		case err == nil:
		case errors.Is(err, unix.EINTR):
		case errors.Is(err, unix.EAGAIN):
			if abort() {
				return done, errInputAborted
			}
			left := time.Until(deadline)
			if left <= 0 {
				return done, errors.New("timed out")
			}
			wait := min(left, inputPollSlice)
			pfd := []unix.PollFd{{Fd: int32(fd), Events: unix.POLLOUT}} //nolint:gosec // fd fits
			if _, err := unix.Poll(pfd, int(wait/time.Millisecond)+1); err != nil && !errors.Is(err, unix.EINTR) {
				return done, err
			}
		default:
			return done, err
		}
	}
	return done, nil
}

func (s *shim) handleResize(m shimproto.Message) shimproto.Message {
	s.reqMu.Lock()
	defer s.unlockReq()
	if s.isExited() {
		return errReply(shimproto.CodeCommandExited, "command exited")
	}
	if s.ptyFd < 0 {
		return errReply(shimproto.CodeFailedPrecondition, "command has no pty")
	}
	if m.Cols == 0 || m.Rows == 0 {
		return errReply(shimproto.CodeInvalidArgument, "cols and rows must be positive")
	}
	// TIOCSWINSZ on the master; the kernel sends SIGWINCH to the foreground
	// process group.
	if err := unix.IoctlSetWinsize(s.ptyFd, unix.TIOCSWINSZ, &unix.Winsize{Row: m.Rows, Col: m.Cols}); err != nil {
		return errReply(shimproto.CodeInternal, "resize: %v", err)
	}
	return shimproto.Message{Type: shimproto.TypeOK}
}

// handleKill sends the first signal (default SIGTERM) to the process group
// and kills the payload after the grace (spec section 9.5). After the exit
// it acts on leftovers only, is a no-op without them and never changes
// exit.json.
func (s *shim) handleKill(m shimproto.Message) shimproto.Message {
	sig := syscall.SIGTERM
	if m.FirstSignal != 0 {
		if err := shimproto.CheckSignal(m.FirstSignal); err != nil {
			return errReply(shimproto.CodeInvalidArgument, "first_signal %d: %v", m.FirstSignal, err)
		}
		sig = syscall.Signal(m.FirstSignal)
	}
	reason := m.Reason
	switch reason {
	case "":
		reason = shimproto.ReasonSignal
	case shimproto.ReasonSignal, shimproto.ReasonTimeout, shimproto.ReasonPTYIdle:
	default:
		return errReply(shimproto.CodeInvalidArgument, "kill reason %q", m.Reason)
	}
	s.mu.Lock()
	s.killLocked(sig, time.Duration(m.GraceMs)*time.Millisecond, reason)
	s.mu.Unlock()
	return shimproto.Message{Type: shimproto.TypeOK}
}

// handleSignal sends a signal to the process group, or kills the whole
// payload with cgroup set. After the exit it reaches the leftovers one by
// one (SIGKILL with a cgroup: cgroup.kill) and is a no-op without them.
func (s *shim) handleSignal(m shimproto.Message) shimproto.Message {
	if err := shimproto.CheckSignal(m.Sig); err != nil {
		return errReply(shimproto.CodeInvalidArgument, "sig %d: %v", m.Sig, err)
	}
	sig := syscall.Signal(m.Sig)
	s.mu.Lock()
	defer s.mu.Unlock()
	if s.exited && !s.leftoversLocked() {
		return shimproto.Message{Type: shimproto.TypeOK}
	}
	if !s.exited {
		s.signalled = true
	}
	switch {
	case m.Cgroup, s.exited && sig == syscall.SIGKILL && s.cg != nil:
		s.hardKillLocked()
	default:
		s.signalLocked(sig)
	}
	return shimproto.Message{Type: shimproto.TypeOK}
}
