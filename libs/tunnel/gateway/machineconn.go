package gateway

import (
	"context"
	"errors"
	"fmt"
	"io"
	"net"
	"net/http"
	"strconv"
	"strings"
	"sync"
	"sync/atomic"
	"time"

	"connectrpc.com/connect"
	"google.golang.org/protobuf/types/known/durationpb"

	tunnelv1 "github.com/belov38/boat-dev-clone/libs/proto/sbx/tunnel/v1"
	"github.com/belov38/boat-dev-clone/libs/tunnel/transport"
	"github.com/belov38/boat-dev-clone/libs/tunnel/wire"
)

// agentBaseURL is the base URL of requests sent to the agent; RoundTrip
// rewrites every request to it.
const (
	agentHost    = "agent"
	agentBaseURL = "http://" + agentHost
)

// TCPOptions controls one TCP stream opened with DialTCPWith.
type TCPOptions struct {
	// DrainDeadline is how long the stream may keep running after the
	// machine moved off a draining instance; 0 uses Timing.TCPDeadline.
	// It is capped at Timing.MaxTCPDrainDeadline.
	DrainDeadline time.Duration
}

// errDeadlinesUnsupported is returned by the deadline setters of TCP conns.
var errDeadlinesUnsupported = fmt.Errorf("gateway: tcp stream deadlines: %w", errors.ErrUnsupported)

// requestKind classifies tracked requests (spec 7 step 6).
type requestKind int

const (
	// kindUnary is any plain request: finishes on its own when moved.
	kindUnary requestKind = iota
	// kindRPCStream is a Connect or gRPC streaming call: aborted when moved.
	kindRPCStream
	// kindTCP is a CONNECT stream: lives until its drain deadline when moved.
	kindTCP
)

func classify(r *http.Request) requestKind {
	if r.Method == http.MethodConnect {
		return kindTCP
	}
	ct := r.Header.Get("Content-Type")
	if strings.HasPrefix(ct, "application/connect+") || strings.HasPrefix(ct, "application/grpc") {
		return kindRPCStream
	}
	return kindUnary
}

// stream is one tracked request in flight on a session.
type stream struct {
	kind requestKind
	// cancel aborts the request; the cause is ErrMachineMoved or ErrSessionClosed.
	cancel context.CancelCauseFunc
	// deadline is the drain deadline of unary and TCP streams.
	deadline time.Duration
	timer    *time.Timer // guarded by session.mu; set when moved
}

// track registers a request. It fails when the session no longer serves
// calls, and for TCP streams beyond MaxTCPStreamsPerMachine.
func (s *session) track(kind requestKind, cancel context.CancelCauseFunc, deadline time.Duration) (*stream, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	switch s.st {
	case stateMoved:
		return nil, ErrMachineMoved
	case stateClosed:
		return nil, ErrSessionClosed
	case stateActive, stateDraining:
	}
	if kind == kindTCP {
		if s.tcpCount >= s.g.cfg.MaxTCPStreamsPerMachine {
			return nil, ErrTooManyStreams
		}
		s.tcpCount++
	}
	st := &stream{kind: kind, cancel: cancel, deadline: deadline}
	s.streams[st] = struct{}{}
	return st, nil
}

// untrack forgets a finished request. A moved session closes once its last
// unary or TCP stream is gone. Safe to call more than once.
func (s *session) untrack(st *stream) {
	s.mu.Lock()
	if _, ok := s.streams[st]; !ok {
		s.mu.Unlock()
		return
	}
	delete(s.streams, st)
	if st.kind == kindTCP {
		s.tcpCount--
	}
	if st.timer != nil {
		st.timer.Stop()
	}
	closeNow := s.st == stateMoved && s.lingeringLocked() == 0
	s.mu.Unlock()
	if closeNow {
		s.close("moved: last stream ended")
	}
}

// lingeringLocked counts the streams a moved session waits for.
func (s *session) lingeringLocked() int {
	n := 0
	for st := range s.streams {
		if st.kind != kindRPCStream {
			n++
		}
	}
	return n
}

// longestTCPDeadline returns the longest drain deadline among the open TCP
// streams, at least Timing.TCPDeadline (the tcp_deadline sent in Drain).
func (s *session) longestTCPDeadline() time.Duration {
	s.mu.Lock()
	defer s.mu.Unlock()
	d := s.g.cfg.Timing.TCPDeadline
	for st := range s.streams {
		if st.kind == kindTCP {
			d = max(d, st.deadline)
		}
	}
	return d
}

// abortErr attaches the abort cause of ctx (ErrMachineMoved or
// ErrSessionClosed) to err so callers can tell why a request ended.
func abortErr(ctx context.Context, err error) error {
	cause := context.Cause(ctx)
	if cause == nil || errors.Is(err, cause) {
		return err
	}
	if !errors.Is(cause, ErrMachineMoved) && !errors.Is(cause, ErrSessionClosed) {
		return err
	}
	return fmt.Errorf("%w: %w", cause, err)
}

// MachineConn is the gateway-side handle to the tunnel of one machine. It
// implements transport.MachineConn.
type MachineConn struct{ s *session }

