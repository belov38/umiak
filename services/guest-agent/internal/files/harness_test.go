package files

import (
	"bytes"
	"context"
	"crypto/rand"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"net/http/httptest"
	"net/url"
	"os"
	"os/user"
	"path/filepath"
	"strings"
	"sync"
	"testing"
	"time"

	"connectrpc.com/connect"
	"google.golang.org/protobuf/encoding/protojson"

	agentv1 "github.com/belov38/boat-dev-clone/libs/proto/sbx/agent/v1"
	"github.com/belov38/boat-dev-clone/libs/proto/sbx/agent/v1/agentv1connect"
	"github.com/belov38/boat-dev-clone/libs/tunnel/wire"

	"github.com/belov38/boat-dev-clone/services/guest-agent/internal/paths"
	"github.com/belov38/boat-dev-clone/services/guest-agent/internal/process"
	"github.com/belov38/boat-dev-clone/services/guest-agent/internal/reqcache"
	"github.com/belov38/boat-dev-clone/services/guest-agent/internal/store"
)

// clock is a settable test clock.
type clock struct {
	mu  sync.Mutex
	now time.Time
}

func (c *clock) Now() time.Time {
	c.mu.Lock()
	defer c.mu.Unlock()
	return c.now
}

func (c *clock) Add(d time.Duration) {
	c.mu.Lock()
	c.now = c.now.Add(d)
	c.mu.Unlock()
}

// harness is a Service over a real store in a temporary root, served over
// HTTP with both its Connect handler and its /files handler. The request
// user is the current user.
type harness struct {
	t      *testing.T
	root   string // scratch directory for test files
	layout paths.Layout
	st     *store.Store
	clock  *clock
	svc    *Service
	srv    *httptest.Server
	fs     agentv1connect.FilesystemClient
	user   *process.User
}

func newHarness(t *testing.T, mods ...func(*Options)) *harness {
	t.Helper()
	base := t.TempDir()
	l := paths.ForRoot(filepath.Join(base, "agent"))
	if err := os.MkdirAll(l.StateDir, 0o700); err != nil {
		t.Fatal(err)
	}
	st, err := store.Open(l.StateDB, store.Options{})
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = st.Close() })
	cu, err := user.Current()
	if err != nil {
		t.Fatal(err)
	}
	u, err := process.LookupUser(cu.Username)
	if err != nil {
		t.Fatal(err)
	}
	root := filepath.Join(base, "work")
	if err := os.MkdirAll(root, 0o755); err != nil {
		t.Fatal(err)
	}
	c := &clock{now: time.Date(2026, 10, 30, 12, 0, 0, 0, time.UTC)}
	opts := Options{
		Store:          st,
		Layout:         l,
		DefaultUser:    cu.Username,
		Now:            c.Now,
		DurableTimeout: 2 * time.Second,
		HandlerOptions: reqcache.Interceptors(st),
	}
	for _, mod := range mods {
		mod(&opts)
	}
	svc, err := New(opts)
	if err != nil {
		t.Fatalf("New: %v", err)
	}
	connectPath, connectHandler := svc.ConnectHandler()
	filesHandler := svc.HTTPHandler()
	// Route by prefix instead of http.ServeMux: the mux would clean and
	// redirect paths with "." segments before the handler sees them.
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if strings.HasPrefix(r.URL.Path, connectPath) {
			connectHandler.ServeHTTP(w, r)
			return
		}
		filesHandler.ServeHTTP(w, r)
	}))
	t.Cleanup(srv.Close)
	h := &harness{t: t, root: root, layout: l, st: st, clock: c, svc: svc, srv: srv, user: u}
	h.fs = agentv1connect.NewFilesystemClient(srv.Client(), srv.URL, connect.WithInterceptors(requestIDs{}))
	return h
}

// requestIDs adds a fresh Sbx-Request-Id to every call.
type requestIDs struct{}

func (requestIDs) WrapUnary(next connect.UnaryFunc) connect.UnaryFunc {
	return func(ctx context.Context, req connect.AnyRequest) (connect.AnyResponse, error) {
		req.Header().Set(wire.HeaderRequestID, newUUID())
		return next(ctx, req)
	}
}

func (requestIDs) WrapStreamingClient(next connect.StreamingClientFunc) connect.StreamingClientFunc {
	return next
}

func (requestIDs) WrapStreamingHandler(next connect.StreamingHandlerFunc) connect.StreamingHandlerFunc {
	return next
}

