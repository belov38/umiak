package sshgw

import (
	"context"
	"crypto/rand"
	"encoding/hex"
	"io"
	"log/slog"
	"maps"
	"net/netip"
	"sync"
	"sync/atomic"
	"time"

	"golang.org/x/crypto/ssh"

	"github.com/belov38/boat-dev-clone/services/gateway/internal/obs"
)

const (
	// stoppedTimeout closes a connection to a sandbox that cannot be
	// reached when the client opens no session channel.
	stoppedTimeout = 30 * time.Second
	// stoppedGrace is how long the client may take to disconnect after
	// the stopped message, before the gateway closes the connection.
	stoppedGrace = 5 * time.Second
	// stoppedExitStatus is the exit status of the stopped message.
	stoppedExitStatus = 255
)

// Results of sbx_gateway_ssh_sessions_total, counted per session channel:
// ok (opened on the VM), limited (over the per-user limit), rejected
// (refused by the VM, or answered with the stopped message).
const (
	resultOK       = "ok"
	resultLimited  = "limited"
	resultRejected = "rejected"
)

// Close reasons in the SSH log.
const (
	reasonClient      = "client_closed"
	reasonBackend     = "backend_closed"
	reasonKeepalive   = "keepalive_timeout"
	reasonShutdown    = "shutdown"
	reasonUnavailable = "sandbox_unavailable"
	reasonRevoked     = "revoked"
	reasonDrain       = "drain"
)

// session is one authenticated client connection.
type session struct {
	srv   *Server
	sid   string // the session id of logs and the backend KeyId
	ip    netip.Addr
	conn  *ssh.ServerConn
	id    identity
	start time.Time
	log   *slog.Logger

	bytesIn  atomic.Int64 // channel data from the client
	bytesOut atomic.Int64 // channel data to the client
	// nchans counts the open (or opening) proxied channels.
	nchans atomic.Int64
	// agentRequested and x11Requested are set once the client sent
	// auth-agent-req@openssh.com or x11-req on a session channel.
	agentRequested, x11Requested atomic.Bool

	// mu guards the fields below. It is a leaf lock: nothing else is
	// locked or blocked on while it is held.
	mu      sync.Mutex
	backend *backend
	// channels counts the opened channels by type, for the log.
	channels map[string]int
	// open is the set of proxied channels that are open.
	open   map[*channel]struct{}
	reason string
	// ended is set when run is about to wait for wg; no notice may start
	// after that.
	ended bool
	// wg tracks notice writes (notify).
	wg sync.WaitGroup
}

func newSession(s *Server, conn *ssh.ServerConn, id identity, ip netip.Addr) *session {
	sid := newSessionID()
	actor := id.Auth.Actor.UserID
	if id.Auth.Actor.Kind == actorTeamKey {
		actor = id.Auth.Actor.APIKeyID
	}
	return &session{
		srv:      s,
		sid:      sid,
		ip:       ip,
		conn:     conn,
		id:       id,
		start:    time.Now(),
		channels: map[string]int{},
		open:     map[*channel]struct{}{},
		log: s.log.With("session_id", sid, "client_ip", ip.String(), "sandbox", conn.User(),
			"sandbox_id", id.Auth.SandboxID, "actor", actor),
	}
}

// newSessionID returns 16 random hex characters.
func newSessionID() string {
	var b [8]byte
	if _, err := rand.Read(b[:]); err != nil {
		panic(err) // crypto/rand does not fail
	}
	return hex.EncodeToString(b[:])
}

// ident returns the immutable identity of the session.
func (ss *session) ident() identity { return ss.id }

// ownerInstance returns the instance holding the tunnel of the backend
// stream, or "" before the backend is connected.
func (ss *session) ownerInstance() string {
	ss.mu.Lock()
	defer ss.mu.Unlock()
	if ss.backend == nil {
		return ""
	}
	return ss.backend.owner
}

// setReason records the first close reason.
func (ss *session) setReason(r string) {
	ss.mu.Lock()
	defer ss.mu.Unlock()
	if ss.reason == "" {
		ss.reason = r
	}
}

// countChannel records an opened channel for the log and the metric.
func (ss *session) countChannel(typ string) {
	ss.mu.Lock()
	ss.channels[typ]++
	ss.mu.Unlock()
	if m := ss.srv.cfg.Metrics; m != nil {
		m.SSHChannels.WithLabelValues(channelLabel(typ)).Inc()
	}
}

