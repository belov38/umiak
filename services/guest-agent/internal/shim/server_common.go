//go:build linux || windows

package shim

import (
	"errors"
	"fmt"
	"net"
	"sync"
	"time"

	"github.com/belov38/umiak/services/guest-agent/internal/shimproto"
)

// The OS-neutral part of the shim socket server (spec section 9.6): the
// connection handling and the request dispatch. Listening and the
// handlers that touch pipes, terminals and signals are per OS.

const (
	// helloTimeout bounds the hello exchange of a new connection.
	helloTimeout = 10 * time.Second
	// writeTimeout bounds one frame write to an agent that stopped reading.
	writeTimeout = 5 * time.Second
	// inputTimeout bounds one input write to a process that does not read
	// its stdin.
	inputTimeout = 5 * time.Second
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
