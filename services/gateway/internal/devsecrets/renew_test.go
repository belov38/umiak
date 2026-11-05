package devsecrets_test

import (
	"bytes"
	"context"
	"crypto/tls"
	"crypto/x509"
	"io"
	"net"
	"os"
	"path/filepath"
	"slices"
	"testing"
	"time"

	"github.com/belov38/umiak/services/gateway/internal/devsecrets"
	"github.com/belov38/umiak/services/gateway/internal/edge"
)

func TestRenewBeforePreservesCAKeysAndOtherSecrets(t *testing.T) {
	now := time.Now().UTC().Truncate(time.Second)
	for _, age := range []time.Duration{24 * time.Hour, 390 * 24 * time.Hour, 400 * 24 * time.Hour} {
		t.Run(age.String(), func(t *testing.T) {
			dir := t.TempDir()
			if _, err := devsecrets.Generate(devsecrets.Options{Dir: dir, Now: func() time.Time { return now.Add(-age) }}); err != nil {
				t.Fatal(err)
			}
			before := snapshot(t, dir)
			written, err := devsecrets.Generate(devsecrets.Options{Dir: dir, RenewBefore: 720 * time.Hour, Now: func() time.Time { return now }})
			if err != nil {
				t.Fatal(err)
			}
			want := []string(nil)
			if age > 365*24*time.Hour {
				want = []string{"tunnel.pem", "umiak.pem"}
			}
			slices.Sort(written)
			if !slices.Equal(written, want) {
				t.Fatalf("wrote %v, want %v", written, want)
			}
			after := snapshot(t, dir)
			for name, old := range before {
				if slices.Contains(want, name) {
					if after[name] == old {
						t.Errorf("%s was not renewed", name)
					}
				} else if after[name] != old {
					t.Errorf("%s changed", name)
				}
			}
			verifyLeaf(t, dir, "umiak", "x.umiak.localhost")
			verifyLeaf(t, dir, "tunnel", "tunnel.localhost")
			if again, err := devsecrets.Generate(devsecrets.Options{Dir: dir, RenewBefore: 720 * time.Hour}); err != nil || len(again) != 0 {
				t.Fatalf("repeated renewal wrote %v: %v", again, err)
			}
		})
	}
}

