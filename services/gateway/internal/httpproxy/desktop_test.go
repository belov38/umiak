package httpproxy

import (
	"context"
	"net/http/httptest"
	"net/http/httputil"
	"net/url"
	"strings"
	"testing"

	"github.com/belov38/boat-dev-clone/services/gateway/internal/cpapi"
	"github.com/belov38/boat-dev-clone/services/gateway/internal/portauth"
	"github.com/belov38/boat-dev-clone/services/gateway/internal/routes"
)

type fakeDesktopAPI struct{}

func (fakeDesktopAPI) ExchangeDesktopTicket(context.Context, string, string) (cpapi.PortAuthGrant, error) {
	return cpapi.PortAuthGrant{}, cpapi.ErrInvalidCode
}
func (fakeDesktopAPI) OpenDesktop(context.Context, string) (cpapi.DesktopOpen, error) {
	return cpapi.DesktopOpen{HostID: "only-host", AppID: "only-app"}, nil
}
func TestDesktopOpenWhitelistsViewerParameters(t *testing.T) {
	r := httptest.NewRequestWithContext(t.Context(), "GET", "https://a-desktop.sbx.test/?_ticket=secret&hostId=evil&fps=30&dataTransport=websocket&redirect=https://evil.test", nil)
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
	r := httptest.NewRequestWithContext(t.Context(), "GET", "https://a-desktop.sbx.test/", nil)
	w := httptest.NewRecorder()
	h := &handler{}
	x := &exchange{r: r, w: &recorder{rw: w}, label: routes.Label{Raw: "a-desktop"}}
	if !h.desktopOpen(x) || w.Code != 503 {
		t.Fatalf("desktop without backend: %d", w.Code)
	}
}
func TestDesktopRewriteStripsSpoofedIdentityAndSecrets(t *testing.T) {
	r := httptest.NewRequestWithContext(t.Context(), "GET", "https://a-desktop.sbx.test/api?_ticket=secret&x=1", nil)
	r.Header.Set("X_Sbx_Desktop_User", "attacker")
	r.Header.Set("Cookie", "__Host-sbx_auth=secret; app=kept")
	h := &handler{}
	x := &exchange{r: r, rid: "rid"}
	pr := &httputil.ProxyRequest{In: r, Out: r.Clone(t.Context())}
	rt := cpapi.Route{Kind: cpapi.KindDesktop, Port: 47800, HostRewrite: "localhost"}
	h.rewrite(x, pr, rt, portauth.Result{}, "target", nil)
	if pr.Out.Header.Get("X-Sbx-Desktop-User") != "sbx" || pr.Out.Header.Get("X_Sbx_Desktop_User") != "" || strings.Contains(pr.Out.URL.RawQuery, "ticket") || strings.Contains(pr.Out.Header.Get("Cookie"), "secret") || pr.Out.Host != "localhost:47800" {
		t.Fatalf("unsafe forwarded request: %v %v", pr.Out, pr.Out.Header)
	}
}
