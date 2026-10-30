package edge_test

import (
	"context"
	"crypto/tls"
	"crypto/x509"
	"fmt"
	"net"
	"net/http"
	"net/netip"
	"testing"
	"time"

	"github.com/prometheus/client_golang/prometheus/testutil"

	"github.com/belov38/boat-dev-clone/services/gateway/internal/edge"
	"github.com/belov38/boat-dev-clone/services/gateway/internal/obs"
)

// promptClose is how fast a conn over a handshake cap must be closed: far
// below the handshake timeout of these tests (20 s).
const promptClose = 2 * time.Second

// capDispatcher serves a dispatcher on a fresh loopback listener (wrapped
// with PROXY v2 trusting 127.0.0.0/8 when proxy is set). Tunnel conns are
// accepted and closed; sbx conns are served by an HTTP server.
func capDispatcher(t *testing.T, proxy bool, mod func(*edge.DispatchConfig)) (d *edge.Dispatcher, addr string, roots *x509.CertPool, m *obs.Metrics) {
	t.Helper()
	raw, err := (&net.ListenConfig{}).Listen(context.Background(), "tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatal(err)
	}
	ln := raw
	if proxy {
		ln = edge.WrapProxyProtocol(raw, []netip.Prefix{netip.MustParsePrefix("127.0.0.0/8")}, 20*time.Second)
	}
	d, pki, served := newDispatcher(t, ln, func(c *edge.DispatchConfig) {
		c.HandshakeTimeout = 20 * time.Second
		m = c.Metrics
		if mod != nil {
			mod(c)
		}
	})
	srv := &http.Server{Handler: hostApp("sbx"), ReadHeaderTimeout: 10 * time.Second}
	go func() { _ = srv.Serve(d.Sbx()) }()
	go func() {
		for {
			c, err := d.Tunnel().Accept()
			if err != nil {
				return
			}
			_ = c.Close()
		}
	}()
	t.Cleanup(func() {
		_ = d.Close()
		_ = srv.Close()
		if err := <-served; err != nil {
			t.Errorf("Serve = %v", err)
		}
	})
	return d, raw.Addr().String(), pki.Roots, m
}

// header returns a PROXY v2 header claiming the client ip.
func header(t *testing.T, ip string) []byte {
	t.Helper()
	return proxyHeader(t, ip+":40000")
}

// tlsVia dials addr, writes hdr (if any) and runs a TLS handshake for sni.
func tlsVia(addr string, hdr []byte, sni string, roots *x509.CertPool) (*tls.Conn, error) {
	return tlsViaContext(context.Background(), addr, hdr, sni, roots)
}

func tlsViaContext(ctx context.Context, addr string, hdr []byte, sni string, roots *x509.CertPool) (*tls.Conn, error) {
	ctx, cancel := context.WithTimeout(ctx, reqTimeout)
	defer cancel()
	raw, err := (&net.Dialer{}).DialContext(ctx, "tcp", addr)
	if err != nil {
		return nil, err
	}
	if len(hdr) > 0 {
		if _, err := raw.Write(hdr); err != nil {
			_ = raw.Close()
			return nil, err
		}
	}
	c := tls.Client(raw, &tls.Config{ServerName: sni, RootCAs: roots, MinVersion: tls.VersionTLS12})
	if err := c.HandshakeContext(ctx); err != nil {
		_ = raw.Close()
		return nil, err
	}
	return c, nil
}

// getVia runs an HTTPS GET of https://host/ over a conn that starts with
// hdr (if any).
func getVia(t *testing.T, addr string, hdr []byte, host string, roots *x509.CertPool) error {
	t.Helper()
	tr := &http.Transport{
		DialTLSContext: func(ctx context.Context, _, _ string) (net.Conn, error) {
			return tlsViaContext(ctx, addr, hdr, host, roots)
		},
		DisableKeepAlives: true,
	}
	defer tr.CloseIdleConnections()
	ctx, cancel := context.WithTimeout(context.Background(), reqTimeout)
	defer cancel()
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, "https://"+host+"/", nil)
	if err != nil {
		t.Fatal(err)
	}
	resp, err := (&http.Client{Transport: tr}).Do(req)
	if err != nil {
		return err
	}
	defer func() { _ = resp.Body.Close() }()
	if resp.StatusCode != http.StatusOK {
		return fmt.Errorf("status %d", resp.StatusCode)
	}
	return nil
}

// idleConn opens a conn that sends hdr (if any) and then nothing.
func idleConn(t *testing.T, addr string, hdr []byte) net.Conn {
	t.Helper()
	return dialWrite(t, addr, hdr)
}

func waitInFlight(t *testing.T, d *edge.Dispatcher, ip string, want int) {
	t.Helper()
	a := netip.MustParseAddr(ip)
	eventually(t, 10*time.Second, fmt.Sprintf("%d handshakes in flight of %s", want, ip), func() bool {
		return d.HandshakesInFlightOf(a) == want
	})
}

