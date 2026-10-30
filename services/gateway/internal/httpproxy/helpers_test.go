package httpproxy_test

import (
	"bufio"
	"context"
	"encoding/json"
	"io"
	"net"
	"net/http"
	"net/netip"
	"strings"
	"testing"
	"time"

	"github.com/belov38/boat-dev-clone/libs/tunnel/tunneltest/pgtest"
	"github.com/belov38/boat-dev-clone/services/gateway/internal/config"
	"github.com/belov38/boat-dev-clone/services/gateway/internal/testenv"
)

func TestMain(m *testing.M) { pgtest.Main(m) }

// reqTimeout bounds one request on success paths.
const reqTimeout = 30 * time.Second

type fixture struct {
	env  *testenv.Env
	inst *testenv.Inst
	m    *testenv.Machine
	c    *http.Client
}

func newFixture(t *testing.T, mod func(*config.Config)) *fixture {
	t.Helper()
	env := testenv.New(t, testenv.Options{})
	inst := env.StartInstance(mod)
	m := env.NewMachine()
	return &fixture{env: env, inst: inst, m: m, c: env.PlainClient(inst)}
}

func newReq(t *testing.T, method, host, pathQuery string, body io.Reader) *http.Request {
	t.Helper()
	ctx, cancel := context.WithTimeout(context.Background(), reqTimeout)
	t.Cleanup(cancel)
	req, err := http.NewRequestWithContext(ctx, method, "http://"+host+pathQuery, body)
	if err != nil {
		t.Fatal(err)
	}
	return req
}

// do sends req and returns the response; its body is closed at cleanup.
func do(t *testing.T, c *http.Client, req *http.Request) *http.Response {
	t.Helper()
	resp, err := c.Do(req)
	if err != nil {
		t.Fatalf("%s %s: %v", req.Method, req.URL, err)
	}
	t.Cleanup(func() { _ = resp.Body.Close() })
	return resp
}

func readBody(t *testing.T, resp *http.Response) string {
	t.Helper()
	b, err := io.ReadAll(resp.Body)
	if err != nil {
		t.Fatalf("read body: %v", err)
	}
	return string(b)
}

// echoed is what echoApp saw.
type echoed struct {
	Method   string
	Host     string
	Path     string
	RawQuery string
	Proto    string
	Header   http.Header
}

// echoApp answers every request with a JSON dump of it.
func echoApp() http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		_, _ = io.Copy(io.Discard, r.Body)
		w.Header().Set("Content-Type", "application/json")
		_ = json.NewEncoder(w).Encode(echoed{
			Method: r.Method, Host: r.Host, Path: r.URL.Path, RawQuery: r.URL.RawQuery,
			Proto: r.Proto, Header: r.Header,
		})
	})
}

// getEcho sends req to echoApp and returns what the app saw and the
// response header.
func getEcho(t *testing.T, c *http.Client, req *http.Request) (echoed, http.Header) {
	t.Helper()
	resp := do(t, c, req)
	defer func() { _ = resp.Body.Close() }()
	body := readBody(t, resp)
	if resp.StatusCode != http.StatusOK {
		t.Fatalf("status = %d (%s), body %s", resp.StatusCode, resp.Header.Get("Sbx-Error"), body)
	}
	var e echoed
	if err := json.Unmarshal([]byte(body), &e); err != nil {
		t.Fatalf("echo body %q: %v", body, err)
	}
	return e, resp.Header
}

// logLine waits for the access log line with the request id.
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

// rawConn opens a TCP conn to the plain listener of inst.
func rawConn(t *testing.T, inst *testenv.Inst) net.Conn {
	t.Helper()
	c, err := (&net.Dialer{Timeout: reqTimeout}).DialContext(context.Background(), "tcp", inst.PlainAddr)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = c.Close() })
	return c
}

// upgradeRequest writes an HTTP/1.1 WebSocket upgrade and reads the answer.
func upgradeRequest(t *testing.T, c net.Conn, host, path string) (*http.Response, *bufio.Reader) {
	t.Helper()
	_ = c.SetDeadline(time.Now().Add(reqTimeout))
	req := "GET " + path + " HTTP/1.1\r\nHost: " + host + "\r\nUpgrade: websocket\r\nConnection: Upgrade\r\n" +
		"Sec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==\r\nSec-WebSocket-Version: 13\r\nX-Request-Id: ws-" + path[1:] + "\r\n\r\n"
	if _, err := io.WriteString(c, req); err != nil {
		t.Fatal(err)
	}
	br := bufio.NewReader(c)
	resp, err := http.ReadResponse(br, nil)
	if err != nil {
		t.Fatalf("read upgrade response: %v", err)
	}
	return resp, br
}

func cidrs(t *testing.T, s ...string) []netip.Prefix {
	t.Helper()
	out := make([]netip.Prefix, 0, len(s))
	for _, p := range s {
		pp, err := netip.ParsePrefix(p)
		if err != nil {
			t.Fatal(err)
		}
		out = append(out, pp)
	}
	return out
}
