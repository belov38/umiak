package httpproxy_test

import (
	"bufio"
	"crypto/sha256"
	"encoding/hex"
	"fmt"
	"io"
	"net/http"
	"net/http/httptrace"
	"net/textproto"
	"strconv"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/prometheus/client_golang/prometheus/testutil"

	"github.com/belov38/umiak/services/gateway/internal/config"
	"github.com/belov38/umiak/services/gateway/internal/cpapi"
	"github.com/belov38/umiak/services/gateway/internal/testenv"
)

func TestProxyPublicEcho(t *testing.T) {
	f := newFixture(t, nil)
	f.m.ServeHTTP(3000, echoApp())
	rt := f.env.Route(f.m, 3000, nil)
	host := testenv.Host(rt.Label)

	req := newReq(t, http.MethodGet, host, "/a/b?x=1&y=2", nil)
	req.Header.Set("X-Forwarded-For", "6.6.6.6")
	req.Header.Set("X-Forwarded-Proto", "http")
	req.Header.Set("X-Forwarded-Host", "evil.example")
	req.Header.Set("X-Forwarded-Port", "80")
	req.Header.Set("Forwarded", "for=6.6.6.6")
	req.Header.Set("Authorization", "Bearer app-owned")
	req.Header.Set("User-Agent", "probe/1")
	e, hdr := getEcho(t, f.c, req)

	if e.Host != host || e.Path != "/a/b" || e.RawQuery != "x=1&y=2" || e.Method != http.MethodGet {
		t.Fatalf("app saw %s %s %s ? %s", e.Method, e.Host, e.Path, e.RawQuery)
	}
	want := map[string]string{
		"X-Forwarded-For":   "127.0.0.1",
		"X-Forwarded-Proto": "https",
		"X-Forwarded-Host":  host,
		"X-Forwarded-Port":  "443",
		"Forwarded":         "for=127.0.0.1;proto=https;host=" + host,
		"Authorization":     "Bearer app-owned",
		"User-Agent":        "probe/1",
	}
	for k, v := range want {
		if got := e.Header.Values(k); len(got) != 1 || got[0] != v {
			t.Errorf("app header %s = %q, want %q", k, got, v)
		}
	}
	if v := e.Header.Get("X-Umiak-User-Email"); v != "" {
		t.Errorf("X-Umiak-User-Email = %q on a public route", v)
	}
	rid := e.Header.Get("X-Request-Id")
	if len(rid) != 26 {
		t.Fatalf("X-Request-Id = %q, want a ULID", rid)
	}
	if got := hdr.Values("X-Request-Id"); len(got) != 1 || got[0] != rid {
		t.Errorf("response X-Request-Id = %q, want %q", got, rid)
	}
	if got := hdr.Values("X-Robots-Tag"); len(got) != 1 || got[0] != "noindex, nofollow" {
		t.Errorf("X-Robots-Tag = %q", got)
	}
	if hdr.Get("Umiak-Error") != "" {
		t.Errorf("Umiak-Error = %q on an app answer", hdr.Get("Umiak-Error"))
	}

	l := logLine(t, f.inst, rid)
	wantLog := map[string]any{
		"status": 200.0, "via": "local", "label": rt.Label, "sandboxId": rt.SandboxID,
		"machineId": f.m.ID, "port": 3000.0, "path": "/a/b", "method": "GET", "access": "public",
		"userAgent": "probe/1", "clientIp": "127.0.0.1", "ownerInstance": f.inst.Name, "host": host,
		"umiakError": "", "upgrade": "",
	}
	for k, v := range wantLog {
		if l[k] != v {
			t.Errorf("access log %s = %v, want %v", k, l[k], v)
		}
	}
	if n, _ := l["bytesOut"].(float64); n <= 0 {
		t.Errorf("bytesOut = %v", l["bytesOut"])
	}
	if got := testutil.ToFloat64(f.inst.Metrics().HTTPRequests.WithLabelValues("public", "2xx", "", "local")); got != 1 {
		t.Errorf("http_requests_total{public,2xx,,local} = %v, want 1", got)
	}
	if got := testutil.ToFloat64(f.inst.Metrics().HTTPBytes.WithLabelValues("out")); got <= 0 {
		t.Errorf("http_bytes_total{out} = %v", got)
	}
}

