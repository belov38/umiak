package edge

import (
	"context"
	"crypto/x509"
	"encoding/pem"
	"fmt"
	"log/slog"
	"os"
	"time"

	"github.com/belov38/umiak/services/gateway/internal/obs"
)

// CAExpirySource publishes CA expiry from a public certificate without a signing key.
// Unlike TLS leaf sources it does not install certificates or manage trust roots.
type CAExpirySource struct {
	file    string
	metrics *obs.Metrics
}

// NewCAExpirySource validates a public CA PEM and records its expiry.
func NewCAExpirySource(caFile string, m *obs.Metrics) (*CAExpirySource, error) {
	s := &CAExpirySource{file: caFile, metrics: m}
	if err := s.refresh(); err != nil {
		return nil, err
	}
	return s, nil
}

// Run rereads the CA daily. A read failure preserves the last observed expiry.
func (s *CAExpirySource) Run(ctx context.Context) {
	ticker := time.NewTicker(24 * time.Hour)
	defer ticker.Stop()
	for {
		select {
		case <-ctx.Done():
			return
		case <-ticker.C:
			if err := s.refresh(); err != nil {
				slog.Warn("edge: CA expiry refresh failed", "err", err)
			}
		}
	}
}

func (s *CAExpirySource) refresh() error {
	b, err := os.ReadFile(s.file)
	if err != nil {
		return fmt.Errorf("edge: CA expiry: %w", err)
	}
	block, _ := pem.Decode(b)
	if block == nil || block.Type != "CERTIFICATE" {
		return fmt.Errorf("edge: CA expiry %s: no PEM certificate", s.file)
	}
	cert, err := x509.ParseCertificate(block.Bytes)
	if err != nil {
		return fmt.Errorf("edge: CA expiry %s: %w", s.file, err)
	}
	if !cert.IsCA {
		return fmt.Errorf("edge: CA expiry %s: certificate is not a CA", s.file)
	}
	if s.metrics != nil {
		s.metrics.CertExpiry.WithLabelValues("ca").Set(float64(cert.NotAfter.Unix()))
	}
	return nil
}
