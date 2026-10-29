package edge_test

import (
	"bufio"
	"context"
	"crypto/tls"
	"crypto/x509"
	"errors"
	"io"
	"net"
	"net/http"
	"net/http/httptest"
	"net/netip"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"testing"
	"time"

	proxyproto "github.com/pires/go-proxyproto"
	"github.com/prometheus/client_golang/prometheus"
	"github.com/prometheus/client_golang/prometheus/testutil"
	"golang.org/x/time/rate"

	"github.com/belov38/boat-dev-clone/libs/tunnel/transport"
	"github.com/belov38/boat-dev-clone/services/gateway/internal/config"
	"github.com/belov38/boat-dev-clone/services/gateway/internal/edge"
	"github.com/belov38/boat-dev-clone/services/gateway/internal/obs"
	"github.com/belov38/boat-dev-clone/services/gateway/internal/testenv"
)

// writePair issues a certificate for names and writes it to dir.
func writePair(t *testing.T, issue func(time.Duration, ...string) ([]byte, []byte, error), certFile, keyFile string, validFor time.Duration, names ...string) {
	t.Helper()
	c, k, err := issue(validFor, names...)
	if err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(certFile, c, 0o600); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(keyFile, k, 0o600); err != nil {
		t.Fatal(err)
	}
}

func leafOf(t *testing.T, c *tls.Certificate) *x509.Certificate {
	t.Helper()
	if c == nil {
		t.Fatal("nil certificate")
	}
	if c.Leaf != nil {
		return c.Leaf
	}
	l, err := x509.ParseCertificate(c.Certificate[0])
	if err != nil {
		t.Fatal(err)
	}
	return l
}

func TestCertSourceLoadErrors(t *testing.T) {
	pki := newTestPKI(t)
	dir := t.TempDir()
	m := obs.NewMetrics(prometheus.NewRegistry())
	if _, err := edge.NewCertSource("sbx", filepath.Join(dir, "missing.crt"), filepath.Join(dir, "missing.key"), m); err == nil {
		t.Fatal("NewCertSource with missing files: no error")
	}
	cf, kf := filepath.Join(dir, "a.crt"), filepath.Join(dir, "a.key")
	writePair(t, pki.Issue, cf, kf, time.Hour, "a.test")
	if err := os.WriteFile(kf, []byte("garbage"), 0o600); err != nil {
		t.Fatal(err)
	}
	if _, err := edge.NewCertSource("sbx", cf, kf, m); err == nil {
		t.Fatal("NewCertSource with a broken key: no error")
	}
}

func TestCertSourceBrokenReloadKeepsOld(t *testing.T) {
	pki := newTestPKI(t)
	dir := t.TempDir()
	cf, kf := filepath.Join(dir, "a.crt"), filepath.Join(dir, "a.key")
	writePair(t, pki.Issue, cf, kf, 2*time.Hour, "a.test")
	m := obs.NewMetrics(prometheus.NewRegistry())
	cs, err := edge.NewCertSource("tunnel", cf, kf, m)
	if err != nil {
		t.Fatal(err)
	}
	if !cs.Loaded() {
		t.Fatal("not Loaded after construction")
	}
	first := leafOf(t, cs.Get())
	if got := testutil.ToFloat64(m.CertExpiry.WithLabelValues("tunnel")); got != float64(first.NotAfter.Unix()) {
		t.Fatalf("expiry gauge = %v, want %d", got, first.NotAfter.Unix())
	}
	cs.SetLogger(testenv.Logger())
	cs.SetPollInterval(50 * time.Millisecond)
	ctx, cancel := context.WithCancel(context.Background())
	done := make(chan struct{})
	go func() { cs.Run(ctx); close(done) }()
	t.Cleanup(func() { cancel(); <-done })

	if err := os.WriteFile(cf, []byte("not a certificate"), 0o600); err != nil {
		t.Fatal(err)
	}
	time.Sleep(400 * time.Millisecond)
	if !cs.Loaded() || leafOf(t, cs.Get()).SerialNumber.Cmp(first.SerialNumber) != 0 {
		t.Fatal("a broken reload replaced the certificate")
	}

	// A good pair afterwards is picked up (here by fsnotify or the poll).
	writePair(t, pki.Issue, cf, kf, 5*time.Hour, "a.test")
	deadline := time.Now().Add(2 * time.Second)
	for leafOf(t, cs.Get()).SerialNumber.Cmp(first.SerialNumber) == 0 {
		if time.Now().After(deadline) {
			t.Fatal("the fixed pair was not reloaded")
		}
		time.Sleep(10 * time.Millisecond)
	}
	if got := testutil.ToFloat64(m.CertExpiry.WithLabelValues("tunnel")); got != float64(leafOf(t, cs.Get()).NotAfter.Unix()) {
		t.Fatalf("expiry gauge = %v after reload", got)
	}
}

