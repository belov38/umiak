package edge

import (
	"net"
	"net/http"
	"strings"
)

// PlainHandler dispatches the requests of the plain listener (spec 5.2,
// behind an ingress) by Host: tunnelHost goes to tunnel, everything else to
// sbx. The Host is compared case-insensitively without its port and a
// trailing dot.
func PlainHandler(sbx, tunnel http.Handler, tunnelHost string) http.Handler {
	tunnelHost = strings.TrimSuffix(strings.ToLower(tunnelHost), ".")
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if tunnelHost != "" && hostOnly(r.Host) == tunnelHost {
			tunnel.ServeHTTP(w, r)
			return
		}
		sbx.ServeHTTP(w, r)
	})
}

// hostOnly lower-cases a Host and strips its port and a trailing dot.
func hostOnly(h string) string {
	if host, _, err := net.SplitHostPort(h); err == nil {
		h = host
	}
	return strings.TrimSuffix(strings.ToLower(h), ".")
}
