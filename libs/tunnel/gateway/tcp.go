package gateway

import (
	"context"
	"errors"
	"fmt"
	"io"
	"math"
	"net"
	"net/http"
	"net/url"
	"strconv"
	"sync"
	"sync/atomic"
	"time"

	"connectrpc.com/connect"

	"github.com/belov38/boat-dev-clone/libs/tunnel/h2"
	"github.com/belov38/boat-dev-clone/libs/tunnel/transport"
	"github.com/belov38/boat-dev-clone/libs/tunnel/wire"
)

// Peer transport parameters.
const (
	peerDialTimeout = 10 * time.Second
	peerKeepAlive   = 15 * time.Second
	peerIdleTimeout = 90 * time.Second
)

// closeWriter is a conn that can half-close its write side.
type closeWriter interface{ CloseWrite() error }

// serveTCP serves a peer CONNECT with :authority <machineId>:<port> (spec
// 8.4, agreed with S4 as plain CONNECT). After 200 it splices the caller
// with a DialTCPWith stream: the caller's EOF half-closes the target
// (CloseWrite); the target's EOF ends the stream for the caller. The peer
// gets only gateway-produced headers: the agent's CONNECT answer headers are
// never copied, and an agent refusal keeps its status only if it is 400,
// 403 or 502 (502 otherwise).
func (h *internalHandler) serveTCP(w http.ResponseWriter, r *http.Request) {
	authority := r.URL.Host
	if authority == "" {
		authority = r.Host
	}
	host, portStr, err := net.SplitHostPort(authority)
	if err != nil {
		h.writeRequestError(w, fmtJSON, connect.CodeInvalidArgument, "CONNECT authority must be <machineId>:<port>")
		return
	}
	id, ok := parseMachineID(host)
	if !ok {
		h.writeRequestError(w, fmtJSON, connect.CodeInvalidArgument, "machine id must be a uuid")
		return
	}
	port, err := strconv.ParseUint(portStr, 10, 16)
	if err != nil || port == 0 {
		h.writeRequestError(w, fmtJSON, connect.CodeInvalidArgument, "port must be 1-65535")
		return
	}
	var opts TCPOptions
	if v := r.Header.Get(wire.HeaderTCPDrainDeadline); v != "" {
		ms, err := strconv.ParseInt(v, 10, 64)
		if err != nil || ms < 0 || ms > math.MaxInt64/int64(time.Millisecond) {
			h.writeRequestError(w, fmtJSON, connect.CodeInvalidArgument, "malformed "+wire.HeaderTCPDrainDeadline)
			return
		}
		// DialTCPWith caps it at Timing.MaxTCPDrainDeadline.
		opts.DrainDeadline = min(time.Duration(ms)*time.Millisecond, h.g.cfg.Timing.MaxTCPDrainDeadline)
	}
	s := h.target(w, r, id, fmtJSON)
	if s == nil {
		return
	}
	conn, err := s.mc.DialTCPWith(r.Context(), uint16(port), opts)
	if err != nil {
		var de *transport.DialError
		switch {
		case r.Context().Err() != nil:
		case errors.Is(err, ErrTooManyStreams):
			writeJSONError(w, http.StatusTooManyRequests, jsonError{Code: "too_many_streams", Message: err.Error()})
		case errors.As(err, &de):
			status := de.Status
			switch status {
			case http.StatusBadRequest, http.StatusForbidden, http.StatusBadGateway:
				// The agent's own refusals: bad authority, policy, dial failed.
			default:
				// Anything else (401, 421, 429, 503, a redirect) would read
				// as a gateway signal to the peer: auth, moved, too many
				// streams, unavailable.
				status = http.StatusBadGateway
			}
			writeJSONError(w, status, jsonError{Code: "dial_refused", Message: err.Error()})
		default:
			h.notServed(w, r, id, fmtJSON)
		}
		return
	}
	s.log.Debug("gateway: peer tcp stream open", "port", port, "caller", callerOf(r.Context()))
	if r.ProtoMajor >= 2 {
		spliceH2(w, r, conn)
	} else {
		spliceHijacked(w, conn)
	}
}

