package wstransport_test

import (
	"context"
	"crypto/ecdsa"
	"crypto/elliptic"
	"crypto/rand"
	"crypto/tls"
	"crypto/x509"
	"crypto/x509/pkix"
	"errors"
	"io"
	"math/big"
	"net"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync"
	"sync/atomic"
	"testing"
	"time"

	"github.com/coder/websocket"

	"github.com/belov38/boat-dev-clone/libs/tunnel/h2"
	"github.com/belov38/boat-dev-clone/libs/tunnel/transport"
	"github.com/belov38/boat-dev-clone/libs/tunnel/wire"
	"github.com/belov38/boat-dev-clone/libs/tunnel/wstransport"
)

// fakeAdmitter records the Hello and serves an HTTP/2 client over the admitted
// connection, like the gateway does.
type fakeAdmitter struct {
	info transport.ConnInfo
	err  error

	admits atomic.Int32
	mu     sync.Mutex
	hello  transport.Hello

	// reply receives the body of GET http://agent/hello made over the conn.
	reply   chan string
	aborted chan error
	served  chan struct{}
}

func newFakeAdmitter() *fakeAdmitter {
	return &fakeAdmitter{
		info:    transport.ConnInfo{GatewayInstance: "gw-1", Epoch: 7, ConnID: "conn-abc"},
		reply:   make(chan string, 1),
		aborted: make(chan error, 1),
		served:  make(chan struct{}, 1),
	}
}

func (f *fakeAdmitter) Admit(_ context.Context, hello transport.Hello) (transport.Admission, error) {
	f.admits.Add(1)
	f.mu.Lock()
	f.hello = hello
	f.mu.Unlock()
	if f.err != nil {
		return nil, f.err
	}
	return &fakeAdmission{f: f}, nil
}

func (f *fakeAdmitter) gotHello() transport.Hello {
	f.mu.Lock()
	defer f.mu.Unlock()
	return f.hello
}

type fakeAdmission struct{ f *fakeAdmitter }

func (a *fakeAdmission) Info() transport.ConnInfo { return a.f.info }

func (a *fakeAdmission) Abort(err error) { a.f.aborted <- err }

func (a *fakeAdmission) Serve(conn net.Conn) {
	a.f.served <- struct{}{}
	go func() {
		cc, err := h2.NewClientConn(context.Background(), conn, h2.DefaultClientConfig())
		if err != nil {
			a.f.reply <- "client conn: " + err.Error()
			return
		}
		req, _ := http.NewRequestWithContext(context.Background(), http.MethodGet, "http://agent/hello", nil)
		resp, err := cc.RoundTrip(req)
		if err != nil {
			a.f.reply <- "round trip: " + err.Error()
			return
		}
		defer func() { _ = resp.Body.Close() }()
		b, _ := io.ReadAll(resp.Body)
		a.f.reply <- string(b)
	}()
}

func tlsConfig(pool *x509.CertPool) *tls.Config {
	return &tls.Config{RootCAs: pool, MinVersion: tls.VersionTLS13}
}

// unrelatedPool returns a pool with a freshly generated self-signed CA.
// (httptest servers all share one built-in certificate, so they cannot
// stand in for a different CA.)
func unrelatedPool(t *testing.T) *x509.CertPool {
	t.Helper()
	key, err := ecdsa.GenerateKey(elliptic.P256(), rand.Reader)
	if err != nil {
		t.Fatal(err)
	}
	tmpl := &x509.Certificate{
		SerialNumber:          big.NewInt(1),
		Subject:               pkix.Name{CommonName: "unrelated test CA"},
		NotBefore:             time.Now().Add(-time.Hour),
		NotAfter:              time.Now().Add(time.Hour),
		IsCA:                  true,
		BasicConstraintsValid: true,
		KeyUsage:              x509.KeyUsageCertSign,
	}
	der, err := x509.CreateCertificate(rand.Reader, tmpl, tmpl, &key.PublicKey, key)
	if err != nil {
		t.Fatal(err)
	}
	cert, err := x509.ParseCertificate(der)
	if err != nil {
		t.Fatal(err)
	}
	pool := x509.NewCertPool()
	pool.AddCert(cert)
	return pool
}

