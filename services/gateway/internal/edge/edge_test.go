package edge_test

import (
	"bufio"
	"context"
	"crypto/tls"
	"crypto/x509"
	"io"
	"net"
	"net/http"
	"net/netip"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"github.com/prometheus/client_golang/prometheus"
	"github.com/prometheus/client_golang/prometheus/testutil"
	"golang.org/x/net/http2"

	"github.com/belov38/boat-dev-clone/libs/tunnel/wire"
	"github.com/belov38/boat-dev-clone/services/gateway/internal/config"
	"github.com/belov38/boat-dev-clone/services/gateway/internal/edge"
	"github.com/belov38/boat-dev-clone/services/gateway/internal/obs"
	"github.com/belov38/boat-dev-clone/services/gateway/internal/server"
	"github.com/belov38/boat-dev-clone/services/gateway/internal/testenv"
)

func tlsDial(t *testing.T, env *testenv.Env, inst *testenv.Inst, sni string, alpn ...string) *tls.Conn {
	t.Helper()
	c, err := env.TLSDial(inst, sni, alpn...)
	if err != nil {
		t.Fatalf("TLS dial %s: %v", sni, err)
	}
	t.Cleanup(func() { _ = c.Close() })
	return c
}

// TLS alert descriptions.
const (
	alertProtocolVersion  = 70
	alertUnrecognizedName = 112
)

func TestSNIDispatch(t *testing.T) {
	env := testenv.New(t, testenv.Options{})
	inst := env.StartInstance(nil)

	// sbx SNI → the proxy.
	m := env.NewMachine()
	m.ServeHTTP(3000, hostApp("app"))
	rt := env.Route(m, 3000, nil)
	host := testenv.Host(rt.Label)
	for _, h2 := range []bool{true, false} {
		resp := get(t, env.HTTPClient(inst, h2), "https://"+host+"/", nil)
		if b := resp.Body; resp.StatusCode != http.StatusOK || b != "app "+host {
			t.Fatalf("h2=%v: %d %q", h2, resp.StatusCode, b)
		}
		if want := map[bool]int{true: 2, false: 1}[h2]; resp.ProtoMajor != want {
			t.Fatalf("h2=%v: proto %s", h2, resp.Proto)
		}
	}

	// Tunnel SNI → the upgrade handler: valid credentials are admitted.
	id, bs := env.NewCredentials()
	resp := upgrade(t, tlsDial(t, env, inst, testenv.TunnelHost, "http/1.1"), testenv.TunnelHost, bootstrapHello(id, bs))
	if resp.StatusCode != http.StatusSwitchingProtocols || resp.Header.Get(wire.HeaderGatewayInstance) != inst.Name {
		t.Fatalf("tunnel upgrade = %d, gateway %q", resp.StatusCode, resp.Header.Get(wire.HeaderGatewayInstance))
	}
	// A wrong secret is refused by the tunnel gateway, not by the proxy.
	resp = upgrade(t, tlsDial(t, env, inst, testenv.TunnelHost), testenv.TunnelHost, bootstrapHello(id, []byte("wrong-secret-wrong-secret-wrong!!")))
	if resp.StatusCode != http.StatusUnauthorized || resp.Header.Get("X-Request-Id") != "" {
		t.Fatalf("bad secret = %d (X-Request-Id %q), want 401 from the tunnel handler", resp.StatusCode, resp.Header.Get("X-Request-Id"))
	}

	// Unknown and empty SNI → alert unrecognized_name.
	before := testutil.ToFloat64(inst.Metrics().TLSHandshakeErrors.WithLabelValues("unknown"))
	for _, sni := range []string{"", "example.com", "sbx.test", "tunnel.test.example", "xtunnel.test"} {
		if a := handshakeAlert(t, inst.HTTPSAddr, sni); a != alertUnrecognizedName {
			t.Errorf("SNI %q: alert %d, want %d (unrecognized_name)", sni, a, alertUnrecognizedName)
		}
	}
	// TLS 1.2 gets the same alert.
	if a := handshakeAlertVersion(t, inst.HTTPSAddr, "example.com", tls.VersionTLS12, tls.VersionTLS12); a != alertUnrecognizedName {
		t.Errorf("TLS 1.2, unknown SNI: alert %d, want %d", a, alertUnrecognizedName)
	}
	if c, err := dialTLS(inst.HTTPSAddr, &tls.Config{ServerName: host, RootCAs: env.PKI.Roots, MinVersion: tls.VersionTLS12, MaxVersion: tls.VersionTLS12}); err != nil {
		t.Errorf("TLS 1.2 to an sbx host: %v", err)
	} else {
		_ = c.Close()
	}
	// TLS 1.1 is refused (alert protocol_version) for every SNI.
	for _, sni := range []string{host, testenv.TunnelHost} {
		if a := handshakeAlertVersion(t, inst.HTTPSAddr, sni, tls.VersionTLS10, tls.VersionTLS11); a != alertProtocolVersion {
			t.Errorf("TLS 1.1 to %s: alert %d, want %d (protocol_version)", sni, a, alertProtocolVersion)
		}
	}
	eventually(t, 5*time.Second, "handshake error metric", func() bool {
		return testutil.ToFloat64(inst.Metrics().TLSHandshakeErrors.WithLabelValues("unknown")) >= before+6
	})
	// Upper-case SNI is matched case-insensitively.
	c := tlsDial(t, env, inst, strings.ToUpper(host), "h2")
	if c.ConnectionState().NegotiatedProtocol != "h2" {
		t.Fatalf("upper-case sbx SNI ALPN = %q", c.ConnectionState().NegotiatedProtocol)
	}
}