func handshakesLimited(m *obs.Metrics) float64 {
	return testutil.ToFloat64(m.RateLimited.WithLabelValues("handshakes"))
}

// TestDispatcherPerIPHandshakeCap: without PROXY, the conns of one transport
// peer over the per-IP cap are closed in the accept loop at once.
func TestDispatcherPerIPHandshakeCap(t *testing.T) {
	const perIP = 8
	d, addr, roots, m := capDispatcher(t, false, func(c *edge.DispatchConfig) { c.MaxHandshakesPerIP = perIP })
	var idle []net.Conn
	for range perIP {
		idle = append(idle, idleConn(t, addr, nil))
	}
	waitInFlight(t, d, "127.0.0.1", perIP)
	for i := range 20 {
		c := idleConn(t, addr, nil)
		start := time.Now()
		if !closedWithin(c, promptClose) {
			t.Fatalf("extra conn %d over the per-IP cap was not closed within %s", i, promptClose)
		}
		if el := time.Since(start); el > promptClose {
			t.Fatalf("extra conn %d closed after %s", i, el)
		}
		if n := d.HandshakesInFlightOf(netip.MustParseAddr("127.0.0.1")); n > perIP {
			t.Fatalf("%d handshakes in flight over the per-IP cap %d", n, perIP)
		}
	}
	if got := handshakesLimited(m); got != 20 {
		t.Errorf("ratelimited_total{handshakes} = %v, want 20", got)
	}
	if general, _ := d.HandshakesInFlight(); general != perIP {
		t.Errorf("general handshakes in flight = %d, want %d", general, perIP)
	}
	for _, c := range idle {
		_ = c.Close()
	}
	waitInFlight(t, d, "127.0.0.1", 0)
	c, err := tlsVia(addr, nil, "tunnel.test", roots)
	if err != nil {
		t.Fatalf("handshake after the idle conns closed: %v", err)
	}
	_ = c.Close()
	eventually(t, 10*time.Second, "no handshake in flight", func() bool {
		g, e := d.HandshakesInFlight()
		return g == 0 && e == 0
	})
}

// TestDispatcherPerIPHandshakeCapProxy: behind a trusted PROXY v2 source the
// per-IP cap is keyed by the header address, and exempt clients have their
// own budget.
func TestDispatcherPerIPHandshakeCapProxy(t *testing.T) {
	const perIP, general, exempt = 10, 12, 4
	d, addr, roots, m := capDispatcher(t, true, func(c *edge.DispatchConfig) {
		c.MaxHandshakes = general
		c.MaxHandshakesPerIP = perIP
		c.MaxExemptHandshakes = exempt
		c.HandshakeExempt = []netip.Prefix{netip.MustParsePrefix("10.0.0.0/8")}
	})
	const attacker, client, snat = "192.0.2.1", "198.51.100.7", "10.0.0.1"
	for range perIP {
		idleConn(t, addr, header(t, attacker))
	}
	waitInFlight(t, d, attacker, perIP)
	for i := range 50 {
		c := idleConn(t, addr, header(t, attacker))
		if !closedWithin(c, promptClose) {
			t.Fatalf("attacker conn %d over the per-IP cap was not closed within %s", i, promptClose)
		}
		if n := d.HandshakesInFlightOf(netip.MustParseAddr(attacker)); n > perIP {
			t.Fatalf("%d attacker handshakes in flight over the cap %d", n, perIP)
		}
	}
	if got := handshakesLimited(m); got != 50 {
		t.Errorf("ratelimited_total{handshakes} = %v, want 50", got)
	}
	eventually(t, 10*time.Second, "the general budget holds the attacker conns", func() bool {
		g, _ := d.HandshakesInFlight()
		return g == perIP
	})

	// The general budget is nearly full: a normal client is served.
	if err := getVia(t, addr, header(t, client), "a-80.sbx.test", roots); err != nil {
		t.Fatalf("normal client GET: %v", err)
	}

	// An idle conn of the exempt IP moves to the exempt budget.
	snatIdle := idleConn(t, addr, header(t, snat))
	eventually(t, 10*time.Second, "the exempt conn in the exempt budget", func() bool {
		g, e := d.HandshakesInFlight()
		return g == perIP && e == 1
	})
	_ = snatIdle.Close()
	eventually(t, 10*time.Second, "the exempt slot released", func() bool {
		_, e := d.HandshakesInFlight()
		return e == 0
	})

	// Fill the general budget completely with a second attacker.
	for range general - perIP {
		idleConn(t, addr, header(t, "192.0.2.2"))
	}
	waitInFlight(t, d, "192.0.2.2", general-perIP)
	if g, _ := d.HandshakesInFlight(); g != general {
		t.Fatalf("general handshakes in flight = %d, want %d", g, general)
	}
	// The exempt node SNAT still gets its tunnel handshake.
	c, err := tlsVia(addr, header(t, snat), "tunnel.test", roots)
	if err != nil {
		t.Fatalf("tunnel handshake of the exempt IP with the general budget full: %v", err)
	}
	_ = c.Close()
	// A normal client is shed now: the general cap is the last resort.
	if c, err := tlsVia(addr, header(t, client), "a-80.sbx.test", roots); err == nil {
		_ = c.Close()
		t.Fatal("a non-exempt handshake passed with the general budget full")
	}
	eventually(t, 10*time.Second, "slots back to the idle conns", func() bool {
		g, e := d.HandshakesInFlight()
		return g == general && e == 0 && d.HandshakesInFlightOf(netip.MustParseAddr(client)) == 0
	})
}