func newTLSServer(t *testing.T, h http.Handler) (*httptest.Server, *x509.CertPool) {
	t.Helper()
	ts := httptest.NewTLSServer(h)
	t.Cleanup(ts.Close)
	pool := x509.NewCertPool()
	pool.AddCert(ts.Certificate())
	return ts, pool
}

func testConfig(ts *httptest.Server, pool *x509.CertPool) wstransport.DialerConfig {
	return wstransport.DialerConfig{
		URL:          "wss://" + strings.TrimPrefix(ts.URL, "https://") + wire.ConnectPath,
		RootCAs:      pool,
		PingInterval: 50 * time.Millisecond,
		PingTimeout:  200 * time.Millisecond,
	}
}

func testHello(scheme transport.AuthScheme) transport.Hello {
	secret := make([]byte, wire.SecretLen)
	for i := range secret {
		secret[i] = byte(i + 1)
	}
	return transport.Hello{
		MachineID:       "0f8fad5b-d9cb-469f-a165-70867728950e",
		BootID:          "boot-1",
		AgentInstanceID: "inst-1",
		Vmgenid:         "vmgen-1",
		AgentVersion:    "1.2.3",
		Scheme:          scheme,
		Secret:          secret,
	}
}

func TestDialSuccessCarriesHelloAndInfo(t *testing.T) {
	for name, scheme := range map[string]transport.AuthScheme{
		"bearer":    transport.AuthToken,
		"bootstrap": transport.AuthBootstrap,
	} {
		t.Run(name, func(t *testing.T) {
			adm := newFakeAdmitter()
			ts, pool := newTLSServer(t, wstransport.NewHandler(adm, wstransport.HandlerOptions{}))
			hello := testHello(scheme)

			ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
			defer cancel()
			conn, info, err := wstransport.NewDialer(testConfig(ts, pool)).Dial(ctx, hello)
			if err != nil {
				t.Fatalf("Dial: %v", err)
			}
			defer func() { _ = conn.Close() }()

			if info != adm.info {
				t.Errorf("ConnInfo = %+v, want %+v", info, adm.info)
			}
			got := adm.gotHello()
			want := hello
			want.ProtoVersion = wire.Subprotocol
			if got.MachineID != want.MachineID || got.BootID != want.BootID ||
				got.AgentInstanceID != want.AgentInstanceID || got.Vmgenid != want.Vmgenid ||
				got.AgentVersion != want.AgentVersion || got.Scheme != want.Scheme ||
				string(got.Secret) != string(want.Secret) || got.ProtoVersion != want.ProtoVersion {
				t.Errorf("Hello = %+v, want %+v", got, want)
			}

			// The fake gateway makes an h2 request that must reach the agent-side h2 server.
			srv := h2.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
				_, _ = io.WriteString(w, "hi from agent")
			}), h2.DefaultServerConfig())
			ln := h2.New()
			t.Cleanup(func() { _ = srv.Close() })
			go func() { _ = srv.Serve(ln) }()
			if err := ln.Push(conn); err != nil {
				t.Fatalf("Push: %v", err)
			}
			select {
			case body := <-adm.reply:
				if body != "hi from agent" {
					t.Errorf("reply = %q", body)
				}
			case <-ctx.Done():
				t.Fatal("no reply from agent over the tunnel")
			}
		})
	}
}

// stubServer answers every request with the given status, headers and body.
func stubServer(t *testing.T, status int, headers map[string]string, body string) (*httptest.Server, *x509.CertPool) {
	t.Helper()
	return newTLSServer(t, http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		for k, v := range headers {
			w.Header().Set(k, v)
		}
		w.WriteHeader(status)
		_, _ = io.WriteString(w, body)
	}))
}