func TestTrustedProxyChain(t *testing.T) {
	f := newFixture(t, func(c *config.Config) {
		c.TrustedProxyCIDRs = cidrs(t, "127.0.0.0/8")
	})
	f.m.ServeHTTP(3000, echoApp())
	rt := f.env.Route(f.m, 3000, nil)
	req := newReq(t, http.MethodGet, testenv.Host(rt.Label), "/", nil)
	req.Header.Set("X-Forwarded-For", "6.6.6.6, 198.51.100.7")
	req.Header.Set("X-Request-Id", "trusted-chain")
	e, _ := getEcho(t, f.c, req)
	if got := e.Header.Get("X-Forwarded-For"); got != "198.51.100.7, 127.0.0.1" {
		t.Errorf("X-Forwarded-For = %q", got)
	}
	if got := e.Header.Get("Forwarded"); !strings.HasPrefix(got, "for=198.51.100.7;") {
		t.Errorf("Forwarded = %q", got)
	}
	if l := logLine(t, f.inst, "trusted-chain"); l["clientIp"] != "198.51.100.7" {
		t.Errorf("clientIp = %v", l["clientIp"])
	}
}

func tokenHash(tok string) string {
	sum := sha256.Sum256([]byte(tok))
	return hex.EncodeToString(sum[:])
}

func TestStripAll(t *testing.T) {
	f := newFixture(t, nil)
	f.m.ServeHTTP(3000, echoApp())
	rt := f.env.Route(f.m, 3000, func(r *cpapi.Route) {
		r.Access = "token"
		r.TokenHash = tokenHash("secret-token")
	})
	req := newReq(t, http.MethodGet, testenv.Host(rt.Label), "/p?x=1&_token=secret-token&y=%2F", nil)
	req.Header.Set("Accept", "application/json")
	stripped := []string{
		"Umiak-Port-Token", "Umiak-Foo", "X-Umiak-User-Email", "X-Umiak-Thing",
		"X-Auth-Request-Email", "X-Auth-Request-User", "X-Auth-Request-Preferred-Username",
		"X-Forwarded-Email", "X-Forwarded-User", "X-Forwarded-Groups",
		"X-Forwarded-Preferred-Username", "X-Forwarded-Access-Token", "X-Real-Ip",
		// Hardening beyond spec 7.4.
		"True-Client-Ip", "X-Client-Ip", "Client-Ip", "Cf-Connecting-Ip", "X-Original-Forwarded-For",
	}
	for _, k := range stripped {
		req.Header.Set(k, "forged")
	}
	// Underscore spellings (CGI/WSGI/Rack map them to the same variable),
	// including the headers the gateway sets itself.
	for _, k := range []string{
		"X_Umiak_User_Email", "Umiak_Foo", "X_Forwarded_For", "X_Forwarded_Email", "X_Real_Ip",
		"X_Auth_Request_Email", "X_Forwarded_Host", "X_Forwarded_Proto", "X_Forwarded_Port",
		"True_Client_Ip", "Cf_Connecting_Ip", "X_Request_Id",
	} {
		req.Header[k] = []string{"forged"}
	}
	cookies := `a=1; __Host-umiak_auth=forged; b="q w"; __host-UMIAK_STATE_abcdefgh=s; _oauth2_proxy=z; __Host-oauth2_proxy_1=z; __Secure-oauth2_proxy=z; c=3`
	req.Header.Set("Cookie", cookies)
	e, hdr := getEcho(t, f.c, req)

	for k, vv := range e.Header {
		for _, v := range vv {
			if strings.Contains(v, "forged") {
				t.Errorf("app saw %s: %q", k, v)
			}
		}
	}
	if got := e.Header.Get("X-Forwarded-For"); got != "127.0.0.1" {
		t.Errorf("X-Forwarded-For = %q", got)
	}
	if got := e.Header.Values("Cookie"); len(got) != 1 || got[0] != `a=1; b="q w"; c=3` {
		t.Errorf("app Cookie = %q", got)
	}
	if e.RawQuery != "x=1&y=%2F" {
		t.Errorf("app query = %q", e.RawQuery)
	}
	var auth int
	for _, c := range hdr.Values("Set-Cookie") {
		if strings.HasPrefix(c, "__Host-umiak_auth=") {
			auth++
		}
	}
	if auth != 1 {
		t.Errorf("Set-Cookie = %q, want one __Host-umiak_auth", hdr.Values("Set-Cookie"))
	}
	if l := logLine(t, f.inst, e.Header.Get("X-Request-Id")); l["access"] != "token" || l["authResult"] != "ok" {
		t.Errorf("access log access=%v authResult=%v", l["access"], l["authResult"])
	}
}

