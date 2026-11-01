package edge

import (
	"net/http"

	"golang.org/x/time/rate"

	"github.com/belov38/umiak/libs/tunnel/transport"
	"github.com/belov38/umiak/libs/tunnel/wire"
	"github.com/belov38/umiak/libs/tunnel/wstransport"
	"github.com/belov38/umiak/services/gateway/internal/obs"
)

// TunnelHandler serves the tunnel endpoint: GET wire.ConnectPath goes to
// the WebSocket upgrade handler of libs/tunnel behind the admission token
// bucket lim (nil: unlimited); over the limit the answer is 503 with
// Retry-After: 1. Anything else is 404. The per-IP cap of open tunnel conns
// is applied by the dispatcher at the handshake (DispatchConfig.
// TunnelConnLimit); the node SNAT address is exempt from it.
func TunnelHandler(adm transport.Admitter, lim *rate.Limiter, m *obs.Metrics) http.Handler {
	ws := wstransport.NewHandler(adm, wstransport.HandlerOptions{})
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.Method != http.MethodGet || r.URL.Path != wire.ConnectPath {
			http.NotFound(w, r)
			return
		}
		if lim != nil && !lim.Allow() {
			if m != nil {
				m.TunnelAdmitLimited.Inc()
			}
			w.Header().Set("Retry-After", "1")
			http.Error(w, "tunnel admission overloaded", http.StatusServiceUnavailable)
			return
		}
		ws.ServeHTTP(w, r)
	})
}
