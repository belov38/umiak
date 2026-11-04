package e2e_test

import (
	"context"
	"encoding/pem"
	"io"
	"net"
	"net/http"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"github.com/prometheus/client_golang/prometheus/testutil"

	"github.com/belov38/umiak/services/gateway/internal/config"
	"github.com/belov38/umiak/services/gateway/internal/testenv"
)

func TestHTTPPreviewsPublicAndToken(t *testing.T) {
	env := testenv.New(t, testenv.Options{})
	caFile := filepath.Join(t.TempDir(), "ca.pem")
	if err := os.WriteFile(caFile, pem.EncodeToMemory(&pem.Block{Type: "CERTIFICATE", Bytes: env.PKI.CA.Raw}), 0o600); err != nil {
		t.Fatal(err)
	}
	front := env.StartInstance(func(c *config.Config) {
		c.AuthMode = "owner"
		c.PreviewScheme = "http"
		c.PreviewPort = 8085
		c.UmiakCertFile, c.UmiakKeyFile = "", ""
		c.TLSCAFile = caFile
	})
	if expiry := testutil.ToFloat64(front.Metrics().CertExpiry.WithLabelValues("ca")); expiry != float64(env.PKI.CA.NotAfter.Unix()) {
		t.Fatalf("CA expiry metric = %v", expiry)
	}
	if conn, err := env.TLSDial(front, testenv.TunnelHost); err != nil {
		t.Fatalf("guest tunnel TLS: %v", err)
	} else {
		_ = conn.Close()
	}
	m := env.NewMachine()
	m.ServeHTTP(3000, http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.Header.Get("X-Forwarded-Proto") != "http" || r.Header.Get("X-Forwarded-Port") != "8085" || !strings.Contains(r.Header.Get("Forwarded"), ";proto=http;") {
			t.Errorf("upstream forwarding headers: %v", r.Header)
		}
		if strings.Contains(r.Header.Get("Cookie"), "umiak_auth") || r.Header.Get("Umiak-Port-Token") != "" || r.URL.Query().Has("_token") {
			t.Error("gateway credentials reached the guest application")
		}
		_, _ = io.WriteString(w, "preview")
	}))
	rt := env.Route(m, 3000, nil)
	tr := &http.Transport{DialContext: func(ctx context.Context, network, _ string) (net.Conn, error) {
		return (&net.Dialer{}).DialContext(ctx, network, front.PlainAddr)
	}}
	t.Cleanup(tr.CloseIdleConnections)
	client := &http.Client{Transport: tr, Jar: env.Jar(), Timeout: 5 * time.Second}
	url := "http://" + testenv.Host(rt.Label) + ":8085/"
	request := func(target string, status int) {
		t.Helper()
		req, _ := http.NewRequestWithContext(t.Context(), http.MethodGet, target, nil)
		req.Header.Set("Accept", "text/html")
		resp, err := client.Do(req)
		if err != nil {
			t.Fatal(err)
		}
		defer func() { _ = resp.Body.Close() }()
		if resp.StatusCode != status {
			t.Fatalf("status = %d, want %d", resp.StatusCode, status)
		}
	}
	request(url, http.StatusOK)
	request("http://"+testenv.TunnelHost+":8085/", http.StatusNotFound)
	rt.Access, rt.TokenHash = "token", tokenHash("preview-secret")
	env.API.SetRoute(rt)
	front.Routes().Flush()
	request(url, http.StatusUnauthorized)
	request(url+"?_token=preview-secret", http.StatusOK)
	request(url, http.StatusOK) // Browser retained the token cookie after the redirect.
	request(url+"?_token=incorrect", http.StatusUnauthorized)
	request(url+"__umiak/auth/logout", http.StatusUnauthorized) // Logout redirects to the now unauthenticated app.
}
