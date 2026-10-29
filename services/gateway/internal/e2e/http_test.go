package e2e_test

import (
	"bytes"
	"context"
	"crypto/sha256"
	"encoding/hex"
	"fmt"
	"io"
	"math/rand/v2"
	"net/http"
	"os"
	"runtime"
	"strconv"
	"sync"
	"testing"
	"time"

	"connectrpc.com/connect"
	"github.com/coder/websocket"

	"github.com/belov38/boat-dev-clone/libs/tunnel/tunneltest/process"
	testingv1 "github.com/belov38/boat-dev-clone/libs/tunnel/tunneltest/testpb/sbx/testing/v1"
	"github.com/belov38/boat-dev-clone/libs/tunnel/tunneltest/testpb/sbx/testing/v1/testingv1connect"
	"github.com/belov38/boat-dev-clone/services/gateway/internal/server"
	"github.com/belov38/boat-dev-clone/services/gateway/internal/testenv"
)

func TestPeerProxy(t *testing.T) {
	t.Parallel()
	c := newCluster(t, testenv.Options{}, nil)
	m := c.newMachine(t)
	m.ServeHTTP(3000, echoApp())
	rt := c.env.Route(m, 3000, nil)
	host := testenv.Host(rt.Label)
	client := c.env.HTTPClient(c.A, true)

	if n := c.C.InternalH2Conns(); n != 0 {
		t.Fatalf("C accepted %d peer conns before the test", n)
	}
	for i := range 50 {
		req := newReq(t, http.MethodGet, "https", host, "/p/"+strconv.Itoa(i)+"?q=1", nil)
		rid := fmt.Sprintf("peer-%02d", i)
		req.Header.Set("X-Request-Id", rid)
		e := decodeEcho(t, send(client, req))
		if e.Host != host || e.Path != "/p/"+strconv.Itoa(i) || e.RawQuery != "q=1" {
			t.Fatalf("app saw %s %s?%s", e.Host, e.Path, e.RawQuery)
		}
		if i == 0 || i == 49 {
			l := logLine(t, c.A, rid)
			if l["via"] != "peer" || l["ownerInstance"] != c.C.Name || l["status"] != 200.0 {
				t.Errorf("access log via=%v ownerInstance=%v status=%v, want peer %s 200", l["via"], l["ownerInstance"], l["status"], c.C.Name)
			}
		}
	}
	if n := c.C.InternalH2Conns(); n != 1 {
		t.Fatalf("C accepted %d peer conns for 50 requests, want 1", n)
	}
	if n := c.B.InternalH2Conns(); n != 0 {
		t.Errorf("B accepted %d peer conns", n)
	}
}

func Test1000WebSocketsViaPeer(t *testing.T) {
	t.Parallel()
	c := newCluster(t, testenv.Options{}, nil)
	// Two machines: one machine holds at most 800 TCP streams
	// (MaxTCPStreamsPerMachine) and its agent at most 1000 HTTP/2 streams,
	// control streams included. The peer conn A→C carries all of them.
	app := &wsEchoApp{}
	var hosts []string
	for range 2 {
		m := c.newMachine(t)
		m.ServeHTTP(3000, app)
		hosts = append(hosts, testenv.Host(c.env.Route(m, 3000, nil).Label))
	}
	client := c.env.PlainClient(c.A)
	// Warm up the peer conn so that its SETTINGS are known before the burst.
	for _, h := range hosts {
		if body := mustGet(t, client, h, "/"); body != "plain" {
			t.Fatalf("warm-up body %q", body)
		}
	}

	const wsCount = 1000
	conns := openWebSockets(t, client, wsCount, func(i int) string { return "ws://" + hosts[i%2] + "/ws" })
	eventually(t, "app holds every WebSocket", func() bool { return app.Open() == wsCount })
	echoAll(t, conns)
	if n := c.C.InternalH2Conns(); n != 1 {
		t.Errorf("C accepted %d peer conns for %d WebSockets, want 1", n, wsCount)
	}
}

// openWebSockets opens n WebSockets, at most 64 handshakes at a time, and
// closes them at cleanup.
func openWebSockets(t *testing.T, client *http.Client, n int, url func(int) string) []*websocket.Conn {
	t.Helper()
	conns := make([]*websocket.Conn, n)
	errs := make([]error, n)
	sem := make(chan struct{}, 64)
	var wg sync.WaitGroup
	for i := range n {
		wg.Go(func() {
			sem <- struct{}{}
			defer func() { <-sem }()
			ctx, cancel := context.WithTimeout(context.Background(), reqTimeout)
			defer cancel()
			ws, status, code, err := dialWS(ctx, client, url(i))
			if err != nil {
				errs[i] = fmt.Errorf("%w (status %d %s)", err, status, code)
				return
			}
			conns[i] = ws
		})
	}
	wg.Wait()
	t.Cleanup(func() {
		for _, ws := range conns {
			if ws != nil {
				_ = ws.CloseNow()
			}
		}
	})
	failed := 0
	for i, err := range errs {
		if err != nil {
			if failed < 5 {
				t.Errorf("WebSocket %d: %v", i, err)
			}
			failed++
		}
	}
	if failed > 0 {
		t.Fatalf("%d of %d WebSockets failed to open", failed, n)
	}
	return conns
}

