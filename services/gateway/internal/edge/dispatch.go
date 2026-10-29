package edge

import (
	"context"
	"crypto/tls"
	"errors"
	"log/slog"
	"net"
	"net/netip"
	"strings"
	"sync"
	"sync/atomic"
	"time"

	proxyproto "github.com/pires/go-proxyproto"

	"github.com/belov38/boat-dev-clone/services/gateway/internal/obs"
	"github.com/belov38/boat-dev-clone/services/gateway/internal/ratelimit"
)

const (
	// defaultHandshakeTimeout bounds a TLS handshake (spec 5.1).
	defaultHandshakeTimeout = 10 * time.Second
	// defaultMaxHandshakes caps the handshakes in flight.
	defaultMaxHandshakes = 4096
	// defaultMaxHandshakesPerIP caps the handshakes in flight of one
	// client IP (IPv4 /32, IPv6 /64).
	defaultMaxHandshakesPerIP = 64
	// DefaultProxyHeaderTimeout bounds the wait for a PROXY header: the
	// load balancer sends it at once on connect.
	DefaultProxyHeaderTimeout = 2 * time.Second
	// defaultMaxExemptHandshakes caps the handshakes in flight of the
	// exempt client IPs (node SNAT).
	defaultMaxExemptHandshakes = 4096
	// Accept retry backoff, like net/http.
	acceptBackoffMin = 5 * time.Millisecond
	acceptBackoffMax = time.Second
)

// errConnLimit refuses an sbx conn over the per-IP limit during the
// handshake, before the certificate work.
var errConnLimit = errors.New("edge: too many conns from the client IP")

// SNI kinds, also the sni_kind label values.
const (
	kindUnknown = "unknown"
	kindSbx     = "sbx"
	kindTunnel  = "tunnel"
)

// DispatchConfig configures a Dispatcher.
type DispatchConfig struct {
	// SbxDomain is the parent of the sandbox hosts (sbx.<domain>).
	SbxDomain string
	// TunnelHost is the tunnel endpoint host (tunnel.<domain>).
	TunnelHost string
	// Sbx and Tunnel are the certificates of both destinations.
	Sbx, Tunnel *CertSource
	// HandshakeTimeout bounds each TLS handshake; 0 means 10 s.
	HandshakeTimeout time.Duration
	// MaxHandshakes caps the handshakes in flight of the non-exempt
	// clients, a last resort behind MaxHandshakesPerIP; a conn over the
	// cap is closed at once. 0 means 4096.
	MaxHandshakes int
	// MaxHandshakesPerIP caps the handshakes in flight of one client IP
	// (ratelimit.Key: IPv4 /32, IPv6 /64), from the accept to the end of
	// the TLS handshake, so the time before the PROXY header and the
	// ClientHello counts. A conn over the cap is closed at once and counted
	// as sbx_gateway_ratelimited_total{limit="handshakes"}. 0 means 64.
	MaxHandshakesPerIP int
	// HandshakeExempt are the client IPs (node SNAT) that skip
	// MaxHandshakesPerIP and MaxHandshakes; they use MaxExemptHandshakes
	// instead, so non-exempt clients cannot starve the agent tunnels.
	HandshakeExempt []netip.Prefix
	// MaxExemptHandshakes caps the handshakes in flight of the exempt
	// clients. 0 means 4096.
	MaxExemptHandshakes int
	// ProxyHeaderTimeout bounds the wait for the PROXY header of a conn
	// from a trusted PROXY source, and so how long the general (or
	// borrowed exempt) slot it takes before its client IP is known is
	// held. A conn without a complete header by then is closed (the SSH
	// listener, which has no dispatcher, instead goes on header-less, keyed
	// by the LB address). Use the same value as the listener's
	// (WrapProxyProtocol). 0 means 2 s.
	ProxyHeaderTimeout time.Duration
	// ConnLimit counts one open sbx conn of the client IP; ok false refuses
	// it. It runs when the ClientHello names an sbx host; release is called
	// once when the conn closes. nil means no limit. Tunnel conns are never
	// limited per IP (spec 11).
	ConnLimit func(ip netip.Addr) (release func(), ok bool)
	Metrics   *obs.Metrics
	Logger    *slog.Logger
}

