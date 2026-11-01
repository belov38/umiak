package e2e_test

import (
	"context"
	"crypto/sha256"
	"crypto/tls"
	"encoding/hex"
	"io"
	"net"
	"net/http"
	"net/http/httptest"
	"net/url"
	"sync"
	"testing"
	"time"

	"github.com/belov38/umiak/services/gateway/internal/cpapi"
	"github.com/belov38/umiak/services/gateway/internal/testenv"
)

func tokenHash(tok string) string {
	sum := sha256.Sum256([]byte(tok))
	return hex.EncodeToString(sum[:])
}

// authHost is the host of the control plane's authorize endpoint
// (testenv's AuthURL).
const authHost = "app.test"

// browser is an HTTPS client with a cookie jar that sends every umiak host to
// the TLS listener of front and app.test to authz (when set). It follows
// redirects when follow is set.
func browser(t *testing.T, c *cluster, front *testenv.Inst, authz string, follow bool) *http.Client {
	t.Helper()
	tr := &http.Transport{
		DialContext: func(ctx context.Context, network, addr string) (net.Conn, error) {
			target := front.HTTPSAddr
			if host, _, _ := net.SplitHostPort(addr); host == authHost && authz != "" {
				target = authz
			}
			return (&net.Dialer{}).DialContext(ctx, network, target)
		},
		TLSClientConfig:    &tls.Config{RootCAs: c.env.PKI.Roots, MinVersion: tls.VersionTLS12},
		ForceAttemptHTTP2:  true,
		DisableCompression: true,
	}
	t.Cleanup(tr.CloseIdleConnections)
	cl := &http.Client{Transport: tr, Jar: c.env.Jar()}
	if !follow {
		cl.CheckRedirect = func(*http.Request, []*http.Request) error { return http.ErrUseLastResponse }
	}
	return cl
}

// page is the answer to a navigation.
type page struct {
	result
	header  http.Header
	cookies []*http.Cookie
	// url is the URL of the last request (after followed redirects).
	url *url.URL
}

// navigate sends a browser navigation (GET, Accept: text/html).
func navigate(t *testing.T, cl *http.Client, rawURL string, hdr http.Header) page {
	t.Helper()
	ctx, cancel := context.WithTimeout(context.Background(), reqTimeout)
	defer cancel()
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, rawURL, nil)
	if err != nil {
		t.Fatal(err)
	}
	req.Header.Set("Accept", "text/html,application/xhtml+xml")
	for k, v := range hdr {
		req.Header[k] = v
	}
	resp, err := cl.Do(req)
	if err != nil {
		t.Fatalf("GET %s: %v", rawURL, err)
	}
	defer func() { _ = resp.Body.Close() }()
	b, err := io.ReadAll(resp.Body)
	return page{
		result:  result{status: resp.StatusCode, umiakError: resp.Header.Get("Umiak-Error"), body: string(b), err: err},
		header:  resp.Header,
		cookies: resp.Cookies(),
		url:     resp.Request.URL,
	}
}

