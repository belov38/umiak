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

// forward proxies the connection until the client's channel stream ends
// (the client conn closed) and every channel finished. ctx done closes both
// conns, which ends everything.
//
// Task 12 extends this with the global requests, backend-initiated
// channels, keepalive and the session limit.
func (ss *session) forward(ctx context.Context, b *backend, chans <-chan ssh.NewChannel) {
	var wg sync.WaitGroup
	defer wg.Wait()
	// Backend global requests (hostkeys-00@openssh.com) are dropped.
	wg.Go(func() { ssh.DiscardRequests(b.reqs) })
	wg.Go(func() {
		for nc := range b.chans {
			_ = nc.Reject(ssh.Prohibited, "sbx: not supported")
		}
	})
	for nc := range chans {
		if ctx.Err() != nil {
			_ = nc.Reject(ssh.ConnectionFailed, "sbx: connection closing")
			continue
		}
		if !clientChannelTypes[nc.ChannelType()] {
			_ = nc.Reject(ssh.UnknownChannelType, "sbx: unsupported channel type")
			continue
		}
		wg.Go(func() { ss.proxyChannel(nc, b.conn, &ss.bytesIn, &ss.bytesOut) })
	}
	// The client conn is gone: end the backend too.
	_ = b.conn.Close()
}

// proxyChannel opens nc's type on dst, accepts nc and pipes the two
// channels. A refusal by dst is passed on with its reason and message.
// in counts bytes from nc's side, out bytes to it.
func (ss *session) proxyChannel(nc ssh.NewChannel, dst ssh.Conn, in, out *atomic.Int64) {
	dch, dreqs, err := dst.OpenChannel(nc.ChannelType(), nc.ExtraData())
	if err != nil {
		var oce *ssh.OpenChannelError
		if errors.As(err, &oce) {
			_ = nc.Reject(oce.Reason, oce.Message)
		} else {
			_ = nc.Reject(ssh.ConnectionFailed, "sbx: connection closing")
		}
		return
	}
	sch, sreqs, err := nc.Accept()
	if err != nil {
		_ = dch.Close()
		return
	}
	ss.addChannel(nc.ChannelType())
	pipeChannels(sch, sreqs, dch, dreqs, in, out)
}

// pipeChannels copies data, extended data (stderr) and requests between
// two channels until both are closed. EOF from one side becomes CloseWrite
// on the other; a side that closes makes the other close once the data it
// sent was copied and the replies to its requests were delivered.
func pipeChannels(a ssh.Channel, areqs <-chan *ssh.Request, b ssh.Channel, breqs <-chan *ssh.Request, aToB, bToA *atomic.Int64) {
	var wg sync.WaitGroup
	abDone := make(chan struct{})
	baDone := make(chan struct{})
	// aReply is held while a request of a is forwarded and answered, so a
	// is not closed before the reply reached it (a fast backend sends the
	// exec reply, the exit status and the close back to back); bReply
	// likewise.
	var aReply, bReply sync.Mutex
	wg.Go(func() {
		copyHalf(b, a, aToB)
		close(abDone)
	})
	wg.Go(func() {
		copyHalf(a, b, bToA)
		close(baDone)
	})
	wg.Go(func() {
		forwardRequests(b, areqs, &aReply)
		// a closed: deliver what it sent, then close b.
		<-abDone
		bReply.Lock()
		_ = b.Close()
		bReply.Unlock()
	})
	wg.Go(func() {
		forwardRequests(a, breqs, &bReply)
		<-baDone
		aReply.Lock()
		_ = a.Close()
		aReply.Unlock()
	})
	wg.Wait()
}

// copyHalf copies data and stderr from src to dst, then sends EOF to dst.
func copyHalf(dst, src ssh.Channel, n *atomic.Int64) {
	var wg sync.WaitGroup
	wg.Go(func() { count(n, dst, src) })
	wg.Go(func() { count(n, dst.Stderr(), src.Stderr()) })
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
// back, holding mu meanwhile. It returns when reqs is closed (the source
// channel closed).
func forwardRequests(dst ssh.Channel, reqs <-chan *ssh.Request, mu *sync.Mutex) {
	for r := range reqs {
		mu.Lock()
		ok, err := dst.SendRequest(r.Type, r.WantReply, r.Payload)
		if err != nil {
			ok = false
		}
		if r.WantReply {
			_ = r.Reply(ok, nil)
		}
		mu.Unlock()
	}
}
