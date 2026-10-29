package e2e_test

import (
	"bufio"
	"bytes"
	"compress/gzip"
	"context"
	"crypto/tls"
	"fmt"
	"io"
	"net"
	"net/http"
	"net/http/httptrace"
	"strings"
	"sync/atomic"
	"testing"
	"time"

	"github.com/belov38/boat-dev-clone/services/gateway/internal/testenv"
)

// The hostile tests mirror the S2 hostile-agent attacks
// (libs/tunnel/internal/cmd/tunnelharness/hostile.go) at the public layer:
// a hostile application behind a published port, and a hostile agent that
// answers the gateway's CONNECTs itself.

// rawHTTPApp serves HTTP/1.1 requests on port of m and answers each with
// the raw bytes answer returns; the conn is closed unless keep is set. The
// app is free to break every HTTP rule.
func rawHTTPApp(m *testenv.Machine, port uint16, answer func(r *http.Request) (raw string, keep bool)) {
	m.ServeTCP(port, func(c net.Conn) {
		br := bufio.NewReader(c)
		for {
			req, err := http.ReadRequest(br)
			if err != nil {
				return
			}
			_, _ = io.Copy(io.Discard, req.Body)
			raw, keep := answer(req)
			if _, err := io.WriteString(c, raw); err != nil || !keep {
				return
			}
		}
	})
}

// countingApp is echoApp that counts its requests.
type countingApp struct{ n atomic.Int64 }

func (a *countingApp) ServeHTTP(w http.ResponseWriter, r *http.Request) {
	a.n.Add(1)
	echoApp().ServeHTTP(w, r)
}

func (a *countingApp) Count() int64 { return a.n.Load() }

// h2Browser is an HTTP/2-only client of the TLS listener of front. Like a
// browser that coalesces every *.sbx host on one conn, h2Get can send a
// request for any label over the conn of another (the pool key is the URL
// host, :authority is the label's). dials counts the TCP dials.
func h2Browser(t *testing.T, c *cluster, front *testenv.Inst) (tr *http.Transport, dials *atomic.Int64) {
	t.Helper()
	dials = &atomic.Int64{}
	var p http.Protocols
	p.SetHTTP2(true)
	tr = &http.Transport{
		DialContext: func(ctx context.Context, network, _ string) (net.Conn, error) {
			dials.Add(1)
			return (&net.Dialer{}).DialContext(ctx, network, front.HTTPSAddr)
		},
		TLSClientConfig:    &tls.Config{RootCAs: c.env.PKI.Roots, MinVersion: tls.VersionTLS12},
		Protocols:          &p,
		DisableCompression: true,
	}
	t.Cleanup(tr.CloseIdleConnections)
	return tr, dials
}

// answer is a full response of the gateway as the client saw it.
type answer struct {
	status  int
	header  http.Header
	trailer http.Header
	body    []byte
	err     error // a transport or body read error
	// conn is the client conn that carried it (httptrace GotConn), when
	// known.
	conn net.Conn
}

func (a answer) String() string {
	if a.err != nil && a.status == 0 {
		return "error " + a.err.Error()
	}
	return fmt.Sprintf("%d %s %q (body err %v)", a.status, a.header.Get("Sbx-Error"), truncate(a.body, 200), a.err)
}

func truncate(b []byte, n int) string {
	if len(b) > n {
		return string(b[:n]) + "..."
	}
	return string(b)
}

// roundTrip sends req over rt and reads the whole answer.
func roundTrip(rt http.RoundTripper, req *http.Request) answer {
	resp, err := rt.RoundTrip(req)
	if err != nil {
		return answer{err: err}
	}
	defer func() { _ = resp.Body.Close() }()
	b, err := io.ReadAll(resp.Body)
	return answer{status: resp.StatusCode, header: resp.Header, trailer: resp.Trailer, body: b, err: err}
}

