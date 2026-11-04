package httpproxy

import (
	"context"
	"net/http"
	"net/http/httptest"
	"net/http/httputil"
	"net/url"
	"strings"
	"testing"

	"github.com/belov38/umiak/services/gateway/internal/cpapi"
	"github.com/belov38/umiak/services/gateway/internal/portauth"
	"github.com/belov38/umiak/services/gateway/internal/routes"
)

type fakeDesktopAPI struct{}

func (fakeDesktopAPI) ExchangeDesktopTicket(context.Context, string, string) (cpapi.PortAuthGrant, error) {
	return cpapi.PortAuthGrant{}, cpapi.ErrInvalidCode
}
func (fakeDesktopAPI) OpenDesktop(context.Context, string) (cpapi.DesktopOpen, error) {
	return cpapi.DesktopOpen{HostID: "only-host", AppID: "only-app"}, nil
}
func TestDesktopOpenWhitelistsViewerParameters(t *testing.T) {
	r := httptest.NewRequestWithContext(t.Context(), "GET", "https://a-desktop.umiak.test/?_ticket=secret&hostId=evil&fps=30&dataTransport=websocket&redirect=https://evil.test", nil)
	w := httptest.NewRecorder()
	h := &handler{cfg: Config{DesktopAPI: fakeDesktopAPI{}}}
	x := &exchange{r: r, w: &recorder{rw: w}, label: routes.Label{Raw: "a-desktop"}}
	if !h.desktopOpen(x) || w.Code != 302 {
		t.Fatalf("open: %d", w.Code)
	}
	location, e := url.Parse(w.Header().Get("Location"))
	if e != nil {
		t.Fatal(e)
	}
	q := location.Query()
	if location.Path != "/stream.html" || q.Get("hostId") != "only-host" || q.Get("fps") != "30" || q.Has("_ticket") || q.Has("redirect") {
		t.Fatalf("unsafe redirect: %v", location)
	}
}

func TestDesktopOpenWithoutControlPlaneFailsClosed(t *testing.T) {
	r := httptest.NewRequestWithContext(t.Context(), "GET", "https://a-desktop.umiak.test/", nil)
	w := httptest.NewRecorder()
	h := &handler{}
	x := &exchange{r: r, w: &recorder{rw: w}, label: routes.Label{Raw: "a-desktop"}}
	if !h.desktopOpen(x) || w.Code != 503 {
		t.Fatalf("desktop without backend: %d", w.Code)
	}
}
func TestDesktopRewriteStripsSpoofedIdentityAndSecrets(t *testing.T) {
	r := httptest.NewRequestWithContext(t.Context(), "GET", "https://a-desktop.umiak.test/api?_ticket=secret&x=1", nil)
	r.Header.Set("X_Umiak_Desktop_User", "attacker")
	r.Header.Set("Cookie", "__Host-umiak_auth=secret; app=kept")
	h := &handler{}
	x := &exchange{r: r, rid: "rid"}
	pr := &httputil.ProxyRequest{In: r, Out: r.Clone(t.Context())}
	rt := cpapi.Route{Kind: cpapi.KindDesktop, Port: 47800, HostRewrite: "localhost"}
	h.rewrite(x, pr, rt, portauth.Result{}, "target", nil)
	if pr.Out.Header.Get("X-Umiak-Desktop-User") != "umiak" || pr.Out.Header.Get("X_Umiak_Desktop_User") != "" || strings.Contains(pr.Out.URL.RawQuery, "ticket") || strings.Contains(pr.Out.Header.Get("Cookie"), "secret") || pr.Out.Host != "localhost:47800" {
		t.Fatalf("unsafe forwarded request: %v %v", pr.Out, pr.Out.Header)
	}
}

func TestDesktopRewriteDropsIngressCredential(t *testing.T) {
	r := httptest.NewRequestWithContext(t.Context(), "GET", "http://a-desktop.umiak.test:8085/stream", nil)
	r.Header.Set("Umiak-Ingress-Desktop", "a-desktop.1.sig")
	r.Header.Set("Authorization", "Bearer owner")
	h := &handler{}
	x := &exchange{r: r, rid: "rid"}
	pr := &httputil.ProxyRequest{In: r, Out: r.Clone(t.Context())}
	rt := cpapi.Route{Kind: cpapi.KindDesktop, Port: 47800, HostRewrite: "localhost"}
	h.rewrite(x, pr, rt, portauth.Result{Ingress: true}, "target", nil)
	hd := pr.Out.Header
	if hd.Get("Umiak-Ingress-Desktop") != "" || hd.Get("Authorization") != "" || hd.Get("X-Umiak-Desktop-User") != "umiak" {
		t.Fatalf("forwarded headers: %v", hd)
	}
}

func TestDesktopUpgradeSecurityHeadersSetOnce(t *testing.T) {
	w := httptest.NewRecorder()
	w.Header().Set("Cache-Control", "no-store")
	w.Header().Set("Referrer-Policy", "no-referrer")
	h := &handler{}
	x := &exchange{w: &recorder{rw: w}, rid: "rid", route: &cpapi.Route{Kind: cpapi.KindDesktop}}
	res := &http.Response{StatusCode: http.StatusSwitchingProtocols, Header: http.Header{"Upgrade": {"websocket"}}}
	if err := h.modifyResponse(x, res, nil); err != nil {
		t.Fatal(err)
	}
	// ReverseProxy copies the 101 fields onto the writer with Add.
	for k, vs := range res.Header {
		for _, v := range vs {
			w.Header().Add(k, v)
		}
	}
	for _, k := range []string{"Cache-Control", "Referrer-Policy"} {
		if got := w.Header().Values(k); len(got) != 1 {
			t.Errorf("%s = %v, want exactly one", k, got)
		}
	}
}
