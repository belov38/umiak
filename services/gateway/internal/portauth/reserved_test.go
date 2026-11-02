package portauth

import (
	"net/http"
	"net/http/httptest"
	"net/url"
	"strconv"
	"strings"
	"testing"
	"time"

	"github.com/belov38/umiak/services/gateway/internal/cpapi"
	"github.com/belov38/umiak/services/gateway/internal/routes"
)

func (h *harness) serve(r *http.Request, l routes.Label, rt *cpapi.Route) *httptest.ResponseRecorder {
	w := httptest.NewRecorder()
	h.auth.ServeReserved(w, r, l, rt, clientIP, "req-1")
	return w
}

// startLogin runs the sso redirect for rd and returns the state value and the
// state cookie.
func (h *harness) startLogin(t *testing.T, l routes.Label, rd string) (string, *http.Cookie) {
	t.Helper()
	rt := ssoRoute(l.Raw)
	w, _ := h.check(navRequest(http.MethodGet, "https://"+l.Raw+"."+testDomain+rd), l, rt)
	loc, err := url.Parse(w.Header().Get("Location"))
	if err != nil {
		t.Fatal(err)
	}
	state := loc.Query().Get("state")
	name := stateName(t, state)
	line := cookieHeader(t, w, name)
	return state, &http.Cookie{Name: name, Value: cookieValue(line)}
}

func stateName(t *testing.T, state string) string {
	t.Helper()
	name, ok := stateCookieName(state)
	if !ok {
		t.Fatalf("state %q too short", state)
	}
	return name
}

func callbackWith(l routes.Label, code, state string, cs ...*http.Cookie) *http.Request {
	r := callbackRequest(l, code, state, nil)
	for _, c := range cs {
		r.AddCookie(c)
	}
	return r
}

func callbackRequest(l routes.Label, code, state string, c *http.Cookie) *http.Request {
	r := navRequest(http.MethodGet, "https://"+l.Raw+"."+testDomain+"/__umiak/auth/callback?code="+url.QueryEscape(code)+"&state="+url.QueryEscape(state))
	if c != nil {
		r.AddCookie(c)
	}
	return r
}

