package portauth

import (
	"context"
	"crypto/sha256"
	"encoding/base64"
	"encoding/hex"
	"net/http"
	"net/http/httptest"
	"net/netip"
	"net/url"
	"strconv"
	"strings"
	"testing"
	"time"

	"github.com/prometheus/client_golang/prometheus"
	"github.com/prometheus/client_golang/prometheus/testutil"

	"github.com/belov38/umiak/services/gateway/internal/config"
	"github.com/belov38/umiak/services/gateway/internal/cpapi"
	"github.com/belov38/umiak/services/gateway/internal/cpapi/cpapitest"
	"github.com/belov38/umiak/services/gateway/internal/obs"
	"github.com/belov38/umiak/services/gateway/internal/ratelimit"
	"github.com/belov38/umiak/services/gateway/internal/routes"
)

const (
	testToken   = "umiakp_secret-token"
	testDomain  = "umiak.example.com"
	testAuthURL = "https://app.example.com/umiak-auth/authorize"
)

var clientIP = netip.MustParseAddr("203.0.113.7")

func tokenHash(tok string) string {
	sum := sha256.Sum256([]byte(tok))
	return hex.EncodeToString(sum[:])
}

type harness struct {
	auth    *Auth
	codec   *Codec
	api     *cpapitest.Fake
	limits  *ratelimit.Limits
	metrics *obs.Metrics
	now     time.Time
}

func newHarness(t *testing.T, mut func(*Config)) *harness {
	t.Helper()
	h := &harness{now: fixedNow()}
	clock := func() time.Time { return h.now }
	h.codec = NewCodec([]config.CookieKey{keyA}, clock)
	h.api = cpapitest.NewFake()
	h.api.SetClock(clock)
	h.metrics = obs.NewMetrics(prometheus.NewRegistry())
	h.limits = ratelimit.New(ratelimit.Config{AuthFailPerMin: 20, AuthBlock: 5 * time.Minute, Now: clock}, h.metrics)
	cfg := Config{
		Codec:       h.codec,
		API:         h.api,
		AuthURL:     testAuthURL,
		UmiakDomain: testDomain,
		TokenTTL:    7 * 24 * time.Hour,
		SSOTTL:      12 * time.Hour,
		StateTTL:    10 * time.Minute,
		Limits:      h.limits,
		Metrics:     h.metrics,
	}
	if mut != nil {
		mut(&cfg)
	}
	h.auth = New(cfg)
	return h
}

func label(raw string) routes.Label {
	return routes.Label{Raw: raw, Slug: raw[:strings.LastIndex(raw, "-")], Port: 3000, Kind: routes.KindPort}
}

func tokenRoute(raw string) cpapi.Route {
	return cpapi.Route{Label: raw, Access: "token", TokenHash: tokenHash(testToken), AuthEpoch: 3, Kind: cpapi.KindPort}
}

func ssoRoute(raw string) cpapi.Route {
	return cpapi.Route{Label: raw, Access: "sso", AuthEpoch: 5, Kind: cpapi.KindPort}
}

func navRequest(method, target string) *http.Request {
	r := httptest.NewRequestWithContext(context.Background(), method, target, nil)
	r.Header.Set("Accept", "text/html,application/xhtml+xml,*/*;q=0.8")
	return r
}

func fetchRequest(method, target string) *http.Request {
	r := httptest.NewRequestWithContext(context.Background(), method, target, nil)
	r.Header.Set("Accept", "application/json")
	return r
}

func (h *harness) check(r *http.Request, l routes.Label, rt cpapi.Route) (*httptest.ResponseRecorder, Result) {
	w := httptest.NewRecorder()
	res := h.auth.Check(w, r, l, rt, clientIP, "req-1")
	return w, res
}

func (h *harness) authCount(access, result string) float64 {
	return testutil.ToFloat64(h.metrics.Auth.WithLabelValues(access, result))
}