func TestRejectMapping(t *testing.T) {
	tests := []struct {
		name    string
		status  int
		headers map[string]string
		body    string
		want    transport.RejectError
	}{
		{"401", 401, nil, "bad token", transport.RejectError{Status: 401, Reason: "bad token"}},
		{"403", 403, nil, "revoked", transport.RejectError{Status: 403, Reason: "revoked"}},
		{"426", 426, nil, "upgrade", transport.RejectError{Status: 426, Reason: "upgrade"}},
		{"503 retry-after", 503, map[string]string{"Retry-After": "7"}, "draining", transport.RejectError{Status: 503, RetryAfter: 7 * time.Second, Reason: "draining"}},
		{"503 http-date ignored", 503, map[string]string{"Retry-After": "Wed, 21 Oct 2099 07:28:00 GMT"}, "", transport.RejectError{Status: 503}},
		{"503 garbage ignored", 503, map[string]string{"Retry-After": "soon"}, "", transport.RejectError{Status: 503}},
		{"200 not an upgrade", 200, nil, "hello", transport.RejectError{Status: 200, Reason: "hello"}},
		{"redirect not followed", 302, map[string]string{"Location": "/elsewhere"}, "", transport.RejectError{Status: 302}},
		{"reason capped at 1 KiB", 500, nil, strings.Repeat("x", 4096), transport.RejectError{Status: 500, Reason: strings.Repeat("x", 1024)}},
	}
	for _, tc := range tests {
		t.Run(tc.name, func(t *testing.T) {
			ts, pool := stubServer(t, tc.status, tc.headers, tc.body)
			_, _, err := wstransport.NewDialer(testConfig(ts, pool)).Dial(context.Background(), testHello(transport.AuthToken))
			var rej *transport.RejectError
			if !errors.As(err, &rej) {
				t.Fatalf("err = %v, want *RejectError", err)
			}
			if *rej != tc.want {
				t.Errorf("RejectError = %+v, want %+v", *rej, tc.want)
			}
		})
	}
}

func TestHandlerRejects(t *testing.T) {
	validHeaders := func() http.Header {
		h := testHello(transport.AuthToken).Header()
		h.Set("Sec-WebSocket-Protocol", wire.Subprotocol)
		return h
	}
	tests := []struct {
		name       string
		admitErr   error
		mutate     func(http.Header)
		wantStatus int
		wantRetry  string
		wantBody   string
		wantAdmit  bool
	}{
		{name: "reject with retry-after rounded up", admitErr: &transport.RejectError{Status: 503, RetryAfter: 1500 * time.Millisecond, Reason: "draining"},
			wantStatus: 503, wantRetry: "2", wantBody: "draining", wantAdmit: true},
		{name: "reject with tiny retry-after is at least 1", admitErr: &transport.RejectError{Status: 503, RetryAfter: time.Millisecond},
			wantStatus: 503, wantRetry: "1", wantAdmit: true},
		{name: "reject without retry-after", admitErr: &transport.RejectError{Status: 403, Reason: "revoked"},
			wantStatus: 403, wantBody: "revoked", wantAdmit: true},
		{name: "other error is 500", admitErr: errors.New("db down"), wantStatus: 500, wantAdmit: true},
		{name: "missing authorization is 401", mutate: func(h http.Header) { h.Del("Authorization") }, wantStatus: 401},
		{name: "missing machine id is 400", mutate: func(h http.Header) { h.Del(wire.HeaderMachineID) }, wantStatus: 400},
	}
	for _, tc := range tests {
		t.Run(tc.name, func(t *testing.T) {
			adm := newFakeAdmitter()
			adm.err = tc.admitErr
			ts, pool := newTLSServer(t, wstransport.NewHandler(adm, wstransport.HandlerOptions{}))
			h := validHeaders()
			if tc.mutate != nil {
				tc.mutate(h)
			}
			resp := rawGet(t, ts, pool, h)
			body := resp.body
			if resp.status != tc.wantStatus {
				t.Errorf("status = %d, want %d", resp.status, tc.wantStatus)
			}
			if got := resp.header.Get("Retry-After"); got != tc.wantRetry {
				t.Errorf("Retry-After = %q, want %q", got, tc.wantRetry)
			}
			if tc.wantBody != "" && !strings.Contains(body, tc.wantBody) {
				t.Errorf("body = %q, want it to contain %q", body, tc.wantBody)
			}
			if tc.wantStatus == 500 && strings.Contains(body, "db down") {
				t.Errorf("internal error text leaked to the client: %q", body)
			}
			if (adm.admits.Load() == 1) != tc.wantAdmit {
				t.Errorf("admits = %d, want admitted=%v", adm.admits.Load(), tc.wantAdmit)
			}
		})
	}
}