var _ transport.MachineConn = (*MachineConn)(nil)

// Epoch returns the tunnel epoch of the session, the one the registry holds
// for it. It needs no registry query.
func (m *MachineConn) Epoch() uint64 { return m.s.info.Epoch }

// RoundTrip sends req to the agent. The URL is rewritten to http://agent/...
// (CONNECT requests keep their authority). The request is tracked until its
// response body is drained or closed; on a moved session RPC streams are
// aborted with ErrMachineMoved and new requests are refused with it.
func (m *MachineConn) RoundTrip(req *http.Request) (*http.Response, error) {
	s := m.s
	kind := classify(req)
	ctx, cancel := context.WithCancelCause(req.Context())
	st, err := s.track(kind, cancel, s.g.cfg.Timing.TCPDeadline)
	if err != nil {
		cancel(err)
		if req.Body != nil {
			_ = req.Body.Close()
		}
		return nil, err
	}
	out := req.Clone(ctx)
	if kind != kindTCP {
		out.URL.Scheme = "http"
		out.URL.Host = agentHost
		out.Host = agentHost
	}
	resp, err := s.cc.RoundTrip(out)
	if err != nil {
		err = abortErr(ctx, err)
		s.untrack(st)
		cancel(nil)
		return nil, err
	}
	abortOnCancel(ctx, resp.Body, nil)
	resp.Body = &trackedBody{rc: resp.Body, s: s, st: st, ctx: ctx, cancel: cancel}
	return resp, nil
}

// abortOnCancel ends a stream when ctx is cancelled (moved session past the
// stream's deadline, closed session, caller gone). The HTTP/2 client does not
// abort a stream for a cancelled context while the request body is still
// open (a CONNECT upload, a bidi call): it would stay up until the whole
// connection closes. Closing the response body resets the stream and makes
// pending reads fail; pw, when set, makes pending writes fail with the cause.
func abortOnCancel(ctx context.Context, body io.Closer, pw *io.PipeWriter) {
	context.AfterFunc(ctx, func() {
		if pw != nil {
			_ = pw.CloseWithError(context.Cause(ctx))
		}
		_ = body.Close()
	})
}

// trackedBody untracks its request when the body ends or is closed.
type trackedBody struct {
	rc     io.ReadCloser
	s      *session
	st     *stream
	ctx    context.Context
	cancel context.CancelCauseFunc
}

func (b *trackedBody) Read(p []byte) (int, error) {
	n, err := b.rc.Read(p)
	if err != nil {
		b.s.untrack(b.st)
		if !errors.Is(err, io.EOF) {
			err = abortErr(b.ctx, err)
		}
	}
	return n, err
}

func (b *trackedBody) Close() error {
	err := b.rc.Close()
	b.s.untrack(b.st)
	b.cancel(nil)
	return err
}

// DialTCP opens a TCP stream to localhost:port inside the machine with the
// default drain deadline. See DialTCPWith.
func (m *MachineConn) DialTCP(ctx context.Context, port uint16) (net.Conn, error) {
	return m.DialTCPWith(ctx, port, TCPOptions{})
}

// DialTCPWith opens a TCP stream to localhost:port inside the machine as an
// HTTP/2 CONNECT. ctx bounds the dial only. The stream counts against
// MaxTCPStreamsPerMachine (ErrTooManyStreams beyond it) until the returned
// conn is closed, the stream is reset, or both directions are finished
// (read EOF and CloseWrite). A refusal by the agent is a
// *transport.DialError; its Reason is "refused" or "timeout" when the agent
// said so with Sbx-Dial-Error, and "" for any other value.
//
// The returned conn does not support deadlines: SetDeadline,
// SetReadDeadline and SetWriteDeadline return an error wrapping
// errors.ErrUnsupported. Callers must not rely on them; Close unblocks a
// pending Read or Write.
func (m *MachineConn) DialTCPWith(ctx context.Context, port uint16, opts TCPOptions) (net.Conn, error) {
	s := m.s
	deadline := min(opts.DrainDeadline, s.g.cfg.Timing.MaxTCPDrainDeadline)
	if deadline <= 0 {
		deadline = s.g.cfg.Timing.TCPDeadline
	}
	// The stream outlives ctx: it gets its own context, cancelled on Close,
	// on session end or at the drain deadline.
	sctx, cancel := context.WithCancelCause(context.WithoutCancel(ctx))
	st, err := s.track(kindTCP, cancel, deadline)
	if err != nil {
		cancel(err)
		return nil, err
	}
	fail := func(err error) (net.Conn, error) {
		s.untrack(st)
		cancel(nil)
		return nil, err
	}

	authority := net.JoinHostPort("localhost", strconv.Itoa(int(port)))
	pr, pw := io.Pipe()
	req, err := http.NewRequestWithContext(sctx, http.MethodConnect, "", pr)
	if err != nil {
		return fail(err)
	}
	req.Host = authority
	req.URL.Host = authority
	stop := context.AfterFunc(ctx, func() { cancel(context.Cause(ctx)) })
	resp, err := s.cc.RoundTrip(req)
	if !stop() {
		// ctx ended during the dial: the stream is cancelled.
		if err == nil {
			_ = resp.Body.Close()
		}
		_ = pw.Close()
		return fail(context.Cause(ctx))
	}
	if err != nil {
		_ = pw.Close()
		return fail(abortErr(sctx, err))
	}
	if resp.StatusCode != http.StatusOK {
		_ = resp.Body.Close()
		_ = pw.Close()
		// Only the reason is taken from the agent, and only from the closed set.
		return fail(&transport.DialError{
			Status: resp.StatusCode,
			Reason: wire.NormalizeDialError(resp.Header.Get(wire.HeaderDialError)),
		})
	}
	abortOnCancel(sctx, resp.Body, pw)
	return &tcpConn{
		s: s, st: st, body: resp.Body, pw: pw, ctx: sctx, cancel: cancel,
		remote: tunnelAddr(s.machineID + ":" + strconv.Itoa(int(port))),
	}, nil
}