func TestCallback(t *testing.T) {
	l := label("quiet-otter-3000")
	rt := ssoRoute(l.Raw)
	grant := cpapi.PortAuthGrant{UserID: "usr_1", Email: "a@b.c", AuthEpoch: rt.AuthEpoch}

	t.Run("good", func(t *testing.T) {
		h := newHarness(t, nil)
		state, sc := h.startLogin(t, l, "/page?x=1")
		code := h.api.IssueCode(l.Raw, grant)
		w := h.serve(callbackRequest(l, code, state, sc), l, &rt)
		if w.Code != http.StatusFound || w.Header().Get("Location") != "/page?x=1" {
			t.Fatalf("got %d Location %q (%s)", w.Code, w.Header().Get("Location"), w.Body.String())
		}
		if w.Header().Get("Referrer-Policy") != "no-referrer" {
			t.Error("no Referrer-Policy")
		}
		assertNoStore(t, w)
		line := cookieHeader(t, w, AuthCookie)
		assertAttrs(t, line, 12*3600, false)
		s, err := h.codec.OpenSession(cookieValue(line))
		if err != nil {
			t.Fatal(err)
		}
		want := Session{Label: l.Raw, Mode: ModeSSO, Epoch: 5, UserID: "usr_1", Email: "a@b.c", Expiry: h.now.Add(12 * time.Hour)}
		if s != want {
			t.Errorf("session = %+v, want %+v", s, want)
		}
		if n := len(w.Result().Header.Values("Set-Cookie")); n != 2 {
			t.Errorf("%d Set-Cookie lines, want auth + one cleared state", n)
		}
		cleared := cookieHeader(t, w, sc.Name)
		if !strings.HasPrefix(cleared, sc.Name+"=;") {
			t.Errorf("state cookie not cleared: %q", cleared)
		}
		assertAttrs(t, cleared, 0, false)
		if h.authCount("sso", ResultOK) != 1 {
			t.Error("callback success not counted")
		}

		// The new cookie lets the user in.
		r := navRequest(http.MethodGet, "https://x/page")
		r.AddCookie(&http.Cookie{Name: AuthCookie, Value: cookieValue(line)})
		if _, res := h.check(r, l, rt); !res.Proceed || res.Email != "a@b.c" || res.UserID != "usr_1" {
			t.Errorf("check with new cookie: %+v", res)
		}

		// The code is single use.
		w = h.serve(callbackRequest(l, code, state, sc), l, &rt)
		assertDenied(t, w, http.StatusUnauthorized, "auth_required")
	})

	t.Run("parallel logins", func(t *testing.T) {
		h := newHarness(t, nil)
		type tab struct {
			state string
			c     *http.Cookie
			rd    string
		}
		var tabs []tab
		for i := range 25 {
			rd := "/tab/" + strconv.Itoa(i)
			state, c := h.startLogin(t, l, rd)
			tabs = append(tabs, tab{state, c, rd})
		}
		jar := func() []*http.Cookie {
			var cs []*http.Cookie
			for _, tb := range tabs {
				if tb.c != nil {
					cs = append(cs, tb.c)
				}
			}
			return cs
		}
		// Callbacks come back in reverse order; each finds its own cookie
		// among all the others and clears only that one.
		for i := len(tabs) - 1; i >= 0; i-- {
			w := h.serve(callbackWith(l, h.api.IssueCode(l.Raw, grant), tabs[i].state, jar()...), l, &rt)
			if w.Code != http.StatusFound || w.Header().Get("Location") != tabs[i].rd {
				t.Fatalf("tab %d: got %d Location %q", i, w.Code, w.Header().Get("Location"))
			}
			if !strings.HasPrefix(cookieHeader(t, w, tabs[i].c.Name), tabs[i].c.Name+"=;") {
				t.Errorf("tab %d: own state cookie not cleared", i)
			}
			tabs[i].c = nil
		}
	})

	t.Run("swapped state", func(t *testing.T) {
		h := newHarness(t, nil)
		_, sc := h.startLogin(t, l, "/")
		other, _ := h.startLogin(t, l, "/")
		code := h.api.IssueCode(l.Raw, grant)
		// The cookie for other is absent: no auth failure.
		w := h.serve(callbackRequest(l, code, other, sc), l, &rt)
		assertDenied(t, w, http.StatusUnauthorized, "auth_required")
		if h.authCount("sso", ResultMissing) != 1 {
			t.Errorf("missing = %v", h.authCount("sso", ResultMissing))
		}
		// The code was not burned.
		if h.api.Calls("ExchangePortAuthCode") != 0 {
			t.Error("exchange called with a bad state")
		}
	})

	t.Run("no state cookie", func(t *testing.T) {
		h := newHarness(t, nil)
		state, _ := h.startLogin(t, l, "/")
		for range 30 {
			w := h.serve(callbackRequest(l, h.api.IssueCode(l.Raw, grant), state, nil), l, &rt)
			assertDenied(t, w, http.StatusUnauthorized, "auth_required")
		}
		// Short or empty state params name no cookie either.
		for _, st := range []string{"", "short"} {
			w := h.serve(callbackRequest(l, "c", st, nil), l, &rt)
			assertDenied(t, w, http.StatusUnauthorized, "auth_required")
		}
		if h.authCount("sso", ResultMissing) != 32 || h.authCount("sso", ResultInvalid) != 0 {
			t.Errorf("missing = %v, invalid = %v", h.authCount("sso", ResultMissing), h.authCount("sso", ResultInvalid))
		}
		if h.api.Calls("ExchangePortAuthCode") != 0 {
			t.Error("exchange called without a state cookie")
		}
	})

	t.Run("state mismatch under the same name", func(t *testing.T) {
		h := newHarness(t, nil)
		state, sc := h.startLogin(t, l, "/")
		// Same first 8 characters, so the same cookie name, but a different
		// state: the cookie is present and does not match.
		forged := state[:stateKeyLen] + strings.Repeat("A", len(state)-stateKeyLen)
		for range 20 {
			w := h.serve(callbackRequest(l, h.api.IssueCode(l.Raw, grant), forged, sc), l, &rt)
			assertDenied(t, w, http.StatusUnauthorized, "auth_required")
		}
		if h.authCount("sso", ResultInvalid) != 20 || h.api.Calls("ExchangePortAuthCode") != 0 {
			t.Errorf("invalid = %v, exchanges = %d", h.authCount("sso", ResultInvalid), h.api.Calls("ExchangePortAuthCode"))
		}
		w := h.serve(callbackRequest(l, h.api.IssueCode(l.Raw, grant), state, sc), l, &rt)
		assertDenied(t, w, http.StatusTooManyRequests, "rate_limited")
	})

	t.Run("garbage state cookie", func(t *testing.T) {
		h := newHarness(t, nil)
		state, sc := h.startLogin(t, l, "/")
		bad := &http.Cookie{Name: sc.Name, Value: "v1s.a.e30.AAAA"}
		w := h.serve(callbackRequest(l, h.api.IssueCode(l.Raw, grant), state, bad), l, &rt)
		assertDenied(t, w, http.StatusUnauthorized, "auth_required")
		if h.authCount("sso", ResultInvalid) != 1 {
			t.Errorf("invalid = %v", h.authCount("sso", ResultInvalid))
		}
	})

	t.Run("expired state", func(t *testing.T) {
		h := newHarness(t, nil)
		state, sc := h.startLogin(t, l, "/")
		h.now = h.now.Add(11 * time.Minute)
		w := h.serve(callbackRequest(l, h.api.IssueCode(l.Raw, grant), state, sc), l, &rt)
		assertDenied(t, w, http.StatusUnauthorized, "auth_required")
	})

	t.Run("state for other label", func(t *testing.T) {
		h := newHarness(t, nil)
		other := label("quiet-otter-4000")
		state, sc := h.startLogin(t, other, "/")
		w := h.serve(callbackRequest(l, h.api.IssueCode(l.Raw, grant), state, sc), l, &rt)
		assertDenied(t, w, http.StatusUnauthorized, "auth_required")
	})

	t.Run("open redirect", func(t *testing.T) {
		h := newHarness(t, nil)
		// A state cookie forged with rd=//evil.com (as if minted by an
		// older or buggy build) still redirects to "/".
		st := State{State: "s1234567890", RD: "//evil.com", Label: l.Raw, Expiry: h.now.Add(time.Minute)}
		sc := &http.Cookie{Name: stateName(t, st.State), Value: h.codec.SealState(st)}
		w := h.serve(callbackRequest(l, h.api.IssueCode(l.Raw, grant), st.State, sc), l, &rt)
		if w.Code != http.StatusFound || w.Header().Get("Location") != "/" {
			t.Errorf("got %d Location %q", w.Code, w.Header().Get("Location"))
		}

		// A request path of //evil.com is stored as "/".
		r := navRequest(http.MethodGet, "https://x/")
		r.URL.Path = "//evil.com"
		w2, _ := h.check(r, l, rt)
		loc, _ := url.Parse(w2.Header().Get("Location"))
		got, err := h.codec.OpenState(cookieValue(cookieHeader(t, w2, stateName(t, loc.Query().Get("state")))))
		if err != nil || got.RD != "/" {
			t.Errorf("stored rd = %q (%v)", got.RD, err)
		}
	})

	t.Run("code for another label", func(t *testing.T) {
		h := newHarness(t, nil)
		state, sc := h.startLogin(t, l, "/")
		code := h.api.IssueCode("quiet-otter-4000", grant)
		w := h.serve(callbackRequest(l, code, state, sc), l, &rt)
		assertDenied(t, w, http.StatusUnauthorized, "auth_required")
	})

	t.Run("epoch changed", func(t *testing.T) {
		h := newHarness(t, nil)
		state, sc := h.startLogin(t, l, "/")
		g := grant
		g.AuthEpoch = 6
		w := h.serve(callbackRequest(l, h.api.IssueCode(l.Raw, g), state, sc), l, &rt)
		assertDenied(t, w, http.StatusUnauthorized, "auth_required")
	})

	t.Run("route not sso", func(t *testing.T) {
		h := newHarness(t, nil)
		state, sc := h.startLogin(t, l, "/")
		tr := tokenRoute(l.Raw)
		w := h.serve(callbackRequest(l, h.api.IssueCode(l.Raw, grant), state, sc), l, &tr)
		assertDenied(t, w, http.StatusUnauthorized, "auth_required")
		w = h.serve(callbackRequest(l, h.api.IssueCode(l.Raw, grant), state, sc), l, nil)
		assertDenied(t, w, http.StatusUnauthorized, "auth_required")
	})

	t.Run("api down", func(t *testing.T) {
		h := newHarness(t, nil)
		state, sc := h.startLogin(t, l, "/")
		code := h.api.IssueCode(l.Raw, grant)
		h.api.SetDown(true)
		w := h.serve(callbackRequest(l, code, state, sc), l, &rt)
		assertDenied(t, w, http.StatusServiceUnavailable, "route_lookup_unavailable")
		if blocked, _ := h.limits.AuthBlocked(clientIP); blocked {
			t.Error("api outage counted as auth failure")
		}
	})

	t.Run("bad codes count and block", func(t *testing.T) {
		h := newHarness(t, nil)
		state, sc := h.startLogin(t, l, "/")
		for range 20 {
			w := h.serve(callbackRequest(l, "bad", state, sc), l, &rt)
			assertDenied(t, w, http.StatusUnauthorized, "auth_required")
		}
		if h.authCount("sso", ResultInvalid) != 20 {
			t.Errorf("invalid = %v", h.authCount("sso", ResultInvalid))
		}
		w := h.serve(callbackRequest(l, h.api.IssueCode(l.Raw, grant), state, sc), l, &rt)
		assertDenied(t, w, http.StatusTooManyRequests, "rate_limited")
	})
}

