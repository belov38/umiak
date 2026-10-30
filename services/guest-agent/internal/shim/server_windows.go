package shim

import (
	"errors"
	"fmt"
	"net"
	"os"
	"sync"
	"time"

	"golang.org/x/sys/windows"

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
	// inputPollSlice is the pause while the input pipe is full, so a
	// blocked input notices the exit of the command quickly.
	inputPollSlice = 10 * time.Millisecond
	// inputChunk is the largest single write into an input pipe. A
	// non-blocking pipe may refuse a write larger than its free space as a
	// whole; a refused write is retried with half the size.
	inputChunk = 4 << 10
	// sockDirSDDL keeps the socket directory to SYSTEM (spec 12.6): AF_UNIX
	// on Windows has no peer credentials, the file ACL decides.
	sockDirSDDL = "D:P(A;OICI;FA;;;SY)"
)

// errInputAborted ends an input write when the command exits meanwhile.
var errInputAborted = errors.New("command exited")

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

// listen opens ShimSocket(id) in a directory only SYSTEM may use.
func (s *shim) listen() error {
	dir := s.layout.ShimSockDir
	if err := os.MkdirAll(dir, 0o700); err != nil {
		return err
	}
	if err := restrictToSystem(dir); err != nil {
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
	s.ln = ln
	go s.accept(ln)
	return nil
}

// restrictToSystem replaces the DACL of dir with SYSTEM full control,
// inherited by its files, and no inherited entries.
func restrictToSystem(dir string) error {
	sd, err := windows.SecurityDescriptorFromString(sockDirSDDL)
	if err != nil {
		return fmt.Errorf("shim: socket directory ACL: %w", err)
	}
	dacl, _, err := sd.DACL()
	if err != nil {
		return fmt.Errorf("shim: socket directory ACL: %w", err)
	}
	if err := windows.SetNamedSecurityInfo(dir, windows.SE_FILE_OBJECT,
		windows.DACL_SECURITY_INFORMATION|windows.PROTECTED_DACL_SECURITY_INFORMATION, nil, nil, dacl, nil); err != nil {
		return fmt.Errorf("shim: restrict %s: %w", dir, err)
	}
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
	defer s.unlockReq()
	r := shimproto.Message{Type: shimproto.TypeStatusReply, Pid: s.pid, State: shimproto.StateRunning,
		LastSeq: s.seqs.snapshot()}
	r.OutputTruncated, r.DroppedBytes = s.truncation()
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
	defer s.unlockReq()
	if s.isExited() {
		return errReply(shimproto.CodeCommandExited, "command exited")
	}
	if !shimproto.ValidSession(m.Session) {
		return errReply(shimproto.CodeInvalidArgument, "input session must match [A-Za-z0-9._:-]{1,%d}", shimproto.MaxSessionLen)
	}
	if m.CloseStdin && s.con != nil {
		return errReply(shimproto.CodeFailedPrecondition, "close_stdin does not apply to a pty, send ^Z")
	}
	if m.Seq <= s.seqs.last(m.Session) {
		return shimproto.Message{Type: shimproto.TypeInputReply, Applied: false}
	}
	h := s.stdin
	if s.con != nil {
		h = s.ptyIn
	}
	if len(m.Data) > 0 {
		if h == 0 {
			return errReply(shimproto.CodeFailedPrecondition, "stdin is not open")
		}
		n, err := writeAll(h, m.Data, inputTimeout, s.stdinCloseReq.Load)
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
	if m.CloseStdin && s.stdin != 0 {
		_ = windows.CloseHandle(s.stdin)
		s.stdin = 0
	}
	s.seqs.set(m.Session, m.Seq)
	return shimproto.Message{Type: shimproto.TypeInputReply, Applied: true}
}

// writeAll writes data to a non-blocking pipe handle, waiting while the
// pipe is full up to timeout in total. It gives up with errInputAborted
// once abort reports true.
func writeAll(h windows.Handle, data []byte, timeout time.Duration, abort func() bool) (int, error) {
	deadline := time.Now().Add(timeout)
	done := 0
	size := min(len(data), inputChunk)
	for done < len(data) {
		size = min(size, len(data)-done)
		var n uint32
		err := windows.WriteFile(h, data[done:done+size], &n, nil)
		done += int(n)
		switch {
		case err != nil:
			// ERROR_NO_DATA: the reading side is closed.
			return done, err
		case n > 0:
			size = inputChunk
			continue
		case size > 1:
			size /= 2
			continue
		}
		// Not even one byte fits.
		if abort() {
			return done, errInputAborted
		}
		if time.Until(deadline) <= 0 {
			return done, errors.New("timed out")
		}
		time.Sleep(inputPollSlice)
		size = inputChunk
	}
	return done, nil
}

func (s *shim) handleResize(m shimproto.Message) shimproto.Message {
	s.reqMu.Lock()
	defer s.unlockReq()
	if s.isExited() {
		return errReply(shimproto.CodeCommandExited, "command exited")
	}
	if s.con == nil {
		return errReply(shimproto.CodeFailedPrecondition, "command has no pty")
	}
	if m.Cols == 0 || m.Rows == 0 {
		return errReply(shimproto.CodeInvalidArgument, "cols and rows must be positive")
	}
	if err := s.con.Resize(m.Cols, m.Rows); err != nil {
		return errReply(shimproto.CodeInternal, "resize: %v", err)
	}
	return shimproto.Message{Type: shimproto.TypeOK}
}

// handleKill runs the soft stage of the first signal (default SIGTERM) and
// terminates the job after the grace (S9 spec 12.6). After the exit it acts
// on leftovers only, is a no-op without them and never changes exit.json.
func (s *shim) handleKill(m shimproto.Message) shimproto.Message {
	sig := sigTERM
	if m.FirstSignal != 0 {
		if err := shimproto.CheckSignal(m.FirstSignal); err != nil {
			return errReply(shimproto.CodeInvalidArgument, "first_signal %d: %v", m.FirstSignal, err)
		}
		sig = m.FirstSignal
	}
	if _, err := winSignalAction(sig, s.con != nil); err != nil {
		return errReply(shimproto.CodeInvalidArgument, "first_signal %d: %v", sig, err)
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

// handleSignal delivers a signal (see signalLocked); Cgroup terminates the
// whole job. After the exit it reaches the leftovers and is a no-op
// without them.
func (s *shim) handleSignal(m shimproto.Message) shimproto.Message {
	if err := shimproto.CheckSignal(m.Sig); err != nil {
		return errReply(shimproto.CodeInvalidArgument, "sig %d: %v", m.Sig, err)
	}
	if _, err := winSignalAction(m.Sig, s.con != nil); err != nil {
		return errReply(shimproto.CodeInvalidArgument, "sig %d: %v", m.Sig, err)
	}
	s.mu.Lock()
	defer s.mu.Unlock()
	if s.exited && !s.leftoversLocked() {
		return shimproto.Message{Type: shimproto.TypeOK}
	}
	if !s.exited {
		s.signalled = true
	}
	sig := m.Sig
	if m.Cgroup {
		sig = sigKILL
	}
	if err := s.signalLocked(sig); err != nil {
		return errReply(shimproto.CodeInvalidArgument, "sig %d: %v", m.Sig, err)
	}
	return shimproto.Message{Type: shimproto.TypeOK}
}