type rawResponse struct {
	status int
	header http.Header
	body   string
}

func rawGet(t *testing.T, ts *httptest.Server, pool *x509.CertPool, h http.Header) rawResponse {
	t.Helper()
	client := &http.Client{Transport: &http.Transport{TLSClientConfig: tlsConfig(pool)}}
	t.Cleanup(client.CloseIdleConnections)
	req, err := http.NewRequestWithContext(context.Background(), http.MethodGet, ts.URL+wire.ConnectPath, nil)
	if err != nil {
		t.Fatal(err)
	}
	req.Header = h
	resp, err := client.Do(req)
	if err != nil {
		t.Fatalf("request: %v", err)
	}
	defer func() { _ = resp.Body.Close() }()
	b, _ := io.ReadAll(resp.Body)
	return rawResponse{status: resp.StatusCode, header: resp.Header, body: string(b)}
}

func TestWrongSubprotocol426(t *testing.T) {
	for name, protos := range map[string][]string{
		"other":  {"sbx-tunnel.v2"},
		"absent": nil,
	} {
		t.Run(name, func(t *testing.T) {
			adm := newFakeAdmitter()
			ts, pool := newTLSServer(t, wstransport.NewHandler(adm, wstransport.HandlerOptions{}))
			_, resp, err := websocket.Dial(context.Background(), ts.URL+wire.ConnectPath, &websocket.DialOptions{
				HTTPClient:   &http.Client{Transport: &http.Transport{TLSClientConfig: tlsConfig(pool)}},
				HTTPHeader:   testHello(transport.AuthToken).Header(),
				Subprotocols: protos,
			})
			if err == nil {
				t.Fatal("Dial succeeded, want 426")
			}
			if resp != nil && resp.Body != nil {
				_ = resp.Body.Close()
			}
			if resp == nil || resp.StatusCode != http.StatusUpgradeRequired {
				t.Fatalf("response = %v, want 426 (err %v)", resp, err)
			}
			if adm.admits.Load() != 0 {
				t.Error("Admit was called for an unsupported subprotocol")
			}
		})
	}
}

func TestCustomSubprotocols(t *testing.T) {
	adm := newFakeAdmitter()
	ts, pool := newTLSServer(t, wstransport.NewHandler(adm, wstransport.HandlerOptions{Subprotocols: []string{"sbx-tunnel.v2", wire.Subprotocol}}))
	c, resp, err := websocket.Dial(context.Background(), ts.URL+wire.ConnectPath, &websocket.DialOptions{
		HTTPClient:   &http.Client{Transport: &http.Transport{TLSClientConfig: tlsConfig(pool)}},
		HTTPHeader:   testHello(transport.AuthToken).Header(),
		Subprotocols: []string{wire.Subprotocol},
	})
	if err != nil {
		t.Fatalf("Dial: %v (resp %v)", err, resp)
	}
	defer func() { _ = c.CloseNow() }()
	if resp != nil && resp.Body != nil {
		_ = resp.Body.Close()
	}
	if got := adm.gotHello().ProtoVersion; got != wire.Subprotocol {
		t.Errorf("ProtoVersion = %q, want %q", got, wire.Subprotocol)
	}
}

