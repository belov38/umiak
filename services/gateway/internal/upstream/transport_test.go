package upstream_test

import (
	"bufio"
	"context"
	"errors"
	"io"
	"net"
	"net/http"
	"net/http/httptrace"
	"testing"
	"time"

	"github.com/google/uuid"

	"github.com/belov38/umiak/services/gateway/internal/config"
	"github.com/belov38/umiak/services/gateway/internal/testenv"
	"github.com/belov38/umiak/services/gateway/internal/upstream"
)

type gotConn struct {
	conn   net.Conn
	reused bool
}

// result is a finished round trip.
type result struct {
	status     int
	protoMajor int
	header     http.Header
	body       string
}

// roundTrip sends req over rt and returns the response with its body read,
// and the conn the transport used.
func roundTrip(t *testing.T, rt http.RoundTripper, req *http.Request) (result, gotConn) {
	t.Helper()
	var gc gotConn
	ctx := httptrace.WithClientTrace(req.Context(), &httptrace.ClientTrace{
		GotConn: func(i httptrace.GotConnInfo) { gc = gotConn{conn: i.Conn, reused: i.Reused} },
	})
	resp, err := rt.RoundTrip(req.WithContext(ctx))
	if err != nil {
		t.Fatalf("RoundTrip %s: %v", req.URL, err)
	}
	defer func() { _ = resp.Body.Close() }()
	b, err := io.ReadAll(resp.Body)
	if err != nil {
		t.Fatalf("read body: %v", err)
	}
	return result{status: resp.StatusCode, protoMajor: resp.ProtoMajor, header: resp.Header, body: string(b)}, gc
}

func newRequest(t *testing.T, host, path string) *http.Request {
	t.Helper()
	req, err := http.NewRequestWithContext(context.Background(), http.MethodGet, "http://"+host+path, nil)
	if err != nil {
		t.Fatal(err)
	}
	return req
}

func epoch(t *testing.T, i *testenv.Inst, machineID string) uint64 {
	t.Helper()
	e, ok, err := i.Upstream().Epoch(context.Background(), machineID)
	if err != nil || !ok {
		t.Fatalf("Epoch = %d, %v, %v", e, ok, err)
	}
	return e
}

func TestSyntheticHost(t *testing.T) {
	id := uuid.NewString()
	h := upstream.SyntheticHost(id, 7, 8080)
	if want := "m-" + id + "-e7-8080.umiak.internal"; h != want {
		t.Fatalf("SyntheticHost = %q, want %q", h, want)
	}
	gotID, gotEpoch, gotPort, ok := upstream.ParseSyntheticHost(h + ":80")
	if !ok || gotID != id || gotEpoch != 7 || gotPort != 8080 {
		t.Fatalf("parse = %q %d %d %v", gotID, gotEpoch, gotPort, ok)
	}
	for _, bad := range []string{
		h,          // no port
		h + ":443", // not port 80
		"example.com:80",
		"m-" + id + "-e7-8080.umiak.internal.evil:80",
		"m-" + id + "-e7-0.umiak.internal:80",
		"m-" + id + "-e7-65536.umiak.internal:80",
		"m-" + id + "-e07-8080.umiak.internal:80",
		"m-" + id + "-e7-08080.umiak.internal:80",
		"m-" + id + "-e-8080.umiak.internal:80",
		"m-" + id + "-7-8080.umiak.internal:80",
		"m-not-a-uuid-e7-8080.umiak.internal:80",
		"m-" + id[:35] + "-e7-8080.umiak.internal:80",
		"M-" + id + "-e7-8080.umiak.internal:80",
		"m-{" + id + "}-e7-8080.umiak.internal:80",
	} {
		if _, _, _, ok := upstream.ParseSyntheticHost(bad); ok {
			t.Errorf("ParseSyntheticHost(%q) accepted", bad)
		}
	}
}

// A request to a host outside the synthetic grammar is refused before any
// dial.
func TestTransportRefusesForeignHost(t *testing.T) {
	env := testenv.New(t, testenv.Options{})
	a := env.StartInstance(nil)
	for _, proto := range []string{"http1", "h2c"} {
		resp, err := a.AppTransports().For(proto).RoundTrip(newRequest(t, "example.com", "/"))
		if err == nil {
			_ = resp.Body.Close()
			t.Fatalf("%s: request to example.com succeeded", proto)
		}
		var ue *upstream.Error
		if errors.As(err, &ue) {
			t.Fatalf("%s: err = %v, want a host error, not a dial error", proto, err)
		}
	}
}

