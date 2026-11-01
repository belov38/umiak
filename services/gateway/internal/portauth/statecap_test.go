package portauth

import (
	"net/http"
	"net/http/cookiejar"
	"net/url"
	"slices"
	"strings"
	"testing"
	"time"

	"github.com/belov38/umiak/services/gateway/internal/cpapi"
)

// TestStateCookieFlood: many sso navigations with a long path keep the
// browser's state cookies bounded, so the callback stays reachable.
func TestStateCookieFlood(t *testing.T) {
	h := newHarness(t, nil)
	l := label("quiet-otter-3000")
	rt := ssoRoute(l.Raw)
	jar, err := cookiejar.New(nil)
	if err != nil {
		t.Fatal(err)
	}
	origin := &url.URL{Scheme: "https", Host: l.Raw + "." + testDomain, Path: "/"}
	long := "/" + strings.Repeat("p", 2000)

	var state string
	for range 40 {
		h.now = h.now.Add(time.Second)
		r := navRequest(http.MethodGet, origin.String()+long[1:])
		for _, c := range jar.Cookies(origin) {
			r.AddCookie(c)
		}
		w, res := h.check(r, l, rt)
		if res.AuthResult != ResultRedirect {
			t.Fatalf("navigation: %+v", res)
		}
		loc, err := url.Parse(w.Header().Get("Location"))
		if err != nil {
			t.Fatal(err)
		}
		state = loc.Query().Get("state")
		jar.SetCookies(origin, w.Result().Cookies())
	}

	var states int
	r := callbackRequest(l, h.api.IssueCode(l.Raw, cpapi.PortAuthGrant{UserID: "usr_1", Email: "a@b.c", AuthEpoch: rt.AuthEpoch}), state, nil)
	for _, c := range jar.Cookies(origin) {
		if isStateCookie(c.Name) {
			states++
		}
		r.AddCookie(c)
	}
	if states > maxStateCookies {
		t.Errorf("%d state cookies in the jar, want at most %d", states, maxStateCookies)
	}
	if n := len(r.Header.Get("Cookie")); n > 8<<10 {
		t.Errorf("Cookie header is %d bytes", n)
	}
	w := h.serve(r, l, &rt)
	if w.Code != http.StatusFound || w.Header().Get("Location") != "/" {
		t.Fatalf("callback of the latest login: %d Location %q (%s)", w.Code, w.Header().Get("Location"), w.Body.String())
	}
}

// TestStateCookieEviction: the redirect clears unopenable state cookies
// first, then the ones with the oldest expiry.
func TestStateCookieEviction(t *testing.T) {
	h := newHarness(t, func(c *Config) { c.CrossSite = true })
	l := label("quiet-otter-3000")
	rt := ssoRoute(l.Raw)
	r := navRequest(http.MethodGet, "https://"+l.Raw+"."+testDomain+"/")
	// names[i] expires after i+1 minutes; the cookies are sent newest
	// first, with an unopenable one and one of another label among them.
	var names []string
	for i := range 8 {
		names = append(names, StateCookiePrefix+"_old0000"+string(rune('a'+i)))
	}
	for i := 7; i >= 0; i-- {
		v := h.codec.SealState(State{State: "s", RD: "/", Label: l.Raw, Expiry: h.now.Add(time.Duration(i+1) * time.Minute)})
		r.Header.Add("Cookie", names[i]+"="+v)
		if i == 4 {
			r.Header.Add("Cookie", StateCookiePrefix+"_garbage1=nope")
			r.Header.Add("Cookie", StateCookiePrefix+"_other000="+h.codec.SealState(State{State: "s", RD: "/", Label: "other-1", Expiry: h.now.Add(time.Hour)}))
		}
	}

	w, _ := h.check(r, l, rt)
	var cleared []string
	for _, line := range w.Result().Header.Values("Set-Cookie") {
		name, _, _ := strings.Cut(line, "=")
		if strings.HasPrefix(line, name+"=;") {
			cleared = append(cleared, name)
			assertAttrs(t, line, 0, true)
		}
	}
	// 10 old cookies + 1 new: 3 go, the two that do not open and the
	// oldest valid one.
	want := []string{StateCookiePrefix + "_garbage1", StateCookiePrefix + "_other000", names[0]}
	slices.Sort(want)
	slices.Sort(cleared)
	if !slices.Equal(cleared, want) {
		t.Errorf("cleared %q, want %q", cleared, want)
	}

	// At or under the cap nothing is cleared.
	r = navRequest(http.MethodGet, "https://"+l.Raw+"."+testDomain+"/")
	for _, name := range names[:7] {
		r.Header.Add("Cookie", name+"=x")
	}
	w, _ = h.check(r, l, rt)
	if n := len(w.Result().Header.Values("Set-Cookie")); n != 1 {
		t.Errorf("%d Set-Cookie lines with 7 old state cookies, want only the new one", n)
	}
}

func TestSafeRDCap(t *testing.T) {
	ok := "/" + strings.Repeat("a", 511)
	if got := safeRD(ok); got != ok {
		t.Errorf("a 512-byte rd was dropped")
	}
	if got := safeRD(ok + "a"); got != "/" {
		t.Errorf("a 513-byte rd was kept")
	}
}