// spliceH2 runs a CONNECT stream over HTTP/2: request body → conn,
// conn → response. It returns only after both copiers stopped. A failure of
// the target side resets the caller's stream.
func spliceH2(w http.ResponseWriter, r *http.Request, conn net.Conn) {
	rc := http.NewResponseController(w)
	w.WriteHeader(http.StatusOK)
	if err := rc.Flush(); err != nil {
		_ = conn.Close()
		return
	}
	stop := context.AfterFunc(r.Context(), func() { _ = conn.Close() })
	defer stop()

	upDone := make(chan struct{})
	go func() {
		defer close(upDone)
		if _, err := io.Copy(conn, r.Body); err != nil {
			_ = conn.Close()
			return
		}
		if cw, ok := conn.(closeWriter); ok {
			_ = cw.CloseWrite()
		}
	}()

	var downErr error
	buf := make([]byte, copyBufSize)
	for {
		n, err := conn.Read(buf)
		if n > 0 {
			if _, werr := w.Write(buf[:n]); werr != nil {
				break
			}
			_ = rc.Flush()
		}
		if err != nil {
			if !errors.Is(err, io.EOF) {
				downErr = err
			}
			break
		}
	}
	// Unblock the up copier (a pending body read or conn write) and wait
	// for it: the request body must not be used after the handler returns.
	_ = r.Body.Close()
	_ = conn.Close()
	<-upDone
	if downErr != nil && r.Context().Err() == nil {
		panic(http.ErrAbortHandler)
	}
}

// spliceHijacked runs a CONNECT stream over HTTP/1.1 on the hijacked
// connection. It returns after both copiers stopped and both sides are closed.
func spliceHijacked(w http.ResponseWriter, conn net.Conn) {
	nc, brw, err := http.NewResponseController(w).Hijack()
	if err != nil {
		_ = conn.Close()
		http.Error(w, "connect over this protocol is not supported", http.StatusInternalServerError)
		return
	}
	defer func() { _ = nc.Close() }()
	defer func() { _ = conn.Close() }()
	if _, err := brw.WriteString("HTTP/1.1 200 OK\r\n\r\n"); err != nil {
		return
	}
	if err := brw.Flush(); err != nil {
		return
	}

	upDone := make(chan struct{})
	go func() {
		defer close(upDone)
		// brw.Reader holds whatever the caller sent after the request head.
		if _, err := io.Copy(conn, brw.Reader); err != nil {
			_ = conn.Close()
			return
		}
		if cw, ok := conn.(closeWriter); ok {
			_ = cw.CloseWrite()
		}
	}()
	_, _ = copyConn(nc, conn)
	_ = nc.Close()
	_ = conn.Close()
	<-upDone
}

// copyConn copies src to dst without ReaderFrom/WriterTo shortcuts.
func copyConn(dst io.Writer, src io.Reader) (int64, error) {
	return io.CopyBuffer(struct{ io.Writer }{dst}, struct{ io.Reader }{src}, make([]byte, copyBufSize))
}

// NewPeerTransport returns the client transport for pod-to-pod calls to
// internal listeners: cleartext HTTP/2 only (prior knowledge), with the
// spec's receive buffers, frame size and PING liveness.
func NewPeerTransport() *http.Transport {
	var p http.Protocols
	p.SetUnencryptedHTTP2(true)
	d := h2.DefaultClientConfig()
	dialer := &net.Dialer{Timeout: peerDialTimeout, KeepAlive: peerKeepAlive}
	return &http.Transport{
		Protocols:       &p,
		DialContext:     dialer.DialContext,
		IdleConnTimeout: peerIdleTimeout,
		HTTP2: &http.HTTP2Config{
			MaxReceiveBufferPerStream:     d.StreamWindow,
			MaxReceiveBufferPerConnection: d.ConnWindow,
			MaxReadFrameSize:              d.MaxFrame,
			SendPingTimeout:               d.PingIdle,
			PingTimeout:                   d.PingTimeout,
		},
	}
}