// cookieHeader returns the Set-Cookie line with the given name.
func cookieHeader(t *testing.T, w *httptest.ResponseRecorder, name string) string {
	t.Helper()
	for _, v := range w.Result().Header.Values("Set-Cookie") {
		if strings.HasPrefix(v, name+"=") {
			return v
		}
	}
	t.Fatalf("no Set-Cookie %s in %q", name, w.Result().Header.Values("Set-Cookie"))
	return ""
}

func cookieValue(line string) string {
	v, _, _ := strings.Cut(line, ";")
	_, v, _ = strings.Cut(v, "=")
	return v
}

func assertAttrs(t *testing.T, line string, maxAge int, crossSite bool) {
	t.Helper()
	attrs := strings.Split(line, "; ")[1:]
	want := []string{"Path=/", "Max-Age=" + strconv.Itoa(maxAge), "HttpOnly", "Secure"}
	if crossSite {
		want = append(want, "SameSite=None", "Partitioned")
	} else {
		want = append(want, "SameSite=Lax")
	}
	if strings.Join(attrs, "; ") != strings.Join(want, "; ") {
		t.Errorf("cookie attributes = %q, want %q", attrs, want)
	}
	if strings.Contains(strings.ToLower(line), "domain") {
		t.Errorf("cookie has a Domain: %q", line)
	}
}

func assertDenied(t *testing.T, w *httptest.ResponseRecorder, status int, code string) {
	t.Helper()
	if w.Code != status || w.Header().Get("Umiak-Error") != code {
		t.Fatalf("got %d %q, want %d %q (body %s)", w.Code, w.Header().Get("Umiak-Error"), status, code, w.Body.String())
	}
}

func assertNoStore(t *testing.T, w *httptest.ResponseRecorder) {
	t.Helper()
	if w.Header().Get("Cache-Control") != "no-store" || w.Header().Get("X-Robots-Tag") != "noindex, nofollow" {
		t.Errorf("headers = %v, want Cache-Control no-store and X-Robots-Tag", w.Header())
	}
}

func TestTokenQueryNavigationRedirect(t *testing.T) {
	for _, crossSite := range []bool{false, true} {
		h := newHarness(t, func(c *Config) { c.CrossSite = crossSite })
		l := label("quiet-otter-3000")
		r := navRequest(http.MethodGet, "https://quiet-otter-3000.umiak.example.com/p/a%2Fb?a=1&_token="+testToken+"&b=%20x")
		w, res := h.check(r, l, tokenRoute(l.Raw))
		if res.Proceed {
			t.Fatal("navigation with _token proceeded")
		}
		if w.Code != http.StatusFound {
			t.Fatalf("status = %d", w.Code)
		}
		if loc := w.Header().Get("Location"); loc != "/p/a%2Fb?a=1&b=%20x" {
			t.Errorf("Location = %q", loc)
		}
		if w.Header().Get("Referrer-Policy") != "no-referrer" {
			t.Errorf("Referrer-Policy = %q", w.Header().Get("Referrer-Policy"))
		}
		assertNoStore(t, w)
		line := cookieHeader(t, w, AuthCookie)
		assertAttrs(t, line, 7*24*3600, crossSite)
		s, err := h.codec.OpenSession(cookieValue(line))
		if err != nil {
			t.Fatal(err)
		}
		want := Session{Label: l.Raw, Mode: ModeToken, Epoch: 3, Expiry: h.now.Add(7 * 24 * time.Hour)}
		if s != want {
			t.Errorf("session = %+v, want %+v", s, want)
		}
		if res.AuthResult != ResultOK || h.authCount("token", ResultOK) != 1 {
			t.Errorf("AuthResult = %q, metric = %v", res.AuthResult, h.authCount("token", ResultOK))
		}
	}
}

func TestTokenQueryRedirectDropsQuestionMark(t *testing.T) {
	h := newHarness(t, nil)
	l := label("quiet-otter-3000")
	w, _ := h.check(navRequest(http.MethodHead, "https://quiet-otter-3000.umiak.example.com/?_token="+testToken), l, tokenRoute(l.Raw))
	if w.Code != http.StatusFound || w.Header().Get("Location") != "/" {
		t.Errorf("got %d Location %q", w.Code, w.Header().Get("Location"))
	}
}

