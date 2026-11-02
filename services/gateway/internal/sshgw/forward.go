package sshgw

import (
	"context"
	"errors"
	"io"
	"sync"
	"sync/atomic"

	"golang.org/x/crypto/ssh"
)

// clientChannelTypes are the channel types a client may open; they are
// opened on the backend with the same type and extra data (spec 9.4).
var clientChannelTypes = map[string]bool{
	"session":                        true,
	"direct-tcpip":                   true,
	"direct-streamlocal@openssh.com": true,
}

// backendChannelTypes are the channel types the VM's sshd may open; they
// are opened on the client (spec 9.4).
var backendChannelTypes = map[string]bool{
	"forwarded-tcpip":                   true,
	"forwarded-streamlocal@openssh.com": true,
	"auth-agent@openssh.com":            true,
	"x11":                               true,
}

// channelLabel bounds the type label of ssh_channels_total.
func channelLabel(typ string) string {
	if clientChannelTypes[typ] || backendChannelTypes[typ] {
		return typ
	}
	return "other"
}

const (
	chanSession = "session"
	// limitedMessage is the refusal of a session channel over the per-user
	// limit (spec 11).
	limitedMessage = "umiak: too many SSH sessions for this user"
	closingMessage = "umiak: connection closing"
	// tooManyMessage refuses a channel over Config.MaxChannels.
	tooManyMessage = "umiak: too many open channels"
	// notRequestedMessage refuses a VM agent or X11 channel the client did
	// not ask for.
	notRequestedMessage = "umiak: forwarding not requested"
)

// Channel requests of the client that allow VM-initiated channels.
const (
	reqAgent = "auth-agent-req@openssh.com"
	reqX11   = "x11-req"
)

// channel is one proxied channel of a session.
type channel struct {
	typ string
	// session is true for a client session channel; only those get
	// gateway notices on stderr.
	session bool
	// client is the client side of the channel.
	client ssh.Channel
	// interactive is set once a pty-req was accepted.
	interactive atomic.Bool
	// errMu serializes writes to the client's stderr: the copy from the
	// backend and gateway notices.
	errMu sync.Mutex
}

// lockedStderr is the client's stderr with every write under errMu.
type lockedStderr struct{ ch *channel }

func (w lockedStderr) Write(p []byte) (int, error) {
	w.ch.errMu.Lock()
	defer w.ch.errMu.Unlock()
	return w.ch.client.Stderr().Write(p)
}

// forward proxies the connection until the client's channel stream ends
// (the client conn closed) and every goroutine it started finished. ctx
// done closes both conns (run arranges that), which ends everything.
func (ss *session) forward(ctx context.Context, b *backend, chans <-chan ssh.NewChannel, reqs <-chan *ssh.Request) {
	ctx, cancel := context.WithCancel(ctx)
	var wg sync.WaitGroup
	defer wg.Wait()
	defer cancel()
	wg.Go(func() { ss.clientGlobalRequests(reqs, b.conn) })
	wg.Go(func() { backendGlobalRequests(b.reqs) })
	wg.Go(func() { ss.keepalive(ctx, b.conn) })
	wg.Go(func() {
		for nc := range b.chans {
			if ctx.Err() != nil {
				_ = nc.Reject(ssh.ConnectionFailed, closingMessage)
				continue
			}
			typ := nc.ChannelType()
			if !backendChannelTypes[typ] {
				_ = nc.Reject(ssh.UnknownChannelType, "umiak: unsupported channel type")
				continue
			}
			// Agent and X11 channels only after the client asked for them
			// on this connection.
			if (typ == "auth-agent@openssh.com" && !ss.agentRequested.Load()) || (typ == "x11" && !ss.x11Requested.Load()) {
				_ = nc.Reject(ssh.Prohibited, notRequestedMessage)
				continue
			}
			if !ss.reserveChannel() {
				_ = nc.Reject(ssh.ResourceShortage, tooManyMessage)
				continue
			}
			wg.Go(func() { ss.proxyChannel(nc, ss.conn, false, nil) })
		}
	})
	for nc := range chans {
		if ctx.Err() != nil {
			_ = nc.Reject(ssh.ConnectionFailed, closingMessage)
			continue
		}
		typ := nc.ChannelType()
		if !clientChannelTypes[typ] {
			_ = nc.Reject(ssh.UnknownChannelType, "umiak: unsupported channel type")
			continue
		}
		if !ss.reserveChannel() {
			_ = nc.Reject(ssh.ResourceShortage, tooManyMessage)
			continue
		}
		var release func()
		if typ == chanSession {
			var ok bool
			if release, ok = ss.acquireSession(); !ok {
				ss.unreserveChannel()
				ss.sessionMetric(resultLimited)
				_ = nc.Reject(ssh.ResourceShortage, limitedMessage)
				continue
			}
		}
		wg.Go(func() { ss.proxyChannel(nc, b.conn, true, release) })
	}
	// The client conn is gone: end the backend too. The client's close
	// came first, so it is the reason (the first reason wins).
	ss.setReason(reasonClient)
	_ = b.conn.Close()
}

