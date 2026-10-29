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
	limitedMessage = "sbx: too many SSH sessions for this user"
	closingMessage = "sbx: connection closing"
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
			if !backendChannelTypes[nc.ChannelType()] {
				_ = nc.Reject(ssh.UnknownChannelType, "sbx: unsupported channel type")
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
			_ = nc.Reject(ssh.UnknownChannelType, "sbx: unsupported channel type")
			continue
		}
		var release func()
		if typ == chanSession {
			var ok bool
			if release, ok = ss.acquireSession(); !ok {
				ss.sessionMetric(resultLimited)
				_ = nc.Reject(ssh.ResourceShortage, limitedMessage)
				continue
			}
		}
		wg.Go(func() { ss.proxyChannel(nc, b.conn, true, release) })
	}
	// The client conn is gone: end the backend too.
	_ = b.conn.Close()
}

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
// once the channel is finished.
func (ss *session) proxyChannel(nc ssh.NewChannel, dst ssh.Conn, fromClient bool, release func()) {
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
		p.onAReply = func(r *ssh.Request, ok bool) {
			if ok && r.Type == "pty-req" {
				ch.interactive.Store(true)
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
	// onAReply, when set, sees each request of a with b's answer (a
	// delivered request without want-reply counts as accepted).
	onAReply func(r *ssh.Request, ok bool)
}

// run pipes until both channels are closed. EOF from one side becomes
// CloseWrite on the other; a side that closes makes the other close once
// the data it sent was copied and its requests (exit-status, exit-signal,
// replies) were delivered.
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
		forwardRequests(p.b, p.areqs, &aReply, p.onAReply)
		// a closed: deliver what it sent, then close b.
		<-abDone
		bReply.Lock()
		_ = p.b.Close()
		bReply.Unlock()
	})
	wg.Go(func() {
		// b's requests (exit-status, exit-signal) all reach a before the
		// close below: reqs ends only when b's close arrived.
		forwardRequests(p.a, p.breqs, &bReply, nil)
		<-baDone
		aReply.Lock()
		_ = p.a.Close()
		aReply.Unlock()
	})
	wg.Wait()
}

// copyHalf copies data and stderr from src to dst, then sends EOF to dst.
func copyHalf(dst ssh.Channel, dstErr io.Writer, src ssh.Channel, n *atomic.Int64) {
	var wg sync.WaitGroup
	wg.Go(func() { count(n, dst, src) })
	wg.Go(func() { count(n, dstErr, src.Stderr()) })
	wg.Wait()
	_ = dst.CloseWrite()
}

// count copies src to dst and adds the bytes to n.
func count(n *atomic.Int64, dst io.Writer, src io.Reader) {
	c, _ := io.Copy(dst, src)
	if n != nil {
		n.Add(c)
	}
}

// forwardRequests sends every request of reqs on dst and passes the reply
// back, holding mu meanwhile. Unknown request names are forwarded too. It
// returns when reqs is closed (the source channel closed).
func forwardRequests(dst ssh.Channel, reqs <-chan *ssh.Request, mu *sync.Mutex, onReply func(*ssh.Request, bool)) {
	for r := range reqs {
		mu.Lock()
		ok, err := dst.SendRequest(r.Type, r.WantReply, r.Payload)
		if err != nil {
			ok = false
		}
		if onReply != nil {
			// Without want-reply, a delivered request counts as accepted.
			onReply(r, ok || (!r.WantReply && err == nil))
		}
		if r.WantReply {
			_ = r.Reply(ok, nil)
		}
		mu.Unlock()
	}
}