func TestTokenFlowE2E(t *testing.T) {
	t.Parallel()
	c := newCluster(t, testenv.Options{}, nil)
	m := c.newMachine(t)
	m.ServeHTTP(3000, &wsEchoApp{Plain: echoApp()})
	rt := c.env.Route(m, 3000, func(r *cpapi.Route) {
		r.Access = "token"
		r.TokenHash = tokenHash("tok-1")
	})
	host := testenv.Host(rt.Label)
	base := "https://" + host

	// A browser opens the shared link: 302 without the token, cookie set.
	br := browser(t, c, c.A, "", false)
	p := navigate(t, br, base+"/page?_token=tok-1&x=1", nil)
	if p.status != http.StatusFound || p.header.Get("Location") != "/page?x=1" {
		t.Fatalf("navigation with _token = %v, Location %q", p.result, p.header.Get("Location"))
	}
	var auth *http.Cookie
	for _, ck := range p.cookies {
		if ck.Name == "__Host-umiak_auth" {
			auth = ck
		}
	}
	if auth == nil || !auth.Secure || !auth.HttpOnly || auth.Path != "/" || auth.Domain != "" {
		t.Fatalf("auth cookie = %+v", auth)
	}
	e := decodeEcho(t, navigate(t, br, base+"/page?x=1", nil).result)
	if e.Path != "/page" || e.RawQuery != "x=1" || e.Header.Get("Cookie") != "" {
		t.Fatalf("app saw %s?%s Cookie %q", e.Path, e.RawQuery, e.Header.Get("Cookie"))
	}

	// curl without a jar: proxied at once, the token stripped.
	curl := c.env.HTTPClient(c.A, true)
	e = decodeEcho(t, send(curl, newReq(t, http.MethodGet, "https", host, "/api?_token=tok-1&y=2", nil)))
	if e.RawQuery != "y=2" {
		t.Fatalf("app saw query %q", e.RawQuery)
	}
	if r := send(curl, newReq(t, http.MethodGet, "https", host, "/api?_token=wrong", nil)); r.status != http.StatusUnauthorized || r.umiakError != "token_invalid" {
		t.Fatalf("wrong token = %v", r)
	}
	if r := send(curl, newReq(t, http.MethodGet, "https", host, "/api", nil)); r.status != http.StatusUnauthorized || r.umiakError != "auth_required" {
		t.Fatalf("no token = %v", r)
	}

	// A WebSocket with ?_token= is proxied at once.
	ctx, cancel := context.WithTimeout(context.Background(), reqTimeout)
	defer cancel()
	ws, status, code, err := dialWS(ctx, c.env.HTTPClient(c.A, false), "wss://"+host+"/ws?_token=tok-1")
	if err != nil {
		t.Fatalf("WebSocket with _token: %v (%d %s)", err, status, code)
	}
	if err := echoOnce(ctx, ws, "token ws"); err != nil {
		t.Fatal(err)
	}
	_ = ws.CloseNow()

	// Rotation: authEpoch+1 and a new token. The old cookie gets 401 at
	// once (after the NOTIFY), the new token works.
	rt.AuthEpoch++
	rt.TokenHash = tokenHash("tok-2")
	c.env.API.SetRoute(rt)
	c.env.NotifyRoutes(rt.Slug)
	within(t, notifyWindow, "old cookie refused", func() bool {
		r := navigate(t, br, base+"/page", nil)
		return r.status == http.StatusUnauthorized && r.umiakError == "auth_required"
	})
	if r := send(curl, newReq(t, http.MethodGet, "https", host, "/api?_token=tok-1", nil)); r.status != http.StatusUnauthorized || r.umiakError != "token_invalid" {
		t.Fatalf("old token after rotation = %v", r)
	}
	decodeEcho(t, send(curl, newReq(t, http.MethodGet, "https", host, "/api?_token=tok-2", nil)))
}

// fakeAuthorize mimics api's authorize endpoint: a signed-in user is sent
// straight back to the label's callback with a fresh single-use code.
type fakeAuthorize struct {
	t     *testing.T
	c     *cluster
	srv   *httptest.Server
	mu    sync.Mutex
	epoch int64
	codes []string
}

func newFakeAuthorize(t *testing.T, c *cluster, epoch int64) *fakeAuthorize {
	t.Helper()
	f := &fakeAuthorize{t: t, c: c, epoch: epoch}
	certPEM, keyPEM, err := c.env.PKI.Issue(time.Hour, authHost)
	if err != nil {
		t.Fatal(err)
	}
	cert, err := tls.X509KeyPair(certPEM, keyPEM)
	if err != nil {
		t.Fatal(err)
	}
	f.srv = httptest.NewUnstartedServer(http.HandlerFunc(f.serve))
	f.srv.TLS = &tls.Config{Certificates: []tls.Certificate{cert}, MinVersion: tls.VersionTLS12}
	f.srv.StartTLS()
	t.Cleanup(f.srv.Close)
	return f
}

func (f *fakeAuthorize) serve(w http.ResponseWriter, r *http.Request) {
	if r.URL.Path != "/sso/authorize" {
		http.NotFound(w, r)
		return
	}
	label, state := r.URL.Query().Get("label"), r.URL.Query().Get("state")
	f.mu.Lock()
	code := f.c.env.API.IssueCode(label, cpapi.PortAuthGrant{UserID: "usr_1", Email: "u@example.com", AuthEpoch: f.epoch})
	f.codes = append(f.codes, code)
	f.mu.Unlock()
	w.Header().Set("Location", "https://"+testenv.Host(label)+"/__umiak/auth/callback?code="+url.QueryEscape(code)+"&state="+url.QueryEscape(state))
	w.WriteHeader(http.StatusFound)
}

// addr is the listener address for the browser's dial override.
func (f *fakeAuthorize) addr() string { return f.srv.Listener.Addr().String() }

// startLogin navigates to path without a session and returns the state of
// the redirect to authorize.
func startLogin(t *testing.T, cl *http.Client, base, path string) string {
	t.Helper()
	p := navigate(t, cl, base+path, nil)
	loc, err := url.Parse(p.header.Get("Location"))
	if p.status != http.StatusFound || err != nil || loc.Host != authHost {
		t.Fatalf("navigation to %s = %v, Location %q", path, p.result, p.header.Get("Location"))
	}
	return loc.Query().Get("state")
}