// Dispatcher accepts TLS conns, completes the handshake with the
// certificate the SNI selects and hands each conn, as a *tls.Conn, to the
// listener of its destination: Sbx() or Tunnel().
type Dispatcher struct {
	ln  net.Listener
	cfg DispatchConfig
	log *slog.Logger

	base      *tls.Config
	sbxTLS    *tls.Config
	tunnelTLS *tls.Config
	rejectTLS *tls.Config

	sbx, tunnel *connListener
	// Semaphores of the handshakes in flight: general (non-exempt
	// clients) and exempt, and the per-IP counts of non-exempt clients.
	handshakes       chan struct{}
	exemptHandshakes chan struct{}
	perIP            *ipSlots

	ctx       context.Context
	cancel    context.CancelFunc
	closeOnce sync.Once
	closeErr  error
	wg        sync.WaitGroup
}

// NewDispatcher returns a dispatcher of the conns of ln. Serve runs it.
func NewDispatcher(ln net.Listener, cfg DispatchConfig) *Dispatcher {
	if cfg.HandshakeTimeout <= 0 {
		cfg.HandshakeTimeout = defaultHandshakeTimeout
	}
	if cfg.MaxHandshakes <= 0 {
		cfg.MaxHandshakes = defaultMaxHandshakes
	}
	if cfg.MaxHandshakesPerIP <= 0 {
		cfg.MaxHandshakesPerIP = defaultMaxHandshakesPerIP
	}
	if cfg.ProxyHeaderTimeout <= 0 {
		cfg.ProxyHeaderTimeout = DefaultProxyHeaderTimeout
	}
	if cfg.MaxExemptHandshakes <= 0 {
		cfg.MaxExemptHandshakes = defaultMaxExemptHandshakes
	}
	cfg.HandshakeExempt = append([]netip.Prefix(nil), cfg.HandshakeExempt...)
	cfg.SbxDomain = strings.ToLower(strings.TrimSuffix(cfg.SbxDomain, "."))
	cfg.TunnelHost = strings.ToLower(strings.TrimSuffix(cfg.TunnelHost, "."))
	log := cfg.Logger
	if log == nil {
		log = slog.Default()
	}
	ctx, cancel := context.WithCancel(context.Background())
	d := &Dispatcher{
		ln: ln, cfg: cfg, log: log,
		sbx:              newConnListener(ln.Addr()),
		tunnel:           newConnListener(ln.Addr()),
		handshakes:       make(chan struct{}, cfg.MaxHandshakes),
		exemptHandshakes: make(chan struct{}, cfg.MaxExemptHandshakes),
		perIP:            newIPSlots(cfg.MaxHandshakesPerIP),
		ctx:              ctx, cancel: cancel,
	}
	certOf := func(cs *CertSource) func(*tls.ClientHelloInfo) (*tls.Certificate, error) {
		return func(*tls.ClientHelloInfo) (*tls.Certificate, error) { return cs.Get(), nil }
	}
	d.sbxTLS = &tls.Config{
		MinVersion:     tls.VersionTLS12,
		GetCertificate: certOf(cfg.Sbx),
		NextProtos:     []string{"h2", "http/1.1"},
	}
	// Agents reconnect rarely: no session tickets, so no ticket key is
	// shared with the sbx config.
	d.tunnelTLS = &tls.Config{
		MinVersion:             tls.VersionTLS12,
		GetCertificate:         certOf(cfg.Tunnel),
		NextProtos:             []string{"http/1.1"},
		SessionTicketsDisabled: true,
	}
	// No certificate at all: crypto/tls answers with the alert
	// unrecognized_name (an error from GetConfigForClient would give
	// internal_error).
	d.rejectTLS = &tls.Config{MinVersion: tls.VersionTLS12, SessionTicketsDisabled: true}
	d.base = &tls.Config{
		MinVersion:         tls.VersionTLS12,
		GetConfigForClient: d.configFor,
	}
	return d
}

// Sbx returns the listener of handshaked *.sbx conns (*tls.Conn).
func (d *Dispatcher) Sbx() net.Listener { return d.sbx }

// Tunnel returns the listener of handshaked tunnel conns (*tls.Conn).
func (d *Dispatcher) Tunnel() net.Listener { return d.tunnel }