func TestRenewBeforeHotReloadKeepsAgentTrustAndConnections(t *testing.T) {
	dir := t.TempDir()
	now := time.Now()
	if _, err := devsecrets.Generate(devsecrets.Options{Dir: dir, Now: func() time.Time { return now.Add(-390 * 24 * time.Hour) }}); err != nil {
		t.Fatal(err)
	}
	certFile, keyFile := filepath.Join(dir, "tunnel.pem"), filepath.Join(dir, "tunnel.key")
	source, err := edge.NewCertSource("tunnel", certFile, keyFile, nil)
	if err != nil {
		t.Fatal(err)
	}
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	go source.Run(ctx)
	// Wait for the file watcher to be active before the atomic renewal.
	first := source.Get()
	deadline := time.Now().Add(3 * time.Second)
	for source.Get() == first && time.Now().Before(deadline) {
		now := time.Now()
		if err := os.Chtimes(certFile, now, now); err != nil {
			t.Fatal(err)
		}
		time.Sleep(150 * time.Millisecond)
	}
	if source.Get() == first {
		t.Fatal("certificate watcher did not start")
	}
	oldDER := bytes.Clone(source.Get().Certificate[0])
	listener, err := tls.Listen("tcp", "127.0.0.1:0", &tls.Config{MinVersion: tls.VersionTLS12, GetCertificate: func(*tls.ClientHelloInfo) (*tls.Certificate, error) { return source.Get(), nil }})
	if err != nil {
		t.Fatal(err)
	}
	defer func() { _ = listener.Close() }()
	go func() {
		for {
			conn, err := listener.Accept()
			if err != nil {
				return
			}
			go func(c net.Conn) { defer func() { _ = c.Close() }(); _, _ = io.Copy(c, c) }(conn)
		}
	}()
	ca, err := os.ReadFile(filepath.Join(dir, "ca.pem"))
	if err != nil {
		t.Fatal(err)
	}
	roots := x509.NewCertPool()
	roots.AppendCertsFromPEM(ca)
	dial := func() *tls.Conn {
		t.Helper()
		dialer := &tls.Dialer{Config: &tls.Config{RootCAs: roots, ServerName: "tunnel.localhost", MinVersion: tls.VersionTLS12}}
		conn, err := dialer.DialContext(ctx, "tcp", listener.Addr().String())
		if err != nil {
			t.Fatal(err)
		}
		return conn.(*tls.Conn)
	}
	oldConn := dial()
	defer func() { _ = oldConn.Close() }()
	ping := func(c *tls.Conn) {
		t.Helper()
		_ = c.SetDeadline(time.Now().Add(3 * time.Second))
		if _, err := c.Write([]byte("ok")); err != nil {
			t.Fatal(err)
		}
		b := make([]byte, 2)
		if _, err := io.ReadFull(c, b); err != nil || string(b) != "ok" {
			t.Fatalf("connection ping: %q %v", b, err)
		}
	}
	ping(oldConn)
	if _, err := devsecrets.Generate(devsecrets.Options{Dir: dir, RenewBefore: 720 * time.Hour}); err != nil {
		t.Fatal(err)
	}
	deadline = time.Now().Add(3 * time.Second)
	for bytes.Equal(source.Get().Certificate[0], oldDER) && time.Now().Before(deadline) {
		time.Sleep(10 * time.Millisecond)
	}
	if bytes.Equal(source.Get().Certificate[0], oldDER) {
		t.Fatal("renewed certificate did not hot reload")
	}
	ping(oldConn)
	newConn := dial()
	defer func() { _ = newConn.Close() }()
	ping(newConn)
	if bytes.Equal(newConn.ConnectionState().PeerCertificates[0].Raw, oldDER) {
		t.Fatal("new connection received the old certificate")
	}
}

func TestRenewBeforeUpdatesNamesWithoutChangingKeys(t *testing.T) {
	dir := t.TempDir()
	generate(t, dir)
	before := snapshot(t, dir)
	written, err := devsecrets.Generate(devsecrets.Options{
		Dir: dir, RenewBefore: 720 * time.Hour,
		Domain: "new.umiak.localhost", TunnelHost: "new.tunnel.localhost",
	})
	if err != nil {
		t.Fatal(err)
	}
	slices.Sort(written)
	if !slices.Equal(written, []string{"tunnel.pem", "umiak.pem"}) {
		t.Fatalf("name change wrote %v", written)
	}
	after := snapshot(t, dir)
	for name, old := range before {
		if name != "umiak.pem" && name != "tunnel.pem" && after[name] != old {
			t.Errorf("name change modified %s", name)
		}
	}
	verifyLeaf(t, dir, "umiak", "x.new.umiak.localhost")
	verifyLeaf(t, dir, "tunnel", "new.tunnel.localhost")
	if again, err := devsecrets.Generate(devsecrets.Options{Dir: dir, RenewBefore: 720 * time.Hour, Domain: "new.umiak.localhost", TunnelHost: "new.tunnel.localhost"}); err != nil || len(again) != 0 {
		t.Fatalf("stable names wrote %v: %v", again, err)
	}
}

func TestTunnelChainContainsInstallCA(t *testing.T) {
	dir := t.TempDir()
	if _, err := devsecrets.Generate(devsecrets.Options{Dir: dir}); err != nil {
		t.Fatal(err)
	}
	pair, err := tls.LoadX509KeyPair(filepath.Join(dir, "tunnel.pem"), filepath.Join(dir, "tunnel.key"))
	if err != nil {
		t.Fatal(err)
	}
	if len(pair.Certificate) != 2 {
		t.Fatalf("chain has %d certificates, want leaf and CA", len(pair.Certificate))
	}
	ca, err := x509.ParseCertificate(pair.Certificate[1])
	if err != nil || !ca.IsCA {
		t.Fatal("chain lacks CA", err)
	}
}