func TestSSOFlowE2E(t *testing.T) {
	t.Parallel()
	c := newCluster(t, testenv.Options{}, nil)
	m := c.newMachine(t)
	m.ServeHTTP(3000, echoApp())
	rt := c.env.Route(m, 3000, func(r *cpapi.Route) { r.Access = "sso" })
	host := testenv.Host(rt.Label)
	base := "https://" + host
	authz := newFakeAuthorize(t, c, rt.AuthEpoch)

	// The full cycle: page → authorize → callback → page, as a browser
	// follows it. The client's own X-Umiak-User-Email never reaches the app.
	full := browser(t, c, c.A, authz.addr(), true)
	p := navigate(t, full, base+"/page?q=1", http.Header{"X-Umiak-User-Email": {"forged@example.com"}})
	e := decodeEcho(t, p.result)
	if p.url.String() != base+"/page?q=1" || e.Path != "/page" || e.RawQuery != "q=1" {
		t.Fatalf("landed on %s, app saw %s?%s", p.url, e.Path, e.RawQuery)
	}
	if got := e.Header.Values("X-Umiak-User-Email"); len(got) != 1 || got[0] != "u@example.com" {
		t.Fatalf("app saw X-Umiak-User-Email %q", got)
	}
	if e.Header.Get("Cookie") != "" {
		t.Fatalf("app saw Cookie %q", e.Header.Get("Cookie"))
	}
	// The session works for fetches too.
	if got := decodeEcho(t, send(full, newReq(t, http.MethodGet, "https", host, "/api", nil))).Header.Get("X-Umiak-User-Email"); got != "u@example.com" {
		t.Fatalf("fetch with the session: X-Umiak-User-Email %q", got)
	}

	// A swapped state: the callback carries the state of another browser's
	// login. Refused, and the code is not burned by the refusal.
	victim := browser(t, c, c.A, "", false)
	attacker := browser(t, c, c.A, "", false)
	victimState := startLogin(t, victim, base, "/dash")
	attackerState := startLogin(t, attacker, base, "/dash")
	code := c.env.API.IssueCode(rt.Label, cpapi.PortAuthGrant{UserID: "usr_1", Email: "u@example.com", AuthEpoch: rt.AuthEpoch})
	callback := func(cl *http.Client, code, state, extra string) page {
		t.Helper()
		return navigate(t, cl, base+"/__umiak/auth/callback?code="+url.QueryEscape(code)+"&state="+url.QueryEscape(state)+extra, nil)
	}
	if r := callback(victim, code, attackerState, ""); r.status != http.StatusUnauthorized || r.umiakError != "auth_required" {
		t.Fatalf("callback with a swapped state = %v", r)
	}
	// rd in the callback query is ignored: the target comes from the state
	// cookie.
	p = callback(victim, code, victimState, "&rd=//evil.com")
	if p.status != http.StatusFound || p.header.Get("Location") != "/dash" {
		t.Fatalf("callback = %v, Location %q; want 302 /dash", p.result, p.header.Get("Location"))
	}

	// The code is single-use (a new browser, the victim is signed in now).
	reuser := browser(t, c, c.A, "", false)
	again := startLogin(t, reuser, base, "/dash")
	if r := callback(reuser, code, again, ""); r.status != http.StatusUnauthorized || r.umiakError != "auth_required" {
		t.Fatalf("callback with a reused code = %v", r)
	}

	// A protocol-relative target is never used: the login lands on "/".
	evil := browser(t, c, c.A, "", false)
	state := startLogin(t, evil, base, "//evil.com")
	code = c.env.API.IssueCode(rt.Label, cpapi.PortAuthGrant{UserID: "usr_1", Email: "u@example.com", AuthEpoch: rt.AuthEpoch})
	p = callback(evil, code, state, "")
	if p.status != http.StatusFound || p.header.Get("Location") != "/" {
		t.Fatalf("callback after //evil.com = %v, Location %q; want 302 /", p.result, p.header.Get("Location"))
	}
	// And with the full browser flow.
	evilFull := browser(t, c, c.A, authz.addr(), true)
	p = navigate(t, evilFull, base+"//evil.com", nil)
	if p.url.Host != host || p.url.Path != "/" {
		t.Fatalf("//evil.com login landed on %s (%v)", p.url, p.result)
	}
	if e := decodeEcho(t, p.result); e.Header.Get("X-Umiak-User-Email") != "u@example.com" {
		t.Fatalf("app saw X-Umiak-User-Email %q", e.Header.Get("X-Umiak-User-Email"))
	}
}
