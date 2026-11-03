package edge

import (
	"os"
	"path/filepath"
	"testing"
	"time"

	"github.com/prometheus/client_golang/prometheus"
	"github.com/prometheus/client_golang/prometheus/testutil"

	"github.com/belov38/umiak/services/gateway/internal/devsecrets"
	"github.com/belov38/umiak/services/gateway/internal/obs"
)

func TestCAExpiryReadsPublicCertificateAndRefreshes(t *testing.T) {
	dir := t.TempDir()
	now := time.Now().Truncate(time.Second)
	if _, err := devsecrets.Generate(devsecrets.Options{Dir: dir, Now: func() time.Time { return now }}); err != nil {
		t.Fatal(err)
	}
	// Runtime metrics need the public CA certificate, never the signing key.
	if err := os.Remove(filepath.Join(dir, "ca.key")); err != nil {
		t.Fatal(err)
	}
	m := obs.NewMetrics(prometheus.NewRegistry())
	s, err := NewCAExpirySource(filepath.Join(dir, "ca.pem"), m)
	if err != nil {
		t.Fatal(err)
	}
	want := float64(now.Add(10 * 365 * 24 * time.Hour).Unix())
	if got := testutil.ToFloat64(m.CertExpiry.WithLabelValues("ca")); got != want {
		t.Fatalf("CA expiry %v, want %v", got, want)
	}
	other := t.TempDir()
	later := now.Add(24 * time.Hour)
	if _, err := devsecrets.Generate(devsecrets.Options{Dir: other, Now: func() time.Time { return later }}); err != nil {
		t.Fatal(err)
	}
	b, err := os.ReadFile(filepath.Join(other, "ca.pem"))
	if err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(dir, "ca.pem"), b, 0o644); err != nil {
		t.Fatal(err)
	}
	if err := s.refresh(); err != nil {
		t.Fatal(err)
	}
	want += 24 * 3600
	if got := testutil.ToFloat64(m.CertExpiry.WithLabelValues("ca")); got != want {
		t.Fatalf("refreshed CA expiry %v, want %v", got, want)
	}
	if err := os.WriteFile(filepath.Join(dir, "ca.pem"), []byte("broken"), 0o644); err != nil {
		t.Fatal(err)
	}
	if err := s.refresh(); err == nil {
		t.Fatal("accepted malformed certificate")
	}
	if got := testutil.ToFloat64(m.CertExpiry.WithLabelValues("ca")); got != want {
		t.Fatalf("failed refresh discarded last CA expiry: %v", got)
	}
	if _, err := NewCAExpirySource(filepath.Join(dir, "tunnel.pem"), m); err == nil {
		t.Fatal("accepted leaf as CA certificate")
	}
}