// TestCertSourceSymlinkSwap mimics a Kubernetes Secret update: the files are
// symlinks through "..data", which is swapped atomically.
func TestCertSourceSymlinkSwap(t *testing.T) {
	pki := newTestPKI(t)
	dir := t.TempDir()
	v1 := filepath.Join(dir, "..v1")
	if err := os.Mkdir(v1, 0o700); err != nil {
		t.Fatal(err)
	}
	writePair(t, pki.Issue, filepath.Join(v1, "tls.crt"), filepath.Join(v1, "tls.key"), time.Hour, "a.test")
	if err := os.Symlink("..v1", filepath.Join(dir, "..data")); err != nil {
		t.Fatal(err)
	}
	for _, f := range []string{"tls.crt", "tls.key"} {
		if err := os.Symlink(filepath.Join("..data", f), filepath.Join(dir, f)); err != nil {
			t.Fatal(err)
		}
	}
	m := obs.NewMetrics(prometheus.NewRegistry())
	cs, err := edge.NewCertSource("sbx", filepath.Join(dir, "tls.crt"), filepath.Join(dir, "tls.key"), m)
	if err != nil {
		t.Fatal(err)
	}
	first := leafOf(t, cs.Get())
	cs.SetLogger(testenv.Logger())
	cs.SetPollInterval(time.Hour) // fsnotify only
	ctx, cancel := context.WithCancel(context.Background())
	done := make(chan struct{})
	go func() { cs.Run(ctx); close(done) }()
	t.Cleanup(func() { cancel(); <-done })
	time.Sleep(100 * time.Millisecond) // let the watch start

	v2 := filepath.Join(dir, "..v2")
	if err := os.Mkdir(v2, 0o700); err != nil {
		t.Fatal(err)
	}
	writePair(t, pki.Issue, filepath.Join(v2, "tls.crt"), filepath.Join(v2, "tls.key"), 3*time.Hour, "a.test")
	if err := os.Symlink("..v2", filepath.Join(dir, "..data_tmp")); err != nil {
		t.Fatal(err)
	}
	if err := os.Rename(filepath.Join(dir, "..data_tmp"), filepath.Join(dir, "..data")); err != nil {
		t.Fatal(err)
	}
	deadline := time.Now().Add(time.Second)
	for leafOf(t, cs.Get()).SerialNumber.Cmp(first.SerialNumber) == 0 {
		if time.Now().After(deadline) {
			t.Fatal("the swapped Secret was not reloaded within 1 s")
		}
		time.Sleep(10 * time.Millisecond)
	}
}

// proxyHeader returns a PROXY v2 header claiming src.
func proxyHeader(t *testing.T, src string) []byte {
	t.Helper()
	ap := netip.MustParseAddrPort(src)
	h := proxyproto.HeaderProxyFromAddrs(2, net.TCPAddrFromAddrPort(ap), &net.TCPAddr{IP: net.IPv4(127, 0, 0, 1), Port: 443})
	b, err := h.Format()
	if err != nil {
		t.Fatal(err)
	}
	return b
}