func TestLogout(t *testing.T) {
	for _, crossSite := range []bool{false, true} {
		h := newHarness(t, func(c *Config) { c.CrossSite = crossSite })
		l := label("quiet-otter-3000")
		r := navRequest(http.MethodGet, "https://x/__umiak/auth/logout")
		r.Header.Set("Cookie", "app=1; "+AuthCookie+"=x; __Host-umiak_state_aaaaaaaa=1; __Host-umiak_state_bbbbbbbb=2; __Host-umiak_state_aaaaaaaa=3")
		w := h.serve(r, l, nil)
		if w.Code != http.StatusFound || w.Header().Get("Location") != "/" {
			t.Fatalf("got %d Location %q", w.Code, w.Header().Get("Location"))
		}
		assertNoStore(t, w)
		if n := len(w.Result().Header.Values("Set-Cookie")); n != 3 {
			t.Errorf("%d Set-Cookie lines, want 3: %q", n, w.Result().Header.Values("Set-Cookie"))
		}
		for _, name := range []string{AuthCookie, "__Host-umiak_state_aaaaaaaa", "__Host-umiak_state_bbbbbbbb"} {
			line := cookieHeader(t, w, name)
			if !strings.HasPrefix(line, name+"=;") {
				t.Errorf("%s not cleared: %q", name, line)
			}
			assertAttrs(t, line, 0, crossSite)
		}

		// Without cookies, logout still clears the auth cookie.
		w = h.serve(navRequest(http.MethodGet, "https://x/__umiak/auth/logout"), l, nil)
		if got := w.Result().Header.Values("Set-Cookie"); len(got) != 1 || !strings.HasPrefix(got[0], AuthCookie+"=;") {
			t.Errorf("Set-Cookie = %q", got)
		}
	}
}