// openChannel counts ch and adds it to the open set.
func (ss *session) openChannel(ch *channel) {
	ss.countChannel(ch.typ)
	ss.mu.Lock()
	ss.open[ch] = struct{}{}
	ss.mu.Unlock()
}

func (ss *session) closeChannel(ch *channel) {
	ss.mu.Lock()
	delete(ss.open, ch)
	ss.mu.Unlock()
}

// sessionChannels returns the open client session channels, only the
// interactive ones (a pty-req was accepted) when interactiveOnly is set.
func (ss *session) sessionChannels(interactiveOnly bool) []*channel {
	ss.mu.Lock()
	defer ss.mu.Unlock()
	var out []*channel
	for ch := range ss.open {
		if ch.session && (!interactiveOnly || ch.interactive.Load()) {
			out = append(out, ch)
		}
	}
	return out
}

// notify writes msg followed by "\r\n" to the stderr of the open session
// channels (only the interactive ones when interactiveOnly is set), for
// drain warnings and revocation notices. The writes are serialized with
// the stderr data the backend sends. They run in the background, because
// a client that does not read blocks them; the returned channel is closed
// when all of them finished. A write to a channel or conn that closes ends
// with an error, so a write never outlives its session.
func (ss *session) notify(msg string, interactiveOnly bool) <-chan struct{} {
	done := make(chan struct{})
	chans := ss.sessionChannels(interactiveOnly)
	ss.mu.Lock()
	if ss.ended || len(chans) == 0 {
		ss.mu.Unlock()
		close(done)
		return done
	}
	var writes sync.WaitGroup
	writes.Add(len(chans))
	ss.wg.Add(len(chans) + 1)
	ss.mu.Unlock()
	line := []byte(msg + "\r\n")
	for _, ch := range chans {
		go func() {
			defer ss.wg.Done()
			defer writes.Done()
			_, _ = lockedStderr{ch}.Write(line)
		}()
	}
	go func() {
		defer ss.wg.Done()
		writes.Wait()
		close(done)
	}()
	return done
}

// ptyOpened announces a known drain deadline on ch, which just became
// interactive: the announcement of the deadline went out before. The
// write runs in the background like notify's.
func (ss *session) ptyOpened(ch *channel) {
	remaining := ss.srv.drainRemaining(ss)
	if remaining <= 0 {
		return
	}
	ss.mu.Lock()
	if ss.ended {
		ss.mu.Unlock()
		return
	}
	ss.wg.Add(1)
	ss.mu.Unlock()
	line := []byte(drainWarning(remaining) + "\r\n")
	go func() {
		defer ss.wg.Done()
		_, _ = lockedStderr{ch}.Write(line)
	}()
}

// closeWithReason records reason (unless an earlier one is set) and closes
// the client and backend conns, which ends the session.
func (ss *session) closeWithReason(reason string) {
	ss.setReason(reason)
	ss.mu.Lock()
	b := ss.backend
	ss.mu.Unlock()
	_ = ss.conn.Close()
	if b != nil {
		_ = b.conn.Close()
	}
}

// run serves the connection until the client or the backend ends it, or
// ctx is done.
func (ss *session) run(ctx context.Context, chans <-chan ssh.NewChannel, reqs <-chan *ssh.Request) {
	ctx, cancel := context.WithCancel(ctx)
	defer cancel()
	defer ss.writeLog()
	defer ss.waitNotices()
	go func() {
		_ = ss.conn.Wait()
		ss.setReason(reasonClient)
		cancel()
	}()
	stop := context.AfterFunc(ctx, func() {
		ss.setReason(reasonShutdown)
		_ = ss.conn.Close()
	})
	defer stop()
	defer func() { _ = ss.conn.Close() }()

	// Client global requests wait in their channel while the backend
	// connects; they need it. x/crypto buffers 16 of them; beyond that its
	// read loop blocks, so the client conn stalls until the backend is up
	// (bounded by the dial and handshake timeouts).
	b, msg := ss.connectBackend(ctx)
	if b == nil {
		// Without a backend every global request is refused. The
		// goroutine ends when the conn closes (deferred above).
		go ssh.DiscardRequests(reqs)
		if ctx.Err() != nil {
			return
		}
		ss.setReason(reasonUnavailable)
		ss.serveStopped(ctx, chans, msg)
		return
	}
	ss.mu.Lock()
	ss.backend = b
	ss.mu.Unlock()
	// The owner instance of the stream may already drain.
	ss.srv.applyDeadline(ss)
	go func() {
		_ = b.conn.Wait()
		ss.setReason(reasonBackend)
		cancel()
	}()
	stopB := context.AfterFunc(ctx, func() { _ = b.conn.Close() })
	defer stopB()
	defer func() { _ = b.conn.Close() }()
	ss.forward(ctx, b, chans, reqs)
	// forward returns once the client conn ended; an earlier reason
	// (backend, shutdown) wins.
	ss.setReason(reasonClient)
}