// echoAll checks that every WebSocket still echoes.
func echoAll(t *testing.T, conns []*websocket.Conn) {
	t.Helper()
	var wg sync.WaitGroup
	errs := make([]error, len(conns))
	sem := make(chan struct{}, 64)
	for i, ws := range conns {
		wg.Go(func() {
			sem <- struct{}{}
			defer func() { <-sem }()
			ctx, cancel := context.WithTimeout(context.Background(), reqTimeout)
			defer cancel()
			errs[i] = echoOnce(ctx, ws, "m"+strconv.Itoa(i))
		})
	}
	wg.Wait()
	for i, err := range errs {
		if err != nil {
			t.Fatalf("WebSocket %d echo: %v", i, err)
		}
	}
}

func TestOverloaded801(t *testing.T) {
	t.Parallel()
	opts := testenv.Options{Deps: func(d *server.Deps) {
		d.AllowedServicePrefixes = []string{"sbx.agent.v1.", "sbx.testing.v1."}
	}}
	c := newCluster(t, opts, nil)
	store := process.NewStore(process.Options{})
	t.Cleanup(store.Close)
	mux := http.NewServeMux()
	mux.Handle(store.Handler())
	m := c.newMachine(t, testenv.MachineOptions{Handler: mux})
	app := &wsEchoApp{}
	m.ServeHTTP(3000, app)
	rt := c.env.Route(m, 3000, nil)
	host := testenv.Host(rt.Label)
	client := c.env.PlainClient(c.A)

	// The default MaxTCPStreamsPerMachine, counted by the owner C.
	const limit = 800
	conns := openWebSockets(t, client, limit, func(int) string { return "ws://" + host + "/ws" })
	eventually(t, "app holds every WebSocket", func() bool { return app.Open() == limit })

	// The keep-alive pool of A is empty (only upgrades so far), so the
	// next request needs stream number limit+1.
	r := get(t, client, host, "/")
	if r.err != nil || r.status != http.StatusServiceUnavailable || r.sbxError != "overloaded" {
		t.Fatalf("request %d = %v, want 503 overloaded", limit+1, r)
	}
	ctx, cancel := context.WithTimeout(context.Background(), reqTimeout)
	defer cancel()
	ws, status, code, err := dialWS(ctx, client, "ws://"+host+"/ws")
	if err == nil {
		_ = ws.CloseNow()
		t.Fatal("WebSocket over the limit opened")
	}
	if status != http.StatusServiceUnavailable || code != "overloaded" {
		t.Fatalf("WebSocket over the limit: %d %s (%v)", status, code, err)
	}

	// An exec through the internal API still works: RPCs are not TCP
	// streams.
	pc := testingv1connect.NewProcessClient(&http.Client{Transport: bearerRT{token: testenv.APIToken}},
		c.C.InternalURL+"/v1/machines/"+m.ID+"/rpc")
	spec := &testingv1.CommandSpec{Lines: 3, LineBytes: 40}
	if _, err := pc.Start(ctx, connect.NewRequest(&testingv1.StartRequest{CommandId: "exec-1", Spec: spec})); err != nil {
		t.Fatalf("Start while overloaded: %v", err)
	}
	stream, err := pc.Attach(ctx, connect.NewRequest(&testingv1.AttachRequest{CommandId: "exec-1"}))
	if err != nil {
		t.Fatalf("Attach while overloaded: %v", err)
	}
	var stdout []byte
	exited := false
	for !exited && stream.Receive() {
		switch ev := stream.Msg().GetEvent().(type) {
		case *testingv1.AttachResponse_Data:
			if ev.Data.GetStream() == testingv1.Stream_STREAM_STDOUT {
				stdout = append(stdout, ev.Data.GetData()...)
			}
		case *testingv1.AttachResponse_Exit:
			exited = true
		}
	}
	_ = stream.Close()
	if want, _ := process.Expected(spec); !exited || !bytes.Equal(stdout, want) {
		t.Fatalf("exec while overloaded: exited=%v stdout %q, want %q (err %v)", exited, stdout, want, stream.Err())
	}

	// One stream fewer: requests work again.
	_ = conns[0].Close(websocket.StatusNormalClosure, "")
	eventually(t, "a free stream", func() bool {
		r := get(t, client, host, "/")
		return r.err == nil && r.status == http.StatusOK
	})
}