// reserveChannel takes one of the connection's MaxChannels slots (open
// channels of all types, both directions). proxyChannel gives it back.
func (ss *session) reserveChannel() bool {
	if ss.nchans.Add(1) > int64(ss.srv.cfg.MaxChannels) {
		ss.nchans.Add(-1)
		return false
	}
	return true
}

func (ss *session) unreserveChannel() { ss.nchans.Add(-1) }

// acquireSession takes a slot of the per-actor session limit.
func (ss *session) acquireSession() (release func(), ok bool) {
	lim := ss.srv.cfg.Limits
	if lim == nil {
		return func() {}, true
	}
	return lim.AcquireSSHSession(ss.id.actorKeyID())
}

// proxyChannel opens nc's type on dst, accepts nc and pipes the two
// channels. A refusal by dst is passed on with its reason and message.
// fromClient tells which side nc came from. release, when set, is called
// once the channel is finished. The caller reserved a channel slot; it is
// given back on return.
func (ss *session) proxyChannel(nc ssh.NewChannel, dst ssh.Conn, fromClient bool, release func()) {
	defer ss.unreserveChannel()
	if release != nil {
		defer release()
	}
	typ := nc.ChannelType()
	isSession := fromClient && typ == chanSession
	dch, dreqs, err := dst.OpenChannel(typ, nc.ExtraData())
	if err != nil {
		if isSession {
			ss.sessionMetric(resultRejected)
		}
		var oce *ssh.OpenChannelError
		if errors.As(err, &oce) {
			_ = nc.Reject(oce.Reason, oce.Message)
		} else {
			_ = nc.Reject(ssh.ConnectionFailed, closingMessage)
		}
		return
	}
	sch, sreqs, err := nc.Accept()
	if err != nil {
		_ = dch.Close()
		return
	}
	if isSession {
		ss.sessionMetric(resultOK)
	}
	ch := &channel{typ: typ, session: isSession, client: sch}
	p := pipe{a: sch, areqs: sreqs, b: dch, breqs: dreqs, aToB: &ss.bytesIn, bToA: &ss.bytesOut}
	if !fromClient {
		ch.client = dch
		p.aToB, p.bToA = &ss.bytesOut, &ss.bytesIn
	}
	if isSession {
		p.aStderr = lockedStderr{ch}
		p.onARequest = func(r *ssh.Request) {
			// Marked before sending: the VM may open the channel before
			// its reply reaches the client.
			switch r.Type {
			case reqAgent:
				ss.agentRequested.Store(true)
			case reqX11:
				ss.x11Requested.Store(true)
			}
		}
		p.onAReply = func(r *ssh.Request, ok bool) {
			if ok && r.Type == "pty-req" && !ch.interactive.Swap(true) {
				ss.ptyOpened(ch)
			}
		}
	}
	ss.openChannel(ch)
	defer ss.closeChannel(ch)
	p.run()
}

// pipe copies data, extended data (stderr) and requests between two
// channels a and b until both are closed.
type pipe struct {
	a     ssh.Channel
	areqs <-chan *ssh.Request
	b     ssh.Channel
	breqs <-chan *ssh.Request
	// aToB counts the data from a to b, bToA the other way.
	aToB, bToA *atomic.Int64
	// aStderr, when set, replaces a.Stderr() as the stderr destination.
	aStderr io.Writer
	// onARequest, when set, sees each request of a before it is sent to b.
	onARequest func(r *ssh.Request)
	// onAReply, when set, sees each request of a with b's answer (a
	// delivered request without want-reply counts as accepted).
	onAReply func(r *ssh.Request, ok bool)
}

