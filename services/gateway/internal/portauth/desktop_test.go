package portauth

import (
	"context"
	"net/http"
	"net/http/httptest"
	"testing"

	"github.com/belov38/boat-dev-clone/services/gateway/internal/cpapi"
	"github.com/belov38/boat-dev-clone/services/gateway/internal/routes"
)

type desktopAPI struct {
	used  bool
	epoch int64
}

func (f *desktopAPI) ExchangeDesktopTicket(_ context.Context, ticket, label string) (cpapi.PortAuthGrant, error) {
	if f.used || ticket != "sbxd_secret" {
		return cpapi.PortAuthGrant{}, cpapi.ErrInvalidCode
	}
	f.used = true
	return cpapi.PortAuthGrant{Label: label, UserID: "user-a", AuthEpoch: f.epoch}, nil
}
func (*desktopAPI) OpenDesktop(context.Context, string) (cpapi.DesktopOpen, error) {
	return cpapi.DesktopOpen{HostID: "host", AppID: "desktop"}, nil
}
func TestDesktopTicketCookieReplayEpochAndOrigin(t *testing.T) {
	h := newHarness(t, nil)
	api := &desktopAPI{epoch: 7}
	l := routes.Label{Raw: "quiet-otter-desktop", Slug: "quiet-otter", Kind: routes.KindDesktop}
	rt := cpapi.Route{Access: "token", AuthEpoch: 7}
	request := func(method, path string) *http.Request {
		return httptest.NewRequestWithContext(t.Context(), method, "https://quiet-otter-desktop."+testDomain+path, nil)
	}
	r := request("GET", "/?_ticket=sbxd_secret")
	w := httptest.NewRecorder()
	result := h.auth.CheckDesktop(w, r, l, rt, clientIP, "rid", api)
	if !result.Proceed || result.SetCookie == nil || !result.SetCookie.Partitioned || result.SetCookie.SameSite != http.SameSiteNoneMode {
		t.Fatalf("ticket grant: %+v", result)
	}
	cookie := result.SetCookie
	w = httptest.NewRecorder()
	if h.auth.CheckDesktop(w, request("GET", "/?_ticket=sbxd_secret"), l, rt, clientIP, "rid", api).Proceed {
		t.Fatal("ticket replay accepted")
	}
	r = request("GET", "/stream.html")
	r.AddCookie(cookie)
	if !h.auth.CheckDesktop(httptest.NewRecorder(), r, l, rt, clientIP, "rid", api).Proceed {
		t.Fatal("cookie rejected")
	}
	rt.AuthEpoch++
	if h.auth.CheckDesktop(httptest.NewRecorder(), r, l, rt, clientIP, "rid", api).Proceed {
		t.Fatal("old epoch accepted")
	}
	rt.AuthEpoch--
	r = request("POST", "/api/input")
	r.AddCookie(cookie)
	if h.auth.CheckDesktop(httptest.NewRecorder(), r, l, rt, clientIP, "rid", api).Proceed {
		t.Fatal("missing Origin accepted")
	}
	r.Header.Set("Origin", "https://quiet-otter-desktop."+testDomain)
	if !h.auth.CheckDesktop(httptest.NewRecorder(), r, l, rt, clientIP, "rid", api).Proceed {
		t.Fatal("same Origin rejected")
	}
	r = request("OPTIONS", "/api/stream")
	r.Header.Set("Origin", "https://quiet-otter-desktop."+testDomain)
	if h.auth.CheckDesktop(httptest.NewRecorder(), r, l, rt, clientIP, "rid", api).Proceed {
		t.Fatal("unauthenticated preflight accepted")
	}
}
