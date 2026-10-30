package edge_test

import (
	"context"
	"crypto/tls"
	"crypto/x509"
	"net"
	"net/http"
	"net/netip"
	"sync"
	"sync/atomic"
	"testing"
	"time"

	"github.com/prometheus/client_golang/prometheus/testutil"

	"github.com/belov38/boat-dev-clone/services/gateway/internal/config"
	"github.com/belov38/boat-dev-clone/services/gateway/internal/edge"
	"github.com/belov38/boat-dev-clone/services/gateway/internal/obs"
	"github.com/belov38/boat-dev-clone/services/gateway/internal/ratelimit"
	"github.com/belov38/boat-dev-clone/services/gateway/internal/testenv"
)

// tunnelCap is a dispatcher on a loopback listener (PROXY v2 trusting
// 127.0.0.0/8, so header-less conns are keyed by 127.0.0.1) whose tunnel
// conns are served by the tunnel server with readHeader as its header
// timeout, and limited per IP by a ratelimit.Limits with maxConns and the
// exempt 10.0.0.0/8. open counts the tunnel slots held by 127.0.0.1.
type tunnelCap struct {
	addr  string
	roots *x509.CertPool
	m     *obs.Metrics
	open  atomic.Int64
}

func newTunnelCap(t *testing.T, maxConns int, readHeader time.Duration) *tunnelCap {
	t.Helper()
	raw, err := (&net.ListenConfig{}).Listen(context.Background(), "tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatal(err)
	}
	ln := edge.WrapProxyProtocol(raw, []netip.Prefix{netip.MustParsePrefix("127.0.0.0/8")}, 5*time.Second)
	tc := &tunnelCap{addr: raw.Addr().String()}
	d, pki, served := newDispatcher(t, ln, func(c *edge.DispatchConfig) {
		c.HandshakeTimeout = 20 * time.Second
		tc.m = c.Metrics
		lim := ratelimit.New(ratelimit.Config{
			TunnelConnsPerIP: maxConns,
			Exempt:           []netip.Prefix{netip.MustParsePrefix("10.0.0.0/8")},
		}, c.Metrics)
		c.TunnelConnLimit = func(ip netip.Addr) (func(), bool) {
			release, ok := lim.AcquireTunnelConn(ip)
			if !ok || !ip.IsLoopback() {
				return release, ok
			}
			tc.open.Add(1)
			var once atomic.Bool
			return func() {
				if once.CompareAndSwap(false, true) {
					tc.open.Add(-1)
				}
				release()
			}, true
		}
	})
	tc.roots = pki.Roots
	srv := edge.NewTunnelServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) { w.WriteHeader(299) }),
		config.Timeouts{TunnelReadHeader: readHeader})
	go func() { _ = srv.Serve(d.Tunnel()) }()
	t.Cleanup(func() {
		_ = srv.Close()
		_ = d.Close()
		if err := <-served; err != nil {
			t.Errorf("Serve = %v", err)
		}
	})
	return tc
}

func (tc *tunnelCap) dial(hdr []byte) (*tls.Conn, error) {
	return tlsVia(tc.addr, hdr, "tunnel.test", tc.roots)
}

func (tc *tunnelCap) refused() float64 {
	return testutil.ToFloat64(tc.m.RateLimited.WithLabelValues("tunnel_conns"))
}

// TestDispatcherTunnelConnCap: the open tunnel conns of a non-exempt IP are
// capped at the handshake; closing one frees its slot; exempt clients are
// not capped.
func TestDispatcherTunnelConnCap(t *testing.T) {
	const maxConns, extra = 4, 3
	tc := newTunnelCap(t, maxConns, 20*time.Second)
	var held []*tls.Conn
	for i := range maxConns {
		c, err := tc.dial(nil)
		if err != nil {
			t.Fatalf("tunnel conn %d: %v", i, err)
		}
		held = append(held, c)
	}
	if n := tc.open.Load(); n != maxConns {
		t.Fatalf("open tunnel slots = %d, want %d", n, maxConns)
	}
	for i := range extra {
		start := time.Now()
		if c, err := tc.dial(nil); err == nil {
			_ = c.Close()
			t.Fatalf("extra tunnel conn %d completed its handshake", i)
		}
		if el := time.Since(start); el > promptClose {
			t.Fatalf("extra tunnel conn %d refused after %s", i, el)
		}
	}
	if got := tc.refused(); got != extra {
		t.Errorf("ratelimited_total{tunnel_conns} = %v, want %d", got, extra)
	}
	if n := tc.open.Load(); n != maxConns {
		t.Errorf("open tunnel slots = %d after the refusals, want %d", n, maxConns)
	}

	// The exempt node SNAT (PROXY header from the trusted LB) is not capped.
	for i := range maxConns + extra {
		c, err := tc.dial(header(t, "10.0.0.1"))
		if err != nil {
			t.Fatalf("exempt tunnel conn %d: %v", i, err)
		}
		held = append(held, c)
	}

	// Closing two conns frees two slots.
	_ = held[0].Close()
	_ = held[1].Close()
	eventually(t, 10*time.Second, "two tunnel slots released", func() bool { return tc.open.Load() == maxConns-2 })
	for i := range 2 {
		c, err := tc.dial(nil)
		if err != nil {
			t.Fatalf("tunnel conn %d after the release: %v", i, err)
		}
		held = append(held, c)
	}
	if c, err := tc.dial(nil); err == nil {
		_ = c.Close()
		t.Fatal("a tunnel conn over the cap passed after the release")
	}
	for _, c := range held {
		_ = c.Close()
	}
	eventually(t, 10*time.Second, "every tunnel slot released", func() bool { return tc.open.Load() == 0 })

	// A conn closed after its ClientHello, before the handshake completes,
	// gives its slot back.
	raw, err := (&net.Dialer{}).DialContext(context.Background(), "tcp", tc.addr)
	if err != nil {
		t.Fatal(err)
	}
	nc := &notifyConn{Conn: raw, wrote: make(chan struct{}), done: make(chan struct{})}
	half := tls.Client(nc, &tls.Config{ServerName: "tunnel.test", RootCAs: tc.roots, MinVersion: tls.VersionTLS12})
	hsDone := make(chan struct{})
	go func() {
		defer close(hsDone)
		_ = half.HandshakeContext(context.Background())
	}()
	<-nc.wrote
	eventually(t, 10*time.Second, "the half-open conn's tunnel slot taken", func() bool { return tc.open.Load() == 1 })
	close(nc.done)
	_ = raw.Close()
	<-hsDone
	eventually(t, 10*time.Second, "the half-open conn's tunnel slot released", func() bool { return tc.open.Load() == 0 })
}