func TestUntrustedCARejected(t *testing.T) {
	adm := newFakeAdmitter()
	ts, _ := newTLSServer(t, wstransport.NewHandler(adm, wstransport.HandlerOptions{}))
	otherPool := unrelatedPool(t)

	for name, pool := range map[string]*x509.CertPool{
		"other CA":     otherPool,
		"nil RootCAs":  nil, // must not fall back to system roots
		"empty RootCA": x509.NewCertPool(),
	} {
		t.Run(name, func(t *testing.T) {
			_, _, err := wstransport.NewDialer(testConfig(ts, pool)).Dial(context.Background(), testHello(transport.AuthToken))
			if err == nil {
				t.Fatal("Dial succeeded against an untrusted server")
			}
			var rej *transport.RejectError
			if errors.As(err, &rej) {
				t.Errorf("err = %v, want a TLS error, not *RejectError", err)
			}
			if adm.admits.Load() != 0 {
				t.Error("Admit was called over an untrusted TLS connection")
			}
		})
	}
}

// pingCountingHandler accepts a websocket, reads it (so pings are processed),
// and optionally suppresses pongs.
func pingCountingHandler(t *testing.T, suppressPong bool, pings *atomic.Int32) http.Handler {
	t.Helper()
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set(wire.HeaderGatewayInstance, "gw-ping")
		w.Header().Set(wire.HeaderConnEpoch, "1")
		c, err := websocket.Accept(w, r, &websocket.AcceptOptions{
			Subprotocols: []string{wire.Subprotocol},
			OnPingReceived: func(context.Context, []byte) bool {
				pings.Add(1)
				return !suppressPong
			},
		})
		if err != nil {
			return
		}
		nc := websocket.NetConn(context.Background(), c, websocket.MessageBinary) //nolint:contextcheck // the conn outlives the request
		go func() {
			_, _ = io.Copy(io.Discard, nc)
			_ = nc.Close()
		}()
	})
}

func TestPingTimeoutClosesConn(t *testing.T) {
	var pings atomic.Int32
	ts, pool := newTLSServer(t, pingCountingHandler(t, true, &pings))
	conn, _, err := wstransport.NewDialer(testConfig(ts, pool)).Dial(context.Background(), testHello(transport.AuthToken))
	if err != nil {
		t.Fatalf("Dial: %v", err)
	}
	defer func() { _ = conn.Close() }()

	start := time.Now()
	_ = conn.SetReadDeadline(start.Add(5 * time.Second))
	_, err = conn.Read(make([]byte, 1))
	elapsed := time.Since(start)
	if err == nil {
		t.Fatal("Read returned data from a silent peer")
	}
	var ne net.Error
	if errors.As(err, &ne) && ne.Timeout() {
		t.Fatalf("conn was not closed by the ping loop within 5s: %v", err)
	}
	if elapsed < 150*time.Millisecond || elapsed > 2*time.Second {
		t.Errorf("conn closed after %s, want about PingTimeout (200ms) plus one interval", elapsed)
	}
}

// The ping timeout counts from the last pong, not from the ping that was
// sent after it: a peer that stops answering is dropped PingTimeout after
// its last pong.
func TestPingTimeoutCountsFromLastPong(t *testing.T) {
	var (
		pings     atomic.Int32
		firstPong atomic.Int64 // unix nanos
	)
	ts, pool := newTLSServer(t, http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set(wire.HeaderGatewayInstance, "gw-ping")
		w.Header().Set(wire.HeaderConnEpoch, "1")
		c, err := websocket.Accept(w, r, &websocket.AcceptOptions{
			Subprotocols: []string{wire.Subprotocol},
			OnPingReceived: func(context.Context, []byte) bool {
				if pings.Add(1) == 1 {
					firstPong.Store(time.Now().UnixNano())
					return true
				}
				return false
			},
		})
		if err != nil {
			return
		}
		nc := websocket.NetConn(context.Background(), c, websocket.MessageBinary) //nolint:contextcheck // the conn outlives the request
		go func() {
			_, _ = io.Copy(io.Discard, nc)
			_ = nc.Close()
		}()
	}))
	cfg := testConfig(ts, pool)
	// An interval close to the timeout: counting from the next ping would
	// close only interval + timeout (350 ms) after the last pong.
	cfg.PingInterval = 150 * time.Millisecond
	cfg.PingTimeout = 200 * time.Millisecond
	conn, _, err := wstransport.NewDialer(cfg).Dial(context.Background(), testHello(transport.AuthToken))
	if err != nil {
		t.Fatalf("Dial: %v", err)
	}
	defer func() { _ = conn.Close() }()

	readErr := make(chan error, 1)
	go func() {
		_, err := conn.Read(make([]byte, 1))
		readErr <- err
	}()
	select {
	case <-readErr:
	case <-time.After(5 * time.Second):
		t.Fatal("conn not closed by the ping loop within 5s")
	}
	closed := time.Now()
	if firstPong.Load() == 0 {
		t.Fatal("no pong was sent")
	}
	since := closed.Sub(time.Unix(0, firstPong.Load()))
	if since < 150*time.Millisecond || since >= 300*time.Millisecond {
		t.Fatalf("conn closed %s after the last pong, want PingTimeout (200ms) + margin, < 300ms", since)
	}
}

