package portauth

import (
	"context"
	"net/http"
	"net/http/httptest"
	"testing"

	"github.com/belov38/umiak/services/gateway/internal/cpapi"
	"github.com/belov38/umiak/services/gateway/internal/routes"
)

type desktopAPI struct {
	used  bool
	epoch int64
}

func (f *desktopAPI) ExchangeDesktopTicket(_ context.Context, ticket, label string) (cpapi.PortAuthGrant, error) {
	if f.used || ticket != "umiakd_secret" {
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
	r := request("GET", "/?_ticket=umiakd_secret")
	w := httptest.NewRecorder()
	result := h.auth.CheckDesktop(w, r, l, rt, clientIP, "rid", api)
	if !result.Proceed || result.SetCookie == nil || !result.SetCookie.Partitioned || result.SetCookie.SameSite != http.SameSiteNoneMode {
		t.Fatalf("ticket grant: %+v", result)
	}
	cookie := result.SetCookie
	w = httptest.NewRecorder()
	if h.auth.CheckDesktop(w, request("GET", "/?_ticket=umiakd_secret"), l, rt, clientIP, "rid", api).Proceed {
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

func TestDesktopWebRTCMediaAndWebSocketRequireCurrentOriginAndEpoch(t *testing.T) {
	h := newHarness(t, nil)
	label := routes.Label{Raw: "quiet-otter-desktop", Slug: "quiet-otter", Kind: routes.KindDesktop}
	rt := cpapi.Route{Access: "token", AuthEpoch: 7}
	api := &desktopAPI{epoch: 7}
	root := "https://" + label.Raw + "." + testDomain
	issue := httptest.NewRequestWithContext(t.Context(), "GET", root+"/?_ticket=umiakd_secret", nil)
	grant := h.auth.CheckDesktop(httptest.NewRecorder(), issue, label, rt, clientIP, "rid", api)
	if grant.SetCookie == nil {
		t.Fatal("no viewer cookie")
	}
	for _, media := range []struct{ method, path, upgrade string }{{"POST", "/api/host/stream/webrtc", ""}, {"PATCH", "/api/host/stream/webrtc/session", ""}, {"DELETE", "/api/host/stream/webrtc/session", ""}, {"GET", "/api/host/stream/web_socket", "websocket"}} {
		for _, current := range []bool{true, false} {
			req := httptest.NewRequestWithContext(t.Context(), media.method, root+media.path, nil)
			req.AddCookie(grant.SetCookie)
			req.Header.Set("Origin", root)
			req.Header.Set("Upgrade", media.upgrade)
			route := rt
			if !current {
				route.AuthEpoch++
			}
			result := h.auth.CheckDesktop(httptest.NewRecorder(), req, label, route, clientIP, "rid", api)
			if result.Proceed != current {
				t.Fatalf("%s %s epoch enforcement", media.method, media.path)
			}
			req.Header.Set("Origin", "https://other.example")
			if h.auth.CheckDesktop(httptest.NewRecorder(), req, label, rt, clientIP, "rid", api).Proceed {
				t.Fatal("foreign Origin reached media endpoint")
			}
		}
	}
}

func TestHTTPDesktopCookieAndExactOrigin(t *testing.T) {
	h := newHarness(t, func(c *Config) { c.PreviewScheme = "http"; c.PreviewPort = 8085; c.CrossSite = true })
	l := routes.Label{Raw: "quiet-otter-desktop", Slug: "quiet-otter", Kind: routes.KindDesktop}
	rt := cpapi.Route{Access: "token", AuthEpoch: 7}
	root := "http://quiet-otter-desktop." + testDomain + ":8085"
	r := httptest.NewRequestWithContext(t.Context(), "GET", root+"/?_ticket=umiakd_secret", nil)
	grant := h.auth.CheckDesktop(httptest.NewRecorder(), r, l, rt, clientIP, "rid", &desktopAPI{epoch: 7})
	if !grant.Proceed || grant.SetCookie == nil {
		t.Fatalf("ticket grant: %+v", grant)
	}
	if grant.SetCookie.Secure || grant.SetCookie.Partitioned || grant.SetCookie.SameSite != http.SameSiteLaxMode {
		t.Fatalf("HTTP desktop cookie cannot require secure transport: %+v", grant.SetCookie)
	}
	for _, origin := range []string{root, "http://quiet-otter-desktop." + testDomain, "http://quiet-otter-desktop." + testDomain + ":8086", "https://quiet-otter-desktop." + testDomain + ":8085", "http://other-desktop." + testDomain + ":8085"} {
		for _, method := range []string{"POST", "GET"} {
			req := httptest.NewRequestWithContext(t.Context(), method, root+"/api/stream", nil)
			req.Header.Set("Origin", origin)
			if method == "GET" {
				req.Header.Set("Upgrade", "websocket")
			}
			req.AddCookie(grant.SetCookie)
			result := h.auth.CheckDesktop(httptest.NewRecorder(), req, l, rt, clientIP, "rid", nil)
			if result.Proceed != (origin == root) {
				t.Fatalf("%s Origin %s proceed=%v", method, origin, result.Proceed)
			}
		}
	}
}