func TestCoalescedHost(t *testing.T) {
	env := testenv.New(t, testenv.Options{})
	inst := env.StartInstance(nil)
	ma, mb := env.NewMachine(), env.NewMachine()
	ma.ServeHTTP(80, hostApp("a"))
	mb.ServeHTTP(80, hostApp("b"))
	ra := env.Route(ma, 80, nil)
	rb := env.Route(mb, 80, nil)
	hostA, hostB := testenv.Host(ra.Label), testenv.Host(rb.Label)

	// One h2 conn with SNI a: :authority picks the route.
	var p http.Protocols
	p.SetHTTP2(true)
	tr := &http.Transport{
		DialContext: func(ctx context.Context, network, _ string) (net.Conn, error) {
			return (&net.Dialer{}).DialContext(ctx, network, inst.HTTPSAddr)
		},
		TLSClientConfig: &tls.Config{RootCAs: env.PKI.Roots, MinVersion: tls.VersionTLS12},
		Protocols:       &p,
	}
	cctx, ccancel := context.WithTimeout(context.Background(), reqTimeout)
	defer ccancel()
	cc, err := tr.NewClientConn(cctx, "https", hostA+":443")
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = cc.Close() })
	rt := func(authority string) (int, http.Header, string) {
		ctx, cancel := context.WithTimeout(context.Background(), reqTimeout)
		defer cancel()
		req, err := http.NewRequestWithContext(ctx, http.MethodGet, "https://"+authority+"/", nil)
		if err != nil {
			t.Fatal(err)
		}
		resp, err := cc.RoundTrip(req)
		if err != nil {
			t.Fatalf("%s: %v", authority, err)
		}
		defer func() { _ = resp.Body.Close() }()
		return resp.StatusCode, resp.Header, body(t, resp)
	}
	if code, _, b := rt(hostA); code != http.StatusOK || b != "a "+hostA {
		t.Fatalf("authority a: %d %q", code, b)
	}
	if code, _, b := rt(hostB); code != http.StatusOK || b != "b "+hostB {
		t.Fatalf("authority b on an a conn: %d %q", code, b)
	}
	if code, h, _ := rt(testenv.TunnelHost); code != http.StatusNotFound || h.Get("Sbx-Error") != "route_not_found" {
		t.Fatalf("authority tunnel on an sbx conn: %d %q", code, h.Get("Sbx-Error"))
	}

	// HTTP/1.1 on a tunnel conn never reaches the proxy, whatever the Host.
	for _, c := range []struct{ host, path string }{
		{testenv.TunnelHost, "/"},
		{testenv.TunnelHost, "/v1/connect/x"},
		{hostB, "/"},
		{"x-80." + testenv.SbxDomain, "/"},
	} {
		conn := tlsDial(t, env, inst, testenv.TunnelHost, "http/1.1")
		_ = conn.SetDeadline(time.Now().Add(reqTimeout))
		if _, err := io.WriteString(conn, "GET "+c.path+" HTTP/1.1\r\nHost: "+c.host+"\r\n\r\n"); err != nil {
			t.Fatal(err)
		}
		resp, err := http.ReadResponse(bufio.NewReader(conn), nil)
		if err != nil {
			t.Fatal(err)
		}
		b := body(t, resp)
		_ = resp.Body.Close()
		if resp.StatusCode != http.StatusNotFound || resp.Header.Get("X-Request-Id") != "" || strings.Contains(b, "b ") {
			t.Errorf("tunnel conn, Host %s %s: %d X-Request-Id %q body %q", c.host, c.path, resp.StatusCode, resp.Header.Get("X-Request-Id"), b)
		}
	}
}

