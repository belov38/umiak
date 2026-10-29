// Package edge is the public edge of the gateway (spec 5): the TLS listener
// that picks the certificate and the destination by SNI, PROXY protocol v2,
// reloadable certificates, the tunnel upgrade endpoint, the HTTP servers of
// both destinations and the plain mode behind an ingress.
package edge

import (
	"bytes"
	"context"
	"crypto/tls"
	"crypto/x509"
	"errors"
	"fmt"
	"log/slog"
	"os"
	"path/filepath"
	"sync/atomic"
	"time"

	"github.com/fsnotify/fsnotify"

	"github.com/belov38/boat-dev-clone/services/gateway/internal/obs"
)

const (
	// certPollInterval is the mtime check of the certificate files.
	certPollInterval = 30 * time.Second
	// certDebounce coalesces the burst of fsnotify events of one update
	// (a Secret swap, or a cert and a key written one after the other).
	certDebounce = 100 * time.Millisecond
)

// CertSource is a certificate and key pair loaded from files and reloaded
// when they change. A failed reload keeps the previous certificate.
type CertSource struct {
	name, certFile, keyFile string
	m                       *obs.Metrics
	log                     *slog.Logger
	pollEvery               time.Duration

	cur  atomic.Pointer[tls.Certificate]
	stat fileStamp // of the last load attempt; owned by Run after construction
}

// NewCertSource loads the pair; a missing or invalid pair is an error. name
// is the label of sbx_gateway_cert_expiry_timestamp_seconds (sbx, tunnel).
func NewCertSource(name, certFile, keyFile string, m *obs.Metrics) (*CertSource, error) {
	c := &CertSource{
		name: name, certFile: certFile, keyFile: keyFile, m: m,
		log: slog.Default(), pollEvery: certPollInterval,
	}
	c.stat = c.stamp()
	if err := c.load(); err != nil {
		return nil, err
	}
	return c, nil
}

// SetLogger sets the logger of reload messages; call before Run.
func (c *CertSource) SetLogger(l *slog.Logger) {
	if l != nil {
		c.log = l
	}
}

// Get returns the current certificate.
func (c *CertSource) Get() *tls.Certificate { return c.cur.Load() }

// Loaded reports whether a certificate is loaded.
func (c *CertSource) Loaded() bool { return c.cur.Load() != nil }

// Run reloads the pair until ctx is done: on any fsnotify event in the
// directories of the files (Kubernetes swaps a "..data" symlink there) and
// when the mtime poll sees a change.
func (c *CertSource) Run(ctx context.Context) {
	var events <-chan fsnotify.Event
	var errs <-chan error
	w, err := fsnotify.NewWatcher()
	if err != nil {
		c.log.Warn("edge: fsnotify unavailable, polling only", "cert", c.name, "err", err)
	} else {
		defer func() { _ = w.Close() }()
		for _, dir := range uniqueDirs(c.certFile, c.keyFile) {
			if err := w.Add(dir); err != nil {
				c.log.Warn("edge: cannot watch certificate directory, polling only", "cert", c.name, "dir", dir, "err", err)
			}
		}
		events, errs = w.Events, w.Errors
	}

	poll := time.NewTicker(c.pollEvery)
	defer poll.Stop()
	debounce := time.NewTimer(time.Hour)
	debounce.Stop()
	defer debounce.Stop()
	for {
		select {
		case <-ctx.Done():
			return
		case <-events:
			debounce.Reset(certDebounce)
		case err := <-errs:
			c.log.Warn("edge: fsnotify error", "cert", c.name, "err", err)
		case <-debounce.C:
			c.stat = c.stamp()
			c.reload()
		case <-poll.C:
			if s := c.stamp(); s != c.stat {
				c.stat = s
				c.reload()
			}
		}
	}
}

func (c *CertSource) reload() {
	old := c.cur.Load()
	if err := c.load(); err != nil {
		c.log.Error("edge: certificate reload failed, keeping the old one", "cert", c.name, "err", err)
		return
	}
	if cur := c.cur.Load(); old == nil || !bytes.Equal(old.Certificate[0], cur.Certificate[0]) {
		c.log.Info("edge: certificate reloaded", "cert", c.name, "not_after", cur.Leaf.NotAfter)
	}
}

func (c *CertSource) load() error {
	certPEM, err := os.ReadFile(c.certFile)
	if err != nil {
		return fmt.Errorf("edge: %s certificate: %w", c.name, err)
	}
	keyPEM, err := os.ReadFile(c.keyFile)
	if err != nil {
		return fmt.Errorf("edge: %s key: %w", c.name, err)
	}
	cert, err := tls.X509KeyPair(certPEM, keyPEM)
	if err != nil {
		return fmt.Errorf("edge: %s pair %s, %s: %w", c.name, c.certFile, c.keyFile, err)
	}
	if cert.Leaf == nil {
		if cert.Leaf, err = x509.ParseCertificate(cert.Certificate[0]); err != nil {
			return fmt.Errorf("edge: %s certificate: %w", c.name, err)
		}
	}
	c.cur.Store(&cert)
	if c.m != nil {
		c.m.CertExpiry.WithLabelValues(c.name).Set(float64(cert.Leaf.NotAfter.Unix()))
	}
	return nil
}

// fileStamp identifies the content of both files for the poll.
type fileStamp struct {
	certMod, keyMod   time.Time
	certSize, keySize int64
	err               bool
}

// stamp stats through symlinks, so a swapped "..data" target shows up.
func (c *CertSource) stamp() fileStamp {
	var s fileStamp
	ci, err1 := os.Stat(c.certFile)
	ki, err2 := os.Stat(c.keyFile)
	if err := errors.Join(err1, err2); err != nil {
		s.err = true
		return s
	}
	s.certMod, s.certSize = ci.ModTime(), ci.Size()
	s.keyMod, s.keySize = ki.ModTime(), ki.Size()
	return s
}

func uniqueDirs(files ...string) []string {
	var out []string
	seen := map[string]bool{}
	for _, f := range files {
		d := filepath.Dir(f)
		if !seen[d] {
			seen[d] = true
			out = append(out, d)
		}
	}
	return out
}