// bearerRT adds the service token to every request.
type bearerRT struct{ token string }

func (b bearerRT) RoundTrip(r *http.Request) (*http.Response, error) {
	r = r.Clone(r.Context())
	r.Header.Set("Authorization", "Bearer "+b.token)
	return http.DefaultTransport.RoundTrip(r)
}

func TestBigTransfer(t *testing.T) {
	if os.Getenv("SBX_E2E_BIG") != "1" {
		t.Skip("5 GiB transfer; set SBX_E2E_BIG=1 to run it")
	}
	const size = 5 << 30
	c := newCluster(t, testenv.Options{}, nil)
	m := c.newMachine(t)
	m.ServeHTTP(3000, http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		switch r.Method {
		case http.MethodPut:
			hs := sha256.New()
			n, err := io.Copy(hs, r.Body)
			if err != nil {
				http.Error(w, err.Error(), http.StatusBadRequest)
				return
			}
			_, _ = fmt.Fprintf(w, "%d %s", n, hex.EncodeToString(hs.Sum(nil)))
		default:
			w.Header().Set("Content-Length", strconv.Itoa(size))
			_, _ = io.Copy(w, newPattern(size))
		}
	}))
	rt := c.env.Route(m, 3000, nil)
	host := testenv.Host(rt.Label)
	client := c.env.PlainClient(c.A)

	sampler := startHeapSampler()
	hs := sha256.New()
	req := newReq(t, http.MethodPut, "http", host, "/upload", io.TeeReader(newPattern(size), hs))
	req.ContentLength = size
	start := time.Now()
	r := send(client, req)
	want := fmt.Sprintf("%d %s", size, hex.EncodeToString(hs.Sum(nil)))
	if r.err != nil || r.status != http.StatusOK || r.body != want {
		t.Fatalf("PUT = %v, want %q", r, want)
	}
	t.Logf("PUT 5 GiB in %s", time.Since(start))

	start = time.Now()
	resp, err := client.Do(newReq(t, http.MethodGet, "http", host, "/download", nil))
	if err != nil {
		t.Fatal(err)
	}
	got := sha256.New()
	n, err := io.Copy(got, resp.Body)
	_ = resp.Body.Close()
	exp := sha256.New()
	_, _ = io.Copy(exp, newPattern(size))
	if err != nil || n != size || !bytes.Equal(got.Sum(nil), exp.Sum(nil)) {
		t.Fatalf("GET: %d bytes, err %v, sha256 equal %v", n, err, bytes.Equal(got.Sum(nil), exp.Sum(nil)))
	}
	t.Logf("GET 5 GiB in %s", time.Since(start))
	growth := sampler.stop()
	t.Logf("heap in use grew by %.1f MiB", float64(growth)/(1<<20))
	if raceEnabled {
		t.Log("heap assertion skipped under the race detector")
		return
	}
	if growth >= 64<<20 {
		t.Fatalf("heap in use grew by %d MiB, want < 64 MiB", growth>>20)
	}
}

// pattern is a cheap deterministic body of n bytes.
type pattern struct {
	left int64
	rng  *rand.ChaCha8
}

func newPattern(n int64) *pattern {
	return &pattern{left: n, rng: rand.NewChaCha8([32]byte{1, 2, 3})}
}

func (p *pattern) Read(b []byte) (int, error) {
	if p.left <= 0 {
		return 0, io.EOF
	}
	if int64(len(b)) > p.left {
		b = b[:p.left]
	}
	n, _ := p.rng.Read(b)
	p.left -= int64(n)
	return n, nil
}

// heapSampler records the peak HeapInuse above the baseline taken at start.
type heapSampler struct {
	base  uint64
	stopc chan struct{}
	wg    sync.WaitGroup
	mu    sync.Mutex
	peak  uint64
}

func startHeapSampler() *heapSampler {
	runtime.GC()
	var ms runtime.MemStats
	runtime.ReadMemStats(&ms)
	s := &heapSampler{base: ms.HeapInuse, peak: ms.HeapInuse, stopc: make(chan struct{})}
	s.wg.Go(func() {
		t := time.NewTicker(50 * time.Millisecond)
		defer t.Stop()
		for {
			select {
			case <-s.stopc:
				return
			case <-t.C:
				var ms runtime.MemStats
				runtime.ReadMemStats(&ms)
				s.mu.Lock()
				s.peak = max(s.peak, ms.HeapInuse)
				s.mu.Unlock()
			}
		}
	})
	return s
}

// stop returns the peak growth in bytes.
func (s *heapSampler) stop() uint64 {
	close(s.stopc)
	s.wg.Wait()
	s.mu.Lock()
	defer s.mu.Unlock()
	return s.peak - s.base
}