func TestHealthyConnStaysOpenAndCloseStopsPings(t *testing.T) {
	var pings atomic.Int32
	ts, pool := newTLSServer(t, pingCountingHandler(t, false, &pings))
	conn, _, err := wstransport.NewDialer(testConfig(ts, pool)).Dial(context.Background(), testHello(transport.AuthToken))
	if err != nil {
		t.Fatalf("Dial: %v", err)
	}

	// 600 ms is several PingTimeouts: the conn must survive because pongs arrive.
	// The read has to be running for pongs to be processed.
	// (A read deadline is no good here: on a websocket NetConn it is fatal.)
	readErr := make(chan error, 1)
	go func() {
		_, err := conn.Read(make([]byte, 1))
		readErr <- err
	}()
	select {
	case err := <-readErr:
		t.Fatalf("healthy conn closed within 600ms: %v", err)
	case <-time.After(600 * time.Millisecond):
	}
	if pings.Load() < 3 {
		t.Errorf("server saw %d pings in 600ms, want at least 3", pings.Load())
	}

	if err := conn.Close(); err != nil {
		t.Errorf("Close: %v", err)
	}
	if err := conn.Close(); err != nil {
		t.Errorf("second Close: %v", err)
	}
	select {
	case err := <-readErr:
		t.Logf("Read after Close: %v", err)
	case <-time.After(2 * time.Second):
		t.Error("Close did not unblock a pending Read")
	}
	time.Sleep(100 * time.Millisecond) // let an in-flight ping drain
	before := pings.Load()
	time.Sleep(300 * time.Millisecond)
	if after := pings.Load(); after != before {
		t.Errorf("pings continued after Close: %d -> %d", before, after)
	}
}

func TestAcceptFailureAborts(t *testing.T) {
	adm := newFakeAdmitter()
	ts, pool := newTLSServer(t, wstransport.NewHandler(adm, wstransport.HandlerOptions{}))

	// Valid hello and subprotocol, but not a websocket upgrade: Accept fails after Admit.
	h := testHello(transport.AuthToken).Header()
	h.Set("Sec-WebSocket-Protocol", wire.Subprotocol)
	resp := rawGet(t, ts, pool, h)
	if resp.status < 400 {
		t.Errorf("status = %d, want an error status", resp.status)
	}
	select {
	case err := <-adm.aborted:
		if err == nil {
			t.Error("Abort(nil)")
		}
	case <-time.After(5 * time.Second):
		t.Fatal("Abort was not called")
	}
	select {
	case <-adm.served:
		t.Error("Serve was called after a failed Accept")
	default:
	}
}

func TestListenConfig(t *testing.T) {
	lc := wstransport.ListenConfig(15*time.Second, 20*time.Second)
	if !lc.KeepAliveConfig.Enable || lc.KeepAliveConfig.Idle != 15*time.Second ||
		lc.KeepAliveConfig.Interval != 15*time.Second || lc.KeepAliveConfig.Count != 3 {
		t.Errorf("KeepAliveConfig = %+v", lc.KeepAliveConfig)
	}
	ln, err := lc.Listen(context.Background(), "tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatalf("Listen with socket options: %v", err)
	}
	_ = ln.Close()
}