// waitNotices waits for the notice writes. The conns are closed by then
// (run's defers run in reverse), so the writes end.
func (ss *session) waitNotices() {
	ss.mu.Lock()
	ss.ended = true
	ss.mu.Unlock()
	ss.wg.Wait()
}

func (ss *session) sessionMetric(result string) {
	if m := ss.srv.cfg.Metrics; m != nil {
		m.SSHSessions.WithLabelValues(result).Inc()
	}
}

// writeLog writes the SSH log line of the session (spec 12.2).
func (ss *session) writeLog() {
	l := ss.srv.cfg.Log
	if l == nil {
		return
	}
	ss.mu.Lock()
	channels := maps.Clone(ss.channels)
	reason := ss.reason
	b := ss.backend
	ss.mu.Unlock()
	e := obs.SSHEntry{
		SessionID:   ss.sid,
		ClientIP:    ss.ip.String(),
		SandboxID:   ss.id.Auth.SandboxID,
		Start:       ss.start,
		End:         time.Now(),
		BytesIn:     ss.bytesIn.Load(),
		BytesOut:    ss.bytesOut.Load(),
		Channels:    channels,
		CloseReason: reason,
	}
	if b != nil {
		e.BackendHostKey = b.HostKey()
	}
	if ss.id.Auth.Actor.Kind == actorTeamKey {
		e.ActorKind, e.APIKeyID = "api_key", ss.id.Auth.Actor.APIKeyID
	} else {
		e.ActorKind, e.UserID = actorUser, ss.id.Auth.Actor.UserID
	}
	if ss.id.Method == MethodCert {
		e.CertSerial = ss.id.CertSerial
	} else {
		e.Fingerprint = ss.id.Fingerprint
	}
	l.SSH(e)
}

// serveStopped answers a connection whose sandbox cannot be reached (spec
// 9.3): the first session channel gets msg on stderr and exit status 255,
// then the connection closes. Without a session channel it closes after
// stoppedTimeout.
func (ss *session) serveStopped(ctx context.Context, chans <-chan ssh.NewChannel, msg string) {
	timer := time.AfterFunc(stoppedTimeout, func() { _ = ss.conn.Close() })
	defer timer.Stop()
	for nc := range chans {
		if nc.ChannelType() != "session" {
			_ = nc.Reject(ssh.Prohibited, msg)
			continue
		}
		ch, reqs, err := nc.Accept()
		if err != nil {
			return
		}
		ss.countChannel(nc.ChannelType())
		ss.sessionMetric(resultRejected)
		stoppedChannel(ctx, ch, reqs, msg)
		return
	}
}

// stoppedChannel waits for the session's command request, writes msg on
// stderr, sends exit status 255 and closes the channel. It returns once
// the client acknowledged the close (so closing the connection then loses
// nothing), stoppedGrace passed, or ctx is done.
func stoppedChannel(ctx context.Context, ch ssh.Channel, reqs <-chan *ssh.Request, msg string) {
	defer func() { _ = ch.Close() }()
	go func() { _, _ = io.Copy(io.Discard, ch) }()
	for r := range reqs {
		switch r.Type {
		case "pty-req", "env":
			if r.WantReply {
				_ = r.Reply(true, nil)
			}
			continue
		case "shell", "exec":
			// Accepted so the client shows stderr and the exit status.
			if r.WantReply {
				_ = r.Reply(true, nil)
			}
		case "subsystem":
			if r.WantReply {
				_ = r.Reply(false, nil)
			}
		default:
			if r.WantReply {
				_ = r.Reply(false, nil)
			}
			continue
		}
		_, _ = io.WriteString(ch.Stderr(), msg+"\r\n")
		_, _ = ch.SendRequest("exit-status", false, ssh.Marshal(struct{ Status uint32 }{stoppedExitStatus}))
		_ = ch.CloseWrite()
		_ = ch.Close()
		// reqs is closed when the client's close arrives.
		acked := make(chan struct{})
		go func() {
			ssh.DiscardRequests(reqs)
			close(acked)
		}()
		grace := time.NewTimer(stoppedGrace)
		defer grace.Stop()
		select {
		case <-acked:
		case <-grace.C:
		case <-ctx.Done():
		}
		return
	}
}