func TestALPN(t *testing.T) {
	env := testenv.New(t, testenv.Options{})
	inst := env.StartInstance(nil)
	for _, c := range []struct {
		sni  string
		alpn []string
		want string
	}{
		{testenv.TunnelHost, []string{"h2", "http/1.1"}, "http/1.1"},
		{testenv.TunnelHost, nil, ""},
		{"a-80." + testenv.SbxDomain, []string{"h2", "http/1.1"}, "h2"},
		{"a-80." + testenv.SbxDomain, []string{"http/1.1"}, "http/1.1"},
	} {
		got := tlsDial(t, env, inst, c.sni, c.alpn...).ConnectionState().NegotiatedProtocol
		if got != c.want {
			t.Errorf("SNI %s ALPN %v: negotiated %q, want %q", c.sni, c.alpn, got, c.want)
		}
	}
	// Nested labels are sbx conns too (the proxy answers 404); the wildcard
	// does not cover them, so skip verification.
	nested, err := dialTLS(inst.HTTPSAddr, &tls.Config{
		ServerName: "x.y." + testenv.SbxDomain, NextProtos: []string{"h2"},
		InsecureSkipVerify: true, MinVersion: tls.VersionTLS12, //nolint:gosec // only the ALPN is checked
	})
	if err != nil {
		t.Fatal(err)
	}
	if p := nested.ConnectionState().NegotiatedProtocol; p != "h2" {
		t.Errorf("nested sbx SNI: negotiated %q", p)
	}
	_ = nested.Close()
	// Session tickets: sbx conns resume, tunnel conns never do.
	for sni, wantResume := range map[string]bool{"a-80." + testenv.SbxDomain: true, testenv.TunnelHost: false} {
		cache := tls.NewLRUClientSessionCache(4)
		cfg := &tls.Config{ServerName: sni, RootCAs: env.PKI.Roots, ClientSessionCache: cache, NextProtos: []string{"http/1.1"}, MinVersion: tls.VersionTLS12}
		c1, err := dialTLS(inst.HTTPSAddr, cfg)
		if err != nil {
			t.Fatal(err)
		}
		// A request and its answer let the client read the TLS 1.3 tickets.
		_ = c1.SetDeadline(time.Now().Add(reqTimeout))
		if _, err := io.WriteString(c1, "GET /x HTTP/1.1\r\nHost: "+sni+"\r\nConnection: close\r\n\r\n"); err != nil {
			t.Fatal(err)
		}
		_, _ = io.Copy(io.Discard, c1)
		_ = c1.Close()
		c2, err := dialTLS(inst.HTTPSAddr, cfg)
		if err != nil {
			t.Fatal(err)
		}
		if got := c2.ConnectionState().DidResume; got != wantResume {
			t.Errorf("SNI %s: DidResume %v, want %v", sni, got, wantResume)
		}
		_ = c2.Close()
	}
	// A client that offers only h2 to the tunnel host fails ALPN.
	if c, err := env.TLSDial(inst, testenv.TunnelHost, "h2"); err == nil {
		_ = c.Close()
		t.Error("tunnel SNI with ALPN [h2] only: handshake succeeded")
	}
}