func TestResponseStrip(t *testing.T) {
	f := newFixture(t, nil)
	f.m.ServeHTTP(3000, http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		hd := w.Header()
		hd.Add("Set-Cookie", "__Host-umiak_auth=x; Path=/; Secure")
		hd.Add("Set-Cookie", "__host-UMIAK_auth=y")
		hd.Add("Set-Cookie", "__Host-umiak_state_abcdefgh=z")
		hd.Add("Set-Cookie", "keep=1")
		hd.Set("Umiak-Error", "fake")
		hd.Set("Umiak-Instance-Url", "http://evil")
		hd.Set("Alt-Svc", `h3=":443"`)
		hd.Set("X-Robots-Tag", "all")
		switch r.URL.Path {
		case "/hints":
			hd.Set("Link", "</app.css>; rel=preload")
			w.WriteHeader(http.StatusEarlyHints)
			_, _ = io.WriteString(w, "body")
		case "/many":
			_, _ = io.WriteString(w, "body")
			for i := range 101 {
				hd.Set(http.TrailerPrefix+"X-T-"+strconv.Itoa(i), "v")
			}
		case "/big":
			_, _ = io.WriteString(w, "body")
			for i := range 3 {
				hd.Set(http.TrailerPrefix+"X-Big-"+strconv.Itoa(i), strings.Repeat("a", 30<<10))
			}
		default:
			hd.Set("Trailer", "Umiak-X, X-Ok")
			_, _ = io.WriteString(w, "body")
			hd.Set("Umiak-X", "1")
			hd.Set("X-Ok", "2")
		}
	}))
	rt := f.env.Route(f.m, 3000, nil)
	host := testenv.Host(rt.Label)

	resp := do(t, f.c, newReq(t, http.MethodGet, host, "/", nil))
	defer func() { _ = resp.Body.Close() }()
	if got := resp.Header.Values("Set-Cookie"); len(got) != 1 || got[0] != "keep=1" {
		t.Errorf("Set-Cookie = %q", got)
	}
	for _, k := range []string{"Umiak-Error", "Umiak-Instance-Url", "Alt-Svc"} {
		if v := resp.Header.Values(k); len(v) != 0 {
			t.Errorf("%s = %q reached the client", k, v)
		}
	}
	if got := resp.Header.Values("X-Robots-Tag"); len(got) != 1 || got[0] != "noindex, nofollow" {
		t.Errorf("X-Robots-Tag = %q", got)
	}
	if _, ok := resp.Trailer["Umiak-X"]; ok {
		t.Error("Umiak-X declared to the client")
	}
	if b := readBody(t, resp); b != "body" {
		t.Fatalf("body = %q", b)
	}
	if resp.Trailer.Get("X-Ok") != "2" {
		t.Errorf("trailer X-Ok = %q (trailers %v)", resp.Trailer.Get("X-Ok"), resp.Trailer)
	}
	if _, ok := resp.Trailer["Umiak-X"]; ok {
		t.Errorf("trailer Umiak-X reached the client: %v", resp.Trailer)
	}

	t.Run("1xx", func(t *testing.T) {
		var mu sync.Mutex
		var hints []textproto.MIMEHeader
		trace := &httptrace.ClientTrace{Got1xxResponse: func(code int, h textproto.MIMEHeader) error {
			mu.Lock()
			defer mu.Unlock()
			if code == http.StatusEarlyHints {
				hints = append(hints, h)
			}
			return nil
		}}
		req := newReq(t, http.MethodGet, host, "/hints", nil)
		req = req.WithContext(httptrace.WithClientTrace(req.Context(), trace))
		resp := do(t, f.c, req)
		defer func() { _ = resp.Body.Close() }()
		_ = readBody(t, resp)
		mu.Lock()
		defer mu.Unlock()
		if len(hints) != 1 {
			t.Fatalf("got %d early hints", len(hints))
		}
		hh := http.Header(hints[0])
		if hh.Get("Link") == "" {
			t.Errorf("Link missing from the 103: %v", hh)
		}
		for _, k := range []string{"Umiak-Error", "Umiak-Instance-Url", "Alt-Svc", "Set-Cookie"} {
			if k == "Set-Cookie" {
				if got := hh.Values(k); len(got) != 1 || got[0] != "keep=1" {
					t.Errorf("103 Set-Cookie = %q", got)
				}
				continue
			}
			if v := hh.Values(k); len(v) != 0 {
				t.Errorf("103 %s = %q reached the client", k, v)
			}
		}
	})

	for _, path := range []string{"/many", "/big"} {
		resp := do(t, f.c, newReq(t, http.MethodGet, host, path, nil))
		defer func() { _ = resp.Body.Close() }()
		if b := readBody(t, resp); b != "body" {
			t.Fatalf("%s: body = %q", path, b)
		}
		if len(resp.Trailer) != 0 {
			t.Errorf("%s: %d trailers reached the client", path, len(resp.Trailer))
		}
	}
}

