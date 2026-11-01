// Package e2e holds the multi-instance end-to-end tests of the gateway:
// three instances on one Postgres, agents over the in-memory tunnel network,
// real local applications and clients on 127.0.0.1.
package e2e_test

import (
	"context"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/coder/websocket"

	"github.com/belov38/umiak/libs/tunnel/tunneltest/pgtest"
	"github.com/belov38/umiak/services/gateway/internal/config"
	"github.com/belov38/umiak/services/gateway/internal/testenv"
)

func TestMain(m *testing.M) { pgtest.Main(m) }

// reqTimeout bounds one request on success paths.
const reqTimeout = 30 * time.Second

// loopPause paces the request loops: ten loops stay below the per-IP rate
// limit of an instance (300/s) and do not exhaust ephemeral ports.
const loopPause = 40 * time.Millisecond

// cluster is three instances A, B and C on one Env. Machines created by
// newMachine connect to C.
type cluster struct {
	env     *testenv.Env
	A, B, C *testenv.Inst
}

// clusterSlots bounds the clusters that run at once. Each Env has its own
// database and a pool of up to max(4, NumCPU) conns; more parallel clusters
// would exceed max_connections (100) of the test Postgres.
var clusterSlots = make(chan struct{}, 4)

// newCluster starts A, B and C with mod applied to every config. It waits
// for a free cluster slot first.
func newCluster(t *testing.T, opts testenv.Options, mod func(*config.Config)) *cluster {
	t.Helper()
	clusterSlots <- struct{}{}
	// Registered before the Env's cleanups, so it runs after them.
	t.Cleanup(func() { <-clusterSlots })
	env := testenv.New(t, opts)
	c := &cluster{env: env}
	c.A = env.StartInstance(mod)
	c.B = env.StartInstance(mod)
	c.C = env.StartInstance(mod)
	return c
}

// newMachine starts a machine whose agent connects to C. New agent dials
// keep going to C only until the test calls RouteOnly again.
func (c *cluster) newMachine(t *testing.T, opts ...testenv.MachineOptions) *testenv.Machine {
	t.Helper()
	c.env.RouteOnly(c.C)
	m := c.env.NewMachine(opts...)
	if o := m.Owner(); o != c.C {
		t.Fatalf("machine owner = %v, want C", o)
	}
	return m
}

// loopClient is a plain client of front for request loops: it keeps enough
// idle conns that a loop does not open a new conn per request.
func loopClient(c *cluster, front *testenv.Inst) *http.Client {
	cl := c.env.PlainClient(front)
	cl.Transport.(*http.Transport).MaxIdleConnsPerHost = 64
	return cl
}

// result is one answer of the gateway.
type result struct {
	status     int
	umiakError string
	retry      string
	body       string
	err        error
	start      time.Time
	took       time.Duration
}

func (r result) String() string {
	if r.err != nil {
		return "error " + r.err.Error()
	}
	return fmt.Sprintf("%d %s %q", r.status, r.umiakError, r.body)
}

// send runs one request and reads the whole body.
func send(c *http.Client, req *http.Request) result {
	r := result{start: time.Now()}
	resp, err := c.Do(req)
	if err != nil {
		r.err = err
		r.took = time.Since(r.start)
		return r
	}
	defer func() { _ = resp.Body.Close() }()
	b, err := io.ReadAll(resp.Body)
	r.took = time.Since(r.start)
	r.status, r.umiakError, r.retry, r.body, r.err = resp.StatusCode, resp.Header.Get("Umiak-Error"), resp.Header.Get("Retry-After"), string(b), err
	return r
}

// newReq builds a request to host; scheme is "http" (plain listener) or
// "https" (TLS listener).
func newReq(t *testing.T, method, scheme, host, pathQuery string, body io.Reader) *http.Request {
	t.Helper()
	ctx, cancel := context.WithTimeout(context.Background(), reqTimeout)
	t.Cleanup(cancel)
	req, err := http.NewRequestWithContext(ctx, method, scheme+"://"+host+pathQuery, body)
	if err != nil {
		t.Fatal(err)
	}
	return req
}

// get sends GET http://host/path over c. It is safe in loops and
// goroutines: it registers no cleanup.
func get(t *testing.T, c *http.Client, host, path string) result {
	t.Helper()
	ctx, cancel := context.WithTimeout(context.Background(), reqTimeout)
	defer cancel()
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, "http://"+host+path, nil)
	if err != nil {
		return result{err: err}
	}
	return send(c, req)
}

// mustGet expects 200 and returns the body.
func mustGet(t *testing.T, c *http.Client, host, path string) string {
	t.Helper()
	r := get(t, c, host, path)
	if r.err != nil || r.status != http.StatusOK {
		t.Fatalf("GET %s%s = %v", host, path, r)
	}
	return r.body
}