func TestHandshakeTimeout(t *testing.T) {
	env := testenv.New(t, testenv.Options{})
	inst := env.StartInstance(func(c *config.Config) { c.Timeouts.TLSHandshake = 200 * time.Millisecond })
	before := testutil.ToFloat64(inst.Metrics().TLSHandshakeErrors.WithLabelValues("unknown"))
	c, err := (&net.Dialer{}).DialContext(context.Background(), "tcp", inst.HTTPSAddr)
	if err != nil {
		t.Fatal(err)
	}
	defer func() { _ = c.Close() }()
	start := time.Now()
	if !closedWithin(c, 3*time.Second) {
		t.Fatal("a silent conn was not closed")
	}
	if el := time.Since(start); el < 150*time.Millisecond || el > 2*time.Second {
		t.Fatalf("closed after %s, want about 200ms", el)
	}
	eventually(t, 5*time.Second, "handshake error metric", func() bool {
		return testutil.ToFloat64(inst.Metrics().TLSHandshakeErrors.WithLabelValues("unknown")) > before
	})
	// Other conns are served meanwhile and afterwards.
	tlsDial(t, env, inst, testenv.TunnelHost)
}

// TestHandshakesPerIPWiring: SBX_GATEWAY_TLS_MAX_HANDSHAKES_PER_IP reaches
// the dispatcher of an instance.
func TestHandshakesPerIPWiring(t *testing.T) {
	env := testenv.New(t, testenv.Options{})
	inst := env.StartInstance(func(c *config.Config) {
		c.Timeouts.TLSHandshake = 20 * time.Second
		c.TLSMaxHandshakesPerIP = 2
	})
	for range 2 {
		dialWrite(t, inst.HTTPSAddr, nil)
	}
	// The kernel queue hands the conns to the accept loop in order.
	if !closedWithin(dialWrite(t, inst.HTTPSAddr, nil), 5*time.Second) {
		t.Fatal("a third idle conn of one IP was not closed")
	}
	if got := testutil.ToFloat64(inst.Metrics().RateLimited.WithLabelValues("handshakes")); got != 1 {
		t.Fatalf("ratelimited_total{handshakes} = %v, want 1", got)
	}
}

// ppClient sends every request to the TLS listener of inst, writing header
// (if any) before the TLS handshake.
func ppClient(t *testing.T, env *testenv.Env, inst *testenv.Inst, header []byte) *http.Client {
	t.Helper()
	tr := &http.Transport{
		DialContext: func(ctx context.Context, network, _ string) (net.Conn, error) {
			c, err := (&net.Dialer{}).DialContext(ctx, network, inst.HTTPSAddr)
			if err != nil {
				return nil, err
			}
			if len(header) > 0 {
				if _, err := c.Write(header); err != nil {
					_ = c.Close()
					return nil, err
				}
			}
			return c, nil
		},
		TLSClientConfig:   &tls.Config{RootCAs: env.PKI.Roots, MinVersion: tls.VersionTLS12},
		ForceAttemptHTTP2: true,
		DisableKeepAlives: true,
	}
	t.Cleanup(tr.CloseIdleConnections)
	return &http.Client{Transport: tr}
}