// TestSetCookieTrailerStripped: an app cannot set cookies through
// trailers, declared or not, over HTTP/1 chunked or h2c.
func TestSetCookieTrailerStripped(t *testing.T) {
	f := newFixture(t, nil)
	app := http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		hd := w.Header()
		if r.URL.Path == "/declared" {
			hd.Set("Trailer", "Set-Cookie, X-Ok")
		}
		w.WriteHeader(http.StatusOK)
		_, _ = io.WriteString(w, "body")
		_ = http.NewResponseController(w).Flush()
		if r.URL.Path == "/declared" {
			hd.Add("Set-Cookie", "__Host-umiak_auth=forged; Path=/")
			hd.Add("Set-Cookie", "app=1")
			hd.Set("X-Ok", "2")
			return
		}
		hd.Add(http.TrailerPrefix+"Set-Cookie", "app=1")
		hd.Set(http.TrailerPrefix+"X-Ok", "2")
	})
	f.m.ServeHTTP(3000, app)
	f.m.ServeH2C(5000, app)
	h1 := testenv.Host(f.env.Route(f.m, 3000, nil).Label)
	h2 := testenv.Host(f.env.Route(f.m, 5000, func(r *cpapi.Route) { r.AppProtocol = "h2c" }).Label)
	h2c := h2cTransport(f.inst)
	defer h2c.CloseIdleConnections()

	for _, tc := range []struct {
		name string
		host string
		rt   http.RoundTripper
	}{
		{"http1 app, http1 client", h1, f.c.Transport},
		{"http1 app, h2c client", h1, h2c},
		{"h2c app, http1 client", h2, f.c.Transport},
		{"h2c app, h2c client", h2, h2c},
	} {
		for _, path := range []string{"/declared", "/undeclared"} {
			t.Run(tc.name+" "+path, func(t *testing.T) {
				resp := do(t, &http.Client{Transport: tc.rt}, newReq(t, http.MethodGet, tc.host, path, nil))
				defer func() { _ = resp.Body.Close() }()
				if _, ok := resp.Trailer["Set-Cookie"]; ok {
					t.Errorf("Set-Cookie declared to the client: %v", resp.Trailer)
				}
				if b := readBody(t, resp); b != "body" {
					t.Fatalf("body = %q", b)
				}
				if v := resp.Trailer.Values("Set-Cookie"); len(v) != 0 {
					t.Errorf("Set-Cookie trailer reached the client: %q", v)
				}
				if v := resp.Header.Values("Set-Cookie"); len(v) != 0 {
					t.Errorf("Set-Cookie header = %q", v)
				}
				if resp.Trailer.Get("X-Ok") != "2" {
					t.Errorf("trailer X-Ok = %q (trailers %v)", resp.Trailer.Get("X-Ok"), resp.Trailer)
				}
			})
		}
	}
}