// h2Get sends GET https://connHost/path with :authority host over tr and
// reports the client conn it used.
func h2Get(t *testing.T, tr *http.Transport, connHost, host, path string, hdr http.Header) answer {
	t.Helper()
	ctx, cancel := context.WithTimeout(context.Background(), reqTimeout)
	defer cancel()
	var conn net.Conn
	ctx = httptrace.WithClientTrace(ctx, &httptrace.ClientTrace{
		GotConn: func(info httptrace.GotConnInfo) { conn = info.Conn },
	})
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, "https://"+connHost+path, nil)
	if err != nil {
		t.Fatal(err)
	}
	req.Host = host
	for k, v := range hdr {
		req.Header[k] = v
	}
	resp, err := tr.RoundTrip(req)
	if err != nil {
		return answer{err: err}
	}
	defer func() { _ = resp.Body.Close() }()
	if resp.ProtoMajor != 2 {
		t.Fatalf("%s answered over %s, want HTTP/2", host, resp.Proto)
	}
	b, err := io.ReadAll(resp.Body)
	return answer{status: resp.StatusCode, header: resp.Header, trailer: resp.Trailer, body: b, err: err, conn: conn}
}

// rawH1 is an HTTP/1.1 client conn over TLS whose request bytes the test
// writes itself.
type rawH1 struct {
	c  *tls.Conn
	br *bufio.Reader
}

func dialRawH1(t *testing.T, c *cluster, front *testenv.Inst, sni string) *rawH1 {
	t.Helper()
	tc, err := c.env.TLSDial(front, sni, "http/1.1")
	if err != nil {
		t.Fatalf("TLS dial %s: %v", sni, err)
	}
	t.Cleanup(func() { _ = tc.Close() })
	return &rawH1{c: tc, br: bufio.NewReader(tc)}
}

// do writes raw and reads one response with its whole body.
func (r *rawH1) do(t *testing.T, raw string) answer {
	t.Helper()
	_ = r.c.SetDeadline(time.Now().Add(reqTimeout))
	if _, err := io.WriteString(r.c, raw); err != nil {
		return answer{err: err}
	}
	resp, err := http.ReadResponse(r.br, nil)
	if err != nil {
		return answer{err: err}
	}
	defer func() { _ = resp.Body.Close() }()
	b, err := io.ReadAll(resp.Body)
	return answer{status: resp.StatusCode, header: resp.Header, trailer: resp.Trailer, body: b, err: err}
}

// expectGatewayError checks a gateway-generated answer.
func expectGatewayError(t *testing.T, what string, a answer, status int, codes ...string) {
	t.Helper()
	if a.status != status || len(codes) > 0 && !containsStr(codes, a.header.Get("Sbx-Error")) {
		t.Fatalf("%s = %v; want %d %v", what, a, status, codes)
	}
}

func containsStr(list []string, s string) bool {
	for _, x := range list {
		if x == s {
			return true
		}
	}
	return false
}

// prefaceListener counts the conns whose first bytes are the HTTP/2
// preface, a CONNECT or the peer service token: what a gateway instance
// would send to an address it believed to be a peer. Port probes of other
// local processes (a plain GET, a TLS hello) are not counted. Every conn
// is counted on accept; hits waits until each accepted conn was
// classified, so a late or slow conn cannot slip past the assertion.
type prefaceListener struct {
	ln                   net.Listener
	accepted, classified atomic.Int64
	hit                  atomic.Int64
}

// prefaceReadTimeout bounds the classification read of one conn.
const prefaceReadTimeout = 2 * time.Second