func TestProxyProtoV2(t *testing.T) {
	env := testenv.New(t, testenv.Options{})
	trusted := env.StartInstance(func(c *config.Config) {
		c.ProxyProtocol = true
		c.ProxyProtocolCIDRs = []netip.Prefix{netip.MustParsePrefix("127.0.0.0/8")}
	})
	untrusted := env.StartInstance(func(c *config.Config) {
		c.ProxyProtocol = true
		c.ProxyProtocolCIDRs = []netip.Prefix{netip.MustParsePrefix("10.0.0.0/8")}
	})
	m := env.NewMachine()
	m.ServeHTTP(3000, hostApp("app"))
	host := testenv.Host(env.Route(m, 3000, nil).Label)
	header := proxyHeader(t, "203.0.113.7:4444")
	setID := func(id string) func(*http.Request) {
		return func(r *http.Request) { r.Header.Set("X-Request-Id", id) }
	}

	// Trusted source with a header: the header's address is the client.
	resp := get(t, ppClient(t, env, trusted, header), "https://"+host+"/", setID("pp-trusted"))
	if resp.StatusCode != http.StatusOK {
		t.Fatalf("trusted with header: %d", resp.StatusCode)
	}
	if ip := logLine(t, trusted, "pp-trusted")["clientIp"]; ip != "203.0.113.7" {
		t.Fatalf("trusted with header: clientIp %v, want 203.0.113.7", ip)
	}
	// Trusted source without a header: the TCP peer.
	resp = get(t, ppClient(t, env, trusted, nil), "https://"+host+"/", setID("pp-trusted-plain"))
	if resp.StatusCode != http.StatusOK {
		t.Fatalf("trusted without header: %d", resp.StatusCode)
	}
	if ip := logLine(t, trusted, "pp-trusted-plain")["clientIp"]; ip != "127.0.0.1" {
		t.Fatalf("trusted without header: clientIp %v", ip)
	}

	// Untrusted source with a header: the conn is closed.
	ctx, cancel := context.WithTimeout(context.Background(), reqTimeout)
	defer cancel()
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, "https://"+host+"/", nil)
	if err != nil {
		t.Fatal(err)
	}
	if resp, err := ppClient(t, env, untrusted, header).Do(req); err == nil {
		_ = resp.Body.Close()
		t.Fatalf("untrusted with header: served with %d", resp.StatusCode)
	}
	raw := dialWrite(t, untrusted.HTTPSAddr, header)
	if !closedWithin(raw, 5*time.Second) {
		t.Fatal("untrusted with header: conn not closed")
	}

	// Untrusted source without a header: served, the TCP peer is the client.
	resp = get(t, ppClient(t, env, untrusted, nil), "https://"+host+"/", setID("pp-untrusted"))
	if resp.StatusCode != http.StatusOK {
		t.Fatalf("untrusted without header: %d", resp.StatusCode)
	}
	if ip := logLine(t, untrusted, "pp-untrusted")["clientIp"]; ip != "127.0.0.1" {
		t.Fatalf("untrusted without header: clientIp %v", ip)
	}
}

