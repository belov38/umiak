//go:build linux

package shim

import (
	"errors"
	"fmt"
	"net"
	"os"
	"sync"
	"syscall"
	"time"

	"golang.org/x/sys/unix"

	"github.com/belov38/boat-dev-clone/services/guest-agent/internal/shimproto"
)

const (
	// helloTimeout bounds the hello exchange of a new connection.
	helloTimeout = 10 * time.Second
	// writeTimeout bounds one frame write to an agent that stopped reading.
	writeTimeout = 5 * time.Second
	// inputTimeout bounds one input write to a process that does not read
	// its stdin.
	inputTimeout = 5 * time.Second
	// maxSessionLen is the longest accepted input session id.
	maxSessionLen = 256
)

// conn is one agent connection.
type conn struct {
	c   net.Conn
	wmu sync.Mutex
}

// send writes one frame; replies and the exited push never interleave.
func (c *conn) send(m shimproto.Message) error {
	c.wmu.Lock()
	defer c.wmu.Unlock()
	_ = c.c.SetWriteDeadline(time.Now().Add(writeTimeout))
	return shimproto.Write(c.c, m)
}

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

// accept serves agent connections one after another or side by side: the
// agent reconnects after a restart.
func (s *shim) accept(ln *net.UnixListener) {
	for {
		c, err := ln.Accept()
		if err != nil {
			if !errors.Is(err, net.ErrClosed) {
				s.log.Error("shim: accept", "err", err)
			}
			return
		}
		sc := &conn{c: c}
		s.mu.Lock()
		if s.closing {
			s.mu.Unlock()
			_ = c.Close()
			return
		}
		s.conns[sc] = false
		s.mu.Unlock()
		go s.serve(sc)
	}
}

// serve runs the hello exchange and answers requests until the agent goes
// away.
func (s *shim) serve(sc *conn) {
	defer func() {
		s.mu.Lock()
		delete(s.conns, sc)
		s.mu.Unlock()
		_ = sc.c.Close()
	}()
	_ = sc.c.SetDeadline(time.Now().Add(helloTimeout))
	if _, err := shimproto.Accept(sc.c, shimproto.MinVersion, shimproto.Version); err != nil {
		s.log.Warn("shim: hello failed", "err", err)
		return
	}
	_ = sc.c.SetDeadline(time.Time{})
	s.mu.Lock()
	s.conns[sc] = true // receives the exited push from now on
	s.mu.Unlock()
	for {
		m, err := shimproto.Read(sc.c)
		if err != nil {
			return
		}
		if m.Type == shimproto.TypeKill || m.Type == shimproto.TypeSignal {
			// Kill and signal never wait behind an input blocked on a full
			// stdin pipe, also on the same connection; the reply carries
			// the request ID, so it may overtake earlier replies.
			go func() {
				reply := s.handle(m)
				reply.ID = m.ID
				if err := sc.send(reply); err != nil {
					_ = sc.c.Close()
				}
			}()
			continue
		}
		reply := s.handle(m)
		reply.ID = m.ID
		if err := sc.send(reply); err != nil {
			return
		}
	}
}

// shutdown stops the server and closes every agent connection.
func (s *shim) shutdown() {
	s.mu.Lock()
	s.closing = true
	conns := make([]*conn, 0, len(s.conns))
	for c := range s.conns {
		conns = append(conns, c)
	}
	s.mu.Unlock()
	if s.ln != nil {
		_ = s.ln.Close()
	}
	for _, c := range conns {
		_ = c.c.Close()
	}
}

func errReply(code, format string, args ...any) shimproto.Message {
	return shimproto.Message{Type: shimproto.TypeError, Code: code, Text: fmt.Sprintf(format, args...)}
}

// handle answers one request. Status, input and resize run under reqMu, one
// at a time. Kill and signal only touch the loop state under mu and are
// dispatched outside the connection's request order (see serve), so a
// blocked input write cannot delay them.
func (s *shim) handle(m shimproto.Message) shimproto.Message {
	switch m.Type {
	case shimproto.TypeStatus:
		return s.handleStatus()
	case shimproto.TypeInput:
		return s.handleInput(m)
	case shimproto.TypeResize:
		return s.handleResize(m)
	case shimproto.TypeKill:
		return s.handleKill(m)
	case shimproto.TypeSignal:
		return s.handleSignal(m)
	case shimproto.TypeHello:
		return errReply(shimproto.CodeInvalidArgument, "hello already done")
	default:
		return errReply(shimproto.CodeUnknownType, "unknown message type %q", m.Type)
	}
}

func (s *shim) isExited() bool {
	s.mu.Lock()
	defer s.mu.Unlock()
	return s.exited
}

func (s *shim) handleStatus() shimproto.Message {
	s.reqMu.Lock()
	defer s.reqMu.Unlock()
	r := shimproto.Message{Type: shimproto.TypeStatusReply, Pid: s.pid, State: shimproto.StateRunning,
		LastSeq: s.seqs.snapshot()}
	s.mu.Lock()
	if s.exited {
		r.State = shimproto.StateExited
		r.Exited = true
		r.Leftovers = s.leftoversLocked()
	}
	s.mu.Unlock()
	return r
}

// handleInput applies an input once per (session, seq): a seq not above the
// last applied one of the session is a duplicate (spec section 9.4).
func (s *shim) handleInput(m shimproto.Message) shimproto.Message {
	s.reqMu.Lock()
	defer s.reqMu.Unlock()
	if s.isExited() {
		return errReply(shimproto.CodeCommandExited, "command exited")
	}
	if m.Session == "" || len(m.Session) > maxSessionLen {
		return errReply(shimproto.CodeInvalidArgument, "input session must be 1..%d bytes", maxSessionLen)
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
		n, err := writeAll(fd, m.Data, inputTimeout)
		if err != nil {
			if n > 0 {
				// Part of the data reached the process: a retry must not
				// write it again.
				s.seqs.set(m.Session, m.Seq)
			}
			r := errReply(shimproto.CodeInternal, "input: wrote %d of %d bytes: %v", n, len(m.Data), err)
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
// timeout in total.
func writeAll(fd int, data []byte, timeout time.Duration) (int, error) {
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
			left := time.Until(deadline)
			if left <= 0 {
				return done, errors.New("timed out")
			}
			pfd := []unix.PollFd{{Fd: int32(fd), Events: unix.POLLOUT}} //nolint:gosec // fd fits
			if _, err := unix.Poll(pfd, int(left/time.Millisecond)+1); err != nil && !errors.Is(err, unix.EINTR) {
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
	defer s.reqMu.Unlock()
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
		if err := checkSignal(m.FirstSignal); err != nil {
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
	if err := checkSignal(m.Sig); err != nil {
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