func TestHostRewriteLocalhost(t *testing.T) {
	f := newFixture(t, nil)
	f.m.ServeHTTP(5173, echoApp())
	rt := f.env.Route(f.m, 5173, func(r *cpapi.Route) { r.HostRewrite = "localhost" })
	host := testenv.Host(rt.Label)
	e, _ := getEcho(t, f.c, newReq(t, http.MethodGet, host, "/", nil))
	if e.Host != "localhost:5173" {
		t.Errorf("Host = %q, want localhost:5173", e.Host)
	}
	if got := e.Header.Get("X-Forwarded-Host"); got != host {
		t.Errorf("X-Forwarded-Host = %q, want %q", got, host)
	}
}

func TestRequestID(t *testing.T) {
	f := newFixture(t, nil)
	f.m.ServeHTTP(3000, echoApp())
	rt := f.env.Route(f.m, 3000, nil)
	host := testenv.Host(rt.Label)

	t.Run("kept", func(t *testing.T) {
		req := newReq(t, http.MethodGet, host, "/", nil)
		req.Header.Set("X-Request-Id", "client-id_1.A")
		e, hdr := getEcho(t, f.c, req)
		if e.Header.Get("X-Request-Id") != "client-id_1.A" || hdr.Get("X-Request-Id") != "client-id_1.A" {
			t.Fatalf("app %q, response %q", e.Header.Get("X-Request-Id"), hdr.Get("X-Request-Id"))
		}
		logLine(t, f.inst, "client-id_1.A")
	})
	t.Run("replaced", func(t *testing.T) {
		req := newReq(t, http.MethodGet, host, "/", nil)
		req.Header.Set("X-Request-Id", strings.Repeat("x", 129))
		e, hdr := getEcho(t, f.c, req)
		got := e.Header.Get("X-Request-Id")
		if len(got) != 26 || hdr.Get("X-Request-Id") != got {
			t.Fatalf("app %q, response %q", got, hdr.Get("X-Request-Id"))
		}
		logLine(t, f.inst, got)
	})
	t.Run("error page", func(t *testing.T) {
		req := newReq(t, http.MethodGet, testenv.Host("nosuch-3000"), "/", nil)
		req.Header.Set("Accept", "text/html")
		req.Header.Set("X-Request-Id", "err-req-1")
		resp := do(t, f.c, req)
		defer func() { _ = resp.Body.Close() }()
		body := readBody(t, resp)
		if resp.StatusCode != http.StatusNotFound || !strings.Contains(body, "err-req-1") {
			t.Fatalf("status %d, body %s", resp.StatusCode, body)
		}
		if resp.Header.Get("X-Request-Id") != "err-req-1" {
			t.Errorf("response X-Request-Id = %q", resp.Header.Get("X-Request-Id"))
		}
		l := logLine(t, f.inst, "err-req-1")
		if l["status"] != 404.0 || l["umiakError"] != "route_not_found" {
			t.Errorf("access log status=%v umiakError=%v", l["status"], l["umiakError"])
		}
	})
}