func newPrefaceListener(t *testing.T) *prefaceListener {
	t.Helper()
	ln, err := (&net.ListenConfig{}).Listen(context.Background(), "tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatal(err)
	}
	p := &prefaceListener{ln: ln}
	done := make(chan struct{})
	go func() {
		defer close(done)
		for {
			c, err := ln.Accept()
			if err != nil {
				return
			}
			p.accepted.Add(1)
			go func() {
				defer p.classified.Add(1)
				defer func() { _ = c.Close() }()
				_ = c.SetReadDeadline(time.Now().Add(prefaceReadTimeout))
				// The first bytes decide; a peer sends them at once.
				b := make([]byte, 4096)
				n, _ := io.ReadAtLeast(c, b, len("PRI * HTTP/2.0\r\n\r\nSM\r\n\r\n"))
				b = b[:n]
				if bytes.HasPrefix(b, []byte("PRI * HTTP/2.0")) || bytes.Contains(b, []byte(testenv.PeerToken)) ||
					bytes.HasPrefix(b, []byte("CONNECT")) {
					p.hit.Add(1)
				}
			}()
		}
	}()
	t.Cleanup(func() {
		_ = ln.Close()
		<-done
	})
	return p
}

// hits returns the number of peer-like conns once every conn accepted so
// far (and any that arrives within the next 100 ms) was classified.
func (p *prefaceListener) hits(t *testing.T) int64 {
	t.Helper()
	time.Sleep(100 * time.Millisecond)
	deadline := time.Now().Add(prefaceReadTimeout + time.Second)
	for p.classified.Load() < p.accepted.Load() {
		if time.Now().After(deadline) {
			t.Fatalf("%d of %d conns not classified", p.accepted.Load()-p.classified.Load(), p.accepted.Load())
		}
		time.Sleep(10 * time.Millisecond)
	}
	return p.hit.Load()
}

func (p *prefaceListener) URL() string { return "http://" + p.ln.Addr().String() }