// DialRemoteTCP opens a TCP stream to localhost:port inside a machine
// whose tunnel is on another gateway instance: an HTTP/2 CONNECT with
// :authority <machineId>:<port> to that instance's internal listener at
// instanceURL, over rt (NewPeerTransport). ctx bounds the dial only.
// opts.DrainDeadline is sent as Sbx-Tcp-Drain-Deadline-Ms.
//
// Errors: 421 → *transport.MovedError with the owner's URL; 429 →
// ErrTooManyStreams; any other non-200 → *transport.DialError. The returned
// conn supports CloseWrite; deadlines are not supported.
//
// serviceToken is sent to instanceURL: it must come from the registry. A
// MovedError's InstanceURL must be validated (registry.Store.InstanceByURL
// or a fresh Owner lookup) before it is passed back in here.
func DialRemoteTCP(ctx context.Context, rt http.RoundTripper, instanceURL, serviceToken, machineID string, port uint16, opts TCPOptions) (net.Conn, error) {
	base, err := url.Parse(instanceURL)
	if err != nil || base.Host == "" {
		return nil, fmt.Errorf("gateway: bad instance url %q", instanceURL)
	}
	authority := net.JoinHostPort(machineID, strconv.Itoa(int(port)))
	// The stream outlives ctx: it gets its own context, cancelled on Close.
	sctx, cancel := context.WithCancel(context.WithoutCancel(ctx))
	pr, pw := io.Pipe()
	req, err := http.NewRequestWithContext(sctx, http.MethodConnect, base.Scheme+"://"+base.Host, pr)
	if err != nil {
		cancel()
		return nil, err
	}
	req.Host = authority
	req.ContentLength = -1
	req.Header.Set("Authorization", "Bearer "+serviceToken)
	if opts.DrainDeadline > 0 {
		req.Header.Set(wire.HeaderTCPDrainDeadline, strconv.FormatInt(opts.DrainDeadline.Milliseconds(), 10))
	}
	fail := func(err error) (net.Conn, error) {
		_ = pw.Close()
		cancel()
		return nil, err
	}
	stop := context.AfterFunc(ctx, cancel)
	resp, err := rt.RoundTrip(req)
	if !stop() {
		if err == nil {
			_ = resp.Body.Close()
		}
		return fail(context.Cause(ctx))
	}
	if err != nil {
		return fail(err)
	}
	if resp.StatusCode != http.StatusOK {
		_ = resp.Body.Close()
		switch resp.StatusCode {
		case http.StatusMisdirectedRequest:
			return fail(&transport.MovedError{InstanceURL: resp.Header.Get(wire.HeaderInstanceURL)})
		case http.StatusTooManyRequests:
			return fail(ErrTooManyStreams)
		default:
			return fail(&transport.DialError{Status: resp.StatusCode})
		}
	}
	return &remoteConn{
		body: resp.Body, pw: pw, cancel: cancel,
		remote: tunnelAddr(authority), local: tunnelAddr(base.Host),
	}, nil
}

// remoteConn is a TCP stream over a peer CONNECT. Deadlines are not supported.
type remoteConn struct {
	body          io.ReadCloser
	pw            *io.PipeWriter
	cancel        context.CancelFunc
	remote, local tunnelAddr

	closed    atomic.Bool
	closeOnce sync.Once
}

func (c *remoteConn) Read(p []byte) (int, error) {
	n, err := c.body.Read(p)
	if err != nil && c.closed.Load() {
		err = net.ErrClosed
	}
	return n, err
}

func (c *remoteConn) Write(p []byte) (int, error) {
	n, err := c.pw.Write(p)
	if err != nil && c.closed.Load() {
		err = net.ErrClosed
	}
	return n, err
}

// CloseWrite half-closes the stream: the target sees EOF.
func (c *remoteConn) CloseWrite() error { return c.pw.Close() }

func (c *remoteConn) Close() error {
	c.closeOnce.Do(func() {
		c.closed.Store(true)
		_ = c.pw.CloseWithError(net.ErrClosed)
		_ = c.body.Close()
		c.cancel()
	})
	return nil
}

func (c *remoteConn) LocalAddr() net.Addr  { return c.local }
func (c *remoteConn) RemoteAddr() net.Addr { return c.remote }

func (c *remoteConn) SetDeadline(time.Time) error      { return errDeadlinesUnsupported }
func (c *remoteConn) SetReadDeadline(time.Time) error  { return errDeadlinesUnsupported }
func (c *remoteConn) SetWriteDeadline(time.Time) error { return errDeadlinesUnsupported }