// kind classifies an SNI.
func (d *Dispatcher) kind(sni string) string {
	sni = strings.ToLower(sni)
	switch {
	case sni == "":
		return kindUnknown
	case sni == d.cfg.TunnelHost:
		return kindTunnel
	case d.cfg.SbxDomain != "" && strings.HasSuffix(sni, "."+d.cfg.SbxDomain) && len(sni) > len(d.cfg.SbxDomain)+1:
		// One or more labels; the proxy answers 404 for nested ones.
		return kindSbx
	default:
		return kindUnknown
	}
}

func (d *Dispatcher) configFor(chi *tls.ClientHelloInfo) (*tls.Config, error) {
	k := d.kind(chi.ServerName)
	ec, _ := chi.Conn.(*edgeConn)
	if ec != nil {
		ec.kind.Store(k)
	}
	switch k {
	case kindSbx:
		// The per-IP limit applies once the SNI picked sbx, and before
		// the certificate work. The ClientHello has been read, so the
		// PROXY header (if any) is too and RemoteAddr does not block.
		if d.cfg.ConnLimit != nil && ec != nil && !ec.hasRelease() {
			release, ok := d.cfg.ConnLimit(addrIP(ec.RemoteAddr()))
			if !ok {
				return nil, errConnLimit
			}
			ec.setRelease(release)
		}
		return d.sbxTLS, nil
	case kindTunnel:
		return d.tunnelTLS, nil
	default:
		return d.rejectTLS, nil
	}
}

// Serve accepts conns until ctx is done or Close is called (both return
// nil) or the listener fails. The dispatcher is closed when Serve returns.
func (d *Dispatcher) Serve(ctx context.Context) error {
	// On any exit: close (which aborts the handshakes in flight and the
	// pushes to the destination listeners), then wait for them.
	defer d.wg.Wait()
	defer func() { _ = d.Close() }()
	stop := context.AfterFunc(ctx, func() { _ = d.Close() })
	defer stop()
	var backoff time.Duration
	for {
		c, err := d.ln.Accept()
		if err != nil {
			if d.ctx.Err() != nil || errors.Is(err, net.ErrClosed) {
				return nil
			}
			// Anything else (EMFILE, ENFILE, ECONNABORTED, ...) is retried
			// with a backoff: one failed accept must not take down the
			// instance and the tunnels it owns.
			backoff = min(max(2*backoff, acceptBackoffMin), acceptBackoffMax)
			d.log.Warn("edge: accept error, retrying", "err", err, "backoff", backoff)
			select {
			case <-time.After(backoff):
				continue
			case <-d.ctx.Done():
				return nil
			}
		}
		backoff = 0
		s, ok := d.admit(c)
		if !ok {
			// Over a handshake cap: shed the conn at once.
			_ = c.Close()
			continue
		}
		d.wg.Go(func() { d.handle(c, s) }) //nolint:contextcheck // handshakes run on the dispatcher context, ended by Close
	}
}

// admit takes the handshake slots of a new conn in the accept loop, without
// I/O. The client IP of a conn from a trusted PROXY source is known only
// once the header is read, so such a conn gets a general slot (or, with the
// general budget full, an exempt one) and handle settles its slots after the
// header. Any other conn's client IP is its transport peer: the go-proxyproto
// conn is unwrapped with Raw, since its RemoteAddr would wait for the header.
func (d *Dispatcher) admit(c net.Conn) (*slots, bool) {
	transport := c
	if pc, ok := c.(*proxyproto.Conn); ok {
		transport = pc.Raw()
		if pc.ProxyHeaderPolicy == proxyproto.USE || pc.ProxyHeaderPolicy == proxyproto.REQUIRE {
			s := &slots{d: d, viaProxy: true}
			switch {
			case tryAcquire(d.handshakes):
				s.general = true
			case tryAcquire(d.exemptHandshakes):
				s.exempt = true
			default:
				d.shedGeneral()
				return nil, false
			}
			return s, true
		}
	}
	s := &slots{d: d}
	if !s.forClient(addrIP(transport.RemoteAddr())) {
		return nil, false
	}
	return s, true
}

// shedGeneral counts a conn shed because no general (or exempt) slot was
// free.
func (d *Dispatcher) shedGeneral() {
	if d.cfg.Metrics != nil {
		d.cfg.Metrics.TLSHandshakeErrors.WithLabelValues(kindUnknown).Inc()
	}
}