// acceptOne accepts one conn from ln and reports its RemoteAddr and the
// first line it reads, or the read error.
func acceptOne(t *testing.T, ln net.Listener) (addr string, line string, err error) {
	t.Helper()
	c, err := ln.Accept()
	if err != nil {
		t.Fatal(err)
	}
	defer func() { _ = c.Close() }()
	_ = c.SetDeadline(time.Now().Add(5 * time.Second))
	line, err = bufio.NewReader(c).ReadString('\n')
	return c.RemoteAddr().String(), line, err
}

func dialWrite(t *testing.T, addr string, data []byte) net.Conn {
	t.Helper()
	c, err := (&net.Dialer{}).DialContext(context.Background(), "tcp", addr)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = c.Close() })
	if _, err := c.Write(data); err != nil {
		t.Fatal(err)
	}
	return c
}

func TestWrapProxyProtocolPolicy(t *testing.T) {
	listen := func(trusted ...string) net.Listener {
		raw, err := (&net.ListenConfig{}).Listen(context.Background(), "tcp", "127.0.0.1:0")
		if err != nil {
			t.Fatal(err)
		}
		var ps []netip.Prefix
		for _, s := range trusted {
			ps = append(ps, netip.MustParsePrefix(s))
		}
		ln := edge.WrapProxyProtocol(raw, ps, 2*time.Second)
		t.Cleanup(func() { _ = ln.Close() })
		return ln
	}

	t.Run("trusted with header", func(t *testing.T) {
		ln := listen("127.0.0.0/8")
		dialWrite(t, ln.Addr().String(), append(proxyHeader(t, "203.0.113.7:5555"), "hello\n"...))
		addr, line, err := acceptOne(t, ln)
		if err != nil || line != "hello\n" || addr != "203.0.113.7:5555" {
			t.Fatalf("addr %s line %q err %v", addr, line, err)
		}
	})
	t.Run("trusted without header", func(t *testing.T) {
		ln := listen("127.0.0.0/8")
		dialWrite(t, ln.Addr().String(), []byte("hello\n"))
		addr, line, err := acceptOne(t, ln)
		if err != nil || line != "hello\n" || !strings.HasPrefix(addr, "127.0.0.1:") {
			t.Fatalf("addr %s line %q err %v", addr, line, err)
		}
	})
	t.Run("untrusted with header", func(t *testing.T) {
		ln := listen("10.0.0.0/8")
		dialWrite(t, ln.Addr().String(), append(proxyHeader(t, "203.0.113.7:5555"), "hello\n"...))
		_, _, err := acceptOne(t, ln)
		if err == nil {
			t.Fatal("a PROXY header from an untrusted source was accepted")
		}
	})
	t.Run("untrusted without header", func(t *testing.T) {
		ln := listen("10.0.0.0/8")
		dialWrite(t, ln.Addr().String(), []byte("hello\n"))
		addr, line, err := acceptOne(t, ln)
		if err != nil || line != "hello\n" || !strings.HasPrefix(addr, "127.0.0.1:") {
			t.Fatalf("addr %s line %q err %v", addr, line, err)
		}
	})
}

