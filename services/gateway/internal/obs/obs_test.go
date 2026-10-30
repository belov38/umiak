package obs

import (
	"bytes"
	"encoding/json"
	"sort"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/prometheus/client_golang/prometheus"
)

func TestMetricsNames(t *testing.T) {
	reg := prometheus.NewRegistry()
	m := NewMetrics(reg)

	// Vector metrics appear in Gather only after a child exists.
	m.HTTPRequests.WithLabelValues("public", "2xx", "", "local").Inc()
	m.HTTPDuration.WithLabelValues("public", "local").Observe(0.01)
	m.HTTPBytes.WithLabelValues("in").Add(1)
	m.HTTPActiveStreams.Inc()
	m.UpstreamDialDuration.WithLabelValues("local").Observe(0.01)
	m.UpstreamDialErrors.WithLabelValues("refused").Inc()
	m.RouteLookups.WithLabelValues("hit").Inc()
	m.RouteInvalidations.Inc()
	m.Auth.WithLabelValues("token", "ok").Inc()
	m.RateLimited.WithLabelValues("ip").Inc()
	m.PeerStreamsActive.Inc()
	m.SSHConnectionsActive.Inc()
	m.SSHSessions.WithLabelValues("ok").Inc()
	m.SSHAuth.WithLabelValues("ok").Inc()
	m.SSHChannels.WithLabelValues("session").Inc()
	m.TLSHandshakeErrors.WithLabelValues("sbx").Inc()
	m.CertExpiry.WithLabelValues("sbx").Set(1)
	m.DrainOpenStreams.WithLabelValues("http").Set(1)
	m.DependencyUp.WithLabelValues("postgres").Set(1)
	m.TunnelAdmitLimited.Inc()

	mfs, err := reg.Gather()
	if err != nil {
		t.Fatal(err)
	}
	got := map[string][]string{}
	for _, mf := range mfs {
		var labels []string
		if len(mf.Metric) > 0 {
			for _, l := range mf.Metric[0].Label {
				labels = append(labels, l.GetName())
			}
		}
		sort.Strings(labels)
		got[mf.GetName()] = labels
	}

	want := map[string]string{
		"sbx_gateway_http_requests_total":            "access,code_class,sbx_error,via",
		"sbx_gateway_http_request_duration_seconds":  "access,via",
		"sbx_gateway_http_bytes_total":               "direction",
		"sbx_gateway_http_active_streams":            "",
		"sbx_gateway_upstream_dial_duration_seconds": "via",
		"sbx_gateway_upstream_dial_errors_total":     "reason",
		"sbx_gateway_route_lookups_total":            "result",
		"sbx_gateway_route_invalidations_total":      "",
		"sbx_gateway_auth_total":                     "access,result",
		"sbx_gateway_ratelimited_total":              "limit",
		"sbx_gateway_peer_streams_active":            "",
		"sbx_gateway_ssh_connections_active":         "",
		"sbx_gateway_ssh_sessions_total":             "result",
		"sbx_gateway_ssh_auth_total":                 "result",
		"sbx_gateway_ssh_channels_total":             "type",
		"sbx_gateway_tls_handshake_errors_total":     "sni_kind",
		"sbx_gateway_cert_expiry_timestamp_seconds":  "cert",
		"sbx_gateway_drain_open_streams":             "kind",
		"sbx_gateway_dependency_up":                  "dep",
		"sbx_gateway_tunnel_admit_limited_total":     "",
	}
	for name, labels := range want {
		g, ok := got[name]
		if !ok {
			t.Errorf("metric %s missing", name)
			continue
		}
		if strings.Join(g, ",") != labels {
			t.Errorf("metric %s labels = %v, want %q", name, g, labels)
		}
	}
	if len(got) != len(want) {
		t.Errorf("gathered %d metrics, want %d", len(got), len(want))
	}
}

func TestMetricsRegisterTwiceOnSameRegistryPanics(t *testing.T) {
	reg := prometheus.NewRegistry()
	NewMetrics(reg)
	defer func() {
		if recover() == nil {
			t.Error("expected panic on duplicate registration")
		}
	}()
	NewMetrics(reg)
}