func newUUID() string {
	var b [16]byte
	_, _ = rand.Read(b[:])
	b[6] = b[6]&0x0f | 0x40
	b[8] = b[8]&0x3f | 0x80
	s := hex.EncodeToString(b[:])
	return s[:8] + "-" + s[8:12] + "-" + s[12:16] + "-" + s[16:20] + "-" + s[20:]
}

func (h *harness) ctx() context.Context {
	ctx, cancel := context.WithTimeout(h.t.Context(), 30*time.Second)
	h.t.Cleanup(cancel)
	return ctx
}

// path returns a path under the scratch directory.
func (h *harness) path(elem ...string) string {
	return filepath.Join(append([]string{h.root}, elem...)...)
}

// response is a finished HTTP response with its body read.
type response struct {
	StatusCode int
	Header     http.Header
	Body       []byte
}

// do sends a request with a raw (already escaped) path and query and reads
// the whole response.
func (h *harness) do(method, rawPath string, query url.Values, body io.Reader, hdr http.Header) *response {
	h.t.Helper()
	u := h.srv.URL + rawPath
	if len(query) > 0 {
		u += "?" + query.Encode()
	}
	req, err := http.NewRequestWithContext(h.ctx(), method, u, body)
	if err != nil {
		h.t.Fatal(err)
	}
	for k, v := range hdr {
		req.Header[k] = v
	}
	res, err := h.srv.Client().Do(req)
	if err != nil {
		h.t.Fatalf("%s %s: %v", method, rawPath, err)
	}
	defer func() { _ = res.Body.Close() }()
	b, err := io.ReadAll(res.Body)
	if err != nil {
		h.t.Fatalf("%s %s: read body: %v", method, rawPath, err)
	}
	return &response{StatusCode: res.StatusCode, Header: res.Header, Body: b}
}

// errorBody is the JSON error of /files.
type errorBody struct {
	Code           string `json:"code"`
	Message        string `json:"message"`
	Retryable      bool   `json:"retryable"`
	EntriesWritten *int   `json:"entries_written"`
}

// wantError checks the status and the JSON error code of res.
func wantError(t *testing.T, res *response, status int, code string) errorBody {
	t.Helper()
	body := res.Body
	if res.StatusCode != status {
		t.Fatalf("status = %d, want %d; body %s", res.StatusCode, status, body)
	}
	var e errorBody
	if err := json.Unmarshal(body, &e); err != nil {
		t.Fatalf("error body %q: %v", body, err)
	}
	if e.Code != code {
		t.Fatalf("error code = %q, want %q (message %q)", e.Code, code, e.Message)
	}
	return e
}

// wantStatus checks the status and returns the body.
func wantStatus(t *testing.T, res *response, status int) []byte {
	t.Helper()
	body := res.Body
	if res.StatusCode != status {
		t.Fatalf("status = %d, want %d; body %s", res.StatusCode, status, body)
	}
	return body
}

// fileInfo decodes a FileInfo JSON response.
func fileInfo(t *testing.T, body []byte) *agentv1.FileInfo {
	t.Helper()
	var fi agentv1.FileInfo
	if err := protojson.Unmarshal(body, &fi); err != nil {
		t.Fatalf("FileInfo %s: %v", body, err)
	}
	return &fi
}

// writeFile creates a file with content and mode under the scratch dir.
func (h *harness) writeFile(rel string, data []byte, mode os.FileMode) string {
	h.t.Helper()
	p := h.path(rel)
	if err := os.MkdirAll(filepath.Dir(p), 0o755); err != nil {
		h.t.Fatal(err)
	}
	if err := os.WriteFile(p, data, mode); err != nil {
		h.t.Fatal(err)
	}
	if err := os.Chmod(p, mode); err != nil {
		h.t.Fatal(err)
	}
	return p
}

// randomBytes returns n pseudo-random bytes.
func randomBytes(n int) []byte {
	b := make([]byte, n)
	_, _ = rand.Read(b)
	return b
}

// q builds query values from key/value pairs.
func q(kv ...string) url.Values {
	v := url.Values{}
	for i := 0; i+1 < len(kv); i += 2 {
		v.Set(kv[i], kv[i+1])
	}
	return v
}

func mustEqualBytes(t *testing.T, what string, got, want []byte) {
	t.Helper()
	if !bytes.Equal(got, want) {
		t.Fatalf("%s: got %d bytes, want %d bytes (content differs)", what, len(got), len(want))
	}
}

func itoa(n int) string { return fmt.Sprint(n) }
