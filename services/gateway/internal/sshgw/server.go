// Package sshgw is the SSH gateway (spec 9): an x/crypto/ssh server that
// authenticates clients by a login-CA certificate or a registered key (the
// control plane decides), opens its own SSH connection to the VM's sshd
// through the tunnel with a short-lived user certificate, and forwards
// channels and requests between the two.
package sshgw

import (
	"context"
	"errors"
	"log/slog"
	"net"
	"net/netip"
	"sync"
	"sync/atomic"
	"time"

	"golang.org/x/crypto/ssh"

	"github.com/belov38/umiak/libs/tunnel/registry"
	"github.com/belov38/umiak/services/gateway/internal/cpapi"
	"github.com/belov38/umiak/services/gateway/internal/obs"
	"github.com/belov38/umiak/services/gateway/internal/ratelimit"
	"github.com/belov38/umiak/services/gateway/internal/upstream"
)

// Defaults for zero Config values (spec 9.2, 9.3, 10.3).
const (
	DefaultDrainDeadline        = 15 * time.Minute
	DefaultKeepaliveInterval    = 30 * time.Second
	DefaultKeepaliveMax         = 3
	DefaultAuthTimeout          = 20 * time.Second
	DefaultMaxAuthTries         = 6
	DefaultClockSkew            = 60 * time.Second
	DefaultLoginCertMaxValidity = 24 * time.Hour
	DefaultBackendCertTTL       = 5 * time.Minute
	DefaultMaxChannels          = 256
)

const (
	// ServerVersion is the identification string sent to clients.
	ServerVersion = "SSH-2.0-umiak-gateway"
	// Accept retry backoff, the same rule as the TLS edge.
	acceptBackoffMin = 5 * time.Millisecond
	acceptBackoffMax = time.Second
)

// InstanceSource reads gateway instances from the registry
// (registry.Store satisfies it). The drain deadlines of sessions use it.
type InstanceSource interface {
	Instance(ctx context.Context, id string) (registry.Instance, error)
}

// Config configures a Server. HostSigners, UserCA, API and Dialer are
// required; zero durations and counts take the Default* values.
type Config struct {
	// HostSigners are the gateway host keys (ed25519 and ecdsa-p256).
	HostSigners []ssh.Signer
	// LoginCAKeys are the public keys of the SSH login CA (current and
	// next) that sign clients' short-lived certificates.
	LoginCAKeys []ssh.PublicKey
	// UserCA signs the certificates the gateway presents to the VM's sshd.
	UserCA ssh.Signer

	API     cpapi.Client
	Dialer  *upstream.Dialer
	Limits  *ratelimit.Limits // nil disables the per-IP limits
	Metrics *obs.Metrics      // may be nil
	Log     *obs.AccessLog    // may be nil
	Logger  *slog.Logger

	DrainDeadline     time.Duration
	KeepaliveInterval time.Duration
	KeepaliveMax      int
	AuthTimeout       time.Duration
	MaxAuthTries      int
	ClockSkew         time.Duration
	// LoginCertMaxValidity caps ValidBefore - ValidAfter of a login
	// certificate (they live minutes); 0 means 24 h.
	LoginCertMaxValidity time.Duration
	BackendCertTTL       time.Duration
	// MaxChannels caps the open channels of one connection (all types,
	// both directions); each can hold a 2 MiB window.
	MaxChannels int
	// Now is the clock of certificate checks and backend certificates.
	Now func() time.Time
	// Clock drives the drain deadlines; nil means Now with real timers.
	Clock Clock

	// Self is this instance's id; Instances reads the registry and Owners
	// gives the current tunnel owner of a machine (drain deadlines).
	Self      string
	Instances InstanceSource
	Owners    OwnerSource
}

// Server is the SSH gateway.
type Server struct {
	cfg      Config
	base     ssh.ServerConfig
	loginCAs [][]byte
	log      *slog.Logger

	ctx    context.Context
	cancel context.CancelFunc

	clock Clock
	// revokes runs revocations, jobs the registry reads of owner drains,
	// rechecks runs Recheck: a slow registry or api does not delay a
	// revocation. The workers are started by the first enqueue and end
	// with Close.
	revokes, jobs, rechecks *jobQueue

	mu       sync.Mutex
	closed   bool
	noAccept bool // StopAccepting was called
	workers  bool // the queue workers run
	lns      map[net.Listener]struct{}
	wg       sync.WaitGroup

	active atomic.Int64
	// sessMu guards the fields below. It is a leaf lock: no session
	// method is called while it is held.
	sessMu sync.Mutex
	// sessions are the open authenticated sessions with their drain
	// deadlines.
	sessions map[target]*drainEntry
	// ownStart is the start of this instance's drain; zero before Drain.
	ownStart time.Time
	// ownerDrain holds the drain starts of the owner instances that drain.
	ownerDrain map[string]time.Time
}

// target is what revocation and the drain need from a session; *session
// implements it, unit tests use fakes.
type target interface {
	ident() identity
	// ownerInstance is the gateway instance holding the tunnel of the
	// backend stream, "" before the backend is connected.
	ownerInstance() string
	notify(msg string, interactiveOnly bool) <-chan struct{}
	closeWithReason(reason string)
}