func TestHostileApp(t *testing.T) {
	t.Parallel()
	c := newCluster(t, testenv.Options{}, nil)
	m := c.newMachine(t)

	// A well-behaved echo on another label: every attack must leave the
	// client's conn usable for it.
	m.ServeHTTP(9000, echoApp())
	echoHost := testenv.Host(c.env.Route(m, 9000, nil).Label)

	nextPort := uint16(9100)
	route := func() (port uint16, host string) {
		nextPort++
		return nextPort, testenv.Host(c.env.Route(m, nextPort, nil).Label)
	}
	// browserGet sends GET to host on a fresh coalescing h2 conn, then GET
	// to the echo label on the same conn, which must still work.
	browserGet := func(t *testing.T, host string, hdr http.Header) answer {
		t.Helper()
		tr, dials := h2Browser(t, c, c.A)
		a := h2Get(t, tr, host, host, "/", hdr)
		e := h2Get(t, tr, host, echoHost, "/after", nil)
		if e.status != http.StatusOK || !bytes.Contains(e.body, []byte(`"Path":"/after"`)) {
			t.Fatalf("echo label on the same h2 conn after the attack = %v", e)
		}
		if n := dials.Load(); n != 1 || a.conn == nil || e.conn != a.conn {
			t.Fatalf("%d conns dialed, conns %p and %p; want one", n, a.conn, e.conn)
		}
		return a
	}

	t.Run("header block over 64 KiB", func(t *testing.T) {
		port, host := route()
		rawHTTPApp(m, port, func(*http.Request) (string, bool) {
			return "HTTP/1.1 200 OK\r\nX-Big: " + strings.Repeat("b", 70<<10) + "\r\nContent-Length: 2\r\n\r\nok", false
		})
		expectGatewayError(t, "answer", browserGet(t, host, nil), http.StatusBadGateway, "upstream_error")
	})

	t.Run("10000 small headers", func(t *testing.T) {
		// 6 bytes each on the wire (60,000 bytes: under the transport's
		// 64 KiB read limit), but 340,000 bytes as an HTTP/2 header list.
		port, host := route()
		rawHTTPApp(m, port, func(*http.Request) (string, bool) {
			return "HTTP/1.1 200 OK\r\n" + strings.Repeat("X: v\r\n", 10000) + "Content-Length: 2\r\n\r\nok", false
		})
		expectGatewayError(t, "answer", browserGet(t, host, nil), http.StatusBadGateway, "upstream_error")
	})

	t.Run("1000 declared trailers", func(t *testing.T) {
		port, host := route()
		m.ServeHTTP(port, http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
			for i := range 1000 {
				w.Header().Add("Trailer", fmt.Sprintf("X-T%04d", i))
			}
			_, _ = io.WriteString(w, "body")
			for i := range 1000 {
				w.Header().Set(fmt.Sprintf("X-T%04d", i), "t")
			}
		}))
		a := browserGet(t, host, nil)
		if a.status != http.StatusOK || string(a.body) != "body" || a.err != nil {
			t.Fatalf("answer = %v", a)
		}
		if n := countValues(a.trailer); n != 0 {
			t.Fatalf("client got %d trailer values", n)
		}
	})

	t.Run("trailers over 64 KiB", func(t *testing.T) {
		port, host := route()
		rawHTTPApp(m, port, func(*http.Request) (string, bool) {
			return "HTTP/1.1 200 OK\r\nTrailer: X-Big\r\nTransfer-Encoding: chunked\r\n\r\n4\r\nbody\r\n0\r\nX-Big: " +
				strings.Repeat("t", 70<<10) + "\r\n\r\n", false
		})
		a := browserGet(t, host, nil)
		if a.status != http.StatusOK || string(a.body) != "body" || a.err != nil {
			t.Fatalf("answer = %v", a)
		}
		if n := countValues(a.trailer); n != 0 {
			t.Fatalf("client got %d trailer values", n)
		}
	})

	t.Run("Sbx trailers", func(t *testing.T) {
		port, host := route()
		m.ServeHTTP(port, http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
			w.Header().Add("Trailer", "Sbx-Error")
			w.Header().Add("Trailer", "X-Ok")
			_, _ = io.WriteString(w, "body")
			w.Header().Set("Sbx-Error", "route_blocked")
			w.Header().Set("X-Ok", "1")
			w.Header().Set(http.TrailerPrefix+"sbx-dial-error", "refused")
		}))
		a := browserGet(t, host, nil)
		if a.status != http.StatusOK || string(a.body) != "body" || a.err != nil {
			t.Fatalf("answer = %v", a)
		}
		for k := range a.trailer {
			if strings.HasPrefix(strings.ToLower(k), "sbx-") && a.trailer.Get(k) != "" {
				t.Fatalf("trailer %s = %q reached the client", k, a.trailer.Get(k))
			}
		}
		if a.trailer.Get("X-Ok") != "1" {
			t.Fatalf("trailers %v, want X-Ok: 1", a.trailer)
		}
	})

	t.Run("response header policy", func(t *testing.T) {
		port, host := route()
		m.ServeHTTP(port, http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
			h := w.Header()
			h.Set("Sbx-Error", "route_blocked")
			h.Set("sbx-instance-url", "http://evil")
			h.Add("Set-Cookie", "__host-SBX_AUTH=forged; Path=/; Secure")
			h.Add("Set-Cookie", "__Host-sbx_state_abcdefgh=forged; Path=/; Secure")
			h.Add("Set-Cookie", "app=1; Path=/")
			h.Set("Alt-Svc", `h3=":443"; ma=86400`)
			h.Set("Strict-Transport-Security", "max-age=63072000; includeSubDomains")
			h.Set("X-Sbx-User-Email", "forged@example.com")
			_, _ = io.WriteString(w, "ok")
		}))
		a := browserGet(t, host, nil)
		if a.status != http.StatusOK || string(a.body) != "ok" {
			t.Fatalf("answer = %v", a)
		}
		for k := range a.header {
			if l := strings.ToLower(k); strings.HasPrefix(l, "sbx-") || strings.HasPrefix(l, "x-sbx-") || l == "alt-svc" {
				t.Errorf("header %s: %q reached the client", k, a.header.Values(k))
			}
		}
		if got := a.header.Values("Set-Cookie"); len(got) != 1 || got[0] != "app=1; Path=/" {
			t.Errorf("Set-Cookie = %q, want only the app's own cookie", got)
		}
		// HSTS is the application's business: the gateway is HTTPS-only on
		// *.sbx anyway, and a max-age set by one sandbox host covers only
		// that host (includeSubDomains of a label has no subdomains under
		// it). Stripping it would take a security header away from apps
		// that rely on it.
		if got := a.header.Get("Strict-Transport-Security"); got != "max-age=63072000; includeSubDomains" {
			t.Errorf("Strict-Transport-Security = %q, want the app's value", got)
		}
	})

	t.Run("redirect to metadata", func(t *testing.T) {
		// The gateway never follows a redirect: the client gets it as is.
		attacker := newPrefaceListener(t)
		for _, loc := range []string{"http://169.254.169.254/latest/meta-data/", attacker.URL() + "/x"} {
			port, host := route()
			m.ServeHTTP(port, http.RedirectHandler(loc, http.StatusFound))
			a := browserGet(t, host, nil)
			if a.status != http.StatusFound || a.header.Get("Location") != loc || a.header.Get("Sbx-Error") != "" {
				t.Fatalf("answer = %v, Location %q; want 302 %s", a, a.header.Get("Location"), loc)
			}
		}
		if n := attacker.hits(t); n != 0 {
			t.Fatalf("redirect target contacted %d times", n)
		}
	})

	t.Run("content encoding passes through", func(t *testing.T) {
		var gz bytes.Buffer
		zw := gzip.NewWriter(&gz)
		_, _ = zw.Write(bytes.Repeat([]byte("compressible "), 1000))
		_ = zw.Close()
		garbage := []byte("\x00\xffnot brotli at all\x1b\x00")
		for _, tc := range []struct {
			enc  string
			body []byte
		}{{"gzip", gz.Bytes()}, {"br", garbage}} {
			port, host := route()
			m.ServeHTTP(port, http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
				w.Header().Set("Content-Encoding", tc.enc)
				w.Header().Set("Content-Type", "text/plain")
				_, _ = w.Write(tc.body)
			}))
			a := browserGet(t, host, http.Header{"Accept-Encoding": {"gzip, br"}})
			if a.status != http.StatusOK || a.header.Get("Content-Encoding") != tc.enc || !bytes.Equal(a.body, tc.body) {
				t.Fatalf("%s: answer = %v, Content-Encoding %q, %d bytes; want the app's %d bytes",
					tc.enc, a, a.header.Get("Content-Encoding"), len(a.body), len(tc.body))
			}
		}
	})

	t.Run("101 without an upgrade request", func(t *testing.T) {
		port, host := route()
		rawHTTPApp(m, port, func(*http.Request) (string, bool) {
			return "HTTP/1.1 101 Switching Protocols\r\nConnection: Upgrade\r\nUpgrade: evil\r\n\r\nraw bytes", false
		})
		expectGatewayError(t, "h2 answer", browserGet(t, host, nil), http.StatusBadGateway, "upstream_error")
		// HTTP/1.1 too: the client conn is never switched.
		r := dialRawH1(t, c, c.A, host)
		expectGatewayError(t, "h1 answer", r.do(t, "GET / HTTP/1.1\r\nHost: "+host+"\r\n\r\n"), http.StatusBadGateway, "upstream_error")
		if a := r.do(t, "GET /again HTTP/1.1\r\nHost: "+echoHost+"\r\n\r\n"); a.status != http.StatusOK {
			t.Fatalf("next request on the h1 conn = %v", a)
		}
	})

	t.Run("garbage and HTTP/0.9 answers", func(t *testing.T) {
		for _, raw := range []string{
			"<html>an HTTP/0.9 answer has no status line</html>\n",
			"\x00\x01\x02 garbage \xff\xfe\r\n\r\n",
			"HTTP/1.1 999999 Nope\r\n\r\n",
			"HTTP/1.1 200 OK\r\nContent-Length: 5\r\nContent-Length: 6\r\n\r\nhello!",
		} {
			port, host := route()
			rawHTTPApp(m, port, func(*http.Request) (string, bool) { return raw, false })
			expectGatewayError(t, fmt.Sprintf("answer to %q", raw), browserGet(t, host, nil), http.StatusBadGateway, "upstream_error")
		}
	})

	t.Run("chunked with Content-Length", func(t *testing.T) {
		// A smuggled second response follows the chunked body. The
		// client's conn must not see it, now or on its next request.
		port, host := route()
		rawHTTPApp(m, port, func(*http.Request) (string, bool) {
			return "HTTP/1.1 200 OK\r\nContent-Length: 5\r\nTransfer-Encoding: chunked\r\n\r\n" +
				"5\r\nhello\r\n0\r\n\r\n" +
				"HTTP/1.1 200 OK\r\nContent-Length: 8\r\n\r\nsmuggled", true
		})
		r := dialRawH1(t, c, c.A, host)
		noSmuggle := func(what string, a answer) {
			t.Helper()
			if bytes.Contains(a.body, []byte("smuggled")) {
				t.Fatalf("%s: the smuggled response reached the client: %v", what, a)
			}
		}
		for i := range 3 {
			// The bad label again on the same client conn: another 502
			// each time, never the bytes the app queued behind its answer.
			what := fmt.Sprintf("h1 answer %d", i)
			a := r.do(t, "GET / HTTP/1.1\r\nHost: "+host+"\r\n\r\n")
			noSmuggle(what, a)
			expectGatewayError(t, what, a, http.StatusBadGateway, "upstream_error")
			a = r.do(t, "GET /next HTTP/1.1\r\nHost: "+echoHost+"\r\n\r\n")
			noSmuggle("next request", a)
			if a.status != http.StatusOK || !bytes.Contains(a.body, []byte(`"Path":"/next"`)) {
				t.Fatalf("next request on the same client conn = %v", a)
			}
		}
		// And the h2 path, twice.
		for range 2 {
			a := browserGet(t, host, nil)
			noSmuggle("h2 answer", a)
			expectGatewayError(t, "h2 answer", a, http.StatusBadGateway, "upstream_error")
		}
	})
}