func TestCertReload(t *testing.T) {
	env := testenv.New(t, testenv.Options{})
	inst := env.StartInstance(nil)
	sni := "a-80." + testenv.SbxDomain
	peer := func() *x509.Certificate {
		c, err := env.TLSDial(inst, sni)
		if err != nil {
			t.Fatal(err)
		}
		defer func() { _ = c.Close() }()
		return c.ConnectionState().PeerCertificates[0]
	}
	first := peer()
	if got := testutil.ToFloat64(inst.Metrics().CertExpiry.WithLabelValues("sbx")); got != float64(first.NotAfter.Unix()) {
		t.Fatalf("sbx expiry gauge = %v, want %d", got, first.NotAfter.Unix())
	}
	if got := testutil.ToFloat64(inst.Metrics().CertExpiry.WithLabelValues("tunnel")); got == 0 {
		t.Fatal("tunnel expiry gauge not set")
	}
	time.Sleep(100 * time.Millisecond) // let the watch start

	writePair(t, env.PKI.Issue, env.PKI.SbxCertFile, env.PKI.SbxKeyFile, 72*time.Hour, "*."+testenv.SbxDomain)
	start := time.Now()
	var cur *x509.Certificate
	for {
		cur = peer()
		if cur.SerialNumber.Cmp(first.SerialNumber) != 0 {
			break
		}
		if time.Since(start) > time.Second {
			t.Fatal("the new certificate was not served within 1 s")
		}
		time.Sleep(20 * time.Millisecond)
	}
	if got := testutil.ToFloat64(inst.Metrics().CertExpiry.WithLabelValues("sbx")); got != float64(cur.NotAfter.Unix()) {
		t.Fatalf("sbx expiry gauge = %v after reload, want %d", got, cur.NotAfter.Unix())
	}
}

func TestTunnelAdmissionLimit(t *testing.T) {
	env := testenv.New(t, testenv.Options{})
	inst := env.StartInstance(func(c *config.Config) {
		c.TunnelAdmitRate = 1
		c.TunnelAdmitBurst = 2
	})
	var codes []int
	var last *result
	for range 3 {
		last = upgrade(t, tlsDial(t, env, inst, testenv.TunnelHost), testenv.TunnelHost, nil)
		codes = append(codes, last.StatusCode)
	}
	if codes[0] == http.StatusServiceUnavailable || codes[1] == http.StatusServiceUnavailable {
		t.Fatalf("codes %v: the burst was refused", codes)
	}
	if codes[2] != http.StatusServiceUnavailable || last.Header.Get("Retry-After") != "1" {
		t.Fatalf("third upgrade: %d Retry-After %q, want 503 and 1", codes[2], last.Header.Get("Retry-After"))
	}
	if got := testutil.ToFloat64(inst.Metrics().TunnelAdmitLimited); got != 1 {
		t.Fatalf("tunnel_admit_limited_total = %v", got)
	}
}

// TestTunnelReadHeaderTimeout drives the tunnel server behind a dispatcher.
// The 5 s production value is asserted in TestServerSettings; here it is
// shrunk.
func TestTunnelReadHeaderTimeout(t *testing.T) {
	pki := newTestPKI(t)
	dir := t.TempDir()
	m := obs.NewMetrics(prometheus.NewRegistry())
	raw, err := (&net.ListenConfig{}).Listen(context.Background(), "tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatal(err)
	}
	d := edge.NewDispatcher(raw, edge.DispatchConfig{
		SbxDomain: "sbx.test", TunnelHost: "tunnel.test",
		Sbx: certSource(t, pki, dir, "sbx", "*.sbx.test", m), Tunnel: certSource(t, pki, dir, "tunnel", "tunnel.test", m),
		HandshakeTimeout: 2 * time.Second, Metrics: m,
	})
	ctx, cancel := context.WithCancel(context.Background())
	served := make(chan error, 1)
	go func() { served <- d.Serve(ctx) }()
	srv := edge.NewTunnelServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) { w.WriteHeader(299) }),
		config.Timeouts{TunnelReadHeader: 300 * time.Millisecond})
	go func() { _ = srv.Serve(d.Tunnel()) }()
	t.Cleanup(func() {
		_ = srv.Close()
		cancel()
		if err := <-served; err != nil {
			t.Errorf("Serve = %v", err)
		}
	})
	dial := func() *tls.Conn {
		c, err := dialTLS(raw.Addr().String(), &tls.Config{ServerName: "tunnel.test", RootCAs: pki.Roots, MinVersion: tls.VersionTLS12})
		if err != nil {
			t.Fatal(err)
		}
		t.Cleanup(func() { _ = c.Close() })
		return c
	}

	c := dial()
	if _, err := io.WriteString(c, "GET /v1/connect HTTP/1.1\r\nHost: tunnel.test\r\n"); err != nil {
		t.Fatal(err)
	}
	start := time.Now()
	if !closedWithin(c, 3*time.Second) {
		t.Fatal("a stalled request header was not cut off")
	}
	if el := time.Since(start); el > 2*time.Second {
		t.Fatalf("cut off after %s", el)
	}

	// Oversized headers: 16 KiB cap.
	c = dial()
	_ = c.SetDeadline(time.Now().Add(reqTimeout))
	big := "GET /v1/connect HTTP/1.1\r\nHost: tunnel.test\r\nX-Big: " + strings.Repeat("a", 20<<10) + "\r\n\r\n"
	if _, err := io.WriteString(c, big); err != nil {
		t.Fatal(err)
	}
	resp, err := http.ReadResponse(bufio.NewReader(c), nil)
	if err != nil {
		t.Fatal(err)
	}
	_ = resp.Body.Close()
	if resp.StatusCode != http.StatusRequestHeaderFieldsTooLarge {
		t.Fatalf("20 KiB header = %d, want 431", resp.StatusCode)
	}
}

