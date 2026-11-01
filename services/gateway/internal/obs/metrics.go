// Package obs holds the gateway's Prometheus metrics and JSON access log.
package obs

import "github.com/prometheus/client_golang/prometheus"

// Metrics lists every gateway metric (spec section 12.1). There are no labels
// by sandbox or machine: with thousands of machines that would explode the
// cardinality. Per-sandbox data comes from the access log.
type Metrics struct {
	HTTPRequests         *prometheus.CounterVec   // access, code_class, umiak_error, via
	HTTPDuration         *prometheus.HistogramVec // access, via; time to response headers
	HTTPBytes            *prometheus.CounterVec   // direction
	HTTPActiveStreams    prometheus.Gauge         // WebSocket, SSE, upgrade
	UpstreamDialDuration *prometheus.HistogramVec // via
	UpstreamDialErrors   *prometheus.CounterVec   // reason: refused, timeout, agent_unavailable, moved, peer_error
	RouteLookups         *prometheus.CounterVec   // result: hit, miss, stale, error
	RouteInvalidations   prometheus.Counter
	Auth                 *prometheus.CounterVec // access, result: ok, missing, invalid, redirect
	RateLimited          *prometheus.CounterVec // limit
	PeerStreamsActive    prometheus.Gauge
	SSHConnectionsActive prometheus.Gauge
	SSHSessions          *prometheus.CounterVec // result
	SSHAuth              *prometheus.CounterVec // result
	SSHChannels          *prometheus.CounterVec // type
	TLSHandshakeErrors   *prometheus.CounterVec // sni_kind
	CertExpiry           *prometheus.GaugeVec   // cert: umiak, tunnel
	DrainOpenStreams     *prometheus.GaugeVec   // kind: http, ssh
	DependencyUp         *prometheus.GaugeVec   // dep
	TunnelAdmitLimited   prometheus.Counter
}

// NewMetrics creates the metrics and registers them on reg. It panics when a
// metric is already registered, like prometheus.MustRegister.
func NewMetrics(reg prometheus.Registerer) *Metrics {
	const ns = "umiak_gateway_"
	// Time to response headers: from milliseconds up to the 5 minute limit.
	latency := []float64{.001, .005, .01, .025, .05, .1, .25, .5, 1, 2.5, 5, 10, 30, 60, 120, 300}
	dial := []float64{.001, .005, .01, .025, .05, .1, .25, .5, 1, 2.5, 5, 10}

	m := &Metrics{
		HTTPRequests: prometheus.NewCounterVec(prometheus.CounterOpts{
			Name: ns + "http_requests_total", Help: "HTTP requests handled by the gateway.",
		}, []string{"access", "code_class", "umiak_error", "via"}),
		HTTPDuration: prometheus.NewHistogramVec(prometheus.HistogramOpts{
			Name: ns + "http_request_duration_seconds", Help: "Time until the response headers.", Buckets: latency,
		}, []string{"access", "via"}),
		HTTPBytes: prometheus.NewCounterVec(prometheus.CounterOpts{
			Name: ns + "http_bytes_total", Help: "Proxied body bytes.",
		}, []string{"direction"}),
		HTTPActiveStreams: prometheus.NewGauge(prometheus.GaugeOpts{
			Name: ns + "http_active_streams", Help: "Open WebSocket, SSE and upgraded streams.",
		}),
		UpstreamDialDuration: prometheus.NewHistogramVec(prometheus.HistogramOpts{
			Name: ns + "upstream_dial_duration_seconds", Help: "Time to open a stream to the application.", Buckets: dial,
		}, []string{"via"}),
		UpstreamDialErrors: prometheus.NewCounterVec(prometheus.CounterOpts{
			Name: ns + "upstream_dial_errors_total", Help: "Failed dials to the application.",
		}, []string{"reason"}),
		RouteLookups: prometheus.NewCounterVec(prometheus.CounterOpts{
			Name: ns + "route_lookups_total", Help: "Route lookups by result.",
		}, []string{"result"}),
		RouteInvalidations: prometheus.NewCounter(prometheus.CounterOpts{
			Name: ns + "route_invalidations_total", Help: "Route cache invalidations.",
		}),
		Auth: prometheus.NewCounterVec(prometheus.CounterOpts{
			Name: ns + "auth_total", Help: "Access checks by mode and result.",
		}, []string{"access", "result"}),
		RateLimited: prometheus.NewCounterVec(prometheus.CounterOpts{
			Name: ns + "ratelimited_total", Help: "Requests refused by a rate limit.",
		}, []string{"limit"}),
		PeerStreamsActive: prometheus.NewGauge(prometheus.GaugeOpts{
			Name: ns + "peer_streams_active", Help: "Streams currently served for peer gateways.",
		}),
		SSHConnectionsActive: prometheus.NewGauge(prometheus.GaugeOpts{
			Name: ns + "ssh_connections_active", Help: "Open SSH connections.",
		}),
		SSHSessions: prometheus.NewCounterVec(prometheus.CounterOpts{
			Name: ns + "ssh_sessions_total", Help: "SSH sessions by result.",
		}, []string{"result"}),
		SSHAuth: prometheus.NewCounterVec(prometheus.CounterOpts{
			Name: ns + "ssh_auth_total", Help: "SSH authentication attempts by result.",
		}, []string{"result"}),
		SSHChannels: prometheus.NewCounterVec(prometheus.CounterOpts{
			Name: ns + "ssh_channels_total", Help: "SSH channels opened by type.",
		}, []string{"type"}),
		TLSHandshakeErrors: prometheus.NewCounterVec(prometheus.CounterOpts{
			Name: ns + "tls_handshake_errors_total", Help: "Failed TLS handshakes by SNI kind.",
		}, []string{"sni_kind"}),
		CertExpiry: prometheus.NewGaugeVec(prometheus.GaugeOpts{
			Name: ns + "cert_expiry_timestamp_seconds", Help: "Certificate expiry as a Unix timestamp.",
		}, []string{"cert"}),
		DrainOpenStreams: prometheus.NewGaugeVec(prometheus.GaugeOpts{
			Name: ns + "drain_open_streams", Help: "Streams still open while draining.",
		}, []string{"kind"}),
		DependencyUp: prometheus.NewGaugeVec(prometheus.GaugeOpts{
			Name: ns + "dependency_up", Help: "1 when a dependency (postgres LISTEN, api) is healthy.",
		}, []string{"dep"}),
		TunnelAdmitLimited: prometheus.NewCounter(prometheus.CounterOpts{
			Name: ns + "tunnel_admit_limited_total", Help: "Tunnel connections refused by the admission limiter.",
		}),
	}

	reg.MustRegister(
		m.HTTPRequests, m.HTTPDuration, m.HTTPBytes, m.HTTPActiveStreams,
		m.UpstreamDialDuration, m.UpstreamDialErrors, m.RouteLookups, m.RouteInvalidations,
		m.Auth, m.RateLimited, m.PeerStreamsActive, m.SSHConnectionsActive,
		m.SSHSessions, m.SSHAuth, m.SSHChannels, m.TLSHandshakeErrors,
		m.CertExpiry, m.DrainOpenStreams, m.DependencyUp, m.TunnelAdmitLimited,
	)
	return m
}