// eventually polls cond every 5 ms until it holds or WaitTimeout passed.
func eventually(t *testing.T, what string, cond func() bool) {
	t.Helper()
	deadline := time.Now().Add(testenv.WaitTimeout)
	for !cond() {
		if time.Now().After(deadline) {
			t.Fatalf("timed out waiting for %s", what)
		}
		time.Sleep(5 * time.Millisecond)
	}
}

// within polls cond every 5 ms and fails unless it holds within d.
func within(t *testing.T, d time.Duration, what string, cond func() bool) time.Duration {
	t.Helper()
	start := time.Now()
	for !cond() {
		if time.Since(start) > d {
			t.Fatalf("%s did not happen within %s", what, d)
		}
		time.Sleep(5 * time.Millisecond)
	}
	return time.Since(start)
}

// logLine waits for the access log line of inst with the request id.
func logLine(t *testing.T, inst *testenv.Inst, requestID string) map[string]any {
	t.Helper()
	var found map[string]any
	eventually(t, "access log line "+requestID, func() bool {
		for line := range strings.SplitSeq(inst.AccessLog.String(), "\n") {
			if line == "" {
				continue
			}
			var m map[string]any
			if err := json.Unmarshal([]byte(line), &m); err != nil {
				t.Fatalf("access log line %q: %v", line, err)
			}
			if m["requestId"] == requestID {
				found = m
				return true
			}
		}
		return false
	})
	return found
}

// echoed is what echoApp saw.
type echoed struct {
	Method     string
	Host       string
	Path       string
	RawQuery   string
	RemoteAddr string
	Header     http.Header
}

// echoApp answers every request with a JSON dump of it.
func echoApp() http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		_, _ = io.Copy(io.Discard, r.Body)
		w.Header().Set("Content-Type", "application/json")
		_ = json.NewEncoder(w).Encode(echoed{
			Method: r.Method, Host: r.Host, Path: r.URL.Path, RawQuery: r.URL.RawQuery,
			RemoteAddr: r.RemoteAddr, Header: r.Header,
		})
	})
}

func decodeEcho(t *testing.T, r result) echoed {
	t.Helper()
	if r.err != nil || r.status != http.StatusOK {
		t.Fatalf("echo request = %v", r)
	}
	var e echoed
	if err := json.Unmarshal([]byte(r.body), &e); err != nil {
		t.Fatalf("echo body %q: %v", r.body, err)
	}
	return e
}

// wsEchoApp is a WebSocket echo server. Other requests go to Plain, or get
// "plain" when it is nil.
type wsEchoApp struct {
	Plain http.Handler

	mu   sync.Mutex
	open int
}

func (a *wsEchoApp) ServeHTTP(w http.ResponseWriter, r *http.Request) {
	if !strings.EqualFold(r.Header.Get("Upgrade"), "websocket") {
		if a.Plain != nil {
			a.Plain.ServeHTTP(w, r)
			return
		}
		_, _ = io.WriteString(w, "plain")
		return
	}
	c, err := websocket.Accept(w, r, &websocket.AcceptOptions{InsecureSkipVerify: true})
	if err != nil {
		return
	}
	defer func() { _ = c.CloseNow() }()
	a.add(1)
	defer a.add(-1)
	// The request context is not tied to the hijacked conn; the conn's
	// close ends Read.
	ctx := context.WithoutCancel(r.Context())
	for {
		typ, b, err := c.Read(ctx)
		if err != nil {
			return
		}
		if err := c.Write(ctx, typ, b); err != nil {
			return
		}
	}
}

func (a *wsEchoApp) add(n int) {
	a.mu.Lock()
	a.open += n
	a.mu.Unlock()
}

// Open returns the number of WebSockets the app holds.
func (a *wsEchoApp) Open() int {
	a.mu.Lock()
	defer a.mu.Unlock()
	return a.open
}

// dialWS opens a WebSocket to url over c (HTTP/1.1). A refused handshake
// returns the status and Umiak-Error of the answer with the error.
func dialWS(ctx context.Context, c *http.Client, url string) (ws *websocket.Conn, status int, umiakError string, err error) {
	// coder/websocket owns the response body; it never needs closing.
	ws, resp, err := websocket.Dial(ctx, url, &websocket.DialOptions{HTTPClient: c}) //nolint:bodyclose // see above
	if resp != nil {
		status, umiakError = resp.StatusCode, resp.Header.Get("Umiak-Error")
	}
	return ws, status, umiakError, err
}

// echoOnce writes msg and expects it back.
func echoOnce(ctx context.Context, c *websocket.Conn, msg string) error {
	if err := c.Write(ctx, websocket.MessageText, []byte(msg)); err != nil {
		return err
	}
	_, b, err := c.Read(ctx)
	if err != nil {
		return err
	}
	if string(b) != msg {
		return fmt.Errorf("echo = %q, want %q", b, msg)
	}
	return nil
}
