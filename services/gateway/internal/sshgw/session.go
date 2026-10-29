package sshgw

import (
	"context"
	"crypto/rand"
	"encoding/hex"
	"io"
	"log/slog"
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

// Session results of sbx_gateway_ssh_sessions_total.
const (
	resultOK          = "ok"
	resultUnavailable = "unavailable"
)

// Close reasons in the SSH log.
const (
	reasonClient      = "client_closed"
	reasonBackend     = "backend_closed"
	reasonShutdown    = "shutdown"
	reasonUnavailable = "sandbox_unavailable"
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

	mu       sync.Mutex
	backend  *backend
	channels []string
	reason   string
}

func newSession(s *Server, conn *ssh.ServerConn, id identity, ip netip.Addr) *session {
	sid := newSessionID()
	actor := id.Auth.Actor.UserID
	if id.Auth.Actor.Kind == actorTeamKey {
		actor = id.Auth.Actor.APIKeyID
	}
	return &session{
		srv:   s,
		sid:   sid,
		ip:    ip,
		conn:  conn,
		id:    id,
		start: time.Now(),
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

// setReason records the first close reason.
func (ss *session) setReason(r string) {
	ss.mu.Lock()
	defer ss.mu.Unlock()
	if ss.reason == "" {
		ss.reason = r
	}
}

func (ss *session) addChannel(typ string) {
	ss.mu.Lock()
	ss.channels = append(ss.channels, typ)
	ss.mu.Unlock()
	if m := ss.srv.cfg.Metrics; m != nil {
		m.SSHChannels.WithLabelValues(typ).Inc()
	}
}

// run serves the connection until the client or the backend ends it, or
// ctx is done.
func (ss *session) run(ctx context.Context, chans <-chan ssh.NewChannel, reqs <-chan *ssh.Request) {
	ctx, cancel := context.WithCancel(ctx)
	defer cancel()
	defer ss.writeLog()
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

	// Global requests of the client; Task 12 forwards some of them.
	go ssh.DiscardRequests(reqs)

	b, msg := ss.connectBackend(ctx)
	if b == nil {
		if ctx.Err() != nil {
			return
		}
		ss.sessionMetric(resultUnavailable)
		ss.setReason(reasonUnavailable)
		ss.serveStopped(ctx, chans, msg)
		return
	}
	ss.sessionMetric(resultOK)
	ss.mu.Lock()
	ss.backend = b
	ss.mu.Unlock()
	go func() {
		_ = b.conn.Wait()
		ss.setReason(reasonBackend)
		cancel()
	}()
	stopB := context.AfterFunc(ctx, func() { _ = b.conn.Close() })
	defer stopB()
	defer func() { _ = b.conn.Close() }()
	ss.forward(ctx, b, chans)
	// forward returns once the client conn ended; an earlier reason
	// (backend, shutdown) wins.
	ss.setReason(reasonClient)
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
	channels := append([]string(nil), ss.channels...)
	reason := ss.reason
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
		ss.addChannel(nc.ChannelType())
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