func TestTunnelHandlerPathsAndLimit(t *testing.T) {
	m := obs.NewMetrics(prometheus.NewRegistry())
	h := edge.TunnelHandler(rejectAll{}, rate.NewLimiter(rate.Limit(1), 2), m)
	for _, c := range []struct{ method, path string }{
		{http.MethodGet, "/"},
		{http.MethodGet, "/v1/connect/x"},
		{http.MethodPost, "/v1/connect"},
		{http.MethodGet, "/metrics"},
	} {
		rec := httptest.NewRecorder()
		h.ServeHTTP(rec, httptest.NewRequestWithContext(context.Background(), c.method, c.path, nil))
		if rec.Code != http.StatusNotFound {
			t.Errorf("%s %s = %d, want 404", c.method, c.path, rec.Code)
		}
	}
	codes := make([]int, 3)
	var last *httptest.ResponseRecorder
	for i := range codes {
		rec := httptest.NewRecorder()
		h.ServeHTTP(rec, httptest.NewRequestWithContext(context.Background(), http.MethodGet, "/v1/connect", nil))
		codes[i], last = rec.Code, rec
	}
	if codes[0] == http.StatusServiceUnavailable || codes[1] == http.StatusServiceUnavailable {
		t.Fatalf("codes %v: the burst was refused", codes)
	}
	if codes[2] != http.StatusServiceUnavailable || last.Header().Get("Retry-After") != "1" {
		t.Fatalf("third upgrade = %d Retry-After %q, want 503 and 1", codes[2], last.Header().Get("Retry-After"))
	}
	if got := testutil.ToFloat64(m.TunnelAdmitLimited); got != 1 {
		t.Fatalf("tunnel_admit_limited_total = %v, want 1", got)
	}
}

type rejectAll struct{}

func (rejectAll) Admit(context.Context, transport.Hello) (transport.Admission, error) {
	return nil, &transport.RejectError{Status: http.StatusUnauthorized, Reason: "no"}
}

func TestPlainHandlerDispatch(t *testing.T) {
	tag := func(name string) http.Handler {
		return http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) { _, _ = io.WriteString(w, name) })
	}
	h := edge.PlainHandler(tag("sbx"), tag("tunnel"), "tunnel.test")
	for host, want := range map[string]string{
		"tunnel.test":      "tunnel",
		"TUNNEL.Test:8080": "tunnel",
		"tunnel.test.":     "sbx",
		"a-80.sbx.test":    "sbx",
		"x.tunnel.test":    "sbx",
		"":                 "sbx",
	} {
		req := httptest.NewRequestWithContext(context.Background(), http.MethodGet, "/", nil)
		req.Host = host
		rec := httptest.NewRecorder()
		h.ServeHTTP(rec, req)
		if rec.Body.String() != want {
			t.Errorf("Host %q went to %s, want %s", host, rec.Body.String(), want)
		}
	}
}

func TestServerSettings(t *testing.T) {
	s := edge.NewSbxServer(http.NotFoundHandler(), config.Timeouts{ReadHeader: 3 * time.Second})
	if s.ReadHeaderTimeout != 3*time.Second || s.IdleTimeout != 120*time.Second || s.MaxHeaderBytes != 64<<10 {
		t.Errorf("sbx server: ReadHeader %s Idle %s MaxHeaderBytes %d", s.ReadHeaderTimeout, s.IdleTimeout, s.MaxHeaderBytes)
	}
	if s.Protocols == nil || !s.Protocols.HTTP1() || !s.Protocols.HTTP2() || s.Protocols.UnencryptedHTTP2() {
		t.Errorf("sbx server protocols = %v", s.Protocols)
	}
	tn := edge.NewTunnelServer(http.NotFoundHandler())
	if tn.ReadHeaderTimeout != 10*time.Second || tn.MaxHeaderBytes != 16<<10 {
		t.Errorf("tunnel server: ReadHeader %s MaxHeaderBytes %d", tn.ReadHeaderTimeout, tn.MaxHeaderBytes)
	}
	if tn.Protocols == nil || !tn.Protocols.HTTP1() || tn.Protocols.HTTP2() || tn.Protocols.UnencryptedHTTP2() {
		t.Errorf("tunnel server protocols = %v", tn.Protocols)
	}
	p := edge.NewPlainServer(http.NotFoundHandler(), config.Timeouts{})
	if p.ReadHeaderTimeout != 10*time.Second || p.IdleTimeout != 120*time.Second || p.MaxHeaderBytes != 64<<10 {
		t.Errorf("plain server: ReadHeader %s Idle %s MaxHeaderBytes %d", p.ReadHeaderTimeout, p.IdleTimeout, p.MaxHeaderBytes)
	}
	if p.Protocols == nil || !p.Protocols.HTTP1() || !p.Protocols.UnencryptedHTTP2() {
		t.Errorf("plain server protocols = %v", p.Protocols)
	}
}

