package httpproxy

import (
	"net/http"
	"net/url"

	"github.com/belov38/boat-dev-clone/services/gateway/internal/sbxerr"
)

// desktopOpen replaces the upstream host picker with one sandbox's desktop.
func (h *handler) desktopOpen(x *exchange) bool {
	if x.r.Method != http.MethodGet || x.r.URL.Path != "/" {
		return false
	}
	opened, err := h.cfg.DesktopAPI.OpenDesktop(x.r.Context(), x.label.Raw)
	if err != nil {
		x.fail(sbxerr.Error{Status: http.StatusServiceUnavailable, Code: "desktop_starting", Retryable: true, RetryAfter: 5, Refresh: true})
		return true
	}
	q := url.Values{"hostId": {opened.HostID}, "appId": {opened.AppID}}
	source := x.r.URL.Query()
	for _, key := range []string{"fps", "bitrate", "dataTransport", "language"} {
		if v := source.Get(key); v != "" {
			q.Set(key, v)
		}
	}
	x.w.Header().Set("Cache-Control", "no-store")
	x.w.Header().Set("Referrer-Policy", "no-referrer")
	http.Redirect(x.w, x.r, "/stream.html?"+q.Encode(), http.StatusFound)
	return true
}