func TestSSE(t *testing.T) {
	f := newFixture(t, nil)
	sent := make(chan time.Time, 1)
	f.m.ServeHTTP(3000, http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "text/event-stream")
		w.WriteHeader(http.StatusOK)
		rc := http.NewResponseController(w)
		_ = rc.Flush()
		time.Sleep(50 * time.Millisecond)
		sent <- time.Now()
		_, _ = io.WriteString(w, "data: hi\n\n")
		_ = rc.Flush()
		<-r.Context().Done()
	}))
	rt := f.env.Route(f.m, 3000, nil)
	req := newReq(t, http.MethodGet, testenv.Host(rt.Label), "/events", nil)
	req.Header.Set("X-Request-Id", "sse-1")
	resp := do(t, f.c, req)
	defer func() { _ = resp.Body.Close() }()
	if resp.StatusCode != http.StatusOK {
		t.Fatalf("status = %d", resp.StatusCode)
	}
	br := bufio.NewReader(resp.Body)
	line, err := br.ReadString('\n')
	got := time.Now()
	if err != nil || line != "data: hi\n" {
		t.Fatalf("event = %q, %v", line, err)
	}
	if d := got.Sub(<-sent); d > 100*time.Millisecond {
		t.Errorf("event took %s", d)
	}
	streams := f.inst.Streams()
	if streams.Count() != 1 {
		t.Errorf("tracked streams = %d, want 1", streams.Count())
	}
	if g := testutil.ToFloat64(f.inst.Metrics().HTTPActiveStreams); g != 1 {
		t.Errorf("http_active_streams = %v, want 1", g)
	}

	// The drain closes the stream; the client sees the end.
	streams.CloseAll()
	done := make(chan error, 1)
	go func() {
		_, err := io.Copy(io.Discard, br)
		done <- err
	}()
	select {
	case err := <-done:
		t.Logf("stream ended: %v", err)
	case <-time.After(reqTimeout):
		t.Fatal("stream still open after CloseAll")
	}
	eventually(t, "stream untracked", func() bool { return streams.Count() == 0 })
	if l := logLine(t, f.inst, "sse-1"); l["status"] != 200.0 {
		t.Errorf("access log status = %v", l["status"])
	}
	eventually(t, "gauge back to 0", func() bool {
		return testutil.ToFloat64(f.inst.Metrics().HTTPActiveStreams) == 0
	})
}

func TestWebSocket(t *testing.T) {
	f := newFixture(t, nil)
	f.m.ServeHTTP(3000, http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if !strings.EqualFold(r.Header.Get("Upgrade"), "websocket") {
			http.Error(w, "no upgrade", http.StatusBadRequest)
			return
		}
		c, brw, err := http.NewResponseController(w).Hijack()
		if err != nil {
			return
		}
		defer func() { _ = c.Close() }()
		_, _ = brw.WriteString("HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nUmiak-Evil: 1\r\n\r\n")
		_ = brw.Flush()
		_, _ = io.Copy(c, brw)
	}))
	rt := f.env.Route(f.m, 3000, nil)
	c := rawConn(t, f.inst)
	resp, br := upgradeRequest(t, c, testenv.Host(rt.Label), "/ws1")
	defer func() { _ = resp.Body.Close() }()
	if resp.StatusCode != http.StatusSwitchingProtocols {
		t.Fatalf("status = %d (%s)", resp.StatusCode, resp.Header.Get("Umiak-Error"))
	}
	if resp.Header.Get("Umiak-Evil") != "" {
		t.Error("Umiak-Evil reached the client")
	}
	if resp.Header.Get("X-Robots-Tag") != "noindex, nofollow" {
		t.Errorf("X-Robots-Tag = %q", resp.Header.Get("X-Robots-Tag"))
	}
	for _, msg := range []string{"hello", "world!"} {
		if _, err := io.WriteString(c, msg); err != nil {
			t.Fatal(err)
		}
		buf := make([]byte, len(msg))
		if _, err := io.ReadFull(br, buf); err != nil || string(buf) != msg {
			t.Fatalf("echo = %q, %v", buf, err)
		}
	}
	streams := f.inst.Streams()
	if streams.Count() != 1 {
		t.Errorf("tracked streams = %d, want 1", streams.Count())
	}
	if g := testutil.ToFloat64(f.inst.Metrics().HTTPActiveStreams); g != 1 {
		t.Errorf("http_active_streams = %v, want 1", g)
	}
	streams.CloseAll()
	if _, err := br.ReadByte(); err == nil {
		t.Fatal("read after CloseAll succeeded")
	}
	eventually(t, "stream untracked", func() bool { return streams.Count() == 0 })
	l := logLine(t, f.inst, "ws-ws1")
	if l["status"] != 101.0 || l["upgrade"] != "websocket" {
		t.Errorf("access log status=%v upgrade=%v", l["status"], l["upgrade"])
	}
	if in, _ := l["bytesIn"].(float64); in < 11 {
		t.Errorf("bytesIn = %v", l["bytesIn"])
	}
	if out, _ := l["bytesOut"].(float64); out < 11 {
		t.Errorf("bytesOut = %v", l["bytesOut"])
	}
}