func TestTransportPerEpoch(t *testing.T) {
	env := testenv.New(t, testenv.Options{})
	a := env.StartInstance(nil)
	m := env.NewMachine()
	m.ServeHTTP(8080, http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) { _, _ = io.WriteString(w, "ok") }))
	rt := a.AppTransports().For("http1")

	e1 := epoch(t, a, m.ID)
	host1 := upstream.SyntheticHost(m.ID, e1, 8080)
	r, c1 := roundTrip(t, rt, newRequest(t, host1, "/"))
	if r.status != http.StatusOK || r.body != "ok" {
		t.Fatalf("first request: %d %q", r.status, r.body)
	}
	uc, ok := c1.conn.(*upstream.Conn)
	if !ok {
		t.Fatalf("GotConn conn is %T, want *upstream.Conn", c1.conn)
	}
	if uc.Via != upstream.ViaLocal {
		t.Fatalf("Via = %q", uc.Via)
	}
	if _, c := roundTrip(t, rt, newRequest(t, host1, "/")); !c.reused || c.conn != c1.conn {
		t.Fatal("second request on the same epoch did not reuse the conn")
	}
	// Another epoch is another pool, even while the old conn is alive.
	if _, c := roundTrip(t, rt, newRequest(t, upstream.SyntheticHost(m.ID, e1+1000, 8080), "/")); c.reused || c.conn == c1.conn {
		t.Fatal("a request for another epoch reused the conn")
	}

	m.Restart()
	var e2 uint64
	eventually(t, "a new epoch", func() bool {
		e2 = epoch(t, a, m.ID)
		return e2 != e1
	})
	r, c3 := roundTrip(t, rt, newRequest(t, upstream.SyntheticHost(m.ID, e2, 8080), "/"))
	if r.status != http.StatusOK || r.body != "ok" {
		t.Fatalf("after restart: %d %q", r.status, r.body)
	}
	if c3.reused || c3.conn == c1.conn {
		t.Fatal("the request after the restart reused a conn of the old epoch")
	}
}

func TestStreamIdleCloses(t *testing.T) {
	env := testenv.New(t, testenv.Options{})
	a := env.StartInstance(func(c *config.Config) { c.Timeouts.StreamIdle = 200 * time.Millisecond })
	m := env.NewMachine()
	appClosed := make(chan struct{})
	m.ServeHTTP(8080, http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.Header.Get("Upgrade") != "test" {
			http.Error(w, "upgrade required", http.StatusUpgradeRequired)
			return
		}
		conn, brw, err := http.NewResponseController(w).Hijack()
		if err != nil {
			return
		}
		defer func() { _ = conn.Close() }()
		_, _ = brw.WriteString("HTTP/1.1 101 Switching Protocols\r\nConnection: Upgrade\r\nUpgrade: test\r\n\r\n")
		_ = brw.Flush()
		// Echo until the gateway side goes away.
		_, _ = io.Copy(conn, brw.Reader)
		close(appClosed)
	}))

	req := newRequest(t, upstream.SyntheticHost(m.ID, epoch(t, a, m.ID), 8080), "/ws")
	req.Header.Set("Connection", "Upgrade")
	req.Header.Set("Upgrade", "test")
	resp, err := a.AppTransports().For("http1").RoundTrip(req)
	if err != nil {
		t.Fatal(err)
	}
	defer func() { _ = resp.Body.Close() }()
	if resp.StatusCode != http.StatusSwitchingProtocols {
		t.Fatalf("status = %d", resp.StatusCode)
	}
	rwc, ok := resp.Body.(io.ReadWriteCloser)
	if !ok {
		t.Fatalf("101 body is %T", resp.Body)
	}

	// Traffic keeps the stream open past the idle timeout.
	br := bufio.NewReader(rwc)
	var lastActive time.Time
	for i := range 6 {
		if i > 0 {
			time.Sleep(100 * time.Millisecond)
		}
		if _, err := rwc.Write([]byte("x")); err != nil {
			t.Fatalf("write while active: %v", err)
		}
		if b, err := br.ReadByte(); err != nil || b != 'x' {
			t.Fatalf("read while active: %q, %v", b, err)
		}
		lastActive = time.Now()
	}

	// Silence closes it, about 200ms after the last byte.
	readErr := make(chan error, 1)
	go func() {
		_, err := br.ReadByte()
		readErr <- err
	}()
	select {
	case err := <-readErr:
		if err == nil {
			t.Fatal("read returned data on an idle stream")
		}
		if el := time.Since(lastActive); el < 150*time.Millisecond {
			t.Fatalf("closed %s after the last byte, before the idle timeout", el)
		}
	case <-time.After(testenv.WaitTimeout):
		t.Fatal("idle stream was not closed")
	}
	select {
	case <-appClosed:
	case <-time.After(testenv.WaitTimeout):
		t.Fatal("the app did not see the stream end")
	}
}