// notifyConn closes wrote after the first Write (the ClientHello). Its Read
// blocks until done and then fails, so the handshake never completes.
type notifyConn struct {
	net.Conn
	wrote, done chan struct{}
	once        sync.Once
}

func (c *notifyConn) Write(p []byte) (int, error) {
	n, err := c.Conn.Write(p)
	c.once.Do(func() { close(c.wrote) })
	return n, err
}

func (c *notifyConn) Read([]byte) (int, error) {
	<-c.done
	return 0, net.ErrClosed
}

// TestDispatcherTunnelConnHeaderTimeout: a tunnel conn that never sends the
// upgrade is closed after the tunnel header timeout and gives its slot
// back.
func TestDispatcherTunnelConnHeaderTimeout(t *testing.T) {
	const readHeader = 300 * time.Millisecond
	tc := newTunnelCap(t, 1, readHeader)
	c, err := tc.dial(nil)
	if err != nil {
		t.Fatal(err)
	}
	defer func() { _ = c.Close() }()
	start := time.Now()
	if !closedWithin(c, 5*time.Second) {
		t.Fatal("an idle tunnel conn was not closed")
	}
	if el := time.Since(start); el < readHeader/2 || el > 3*time.Second {
		t.Fatalf("idle tunnel conn closed after %s, want about %s", el, readHeader)
	}
	eventually(t, 5*time.Second, "the tunnel slot released", func() bool { return tc.open.Load() == 0 })
	c2, err := tc.dial(nil)
	if err != nil {
		t.Fatalf("tunnel conn after the idle one was closed: %v", err)
	}
	_ = c2.Close()
}

// TestTunnelConnCapUpgraded: through a real instance, an upgraded tunnel
// keeps its slot past the tunnel header timeout until it is closed.
func TestTunnelConnCapUpgraded(t *testing.T) {
	env := testenv.New(t, testenv.Options{})
	inst := env.StartInstance(func(c *config.Config) {
		c.RateLimit.TunnelConnsPerIP = 1
		c.Timeouts.TunnelReadHeader = 300 * time.Millisecond
	})
	id, bs := env.NewCredentials()
	up, err := env.TLSDial(inst, testenv.TunnelHost, "http/1.1")
	if err != nil {
		t.Fatal(err)
	}
	defer func() { _ = up.Close() }()
	if resp := upgrade(t, up, testenv.TunnelHost, bootstrapHello(id, bs)); resp.StatusCode != http.StatusSwitchingProtocols {
		t.Fatalf("tunnel upgrade = %d", resp.StatusCode)
	}
	_ = up.SetDeadline(time.Time{})
	time.Sleep(time.Second) // past the tunnel header timeout
	if c, err := env.TLSDial(inst, testenv.TunnelHost); err == nil {
		_ = c.Close()
		t.Fatal("a second tunnel conn passed while the upgraded one is open")
	}
	if got := testutil.ToFloat64(inst.Metrics().RateLimited.WithLabelValues("tunnel_conns")); got != 1 {
		t.Fatalf("ratelimited_total{tunnel_conns} = %v, want 1", got)
	}
	_ = up.Close()
	eventually(t, 10*time.Second, "the upgraded tunnel's slot released", func() bool {
		c, err := env.TLSDial(inst, testenv.TunnelHost)
		if err != nil {
			return false
		}
		_ = c.Close()
		return true
	})
}