func TestTokenQueryRedirectUnsafePath(t *testing.T) {
	h := newHarness(t, nil)
	l := label("quiet-otter-3000")
	r := navRequest(http.MethodGet, "https://quiet-otter-3000.umiak.example.com/?_token="+testToken)
	r.URL.Path = "//evil.com/x"
	w, _ := h.check(r, l, tokenRoute(l.Raw))
	if loc := w.Header().Get("Location"); loc != "https://quiet-otter-3000.umiak.example.com//evil.com/x" {
		t.Errorf("Location = %q", loc)
	}
}

func TestTokenQueryFetchProceeds(t *testing.T) {
	h := newHarness(t, nil)
	l := label("quiet-otter-3000")
	for _, r := range []*http.Request{
		fetchRequest(http.MethodGet, "https://quiet-otter-3000.umiak.example.com/api?_token="+url.QueryEscape(testToken)),
		navRequest(http.MethodPost, "https://quiet-otter-3000.umiak.example.com/api?_token="+testToken),
		func() *http.Request {
			r := navRequest(http.MethodGet, "https://quiet-otter-3000.umiak.example.com/ws?_token="+testToken)
			r.Header.Set("Upgrade", "websocket")
			return r
		}(),
	} {
		w, res := h.check(r, l, tokenRoute(l.Raw))
		if !res.Proceed || res.SetCookie == nil {
			t.Fatalf("%s %s: result = %+v, status %d", r.Method, r.URL, res, w.Code)
		}
		if w.Code != http.StatusOK || len(w.Header()) != 0 {
			t.Errorf("Check wrote a response: %d %v", w.Code, w.Header())
		}
		if res.SetCookie.Name != AuthCookie || res.SetCookie.MaxAge != 7*24*3600 || !res.SetCookie.Secure || !res.SetCookie.HttpOnly {
			t.Errorf("SetCookie = %+v", res.SetCookie)
		}
		if _, err := h.codec.OpenSession(res.SetCookie.Value); err != nil {
			t.Errorf("SetCookie value: %v", err)
		}
	}
}

func TestTokenHeader(t *testing.T) {
	h := newHarness(t, nil)
	l := label("quiet-otter-3000")
	r := navRequest(http.MethodGet, "https://quiet-otter-3000.umiak.example.com/")
	r.Header.Set(TokenHeader, testToken)
	w, res := h.check(r, l, tokenRoute(l.Raw))
	if !res.Proceed || res.SetCookie != nil || res.AuthResult != ResultOK {
		t.Fatalf("result = %+v, status %d", res, w.Code)
	}
}

func TestTokenInvalid(t *testing.T) {
	h := newHarness(t, nil)
	l := label("quiet-otter-3000")
	rt := tokenRoute(l.Raw)

	header := fetchRequest(http.MethodGet, "https://quiet-otter-3000.umiak.example.com/")
	header.Header.Set(TokenHeader, "umiakp_wrong")
	w, res := h.check(header, l, rt)
	assertDenied(t, w, http.StatusUnauthorized, "token_invalid")
	if res.Proceed || res.AuthResult != ResultInvalid {
		t.Errorf("result = %+v", res)
	}

	for i := 2; i <= 20; i++ {
		w, _ := h.check(fetchRequest(http.MethodGet, "https://quiet-otter-3000.umiak.example.com/?_token=nope"), l, rt)
		assertDenied(t, w, http.StatusUnauthorized, "token_invalid")
	}
	if got := h.authCount("token", ResultInvalid); got != 20 {
		t.Errorf("invalid count = %v, want 20", got)
	}

	// The 21st attempt is blocked, even with the right token.
	w, res = h.check(fetchRequest(http.MethodGet, "https://quiet-otter-3000.umiak.example.com/?_token="+testToken), l, rt)
	assertDenied(t, w, http.StatusTooManyRequests, "rate_limited")
	if w.Header().Get("Retry-After") != "300" || res.Proceed {
		t.Errorf("Retry-After = %q, result %+v", w.Header().Get("Retry-After"), res)
	}
	if got := testutil.ToFloat64(h.metrics.RateLimited.WithLabelValues(ratelimit.LimitAuthFail)); got != 1 {
		t.Errorf("ratelimited auth_fail = %v, want 1", got)
	}

	// A request without a token is not affected by the block.
	w, _ = h.check(fetchRequest(http.MethodGet, "https://quiet-otter-3000.umiak.example.com/"), l, rt)
	assertDenied(t, w, http.StatusUnauthorized, "auth_required")
}

