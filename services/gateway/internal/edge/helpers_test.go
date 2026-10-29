package edge_test

import (
	"bufio"
	"bytes"
	"context"
	"crypto/tls"
	"encoding/json"
	"errors"
	"io"
	"net"
	"net/http"
	"path/filepath"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/belov38/boat-dev-clone/libs/tunnel/transport"
	"github.com/belov38/boat-dev-clone/libs/tunnel/tunneltest/pgtest"
	"github.com/belov38/boat-dev-clone/libs/tunnel/wire"
	"github.com/belov38/boat-dev-clone/services/gateway/internal/edge"
	"github.com/belov38/boat-dev-clone/services/gateway/internal/obs"
	"github.com/belov38/boat-dev-clone/services/gateway/internal/testenv"
)

func TestMain(m *testing.M) { pgtest.Main(m) }

const reqTimeout = 30 * time.Second

func newTestPKI(t *testing.T) *testenv.PKI {
	t.Helper()
	p, err := testenv.NewPKI(t.TempDir())
	if err != nil {
		t.Fatal(err)
	}
	return p
}

func certSource(t *testing.T, p *testenv.PKI, dir, name, host string, m *obs.Metrics) *edge.CertSource {
	t.Helper()
	cf, kf := filepath.Join(dir, name+".crt"), filepath.Join(dir, name+".key")
	writePair(t, p.Issue, cf, kf, time.Hour, host)
	cs, err := edge.NewCertSource(name, cf, kf, m)
	if err != nil {
		t.Fatal(err)
	}
	return cs
}

// result is a response with its body read.
type result struct {
	StatusCode int
	Proto      string
	ProtoMajor int
	Header     http.Header
	Body       string
}

func readResult(t *testing.T, resp *http.Response) *result {
	t.Helper()
	defer func() { _ = resp.Body.Close() }()
	return &result{
		StatusCode: resp.StatusCode, Proto: resp.Proto, ProtoMajor: resp.ProtoMajor,
		Header: resp.Header, Body: body(t, resp),
	}
}

func get(t *testing.T, c *http.Client, url string, mod func(*http.Request)) *result {
	t.Helper()
	ctx, cancel := context.WithTimeout(context.Background(), reqTimeout)
	defer cancel()
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, url, nil)
	if err != nil {
		t.Fatal(err)
	}
	if mod != nil {
		mod(req)
	}
	resp, err := c.Do(req)
	if err != nil {
		t.Fatalf("GET %s: %v", url, err)
	}
	defer func() { _ = resp.Body.Close() }()
	return readResult(t, resp)
}

func body(t *testing.T, resp *http.Response) string {
	t.Helper()
	b, err := io.ReadAll(resp.Body)
	if err != nil {
		t.Fatal(err)
	}
	return string(b)
}

// hostApp answers with its name and the Host it saw.
func hostApp(name string) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		_, _ = io.WriteString(w, name+" "+r.Host)
	})
}

// upgrade writes a tunnel upgrade request for hello (nil: no credentials)
// on c and reads the answer.
func upgrade(t *testing.T, c net.Conn, host string, hello *transport.Hello) *result {
	t.Helper()
	_ = c.SetDeadline(time.Now().Add(reqTimeout))
	var b strings.Builder
	b.WriteString("GET " + wire.ConnectPath + " HTTP/1.1\r\nHost: " + host + "\r\n")
	b.WriteString("Upgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Version: 13\r\n")
	b.WriteString("Sec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==\r\nSec-WebSocket-Protocol: " + wire.Subprotocol + "\r\n")
	if hello != nil {
		for k, vs := range hello.Header() {
			for _, v := range vs {
				b.WriteString(k + ": " + v + "\r\n")
			}
		}
	}
	b.WriteString("\r\n")
	if _, err := io.WriteString(c, b.String()); err != nil {
		t.Fatal(err)
	}
	resp, err := http.ReadResponse(bufio.NewReader(c), nil)
	if err != nil {
		t.Fatalf("read upgrade response: %v", err)
	}
	defer func() { _ = resp.Body.Close() }()
	if resp.StatusCode == http.StatusSwitchingProtocols {
		// The body of a 101 is the upgraded stream: do not read it.
		return &result{StatusCode: resp.StatusCode, Proto: resp.Proto, ProtoMajor: resp.ProtoMajor, Header: resp.Header}
	}
	return readResult(t, resp)
}