func TestPreflightBypass(t *testing.T) {
	f := newFixture(t, nil)
	f.m.ServeHTTP(3000, echoApp())
	rt := f.env.Route(f.m, 3000, func(r *cpapi.Route) {
		r.Access = "token"
		r.TokenHash = tokenHash("t")
	})
	host := testenv.Host(rt.Label)

	req := newReq(t, http.MethodOptions, host, "/api", nil)
	req.Header.Set("Origin", "https://other-5173.umiak.test")
	req.Header.Set("Access-Control-Request-Method", "POST")
	e, _ := getEcho(t, f.c, req)
	if e.Method != http.MethodOptions {
		t.Fatalf("app saw %s", e.Method)
	}
	if got := testutil.ToFloat64(f.inst.Metrics().Auth.WithLabelValues("token", "missing")); got != 0 {
		t.Errorf("preflight ran the auth check (%v)", got)
	}

	plain := newReq(t, http.MethodOptions, host, "/api", nil)
	plain.Header.Set("Origin", "https://other-5173.umiak.test")
	resp := do(t, f.c, plain)
	defer func() { _ = resp.Body.Close() }()
	if resp.StatusCode != http.StatusUnauthorized || resp.Header.Get("Umiak-Error") != "auth_required" {
		t.Fatalf("OPTIONS without Access-Control-Request-Method = %d %s", resp.StatusCode, resp.Header.Get("Umiak-Error"))
	}
}

func TestSSOUserEmail(t *testing.T) {
	f := newFixture(t, nil)
	f.m.ServeHTTP(3000, echoApp())
	rt := f.env.Route(f.m, 3000, func(r *cpapi.Route) { r.Access = "sso" })
	host := testenv.Host(rt.Label)
	code := f.env.API.IssueCode(rt.Label, cpapi.PortAuthGrant{UserID: "usr_1", Email: "u@example.com", Label: rt.Label, AuthEpoch: rt.AuthEpoch})

	// Navigation without a session: redirect with a state cookie.
	nav := newReq(t, http.MethodGet, host, "/page", nil)
	nav.Header.Set("Accept", "text/html")
	resp := do(t, f.c, nav)
	defer func() { _ = resp.Body.Close() }()
	if resp.StatusCode != http.StatusFound {
		t.Fatalf("navigation = %d", resp.StatusCode)
	}
	var stateCookie *http.Cookie
	for _, c := range resp.Cookies() {
		if strings.HasPrefix(c.Name, "__Host-umiak_state") {
			stateCookie = c
		}
	}
	if stateCookie == nil {
		t.Fatal("no state cookie")
	}
	loc := resp.Header.Get("Location")
	state := loc[strings.Index(loc, "state=")+len("state="):]

	cb := newReq(t, http.MethodGet, host, "/__umiak/auth/callback?code="+code+"&state="+state, nil)
	cb.AddCookie(stateCookie)
	resp = do(t, f.c, cb)
	defer func() { _ = resp.Body.Close() }()
	if resp.StatusCode != http.StatusFound {
		t.Fatalf("callback = %d %s", resp.StatusCode, resp.Header.Get("Umiak-Error"))
	}
	var session *http.Cookie
	for _, c := range resp.Cookies() {
		if c.Name == "__Host-umiak_auth" {
			session = c
		}
	}
	if session == nil {
		t.Fatal("no session cookie")
	}

	req := newReq(t, http.MethodGet, host, "/page", nil)
	req.AddCookie(session)
	req.Header.Set("X-Umiak-User-Email", "forged@example.com")
	e, _ := getEcho(t, f.c, req)
	if got := e.Header.Values("X-Umiak-User-Email"); len(got) != 1 || got[0] != "u@example.com" {
		t.Errorf("X-Umiak-User-Email = %q", got)
	}
	if e.Header.Get("Cookie") != "" {
		t.Errorf("Cookie = %q reached the app", e.Header.Get("Cookie"))
	}
	if l := logLine(t, f.inst, e.Header.Get("X-Request-Id")); l["userId"] != "usr_1" || l["access"] != "sso" {
		t.Errorf("access log userId=%v access=%v", l["userId"], l["access"])
	}
}