func TestTokenInvalidQueryBeatsValidCookie(t *testing.T) {
	h := newHarness(t, nil)
	l := label("quiet-otter-3000")
	r := fetchRequest(http.MethodGet, "https://quiet-otter-3000.umiak.example.com/?_token=nope")
	r.AddCookie(&http.Cookie{Name: AuthCookie, Value: h.codec.SealSession(Session{Label: l.Raw, Mode: ModeToken, Epoch: 3, Expiry: h.now.Add(time.Hour)})})
	w, _ := h.check(r, l, tokenRoute(l.Raw))
	assertDenied(t, w, http.StatusUnauthorized, "token_invalid")
}

func TestTokenMissing(t *testing.T) {
	h := newHarness(t, nil)
	l := label("quiet-otter-3000")
	w, res := h.check(navRequest(http.MethodGet, "https://quiet-otter-3000.umiak.example.com/"), l, tokenRoute(l.Raw))
	assertDenied(t, w, http.StatusUnauthorized, "auth_required")
	if res.AuthResult != ResultMissing || h.authCount("token", ResultMissing) != 1 {
		t.Errorf("result = %+v", res)
	}
}

func TestCookieScope(t *testing.T) {
	h := newHarness(t, nil)
	a := label("quiet-otter-3000")
	b := label("quiet-otter-4000")
	good := Session{Label: a.Raw, Mode: ModeToken, Epoch: 3, Expiry: h.now.Add(time.Hour)}

	withCookie := func(s Session) *http.Request {
		r := fetchRequest(http.MethodGet, "https://x/")
		r.AddCookie(&http.Cookie{Name: "other", Value: "1"})
		r.AddCookie(&http.Cookie{Name: AuthCookie, Value: h.codec.SealSession(s)})
		return r
	}

	if _, res := h.check(withCookie(good), a, tokenRoute(a.Raw)); !res.Proceed || res.AuthResult != ResultOK || res.SetCookie != nil {
		t.Fatalf("good cookie: %+v", res)
	}
	w, res := h.check(withCookie(good), b, tokenRoute(b.Raw))
	assertDenied(t, w, http.StatusUnauthorized, "auth_required")
	if res.AuthResult != ResultInvalid {
		t.Errorf("other label result = %q", res.AuthResult)
	}

	mode := good
	mode.Mode = ModeSSO
	epoch := good
	epoch.Epoch = 2
	expired := good
	expired.Expiry = h.now
	desktop := good
	desktop.Mode = ModeDesktop
	for name, s := range map[string]Session{"mode": mode, "epoch": epoch, "expired": expired, "desktop": desktop} {
		w, _ := h.check(withCookie(s), a, tokenRoute(a.Raw))
		if w.Code != http.StatusUnauthorized {
			t.Errorf("%s mismatch: status %d", name, w.Code)
		}
	}

	// An sso route does not accept a token cookie, and a token route does
	// not accept an sso cookie.
	ssoCookie := Session{Label: a.Raw, Mode: ModeSSO, Epoch: 5, Expiry: h.now.Add(time.Hour), Email: "a@b.c"}
	if _, res := h.check(withCookie(good), a, ssoRoute(a.Raw)); res.Proceed {
		t.Error("token cookie accepted on sso route")
	}
	if _, res := h.check(withCookie(ssoCookie), a, ssoRoute(a.Raw)); !res.Proceed || res.Email != "a@b.c" {
		t.Errorf("sso cookie on sso route: %+v", res)
	}

	// Cookie invalidity is not an auth failure for the rate limit.
	for range 30 {
		h.check(withCookie(epoch), a, tokenRoute(a.Raw))
	}
	if blocked, _ := h.limits.AuthBlocked(clientIP); blocked {
		t.Error("stale cookies blocked the IP")
	}
}