func TestReservedUnknown(t *testing.T) {
	h := newHarness(t, nil)
	l := label("quiet-otter-3000")
	for _, p := range []string{"/__umiak/", "/__umiak/auth", "/__umiak/auth/callback/", "/__umiak/other"} {
		w := h.serve(fetchRequest(http.MethodGet, "https://x"+p), l, nil)
		assertDenied(t, w, http.StatusNotFound, "route_not_found")
	}
}

func TestStripRequest(t *testing.T) {
	h := http.Header{}
	h.Add("Cookie", `a=1; __Host-umiak_auth=v1.x; b="q v"; __host-UMIAK_STATE=s; __Host-umiak_state_abcdefgh=t; __Host-umiak_statex=u`)
	h.Add("Cookie", `_oauth2_proxy_csrf=z;c=3;__Secure-oauth2_proxy=y; d`)
	h.Set(TokenHeader, "t")
	h.Set("Authorization", "Bearer app")
	u, err := url.Parse("https://x/p?z=1&_token=T&a=%20b&%5Ftoken=U&b=c+d&_token")
	if err != nil {
		t.Fatal(err)
	}
	StripRequest(h, u, []string{"_oauth2_proxy", "__Host-oauth2_proxy", "__Secure-oauth2_proxy"})

	if got := h.Values("Cookie"); len(got) != 1 || got[0] != `a=1; b="q v"; c=3; d` {
		t.Errorf("Cookie = %q", got)
	}
	if h.Get(TokenHeader) != "" || h.Get("Authorization") != "Bearer app" {
		t.Errorf("headers = %v", h)
	}
	if u.RawQuery != "z=1&a=%20b&b=c+d" {
		t.Errorf("RawQuery = %q", u.RawQuery)
	}

	// Only gateway cookies: the header goes away; no token: query untouched.
	h = http.Header{"Cookie": {"__Host-umiak_auth=x"}}
	u, _ = url.Parse("https://x/p?a=%2F&b")
	StripRequest(h, u, nil)
	if _, ok := h["Cookie"]; ok {
		t.Errorf("Cookie = %q, want none", h["Cookie"])
	}
	if u.RawQuery != "a=%2F&b" {
		t.Errorf("RawQuery = %q", u.RawQuery)
	}

	// Nothing to strip: multiple Cookie lines stay as they are.
	h = http.Header{"Cookie": {"a=1;b=2", "c=3"}}
	StripRequest(h, u, []string{""})
	if got := h.Values("Cookie"); len(got) != 2 || got[0] != "a=1;b=2" {
		t.Errorf("Cookie = %q", got)
	}

	// Only _token: the query is emptied.
	u, _ = url.Parse("https://x/p?_token=T")
	StripRequest(http.Header{}, u, nil)
	if u.RawQuery != "" || u.String() != "https://x/p" {
		t.Errorf("RawQuery = %q, URL %s", u.RawQuery, u)
	}
}

func TestPreflight(t *testing.T) {
	r := httptest.NewRequestWithContext(t.Context(), http.MethodOptions, "https://x/api", nil)
	r.Header.Set("Origin", "https://a.example.com")
	r.Header.Set("Access-Control-Request-Method", "POST")
	if !IsPreflight(r) {
		t.Error("preflight not detected")
	}
	r.Header.Del("Access-Control-Request-Method")
	if IsPreflight(r) {
		t.Error("OPTIONS without Access-Control-Request-Method is not a preflight")
	}
	r.Header.Set("Access-Control-Request-Method", "POST")
	r.Header.Del("Origin")
	if IsPreflight(r) {
		t.Error("OPTIONS without Origin is not a preflight")
	}
	g := httptest.NewRequestWithContext(t.Context(), http.MethodGet, "https://x/api", nil)
	g.Header.Set("Origin", "https://a.example.com")
	g.Header.Set("Access-Control-Request-Method", "POST")
	if IsPreflight(g) {
		t.Error("GET is not a preflight")
	}
}