func (d *Dispatcher) exempt(ip netip.Addr) bool {
	return ip.IsValid() && inPrefixes(ip.Unmap(), d.cfg.HandshakeExempt)
}

// slots are the handshake slots one conn holds. Only the goroutine that owns
// the conn (the accept loop, then handle) touches them; release frees each
// slot exactly once.
type slots struct {
	d *Dispatcher
	// viaProxy: the conn comes from a trusted PROXY source and its client
	// IP is not known yet.
	viaProxy        bool
	general, exempt bool
	ipKey           netip.Prefix
	hasIP           bool
}

// forClient moves s to the slots of a client IP: the exempt budget for an
// exempt IP, else a per-IP slot and a general slot. It reuses a held slot
// of the right budget and releases the other. On false s holds nothing and
// the refusal is counted.
func (s *slots) forClient(ip netip.Addr) bool {
	d := s.d
	if d.exempt(ip) {
		if !s.exempt {
			if !tryAcquire(d.exemptHandshakes) {
				s.release()
				d.shedGeneral()
				return false
			}
			s.exempt = true
		}
		if s.general {
			s.general = false
			<-d.handshakes
		}
		return true
	}
	k := ratelimit.Key(ip)
	if !d.perIP.acquire(k) {
		s.release()
		if d.cfg.Metrics != nil {
			d.cfg.Metrics.RateLimited.WithLabelValues(ratelimit.LimitHandshakes).Inc()
		}
		return false
	}
	s.ipKey, s.hasIP = k, true
	if !s.general {
		if !tryAcquire(d.handshakes) {
			s.release()
			d.shedGeneral()
			return false
		}
		s.general = true
	}
	if s.exempt {
		s.exempt = false
		<-d.exemptHandshakes
	}
	return true
}

// release frees every slot s holds; later calls do nothing.
func (s *slots) release() {
	d := s.d
	if s.general {
		s.general = false
		<-d.handshakes
	}
	if s.exempt {
		s.exempt = false
		<-d.exemptHandshakes
	}
	if s.hasIP {
		s.hasIP = false
		d.perIP.release(s.ipKey)
	}
}

func tryAcquire(sem chan struct{}) bool {
	select {
	case sem <- struct{}{}:
		return true
	default:
		return false
	}
}

// ipSlots counts the handshakes in flight per client IP key.
type ipSlots struct {
	max int
	mu  sync.Mutex
	m   map[netip.Prefix]int
}

func newIPSlots(maxPerKey int) *ipSlots {
	return &ipSlots{max: maxPerKey, m: map[netip.Prefix]int{}}
}

func (s *ipSlots) acquire(k netip.Prefix) bool {
	s.mu.Lock()
	defer s.mu.Unlock()
	if s.m[k] >= s.max {
		return false
	}
	s.m[k]++
	return true
}

func (s *ipSlots) release(k netip.Prefix) {
	s.mu.Lock()
	defer s.mu.Unlock()
	if s.m[k] <= 1 {
		delete(s.m, k)
		return
	}
	s.m[k]--
}

func (s *ipSlots) count(ip netip.Addr) int {
	s.mu.Lock()
	defer s.mu.Unlock()
	return s.m[ratelimit.Key(ip)]
}

// handle runs the handshake of one conn off the accept loop. s are the
// slots admit took; they are released when the handshake ends, whatever the
// outcome.
func (d *Dispatcher) handle(raw net.Conn, s *slots) {
	defer s.release()
	ctx, cancel := context.WithTimeout(d.ctx, d.cfg.HandshakeTimeout)
	defer cancel()
	if s.viaProxy && !d.settleProxy(ctx, raw, s) {
		_ = raw.Close()
		return
	}
	ec := &edgeConn{Conn: raw}
	ec.kind.Store(kindUnknown)
	tc := tls.Server(ec, d.base)
	err := tc.HandshakeContext(ctx)
	cancel()
	s.release()
	kind, _ := ec.kind.Load().(string)
	if err != nil {
		_ = ec.Close()
		switch {
		case errors.Is(err, errConnLimit):
			// Counted by the rate limiter.
			return
		case errors.Is(err, proxyproto.ErrSuperfluousProxyHeader), errors.Is(err, errProxyVersion):
			d.log.Debug("edge: PROXY header refused", "peer", raw.RemoteAddr(), "err", err)
			return
		}
		if d.cfg.Metrics != nil {
			d.cfg.Metrics.TLSHandshakeErrors.WithLabelValues(kind).Inc()
		}
		d.log.Debug("edge: TLS handshake failed", "sni_kind", kind, "err", err)
		return
	}
	switch kind {
	case kindSbx:
		d.sbx.push(tc)
	case kindTunnel:
		d.tunnel.push(tc)
	default:
		_ = tc.Close()
	}
}