// tcpConn is a TCP stream over an HTTP/2 CONNECT. Deadlines are not supported.
//
// The stream is released (untracked) on Close, on a reset (non-EOF read
// error), or once both directions are finished: the agent's EOF was read and
// the write side was closed (CloseWrite or a failed write). A half-closed
// stream still counts: on a moved session the gateway may still be uploading.
type tcpConn struct {
	s      *session
	st     *stream
	body   io.ReadCloser
	pw     *io.PipeWriter
	ctx    context.Context
	cancel context.CancelCauseFunc
	remote tunnelAddr

	closed    atomic.Bool
	closeOnce sync.Once
	readDone  atomic.Bool
	writeDone atomic.Bool
}

// halfDone records that one direction finished and releases the stream
// once both did.
func (c *tcpConn) halfDone(flag *atomic.Bool) {
	flag.Store(true)
	if c.readDone.Load() && c.writeDone.Load() {
		c.s.untrack(c.st)
	}
}

func (c *tcpConn) Read(p []byte) (int, error) {
	n, err := c.body.Read(p)
	if err != nil {
		switch {
		case c.closed.Load():
			err = net.ErrClosed
		case errors.Is(err, io.EOF):
			c.halfDone(&c.readDone)
		default:
			// The stream was reset: both directions are gone.
			c.s.untrack(c.st)
			err = abortErr(c.ctx, err)
		}
	}
	return n, err
}

func (c *tcpConn) Write(p []byte) (int, error) {
	n, err := c.pw.Write(p)
	if err != nil {
		if c.closed.Load() {
			return n, net.ErrClosed
		}
		c.halfDone(&c.writeDone)
		err = abortErr(c.ctx, err)
	}
	return n, err
}

// CloseWrite half-closes the stream: the agent sees EOF and half-closes the target.
func (c *tcpConn) CloseWrite() error {
	err := c.pw.Close()
	c.halfDone(&c.writeDone)
	return err
}

func (c *tcpConn) Close() error {
	c.closeOnce.Do(func() {
		c.closed.Store(true)
		_ = c.pw.CloseWithError(net.ErrClosed)
		_ = c.body.Close()
		c.cancel(nil)
		c.s.untrack(c.st)
	})
	return nil
}

func (c *tcpConn) LocalAddr() net.Addr  { return tunnelAddr("gateway") }
func (c *tcpConn) RemoteAddr() net.Addr { return c.remote }

func (c *tcpConn) SetDeadline(time.Time) error      { return errDeadlinesUnsupported }
func (c *tcpConn) SetReadDeadline(time.Time) error  { return errDeadlinesUnsupported }
func (c *tcpConn) SetWriteDeadline(time.Time) error { return errDeadlinesUnsupported }

type tunnelAddr string

func (tunnelAddr) Network() string  { return "tunnel" }
func (a tunnelAddr) String() string { return string(a) }

// Ping is a Control/Info round trip (std HTTP/2 has no PING API; PING
// liveness runs inside the HTTP/2 client).
func (m *MachineConn) Ping(ctx context.Context) error {
	_, err := m.s.control.Info(ctx, connect.NewRequest(&tunnelv1.InfoRequest{}))
	return err
}

// Drain marks the session draining and asks the agent to move to another
// instance (Control/Drain). A zero TCPDeadline sends the longest drain
// deadline of the open TCP streams, at least Timing.TCPDeadline.
func (m *MachineConn) Drain(ctx context.Context, opts transport.DrainOptions) error {
	s := m.s
	if !s.markDraining() {
		return fmt.Errorf("drain: session %s", s.state())
	}
	d := opts.TCPDeadline
	if d <= 0 {
		d = s.longestTCPDeadline()
	}
	s.log.Info("gateway: draining session", "reason", opts.Reason, "tcp_deadline", d)
	_, err := s.control.Drain(ctx, connect.NewRequest(&tunnelv1.DrainRequest{
		Reason:      opts.Reason,
		TcpDeadline: durationpb.New(d),
	}))
	return err
}

// Close closes the tunnel connection; the session is marked disconnected.
func (m *MachineConn) Close() error {
	m.s.close("closed by caller")
	return nil
}