func TestSSORedirect(t *testing.T) {
	h := newHarness(t, nil)
	l := label("quiet-otter-3000")
	rt := ssoRoute(l.Raw)

	w, res := h.check(navRequest(http.MethodGet, "https://quiet-otter-3000.umiak.example.com/page?x=1&y=%2F"), l, rt)
	if res.Proceed || w.Code != http.StatusFound || res.AuthResult != ResultRedirect {
		t.Fatalf("result = %+v, status %d", res, w.Code)
	}
	assertNoStore(t, w)
	loc, err := url.Parse(w.Header().Get("Location"))
	if err != nil {
		t.Fatal(err)
	}
	if loc.Scheme+"://"+loc.Host+loc.Path != testAuthURL || loc.Query().Get("label") != l.Raw {
		t.Errorf("Location = %q", loc)
	}
	state := loc.Query().Get("state")
	if raw, err := base64.RawURLEncoding.DecodeString(state); err != nil || len(raw) != 16 {
		t.Errorf("state = %q (%v)", state, err)
	}
	line := cookieHeader(t, w, StateCookiePrefix+"_"+state[:8])
	assertAttrs(t, line, 600, false)
	st, err := h.codec.OpenState(cookieValue(line))
	if err != nil {
		t.Fatal(err)
	}
	want := State{State: state, RD: "/page?x=1&y=%2F", Label: l.Raw, Expiry: h.now.Add(10 * time.Minute)}
	if st != want {
		t.Errorf("state = %+v, want %+v", st, want)
	}
	if h.authCount("sso", ResultRedirect) != 1 {
		t.Error("redirect not counted")
	}

	w, res = h.check(fetchRequest(http.MethodGet, "https://quiet-otter-3000.umiak.example.com/api"), l, rt)
	assertDenied(t, w, http.StatusUnauthorized, "auth_required")
	if res.AuthResult != ResultMissing {
		t.Errorf("xhr result = %q", res.AuthResult)
	}
	if len(w.Result().Header.Values("Set-Cookie")) != 0 {
		t.Error("xhr got a state cookie")
	}
}

func TestSSORedirectAuthURLWithQuery(t *testing.T) {
	h := newHarness(t, func(c *Config) { c.AuthURL = "https://app.example.com/authorize?tenant=x" })
	l := label("quiet-otter-3000")
	w, _ := h.check(navRequest(http.MethodGet, "https://quiet-otter-3000.umiak.example.com/"), l, ssoRoute(l.Raw))
	loc := w.Header().Get("Location")
	if !strings.HasPrefix(loc, "https://app.example.com/authorize?tenant=x&label=quiet-otter-3000&state=") {
		t.Errorf("Location = %q", loc)
	}
}

func TestSafeRD(t *testing.T) {
	for in, want := range map[string]string{
		"/":                                 "/",
		"/a?b=c":                            "/a?b=c",
		"//evil.com":                        "/",
		"/\\evil.com":                       "/",
		"https://e.com/":                    "/",
		"":                                  "/",
		"evil":                              "/",
		"/" + strings.Repeat("a", maxRDLen): "/",
	} {
		if got := safeRD(in); got != want {
			t.Errorf("safeRD(%q) = %q, want %q", in, got, want)
		}
	}
}

func TestIsNavigation(t *testing.T) {
	if !isNavigation(navRequest(http.MethodGet, "/")) || !isNavigation(navRequest(http.MethodHead, "/")) {
		t.Error("GET/HEAD with text/html is a navigation")
	}
	if isNavigation(navRequest(http.MethodPost, "/")) || isNavigation(fetchRequest(http.MethodGet, "/")) {
		t.Error("POST or non-html accept is not a navigation")
	}
	r := navRequest(http.MethodGet, "/")
	r.Header.Set("Upgrade", "websocket")
	if isNavigation(r) {
		t.Error("Upgrade is not a navigation")
	}
}