func TestPlainMode(t *testing.T) {
	env := testenv.New(t, testenv.Options{})
	inst := env.StartInstance(nil)
	behindIngress := env.StartInstance(func(c *config.Config) {
		c.TrustedProxyCIDRs = []netip.Prefix{netip.MustParsePrefix("127.0.0.0/8")}
	})
	m := env.NewMachine()
	m.ServeHTTP(3000, hostApp("app"))
	host := testenv.Host(env.Route(m, 3000, nil).Label)

	// Host tunnel → the upgrade handler.
	id, bs := env.NewCredentials()
	plainConn := func(i *testenv.Inst) net.Conn {
		c, err := (&net.Dialer{}).DialContext(context.Background(), "tcp", i.PlainAddr)
		if err != nil {
			t.Fatal(err)
		}
		t.Cleanup(func() { _ = c.Close() })
		return c
	}
	resp := upgrade(t, plainConn(inst), testenv.TunnelHost+":8080", bootstrapHello(id, bs))
	if resp.StatusCode != http.StatusSwitchingProtocols || resp.Header.Get(wire.HeaderGatewayInstance) != inst.Name {
		t.Fatalf("plain tunnel upgrade = %d", resp.StatusCode)
	}
	resp = get(t, env.PlainClient(inst), "http://"+testenv.TunnelHost+"/", nil)
	if resp.StatusCode != http.StatusNotFound || resp.Header.Get("X-Request-Id") != "" {
		t.Fatalf("plain tunnel GET / = %d X-Request-Id %q", resp.StatusCode, resp.Header.Get("X-Request-Id"))
	}

	// *.sbx → the proxy; XFF only from trusted proxies.
	for _, c := range []struct {
		inst *testenv.Inst
		want string
	}{{inst, "127.0.0.1"}, {behindIngress, "198.51.100.9"}} {
		rid := "plain-" + c.inst.Name
		resp := get(t, env.PlainClient(c.inst), "http://"+host+"/", func(r *http.Request) {
			r.Header.Set("X-Forwarded-For", "198.51.100.9")
			r.Header.Set("X-Request-Id", rid)
		})
		if b := resp.Body; resp.StatusCode != http.StatusOK || b != "app "+host {
			t.Fatalf("%s: %d %q", c.inst.Name, resp.StatusCode, b)
		}
		if ip := logLine(t, c.inst, rid)["clientIp"]; ip != c.want {
			t.Fatalf("%s: clientIp %v, want %s", c.inst.Name, ip, c.want)
		}
	}

	// h2c prior knowledge works on the plain listener.
	var h2cp http.Protocols
	h2cp.SetUnencryptedHTTP2(true)
	h2c := &http.Transport{
		DialContext: func(ctx context.Context, network, _ string) (net.Conn, error) {
			return (&net.Dialer{}).DialContext(ctx, network, inst.PlainAddr)
		},
		Protocols: &h2cp,
	}
	t.Cleanup(h2c.CloseIdleConnections)
	resp = get(t, &http.Client{Transport: h2c}, "http://"+host+"/", nil)
	if b := resp.Body; resp.StatusCode != http.StatusOK || resp.ProtoMajor != 2 || b != "app "+host {
		t.Fatalf("h2c: %d %s %q", resp.StatusCode, resp.Proto, b)
	}
}