// New validates cfg and returns a server. It opens no listener.
func New(cfg Config) (*Server, error) {
	switch {
	case len(cfg.HostSigners) == 0:
		return nil, errors.New("sshgw: no host key")
	case cfg.UserCA == nil:
		return nil, errors.New("sshgw: no user CA")
	case cfg.API == nil:
		return nil, errors.New("sshgw: no control plane client")
	case cfg.Dialer == nil:
		return nil, errors.New("sshgw: no upstream dialer")
	}
	if cfg.DrainDeadline <= 0 {
		cfg.DrainDeadline = DefaultDrainDeadline
	}
	if cfg.KeepaliveInterval <= 0 {
		cfg.KeepaliveInterval = DefaultKeepaliveInterval
	}
	if cfg.KeepaliveMax <= 0 {
		cfg.KeepaliveMax = DefaultKeepaliveMax
	}
	if cfg.AuthTimeout <= 0 {
		cfg.AuthTimeout = DefaultAuthTimeout
	}
	if cfg.MaxAuthTries <= 0 {
		cfg.MaxAuthTries = DefaultMaxAuthTries
	}
	if cfg.ClockSkew <= 0 {
		cfg.ClockSkew = DefaultClockSkew
	}
	if cfg.LoginCertMaxValidity <= 0 {
		cfg.LoginCertMaxValidity = DefaultLoginCertMaxValidity
	}
	if cfg.BackendCertTTL <= 0 {
		cfg.BackendCertTTL = DefaultBackendCertTTL
	}
	if cfg.MaxChannels <= 0 {
		cfg.MaxChannels = DefaultMaxChannels
	}
	if cfg.Now == nil {
		cfg.Now = time.Now
	}
	if cfg.Logger == nil {
		cfg.Logger = slog.Default()
	}
	if cfg.Clock == nil {
		cfg.Clock = realClock{now: cfg.Now}
	}
	s := &Server{
		cfg:        cfg,
		log:        cfg.Logger,
		clock:      cfg.Clock,
		revokes:    newJobQueue(),
		jobs:       newJobQueue(),
		rechecks:   newJobQueue(),
		lns:        map[net.Listener]struct{}{},
		sessions:   map[target]*drainEntry{},
		ownerDrain: map[string]time.Time{},
	}
	for _, k := range cfg.LoginCAKeys {
		s.loginCAs = append(s.loginCAs, k.Marshal())
	}
	// Only publickey: no password, no keyboard-interactive, no "none".
	s.base = ssh.ServerConfig{
		MaxAuthTries:  cfg.MaxAuthTries,
		ServerVersion: ServerVersion,
	}
	for _, h := range cfg.HostSigners {
		s.base.AddHostKey(h)
	}
	s.ctx, s.cancel = context.WithCancel(context.Background())
	return s, nil
}

// Serve accepts conns on ln until Close (it then returns nil). Transient
// accept errors are retried with a backoff. Serve closes ln when it returns.
func (s *Server) Serve(ln net.Listener) error {
	s.mu.Lock()
	if s.closed || s.noAccept {
		s.mu.Unlock()
		_ = ln.Close()
		return nil
	}
	s.lns[ln] = struct{}{}
	s.wg.Add(1)
	s.mu.Unlock()
	defer s.wg.Done()
	defer func() {
		s.mu.Lock()
		delete(s.lns, ln)
		s.mu.Unlock()
		_ = ln.Close()
	}()

	var backoff time.Duration
	for {
		c, err := ln.Accept()
		if err != nil {
			if s.ctx.Err() != nil || errors.Is(err, net.ErrClosed) {
				return nil
			}
			// EMFILE, ECONNABORTED, ...: one failed accept must not take
			// the listener down.
			backoff = min(max(2*backoff, acceptBackoffMin), acceptBackoffMax)
			s.log.Warn("sshgw: accept error, retrying", "err", err, "backoff", backoff)
			select {
			case <-time.After(backoff):
				continue
			case <-s.ctx.Done():
				return nil
			}
		}
		backoff = 0
		s.wg.Go(func() { s.handle(c) })
	}
}

// Close stops accepting, closes every connection and waits for their
// handlers. It is idempotent.
func (s *Server) Close() error {
	s.mu.Lock()
	s.closed = true
	for ln := range s.lns {
		_ = ln.Close()
	}
	s.mu.Unlock()
	s.cancel()
	s.wg.Wait()
	s.sessMu.Lock()
	for _, e := range s.sessions {
		e.stop()
	}
	s.sessMu.Unlock()
	return nil
}

// enqueue pushes a job to q, starting the workers on first use. Nothing
// is queued after Close.
func (s *Server) enqueue(q *jobQueue, key string, fn func(ctx context.Context)) {
	s.mu.Lock()
	if s.closed {
		s.mu.Unlock()
		return
	}
	if !s.workers {
		s.workers = true
		s.wg.Go(func() { s.revokes.run(s.ctx) })
		s.wg.Go(func() { s.jobs.run(s.ctx) })
		s.wg.Go(func() { s.rechecks.run(s.ctx) })
	}
	s.mu.Unlock()
	q.push(key, fn)
}