func TestAccessLogFields(t *testing.T) {
	var buf bytes.Buffer
	l := NewAccessLog(&buf)
	l.HTTP(HTTPEntry{
		Time:          time.Date(2026, 10, 29, 1, 2, 3, 0, time.UTC),
		RequestID:     "01HX",
		ClientIP:      "203.0.113.5",
		Host:          "my-app-3000.sbx.example.com",
		Label:         "my-app-3000",
		SandboxID:     "sbx_1",
		MachineID:     "m_1",
		Port:          3000,
		Method:        "GET",
		Path:          "/index.html?_token=secret&x=1",
		Status:        200,
		SbxError:      "",
		BytesIn:       10,
		BytesOut:      20,
		DurationMs:    5,
		TTFBMs:        3,
		Access:        "token",
		AuthResult:    "ok",
		UserID:        "usr_1",
		Upgrade:       "websocket",
		Via:           "peer",
		OwnerInstance: "gw-2",
		UserAgent:     "curl/8",
	})

	line := buf.String()
	if !strings.HasSuffix(line, "\n") || strings.Count(line, "\n") != 1 {
		t.Fatalf("want exactly one line, got %q", line)
	}
	if strings.Contains(line, "secret") || strings.Contains(line, "_token") {
		t.Errorf("query leaked into log: %s", line)
	}
	var got map[string]any
	if err := json.Unmarshal([]byte(line), &got); err != nil {
		t.Fatal(err)
	}
	want := []string{
		"time", "requestId", "clientIp", "host", "label", "sandboxId", "machineId", "port",
		"method", "path", "status", "sbxError", "bytesIn", "bytesOut", "durationMs", "ttfbMs",
		"access", "authResult", "userId", "upgrade", "via", "ownerInstance", "userAgent",
	}
	var keys []string
	for k := range got {
		keys = append(keys, k)
	}
	sort.Strings(keys)
	sort.Strings(want)
	if strings.Join(keys, ",") != strings.Join(want, ",") {
		t.Errorf("keys = %v\nwant   %v", keys, want)
	}
	if got["path"] != "/index.html" {
		t.Errorf("path = %v", got["path"])
	}
	if got["time"] != "2026-10-29T01:02:03Z" {
		t.Errorf("time = %v", got["time"])
	}
	if got["status"] != float64(200) || got["port"] != float64(3000) || got["via"] != "peer" {
		t.Errorf("values wrong: %v", got)
	}
}

func TestAccessLogPathFragmentAndEmpty(t *testing.T) {
	var buf bytes.Buffer
	l := NewAccessLog(&buf)
	l.HTTP(HTTPEntry{Path: "/a#frag"})
	l.HTTP(HTTPEntry{Path: "?only=query"})
	lines := strings.Split(strings.TrimSpace(buf.String()), "\n")
	var e1, e2 map[string]any
	_ = json.Unmarshal([]byte(lines[0]), &e1)
	_ = json.Unmarshal([]byte(lines[1]), &e2)
	if e1["path"] != "/a" || e2["path"] != "" {
		t.Errorf("paths = %q %q", e1["path"], e2["path"])
	}
	if e1["time"] == "" || e1["time"] == nil {
		t.Error("zero Time should default to now")
	}
}

func TestAccessLogSSH(t *testing.T) {
	var buf bytes.Buffer
	l := NewAccessLog(&buf)
	l.SSH(SSHEntry{
		SessionID:      "s1",
		ClientIP:       "198.51.100.1",
		ActorKind:      "user",
		UserID:         "usr_1",
		Fingerprint:    "SHA256:abc",
		SandboxID:      "sbx_1",
		Start:          time.Date(2026, 10, 29, 1, 0, 0, 0, time.UTC),
		End:            time.Date(2026, 10, 29, 1, 5, 0, 0, time.UTC),
		BytesIn:        1,
		BytesOut:       2,
		Channels:       map[string]int{"session": 2, "direct-tcpip": 1},
		BackendHostKey: "SHA256:vm",
		CloseReason:    "client_closed",
	})
	var got map[string]any
	if err := json.Unmarshal(buf.Bytes(), &got); err != nil {
		t.Fatal(err)
	}
	for _, k := range []string{"sessionId", "clientIp", "actorKind", "userId", "fingerprint", "sandboxId", "start", "end", "bytesIn", "bytesOut", "backendHostKey", "channels", "closeReason"} {
		if _, ok := got[k]; !ok {
			t.Errorf("key %s missing in %v", k, got)
		}
	}
	for _, k := range []string{"apiKeyId", "certSerial"} {
		if _, ok := got[k]; ok {
			t.Errorf("key %s should be omitted when unset", k)
		}
	}
	if ch, _ := got["channels"].(map[string]any); len(ch) != 2 || ch["session"] != float64(2) {
		t.Errorf("channels = %v", got["channels"])
	}

	buf.Reset()
	l.SSH(SSHEntry{SessionID: "s2", ActorKind: "api_key", APIKeyID: "key_1", CertSerial: 7})
	got = nil
	if err := json.Unmarshal(buf.Bytes(), &got); err != nil {
		t.Fatal(err)
	}
	if got["apiKeyId"] != "key_1" || got["certSerial"] != float64(7) {
		t.Errorf("got %v", got)
	}
	if ch, ok := got["channels"].(map[string]any); !ok || len(ch) != 0 {
		t.Errorf("nil channels should encode as {}, got %v", got["channels"])
	}
}

func TestAccessLogConcurrent(t *testing.T) {
	var buf bytes.Buffer
	l := NewAccessLog(&buf)
	var wg sync.WaitGroup
	for i := range 50 {
		wg.Add(1)
		go func() {
			defer wg.Done()
			l.HTTP(HTTPEntry{Method: "GET", Path: "/x", Status: 200 + i})
		}()
	}
	wg.Wait()
	lines := strings.Split(strings.TrimSpace(buf.String()), "\n")
	if len(lines) != 50 {
		t.Fatalf("lines = %d", len(lines))
	}
	for _, ln := range lines {
		var m map[string]any
		if err := json.Unmarshal([]byte(ln), &m); err != nil {
			t.Fatalf("corrupt line %q: %v", ln, err)
		}
	}
}