// countValues counts the non-empty values of h.
func countValues(h http.Header) int {
	n := 0
	for _, vv := range h {
		for _, v := range vv {
			if v != "" {
				n++
			}
		}
	}
	return n
}

// hostileAgent answers the gateway's CONNECTs by the target port; every
// other call gets 404.
type hostileAgent struct {
	attackerURL string
	connects    atomic.Int64
}

// Ports of the hostile agent's answers.
const (
	portMoved     = 1001 // 421 with Sbx-Instance-Url of the attacker
	port401       = 1002
	port429       = 1003
	port503       = 1004
	portEOF       = 1005 // 200, then the stream ends at once
	portDialError = 1006 // 502 with an Sbx-Dial-Error outside the closed set
)

// agentSecret must never reach a client.
const agentSecret = "agent-secret-body"

func (a *hostileAgent) ServeHTTP(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodConnect {
		http.NotFound(w, r)
		return
	}
	a.connects.Add(1)
	_, port, _ := net.SplitHostPort(r.Host)
	h := w.Header()
	h.Set("X-Agent-Evil", "1")
	h.Set("Set-Cookie", "__Host-sbx_auth=forged; Path=/; Secure")
	h.Set("Sbx-Error", "route_blocked")
	status := http.StatusOK
	switch port {
	case fmt.Sprint(portMoved):
		h.Set("Sbx-Instance-Url", a.attackerURL)
		status = http.StatusMisdirectedRequest
	case fmt.Sprint(port401):
		h.Set("Retry-After", "99999")
		status = http.StatusUnauthorized
	case fmt.Sprint(port429):
		h.Set("Retry-After", "99999")
		status = http.StatusTooManyRequests
	case fmt.Sprint(port503):
		h.Set("Retry-After", "99999")
		status = http.StatusServiceUnavailable
	case fmt.Sprint(portEOF):
		w.WriteHeader(http.StatusOK)
		_ = http.NewResponseController(w).Flush()
		return
	case fmt.Sprint(portDialError):
		h.Set("Sbx-Dial-Error", "<script>alert(1)</script>")
		status = http.StatusBadGateway
	}
	w.WriteHeader(status)
	_, _ = io.WriteString(w, agentSecret)
}