// Sessions returns the number of open authenticated connections.
func (s *Server) Sessions() int { return int(s.active.Load()) }

// snapshot returns the open sessions (authenticated connections).
func (s *Server) snapshot() []*session {
	var out []*session
	for _, t := range s.targets() {
		if ss, ok := t.(*session); ok {
			out = append(out, ss)
		}
	}
	return out
}

// targets returns the open sessions, for revocation and drain.
func (s *Server) targets() []target {
	s.sessMu.Lock()
	defer s.sessMu.Unlock()
	out := make([]target, 0, len(s.sessions))
	for t := range s.sessions {
		out = append(out, t)
	}
	return out
}

// register adds t to the open sessions and applies a drain deadline that
// is already known.
func (s *Server) register(t target) {
	s.sessMu.Lock()
	s.sessions[t] = &drainEntry{}
	s.sessMu.Unlock()
	s.applyDeadline(t)
}

// unregister removes t and stops its drain timers.
func (s *Server) unregister(t target) {
	s.sessMu.Lock()
	if e, ok := s.sessions[t]; ok {
		e.stop()
		delete(s.sessions, t)
	}
	s.sessMu.Unlock()
}

func (s *Server) addSession(ss *session) {
	s.active.Add(1)
	if m := s.cfg.Metrics; m != nil {
		m.SSHConnectionsActive.Inc()
	}
	s.register(ss)
}

func (s *Server) removeSession(ss *session) {
	s.unregister(ss)
	s.active.Add(-1)
	if m := s.cfg.Metrics; m != nil {
		m.SSHConnectionsActive.Dec()
	}
}

// handle runs one client conn: the limits, the handshake and then the
// session.
func (s *Server) handle(raw net.Conn) {
	ctx, cancel := context.WithCancel(s.ctx)
	defer cancel()
	// Close unblocks everything of this conn.
	stop := context.AfterFunc(ctx, func() { _ = raw.Close() })
	defer stop()
	defer func() { _ = raw.Close() }()

	// One deadline bounds the whole authentication: the PROXY header read
	// behind RemoteAddr, the handshake and every api call it makes.
	authDeadline := time.Now().Add(s.cfg.AuthTimeout)
	_ = raw.SetDeadline(authDeadline)
	authCtx, authCancel := context.WithDeadline(ctx, authDeadline)
	defer authCancel()
	ip := connIP(raw)
	if lim := s.cfg.Limits; lim != nil {
		if lim.SSHAuthBlocked(ip) || !lim.AllowSSHConn(ip) {
			s.log.Debug("sshgw: conn refused by rate limit", "client_ip", ip)
			return
		}
	}

	// failed: a method other than "none" was refused for a reason other
	// than api being unavailable. unavailable: api could not answer.
	var failed, unavailable atomic.Bool
	conf := s.base
	conf.PublicKeyCallback = func(meta ssh.ConnMetadata, key ssh.PublicKey) (*ssh.Permissions, error) {
		return s.authenticate(authCtx, meta, key)
	}
	conf.AuthLogCallback = func(_ ssh.ConnMetadata, method string, err error) {
		switch {
		case method == "none" || err == nil:
		case errors.Is(err, errUnavailable):
			unavailable.Store(true)
		default:
			failed.Store(true)
		}
	}
	sconn, chans, reqs, err := ssh.NewServerConn(raw, &conf)
	if err != nil {
		switch {
		case failed.Load():
			// An api outage is not the client's failure: it does not
			// count towards the per-IP limit.
			if lim := s.cfg.Limits; lim != nil {
				lim.SSHAuthFailure(ip)
			}
			s.authMetric("fail")
		case unavailable.Load():
			s.authMetric("unavailable")
		}
		s.log.Debug("sshgw: handshake failed", "client_ip", ip, "err", err)
		return
	}
	_ = raw.SetDeadline(time.Time{})
	s.authMetric("ok")

	id, err := identityFrom(sconn.Permissions)
	if err != nil {
		s.log.Error("sshgw: authenticated conn without identity", "err", err)
		_ = sconn.Close()
		return
	}
	ss := newSession(s, sconn, id, ip)
	s.addSession(ss)
	defer s.removeSession(ss)
	ss.run(ctx, chans, reqs)
}

func (s *Server) authMetric(result string) {
	if m := s.cfg.Metrics; m != nil {
		m.SSHAuth.WithLabelValues(result).Inc()
	}
}

// connIP returns the client IP of a conn (the PROXY source when the
// listener parses PROXY headers), or the zero Addr.
func connIP(c net.Conn) netip.Addr {
	a := c.RemoteAddr()
	if a == nil {
		return netip.Addr{}
	}
	if ta, ok := a.(*net.TCPAddr); ok {
		ip, _ := netip.AddrFromSlice(ta.IP)
		return ip.Unmap()
	}
	ap, err := netip.ParseAddrPort(a.String())
	if err != nil {
		return netip.Addr{}
	}
	return ap.Addr().Unmap()
}