func bootstrapHello(id string, bs []byte) *transport.Hello {
	return &transport.Hello{
		MachineID: id, BootID: "boot-" + id, AgentInstanceID: "agent-x", Vmgenid: "gen-1",
		AgentVersion: "1.0.0", Scheme: transport.AuthBootstrap, Secret: bs,
	}
}

// recordConn records everything read from the server.
type recordConn struct {
	net.Conn
	mu  sync.Mutex
	buf bytes.Buffer
}

func (c *recordConn) Read(p []byte) (int, error) {
	n, err := c.Conn.Read(p)
	c.mu.Lock()
	c.buf.Write(p[:n])
	c.mu.Unlock()
	return n, err
}

// handshakeAlert runs a TLS handshake with sni (empty: no SNI) and returns
// the alert description the server sent in its first record, or -1.
func handshakeAlert(t *testing.T, addr, sni string) int {
	t.Helper()
	raw, err := (&net.Dialer{Timeout: 5 * time.Second}).DialContext(context.Background(), "tcp", addr)
	if err != nil {
		t.Fatal(err)
	}
	rc := &recordConn{Conn: raw}
	c := tls.Client(rc, &tls.Config{ServerName: sni, InsecureSkipVerify: sni == "", MinVersion: tls.VersionTLS12}) //nolint:gosec // no SNI needs no verification
	defer func() { _ = c.Close() }()
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	if err := c.HandshakeContext(ctx); err == nil {
		t.Fatalf("handshake with SNI %q succeeded", sni)
	}
	rc.mu.Lock()
	defer rc.mu.Unlock()
	b := rc.buf.Bytes()
	// TLS record: type 21 (alert), version, length 2, level, description.
	if len(b) < 7 || b[0] != 21 {
		return -1
	}
	return int(b[6])
}

// dialTLS dials addr with cfg; the caller closes the conn.
func dialTLS(addr string, cfg *tls.Config) (*tls.Conn, error) {
	ctx, cancel := context.WithTimeout(context.Background(), reqTimeout)
	defer cancel()
	c, err := (&tls.Dialer{Config: cfg}).DialContext(ctx, "tcp", addr)
	if err != nil {
		return nil, err
	}
	return c.(*tls.Conn), nil
}

// logLine waits for the access log line with the request id.
func logLine(t *testing.T, inst *testenv.Inst, requestID string) map[string]any {
	t.Helper()
	deadline := time.Now().Add(testenv.WaitTimeout)
	for {
		for line := range strings.SplitSeq(inst.AccessLog.String(), "\n") {
			var m map[string]any
			if line == "" || json.Unmarshal([]byte(line), &m) != nil {
				continue
			}
			if m["requestId"] == requestID {
				return m
			}
		}
		if time.Now().After(deadline) {
			t.Fatalf("no access log line %s", requestID)
		}
		time.Sleep(5 * time.Millisecond)
	}
}

func eventually(t *testing.T, timeout time.Duration, what string, cond func() bool) {
	t.Helper()
	deadline := time.Now().Add(timeout)
	for !cond() {
		if time.Now().After(deadline) {
			t.Fatalf("timed out after %s waiting for %s", timeout, what)
		}
		time.Sleep(5 * time.Millisecond)
	}
}

// closedWithin reports whether the peer closes c within d.
func closedWithin(c net.Conn, d time.Duration) bool {
	_ = c.SetReadDeadline(time.Now().Add(d))
	buf := make([]byte, 512)
	for {
		if _, err := c.Read(buf); err != nil {
			var ne net.Error
			return !errors.As(err, &ne) || !ne.Timeout()
		}
	}
}