func TestNoEnableConnectProtocol(t *testing.T) {
	env := testenv.New(t, testenv.Options{})
	inst := env.StartInstance(nil)
	c := tlsDial(t, env, inst, "a-80."+testenv.SbxDomain, "h2")
	if p := c.ConnectionState().NegotiatedProtocol; p != "h2" {
		t.Fatalf("ALPN = %q", p)
	}
	_ = c.SetDeadline(time.Now().Add(reqTimeout))
	if _, err := io.WriteString(c, http2.ClientPreface); err != nil {
		t.Fatal(err)
	}
	fr := http2.NewFramer(c, c)
	if err := fr.WriteSettings(); err != nil {
		t.Fatal(err)
	}
	for {
		f, err := fr.ReadFrame()
		if err != nil {
			t.Fatal(err)
		}
		sf, ok := f.(*http2.SettingsFrame)
		if !ok || sf.IsAck() {
			continue
		}
		n := 0
		_ = sf.ForeachSetting(func(s http2.Setting) error {
			n++
			if s.ID == http2.SettingEnableConnectProtocol {
				t.Errorf("server SETTINGS has ENABLE_CONNECT_PROTOCOL=%d", s.Val)
			}
			return nil
		})
		if n == 0 {
			t.Fatal("empty server SETTINGS")
		}
		return
	}
}

func TestReadyNeedsCerts(t *testing.T) {
	env := testenv.New(t, testenv.Options{})
	listen := func() net.Listener {
		ln, err := (&net.ListenConfig{}).Listen(context.Background(), "tcp", "127.0.0.1:0")
		if err != nil {
			t.Fatal(err)
		}
		return ln
	}
	cfg := env.InstanceConfig("gw-nocert", "http://127.0.0.1:1")
	cfg.TunnelCertFile = filepath.Join(t.TempDir(), "missing.crt")

	// With a TLS listener the certificates are required: Run fails and the
	// instance never becomes ready.
	inst, err := server.New(cfg, env.Deps())
	if err != nil {
		t.Fatal(err)
	}
	done := make(chan error, 1)
	go func() { done <- inst.Run(context.Background(), server.Listeners{Metrics: listen(), TLS: listen()}) }()
	select {
	case err := <-done:
		if err == nil || !strings.Contains(err.Error(), "missing.crt") {
			t.Fatalf("Run = %v, want the certificate error", err)
		}
	case <-time.After(testenv.WaitTimeout):
		t.Fatal("Run did not fail")
	}
	if inst.Ready() {
		t.Fatal("Ready without certificates")
	}

	// Without a TLS listener (plain mode) no certificate is needed.
	inst, err = server.New(cfg, env.Deps())
	if err != nil {
		t.Fatal(err)
	}
	ctx, cancel := context.WithCancel(context.Background())
	done = make(chan error, 1)
	go func() { done <- inst.Run(ctx, server.Listeners{Metrics: listen(), Plain: listen()}) }()
	eventually(t, testenv.WaitTimeout, "plain-mode instance ready", inst.Ready)
	cancel()
	if err := <-done; err != nil {
		t.Fatalf("Run = %v", err)
	}
}