func TestLargeUploadStreams(t *testing.T) {
	f := newFixture(t, nil)
	f.m.ServeHTTP(3000, http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		hs := sha256.New()
		n, err := io.Copy(hs, r.Body)
		if err != nil {
			http.Error(w, err.Error(), http.StatusBadRequest)
			return
		}
		_, _ = fmt.Fprintf(w, "%d %s", n, hex.EncodeToString(hs.Sum(nil)))
	}))
	rt := f.env.Route(f.m, 3000, nil)

	src := newPattern(uploadSize)
	hs := sha256.New()
	body := io.TeeReader(src, hs)

	sampler := startHeapSampler()
	req := newReq(t, http.MethodPut, testenv.Host(rt.Label), "/upload", body)
	req.ContentLength = uploadSize
	resp := do(t, f.c, req)
	defer func() { _ = resp.Body.Close() }()
	got := readBody(t, resp)
	growth := sampler.stop()

	want := fmt.Sprintf("%d %s", uploadSize, hex.EncodeToString(hs.Sum(nil)))
	if resp.StatusCode != http.StatusOK || got != want {
		t.Fatalf("status %d, app saw %q, want %q", resp.StatusCode, got, want)
	}
	t.Logf("uploaded %d MiB, heap in use grew by %.1f MiB", uploadSize>>20, float64(growth)/(1<<20))
	if raceEnabled {
		t.Log("heap assertion skipped under the race detector")
		return
	}
	if growth >= 64<<20 {
		t.Fatalf("heap in use grew by %d MiB, want < 64 MiB", growth>>20)
	}
}

func TestUpgradeFiltering(t *testing.T) {
	f := newFixture(t, nil)
	f.m.ServeHTTP(3000, echoApp())
	public := testenv.Host(f.env.Route(f.m, 3000, nil).Label)
	token := testenv.Host(f.env.Route(f.m, 3000, func(r *cpapi.Route) {
		r.Access = "token"
		r.TokenHash = tokenHash("t")
	}).Label)

	t.Run("preflight with upgrade is not exempt", func(t *testing.T) {
		req := newReq(t, http.MethodOptions, token, "/ws", nil)
		req.Header.Set("Origin", "https://other-5173.umiak.test")
		req.Header.Set("Access-Control-Request-Method", "GET")
		req.Header.Set("Connection", "Upgrade")
		req.Header.Set("Upgrade", "websocket")
		expectError(t, f.c, req, 401, "auth_required", -1)
	})

	noUpgrade := func(t *testing.T, e echoed) {
		t.Helper()
		if v := e.Header.Values("Upgrade"); len(v) != 0 {
			t.Errorf("app saw Upgrade %q", v)
		}
		for _, v := range e.Header.Values("Connection") {
			if strings.Contains(strings.ToLower(v), "upgrade") {
				t.Errorf("app saw Connection %q", v)
			}
		}
	}
	rows := []struct {
		name, method, upgrade string
	}{
		{"preflight websocket on a public route", http.MethodOptions, "websocket"},
		{"h2c on GET", http.MethodGet, "h2c"},
		{"custom token on GET", http.MethodGet, "x-tunnel"},
		{"websocket on POST", http.MethodPost, "websocket"},
	}
	for _, row := range rows {
		t.Run(row.name, func(t *testing.T) {
			req := newReq(t, row.method, public, "/up", nil)
			req.Header.Set("Origin", "https://other-5173.umiak.test")
			req.Header.Set("Access-Control-Request-Method", "GET")
			req.Header.Set("Connection", "Upgrade, X-Hop")
			req.Header.Set("Upgrade", row.upgrade)
			req.Header.Set("HTTP2-Settings", "AAMAAABkAAQAAP__")
			e, _ := getEcho(t, f.c, req)
			if e.Method != row.method {
				t.Fatalf("app saw %s", e.Method)
			}
			noUpgrade(t, e)
		})
	}
}