// TestDispatcherConnLimit checks that the per-IP limit applies to sbx conns
// only and that closing a conn releases its slot exactly once.
func TestDispatcherConnLimit(t *testing.T) {
	pki := newTestPKI(t)
	dir := t.TempDir()
	m := obs.NewMetrics(prometheus.NewRegistry())
	sbx := certSource(t, pki, dir, "sbx", "*.sbx.test", m)
	tun := certSource(t, pki, dir, "tunnel", "tunnel.test", m)

	var mu sync.Mutex
	open, acquired, released := 0, 0, 0
	limit := func(ip netip.Addr) (func(), bool) {
		mu.Lock()
		defer mu.Unlock()
		if !ip.IsLoopback() {
			t.Errorf("ConnLimit ip = %s", ip)
		}
		if open >= 1 {
			return nil, false
		}
		open++
		acquired++
		return func() {
			mu.Lock()
			defer mu.Unlock()
			open--
			released++
		}, true
	}
	raw, err := (&net.ListenConfig{}).Listen(context.Background(), "tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatal(err)
	}
	d := edge.NewDispatcher(raw, edge.DispatchConfig{
		SbxDomain: "sbx.test", TunnelHost: "tunnel.test", Sbx: sbx, Tunnel: tun,
		HandshakeTimeout: 2 * time.Second, ConnLimit: limit, Metrics: m,
	})
	ctx, cancel := context.WithCancel(context.Background())
	served := make(chan error, 1)
	go func() { served <- d.Serve(ctx) }()
	t.Cleanup(func() {
		cancel()
		if err := <-served; err != nil {
			t.Errorf("Serve = %v", err)
		}
	})
	accepted := make(chan net.Conn, 10)
	for _, ln := range []net.Listener{d.Sbx(), d.Tunnel()} {
		go func() {
			for {
				c, err := ln.Accept()
				if err != nil {
					return
				}
				accepted <- c
			}
		}()
	}
	dial := func(sni string) (*tls.Conn, error) {
		return dialTLS(raw.Addr().String(), &tls.Config{ServerName: sni, RootCAs: pki.Roots, MinVersion: tls.VersionTLS12})
	}
	next := func() net.Conn {
		t.Helper()
		select {
		case c := <-accepted:
			return c
		case <-time.After(5 * time.Second):
			t.Fatal("no conn reached the destination listener")
			return nil
		}
	}
	readClosed := func(c *tls.Conn) bool {
		_ = c.SetReadDeadline(time.Now().Add(2 * time.Second))
		_, err := c.Read(make([]byte, 1))
		var ne net.Error
		return err != nil && (!errors.As(err, &ne) || !ne.Timeout())
	}

	c1, err := dial("a-80.sbx.test")
	if err != nil {
		t.Fatal(err)
	}
	s1 := next()
	// A second sbx conn from the same IP is over the limit and closed.
	c2, err := dial("b-80.sbx.test")
	if err == nil && !readClosed(c2) {
		t.Fatal("second sbx conn was not closed")
	}
	// Tunnel conns are not limited.
	for range 3 {
		c, err := dial("tunnel.test")
		if err != nil {
			t.Fatal(err)
		}
		_ = next().Close()
		_ = c.Close()
	}
	_ = c1.Close()
	_ = s1.Close()
	_ = s1.Close()
	mu.Lock()
	if acquired != 1 || released != 1 || open != 0 {
		t.Errorf("acquired %d released %d open %d", acquired, released, open)
	}
	mu.Unlock()
	// The slot is free again.
	c3, err := dial("c-80.sbx.test")
	if err != nil {
		t.Fatal(err)
	}
	s3 := next()
	_ = c3.Close()
	_ = s3.Close()
}