func TestDisableCompression(t *testing.T) {
	env := testenv.New(t, testenv.Options{})
	a := env.StartInstance(nil)
	m := env.NewMachine()
	seen := make(chan []string, 4)
	h := http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		seen <- r.Header.Values("Accept-Encoding")
		w.Header().Set("Content-Encoding", "gzip")
		_, _ = io.WriteString(w, "not really gzip")
	})
	m.ServeHTTP(8080, h)
	m.ServeH2C(8081, h)

	for _, tc := range []struct {
		proto string
		port  uint16
	}{{"http1", 8080}, {"h2c", 8081}} {
		t.Run(tc.proto, func(t *testing.T) {
			rt := a.AppTransports().For(tc.proto)
			host := upstream.SyntheticHost(m.ID, epoch(t, a, m.ID), tc.port)
			for _, ae := range []string{"", "gzip, br"} {
				req := newRequest(t, host, "/")
				if ae != "" {
					req.Header.Set("Accept-Encoding", ae)
				}
				r, _ := roundTrip(t, rt, req)
				got := <-seen
				switch {
				case ae == "" && len(got) != 0:
					t.Fatalf("app saw Accept-Encoding %q, client sent none", got)
				case ae != "" && (len(got) != 1 || got[0] != ae):
					t.Fatalf("app saw Accept-Encoding %q, want %q", got, ae)
				}
				if r.body != "not really gzip" || r.header.Get("Content-Encoding") != "gzip" {
					t.Fatalf("response changed: %q, Content-Encoding %q", r.body, r.header.Get("Content-Encoding"))
				}
				if want := 2; tc.proto == "h2c" && r.protoMajor != want {
					t.Fatalf("h2c response proto major %d", r.protoMajor)
				}
			}
		})
	}
}

func TestConnDeadlinesAndIdle(t *testing.T) {
	p1, p2 := net.Pipe()
	defer func() { _ = p2.Close() }()
	c := &upstream.Conn{Conn: p1, Via: upstream.ViaLocal}
	for _, err := range []error{
		c.SetDeadline(time.Now()), c.SetReadDeadline(time.Now()), c.SetWriteDeadline(time.Now()),
	} {
		if err != nil {
			t.Fatalf("deadline setter = %v, want nil", err)
		}
	}
	if err := c.CloseWrite(); !errors.Is(err, errors.ErrUnsupported) {
		t.Fatalf("CloseWrite on a pipe = %v", err)
	}

	go func() { _, _ = io.Copy(p2, p2) }()
	c.SetIdleTimeout(150 * time.Millisecond)
	buf := make([]byte, 1)
	var lastActive time.Time
	for i := range 5 {
		if i > 0 {
			time.Sleep(75 * time.Millisecond)
		}
		if _, err := c.Write([]byte("y")); err != nil {
			t.Fatalf("write while active: %v", err)
		}
		if _, err := io.ReadFull(c, buf); err != nil {
			t.Fatalf("read while active: %v", err)
		}
		lastActive = time.Now()
	}
	if _, err := c.Read(buf); err == nil {
		t.Fatal("read on an idle conn returned data")
	}
	if el := time.Since(lastActive); el < 120*time.Millisecond || el > 5*time.Second {
		t.Fatalf("idle close after %s", el)
	}
	if err := c.Close(); err != nil && !errors.Is(err, net.ErrClosed) && !errors.Is(err, io.ErrClosedPipe) {
		t.Fatalf("Close = %v", err)
	}
}