// run pipes until both channels are closed.
//
// Ordering, per direction src → dst:
//   - EOF: the copy goroutine only signals that src's data ended; the
//     request forwarder sends CloseWrite on dst once every request src
//     sent before its EOF was forwarded. x/crypto queues a request before
//     it processes a following EOF packet, so draining the queue at that
//     point keeps the wire order: an exec followed at once by EOF (ssh -n)
//     reaches the VM as exec, then EOF (sshd drops an EOF that comes
//     before the command);
//   - exit-status and exit-signal from b wait until b's data and stderr
//     were copied to a, so they never overtake trailing output;
//   - close: a side that closes makes the other close once its data was
//     copied and its requests and their replies were delivered.
func (p *pipe) run() {
	var wg sync.WaitGroup
	abDone := make(chan struct{})
	baDone := make(chan struct{})
	// aReply is held while a request of a is forwarded and answered, so a
	// is not closed before the reply reached it (a fast backend sends the
	// exec reply, the exit status and the close back to back); bReply
	// likewise.
	var aReply, bReply sync.Mutex
	aStderr := p.aStderr
	if aStderr == nil {
		aStderr = p.a.Stderr()
	}
	wg.Go(func() {
		copyHalf(p.b, p.b.Stderr(), p.a, p.aToB)
		close(abDone)
	})
	wg.Go(func() {
		copyHalf(p.a, aStderr, p.b, p.bToA)
		close(baDone)
	})
	wg.Go(func() {
		fw := forwarder{dst: p.b, reqs: p.areqs, eof: abDone, mu: &aReply, before: p.onARequest, after: p.onAReply}
		fw.run()
		// a closed and its data and EOF were delivered: close b.
		bReply.Lock()
		_ = p.b.Close()
		bReply.Unlock()
	})
	wg.Go(func() {
		// b's requests (exit-status, exit-signal) all reach a before the
		// close below: reqs ends only when b's close arrived.
		fw := forwarder{dst: p.a, reqs: p.breqs, eof: baDone, mu: &bReply, holdExit: true}
		fw.run()
		aReply.Lock()
		_ = p.a.Close()
		aReply.Unlock()
	})
	wg.Wait()
}

// copyHalf copies data and stderr from src to dst until src's EOF. The
// EOF itself is sent by the request forwarder.
func copyHalf(dst ssh.Channel, dstErr io.Writer, src ssh.Channel, n *atomic.Int64) {
	var wg sync.WaitGroup
	wg.Go(func() { count(n, dst, src) })
	wg.Go(func() { count(n, dstErr, src.Stderr()) })
	wg.Wait()
}

// count copies src to dst and adds the bytes to n.
func count(n *atomic.Int64, dst io.Writer, src io.Reader) {
	c, _ := io.Copy(dst, src)
	if n != nil {
		n.Add(c)
	}
}

// forwarder sends the requests of one channel to dst, passing replies
// back, and sends dst's EOF in order with them (see pipe.run).
type forwarder struct {
	dst  ssh.Channel
	reqs <-chan *ssh.Request
	// eof is closed when the source's data and stderr were copied.
	eof <-chan struct{}
	// mu is held while a request is sent and answered.
	mu *sync.Mutex
	// holdExit delays exit-status and exit-signal until eof.
	holdExit bool
	before   func(*ssh.Request)
	after    func(*ssh.Request, bool)
}

// run returns once reqs is closed (the source channel closed) and the EOF
// was sent.
func (f *forwarder) run() {
	for f.reqs != nil || f.eof != nil {
		select {
		case r, ok := <-f.reqs:
			if !ok {
				f.reqs = nil
				continue
			}
			if f.holdExit && f.eof != nil && (r.Type == "exit-status" || r.Type == "exit-signal") {
				<-f.eof
				f.send(r)
				f.sendEOF()
				continue
			}
			f.send(r)
		case <-f.eof:
			f.sendEOF()
		}
	}
}

// sendEOF forwards the requests already queued (they came before the
// EOF), then sends EOF to dst.
func (f *forwarder) sendEOF() {
	for f.reqs != nil {
		select {
		case r, ok := <-f.reqs:
			if !ok {
				f.reqs = nil
				continue
			}
			f.send(r)
			continue
		default:
		}
		break
	}
	_ = f.dst.CloseWrite()
	f.eof = nil
}

// send forwards one request, unknown names included, with want-reply, and
// passes the reply back.
func (f *forwarder) send(r *ssh.Request) {
	if f.before != nil {
		f.before(r)
	}
	f.mu.Lock()
	defer f.mu.Unlock()
	ok, err := f.dst.SendRequest(r.Type, r.WantReply, r.Payload)
	if err != nil {
		ok = false
	}
	if f.after != nil {
		// Without want-reply, a delivered request counts as accepted.
		f.after(r, ok || (!r.WantReply && err == nil))
	}
	if r.WantReply {
		_ = r.Reply(ok, nil)
	}
}
