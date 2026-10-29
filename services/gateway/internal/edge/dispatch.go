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
)

// defaultHandshakeTimeout bounds a TLS handshake (spec 5.1).
const defaultHandshakeTimeout = 10 * time.Second

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
	// ConnLimit counts one open sbx conn of the client IP; ok false refuses
	// it. release is called once when the conn closes. nil means no limit.
	// Tunnel conns are never limited per IP (spec 11).
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
	cfg.SbxDomain = strings.ToLower(strings.TrimSuffix(cfg.SbxDomain, "."))
	cfg.TunnelHost = strings.ToLower(strings.TrimSuffix(cfg.TunnelHost, "."))
	log := cfg.Logger
	if log == nil {
		log = slog.Default()
	}
	ctx, cancel := context.WithCancel(context.Background())
	d := &Dispatcher{
		ln: ln, cfg: cfg, log: log,
		sbx:    newConnListener(ln.Addr()),
		tunnel: newConnListener(ln.Addr()),
		ctx:    ctx, cancel: cancel,
	}
	certOf := func(cs *CertSource) func(*tls.ClientHelloInfo) (*tls.Certificate, error) {
		return func(*tls.ClientHelloInfo) (*tls.Certificate, error) { return cs.Get(), nil }
	}
	d.sbxTLS = &tls.Config{
		MinVersion:     tls.VersionTLS12,
		GetCertificate: certOf(cfg.Sbx),
		NextProtos:     []string{"h2", "http/1.1"},
	}
	d.tunnelTLS = &tls.Config{
		MinVersion:     tls.VersionTLS12,
		GetCertificate: certOf(cfg.Tunnel),
		NextProtos:     []string{"http/1.1"},
	}
	// No certificate at all: crypto/tls answers with the alert
	// unrecognized_name (an error from GetConfigForClient would give
	// internal_error).
	d.rejectTLS = &tls.Config{MinVersion: tls.VersionTLS12}
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
	if ec, ok := chi.Conn.(*edgeConn); ok {
		ec.kind.Store(k)
	}
	switch k {
	case kindSbx:
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
			if d.ctx.Err() != nil {
				return nil
			}
			var ne net.Error
			if errors.As(err, &ne) && ne.Timeout() {
				// Transient; retry like net/http does.
				backoff = min(max(2*backoff, 5*time.Millisecond), time.Second)
				d.log.Warn("edge: accept error, retrying", "err", err, "backoff", backoff)
				select {
				case <-time.After(backoff):
					continue
				case <-d.ctx.Done():
					return nil
				}
			}
			if errors.Is(err, net.ErrClosed) {
				return nil
			}
			return err
		}
		backoff = 0
		d.wg.Go(func() { d.handle(c) }) //nolint:contextcheck // handshakes run on the dispatcher context, ended by Close
	}
}

// handle runs the handshake of one conn off the accept loop.
func (d *Dispatcher) handle(raw net.Conn) {
	ec := &edgeConn{Conn: raw}
	ec.kind.Store(kindUnknown)
	tc := tls.Server(ec, d.base)
	ctx, cancel := context.WithTimeout(d.ctx, d.cfg.HandshakeTimeout)
	err := tc.HandshakeContext(ctx)
	cancel()
	kind, _ := ec.kind.Load().(string)
	if err != nil {
		_ = ec.Close()
		if errors.Is(err, proxyproto.ErrSuperfluousProxyHeader) {
			d.log.Debug("edge: PROXY header from an untrusted source", "peer", raw.RemoteAddr())
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
		if d.cfg.ConnLimit != nil {
			release, ok := d.cfg.ConnLimit(addrIP(tc.RemoteAddr()))
			if !ok {
				_ = tc.Close()
				return
			}
			ec.setRelease(release)
		}
		d.sbx.push(tc)
	case kindTunnel:
		d.tunnel.push(tc)
	default:
		_ = tc.Close()
	}
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