// settleProxy reads the PROXY header of a conn from a trusted source
// (bounded by ProxyHeaderTimeout, ctx and the header timeout of the
// listener) and moves s to the slots of the client IP it names; false means
// the conn must be closed. Without a header (the first bytes are no PROXY
// signature, or a refused header) the client IP is the transport peer; a
// refused header then fails the handshake on the first read.
func (d *Dispatcher) settleProxy(ctx context.Context, c net.Conn, s *slots) bool {
	deadline := time.Now().Add(d.cfg.ProxyHeaderTimeout)
	hctx, cancel := context.WithDeadline(ctx, deadline)
	defer cancel()
	stop := context.AfterFunc(hctx, func() { _ = c.Close() })
	ip := addrIP(c.RemoteAddr()) // reads the header
	// The listener's own header timeout may end the wait first and report
	// "no header"; past the deadline the conn is closed either way, so a
	// silent conn never goes on as a header-less one.
	if !stop() || !time.Now().Before(deadline) {
		// The header timeout, the handshake timeout or Close ended the
		// wait.
		_ = c.Close()
		d.shedGeneral()
		return false
	}
	s.viaProxy = false
	return s.forClient(ip)
}

// Close stops accepting, closes both destination listeners and aborts the
// handshakes in flight; Serve returns once they ended. Conns already handed
// over stay open.
func (d *Dispatcher) Close() error {
	d.closeOnce.Do(func() {
		d.cancel()
		d.closeErr = d.ln.Close()
		d.sbx.close()
		d.tunnel.close()
		if errors.Is(d.closeErr, net.ErrClosed) {
			d.closeErr = nil
		}
	})
	return d.closeErr
}

// edgeConn is the raw conn under a *tls.Conn: it records the SNI kind seen
// by configFor and releases the per-IP conn slot exactly once on Close.
type edgeConn struct {
	net.Conn
	kind atomic.Value // string

	mu      sync.Mutex
	release func()
	closed  bool
}

func (c *edgeConn) hasRelease() bool {
	c.mu.Lock()
	defer c.mu.Unlock()
	return c.release != nil
}

func (c *edgeConn) setRelease(f func()) {
	c.mu.Lock()
	if c.closed {
		c.mu.Unlock()
		f()
		return
	}
	c.release = f
	c.mu.Unlock()
}

func (c *edgeConn) Close() error {
	c.mu.Lock()
	f := c.release
	c.release = nil
	c.closed = true
	c.mu.Unlock()
	err := c.Conn.Close()
	if f != nil {
		f()
	}
	return err
}

// connListener is a net.Listener fed by the dispatcher.
type connListener struct {
	addr      net.Addr
	ch        chan net.Conn
	done      chan struct{}
	closeOnce sync.Once
}

func newConnListener(addr net.Addr) *connListener {
	return &connListener{addr: addr, ch: make(chan net.Conn), done: make(chan struct{})}
}

// push hands c to Accept, or closes it once the listener is closed.
func (l *connListener) push(c net.Conn) {
	select {
	case l.ch <- c:
	case <-l.done:
		_ = c.Close()
	}
}

func (l *connListener) Accept() (net.Conn, error) {
	select {
	case c := <-l.ch:
		return c, nil
	case <-l.done:
		return nil, net.ErrClosed
	}
}

func (l *connListener) close() { l.closeOnce.Do(func() { close(l.done) }) }

// Close closes the listener; conns pushed afterwards are closed.
func (l *connListener) Close() error {
	l.close()
	return nil
}

func (l *connListener) Addr() net.Addr { return l.addr }