func TestHostileAgent(t *testing.T) {
	t.Parallel()
	c := newCluster(t, testenv.Options{}, nil)
	attacker := newPrefaceListener(t)
	agent := &hostileAgent{attackerURL: attacker.URL()}
	c.env.RouteOnly(c.C)
	m := c.env.NewRawAgent(agent)
	if o := m.Owner(); o != c.C {
		t.Fatalf("raw agent owner = %v, want C", o)
	}

	cases := []struct {
		name  string
		port  uint16
		codes []string
		// status is the expected status; 0 accepts 502 and 503.
		status int
	}{
		{"421 with an attacker instance URL", portMoved, []string{"upstream_error", "agent_unavailable"}, 0},
		{"401 with Retry-After", port401, []string{"upstream_error"}, http.StatusBadGateway},
		{"429 with Retry-After", port429, []string{"upstream_error"}, http.StatusBadGateway},
		{"503 with Retry-After", port503, []string{"upstream_error"}, http.StatusBadGateway},
		{"200 then EOF", portEOF, []string{"upstream_error"}, http.StatusBadGateway},
		{"Sbx-Dial-Error outside the closed set", portDialError, []string{"upstream_error"}, http.StatusBadGateway},
	}
	// Through C the agent's answer reaches the front directly; through A it
	// crosses C's peer CONNECT first.
	fronts := map[string]*testenv.Inst{"local (C)": c.C, "peer (A)": c.A}
	for _, tc := range cases {
		host := testenv.Host(c.env.Route(m, tc.port, nil).Label)
		for fname, front := range fronts {
			t.Run(tc.name+" via "+fname, func(t *testing.T) {
				before := agent.connects.Load()
				cl := c.env.HTTPClient(front, true)
				start := time.Now()
				a := roundTrip(cl.Transport, newReq(t, http.MethodGet, "https", host, "/", nil))
				took := time.Since(start)
				if a.err != nil && a.status == 0 {
					t.Fatalf("request: %v", a.err)
				}
				if tc.status != 0 {
					expectGatewayError(t, "answer", a, tc.status, tc.codes...)
				} else if a.status != http.StatusBadGateway && a.status != http.StatusServiceUnavailable || !containsStr(tc.codes, a.header.Get("Sbx-Error")) {
					t.Fatalf("answer = %v; want 502/503 %v", a, tc.codes)
				}
				if agent.connects.Load() == before {
					t.Fatal("the agent got no CONNECT")
				}
				if a.header.Get("X-Agent-Evil") != "" || a.header.Get("Retry-After") == "99999" ||
					a.header.Get("Sbx-Instance-Url") != "" || a.header.Get("Set-Cookie") != "" ||
					bytes.Contains(a.body, []byte(agentSecret)) || bytes.Contains(a.body, []byte("<script>")) {
					t.Fatalf("agent data reached the client: header %v body %q", a.header, a.body)
				}
				// A refused CONNECT is an answer, not a reason to wait for
				// the agent.
				if took > time.Second {
					t.Fatalf("answer took %s", took)
				}
			})
		}
	}
	if n := attacker.hits(t); n != 0 {
		t.Fatalf("the attacker's instance URL was contacted %d times", n)
	}
}