// TestDispatcherHandshakeFloodRegression reproduces the acceptance finding
// at small scale: one IP holding more idle conns than the general cap no
// longer blocks other clients and the agent tunnels.
func TestDispatcherHandshakeFloodRegression(t *testing.T) {
	d, addr, roots, _ := capDispatcher(t, true, func(c *edge.DispatchConfig) {
		c.MaxHandshakes = 100
	})
	for range 150 {
		idleConn(t, addr, header(t, "192.0.2.1"))
	}
	// The default per-IP cap is 64.
	waitInFlight(t, d, "192.0.2.1", 64)
	if err := getVia(t, addr, header(t, "198.51.100.7"), "a-80.sbx.test", roots); err != nil {
		t.Fatalf("GET of another IP: %v", err)
	}
	c, err := tlsVia(addr, header(t, "198.51.100.8"), "tunnel.test", roots)
	if err != nil {
		t.Fatalf("tunnel handshake: %v", err)
	}
	_ = c.Close()
}

// TestDispatcherProxyHeaderTimeout: a conn from the trusted LB that sends
// nothing holds its slot (a borrowed exempt one when the general budget is
// full) at most ProxyHeaderTimeout, not the handshake timeout.
func TestDispatcherProxyHeaderTimeout(t *testing.T) {
	const headerTimeout = 300 * time.Millisecond
	d, addr, _, _ := capDispatcher(t, true, func(c *edge.DispatchConfig) {
		c.MaxHandshakes = 1
		c.MaxExemptHandshakes = 4
		c.HandshakeExempt = []netip.Prefix{netip.MustParsePrefix("10.0.0.0/8")}
		c.ProxyHeaderTimeout = headerTimeout
	})
	silentClosed := func(what string) {
		t.Helper()
		start := time.Now()
		c := idleConn(t, addr, nil)
		if !closedWithin(c, 5*time.Second) {
			t.Fatalf("%s: a silent LB conn was not closed", what)
		}
		if el := time.Since(start); el < headerTimeout/2 || el > 3*time.Second {
			t.Fatalf("%s: closed after %s, want about %s", what, el, headerTimeout)
		}
	}
	// The general slot is free.
	silentClosed("general budget free")
	eventually(t, 10*time.Second, "no slot held", func() bool {
		g, e := d.HandshakesInFlight()
		return g == 0 && e == 0
	})
	// The general budget is full: the silent conn borrows an exempt slot
	// and gives it back after the header timeout.
	idleConn(t, addr, header(t, "192.0.2.1"))
	waitInFlight(t, d, "192.0.2.1", 1)
	silentClosed("general budget full")
	eventually(t, 10*time.Second, "the borrowed exempt slot released", func() bool {
		g, e := d.HandshakesInFlight()
		return g == 1 && e == 0
	})
}

// TestDispatcherHeaderlessLBConn: a conn from the trusted LB without a PROXY
// header is keyed by the LB address.
func TestDispatcherHeaderlessLBConn(t *testing.T) {
	const perIP = 2
	d, addr, roots, m := capDispatcher(t, true, func(c *edge.DispatchConfig) {
		c.MaxHandshakesPerIP = perIP
		c.ProxyHeaderTimeout = 5 * time.Second
	})
	// The first byte of a TLS record: not a PROXY signature, so the conn
	// goes on without a header and waits for the rest of the ClientHello.
	var held []net.Conn
	for range perIP {
		held = append(held, idleConn(t, addr, []byte{0x16}))
	}
	waitInFlight(t, d, "127.0.0.1", perIP)
	if !closedWithin(idleConn(t, addr, []byte{0x16}), promptClose) {
		t.Fatal("a header-less LB conn over the LB's per-IP cap was not closed")
	}
	eventually(t, 10*time.Second, "the refusal counted", func() bool { return handshakesLimited(m) == 1 })
	for _, c := range held {
		_ = c.Close()
	}
	waitInFlight(t, d, "127.0.0.1", 0)
	c, err := tlsVia(addr, nil, "tunnel.test", roots)
	if err != nil {
		t.Fatalf("header-less handshake from the LB: %v", err)
	}
	_ = c.Close()
}
