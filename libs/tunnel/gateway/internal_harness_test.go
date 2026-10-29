package gateway

import (
	"bytes"
	"context"
	"crypto/sha256"
	"fmt"
	"io"
	"net"
	"net/http"
	"strings"
	"sync"
	"testing"
	"time"

	"connectrpc.com/connect"

	"github.com/belov38/boat-dev-clone/libs/tunnel/agent"
	"github.com/belov38/boat-dev-clone/libs/tunnel/transport"
	testingv1 "github.com/belov38/boat-dev-clone/libs/tunnel/tunneltest/testpb/sbx/testing/v1"
	"github.com/belov38/boat-dev-clone/libs/tunnel/tunneltest/testpb/sbx/testing/v1/testingv1connect"
)

// Service tokens of the internal listener in these tests.
const (
	apiToken1   = "api-token-1"
	apiToken2   = "api-token-2"
	workerToken = "worker-token"
)

func testTokens() TokenSet {
	return TokenSet{"api": {apiToken1, apiToken2}, "worker": {workerToken}}
}

// internalGW is a running gateway with its internal listener on 127.0.0.1.
type internalGW struct {
	*testGW
	url string
}

// internalGateway starts a gateway whose InternalURL is a real internal
// listener served by NewInternalServer.
func (e *env) internalGateway(name string, mod func(*Config)) *internalGW {
	e.t.Helper()
	ln := listenLocal(e.t)
	u := "http://" + ln.Addr().String()
	gw := e.gateway(name, func(c *Config) {
		c.InternalURL = u
		c.ServiceTokens = testTokens()
		c.AllowedServicePrefixes = []string{"sbx.agent.v1.", "sbx.testing.v1."}
		if mod != nil {
			mod(c)
		}
	})
	srv := NewInternalServer(gw.InternalHandler())
	done := make(chan struct{})
	go func() {
		defer close(done)
		_ = srv.Serve(ln)
	}()
	e.t.Cleanup(func() {
		_ = srv.Close()
		<-done
	})
	return &internalGW{testGW: gw, url: u}
}

// machineURL is the base of the machine routes on the internal listener.
func (g *internalGW) machineURL(id string) string { return g.url + "/v1/machines/" + id }

// bearerRT adds the service token to every request.
type bearerRT struct {
	rt    http.RoundTripper
	token string
}

func (b bearerRT) RoundTrip(r *http.Request) (*http.Response, error) {
	r = r.Clone(r.Context())
	if b.token != "" {
		r.Header.Set("Authorization", "Bearer "+b.token)
	}
	return b.rt.RoundTrip(r)
}

// peerClient is an h2c client (NewPeerTransport) presenting token.
func peerClient(t *testing.T, token string) *http.Client {
	t.Helper()
	tr := NewPeerTransport()
	t.Cleanup(tr.CloseIdleConnections)
	return &http.Client{Transport: bearerRT{rt: tr, token: token}}
}

func processClient(t *testing.T, g *internalGW, id, token string) testingv1connect.ProcessClient {
	t.Helper()
	return testingv1connect.NewProcessClient(peerClient(t, token), g.machineURL(id)+"/rpc")
}

// rawResp is a response with its body read.
type rawResp struct {
	StatusCode int
	Header     http.Header
}

// do sends a raw request and returns the response with its body read.
func do(t *testing.T, c *http.Client, method, url, contentType string, body []byte) (rawResp, []byte) {
	t.Helper()
	ctx, cancel := context.WithTimeout(context.Background(), waitTimeout)
	defer cancel()
	req, err := http.NewRequestWithContext(ctx, method, url, bytes.NewReader(body))
	if err != nil {
		t.Fatal(err)
	}
	if contentType != "" {
		req.Header.Set("Content-Type", contentType)
	}
	resp, err := c.Do(req)
	if err != nil {
		t.Fatalf("%s %s: %v", method, url, err)
	}
	defer func() { _ = resp.Body.Close() }()
	b, err := io.ReadAll(resp.Body)
	if err != nil {
		t.Fatalf("%s %s: read body: %v", method, url, err)
	}
	return rawResp{StatusCode: resp.StatusCode, Header: resp.Header}, b
}

// listenLocal listens on 127.0.0.1 on a random port.
func listenLocal(t *testing.T) *net.TCPListener {
	t.Helper()
	ln, err := net.ListenTCP("tcp", &net.TCPAddr{IP: net.IPv4(127, 0, 0, 1)})
	if err != nil {
		t.Fatal(err)
	}
	return ln
}

// dialLocal opens a TCP connection to addr.
func dialLocal(t *testing.T, addr string) net.Conn {
	t.Helper()
	c, err := (&net.Dialer{Timeout: waitTimeout}).DialContext(context.Background(), "tcp", addr)
	if err != nil {
		t.Fatal(err)
	}
	return c
}

// fileContent is served by the stub agent at GET /files.
var fileContent = func() []byte {
	b := make([]byte, 1000)
	for i := range b {
		b[i] = byte('a' + i%26)
	}
	return b
}()

// upload is one PUT /files/uploads/{id} seen by the stub agent.
type upload struct {
	path, query string
	size        int64
	sum         [32]byte
	header      http.Header
}

// stubAgent is the agent Handler of these tests: a stub sbx.testing.v1.Process
// and /files handlers, recording the request headers it sees.
type stubAgent struct {
	testingv1connect.UnimplementedProcessHandler

	mu      sync.Mutex
	headers map[string]http.Header // last request headers by path
	calls   uint64
	uploads []upload
	// attachOpen is signalled when an Attach call has sent its first messages.
	attachOpen chan struct{}
}

// attachMessages is the number of messages Attach sends before it idles.
const attachMessages = 3

func newStubAgent() *stubAgent {
	return &stubAgent{headers: map[string]http.Header{}, attachOpen: make(chan struct{}, 16)}
}

func (s *stubAgent) handler() http.Handler {
	mux := http.NewServeMux()
	path, h := testingv1connect.NewProcessHandler(s)
	mux.Handle(path, h)
	mux.HandleFunc("GET /files", func(w http.ResponseWriter, r *http.Request) {
		http.ServeContent(w, r, r.URL.Query().Get("path"), time.Time{}, bytes.NewReader(fileContent))
	})
	mux.HandleFunc("PUT /files/uploads/{id}", func(w http.ResponseWriter, r *http.Request) {
		h := sha256.New()
		n, err := io.Copy(h, r.Body)
		if err != nil {
			http.Error(w, err.Error(), http.StatusBadRequest)
			return
		}
		u := upload{path: r.URL.Path, query: r.URL.RawQuery, size: n, header: r.Header.Clone()}
		copy(u.sum[:], h.Sum(nil))
		s.mu.Lock()
		s.uploads = append(s.uploads, u)
		s.mu.Unlock()
		w.Header().Set("Content-Type", "application/json")
		_, _ = fmt.Fprintf(w, `{"size":%d}`, n)
	})
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		s.mu.Lock()
		s.headers[r.URL.Path] = r.Header.Clone()
		s.mu.Unlock()
		mux.ServeHTTP(w, r)
	})
}

// header returns the last request headers seen for path.
func (s *stubAgent) header(path string) http.Header {
	s.mu.Lock()
	defer s.mu.Unlock()
	return s.headers[path]
}

func (s *stubAgent) lastUpload() (upload, bool) {
	s.mu.Lock()
	defer s.mu.Unlock()
	if len(s.uploads) == 0 {
		return upload{}, false
	}
	return s.uploads[len(s.uploads)-1], true
}

func dataEvent(offset uint64, data []byte) *testingv1.AttachResponse {
	return &testingv1.AttachResponse{Event: &testingv1.AttachResponse_Data{Data: &testingv1.DataEvent{
		Stream: testingv1.Stream_STREAM_STDOUT, Offset: offset, Data: data,
	}}}
}

func lineData(i, n int) []byte { return bytes.Repeat([]byte{byte('a' + i%26)}, n) }

func (s *stubAgent) SetLabel(_ context.Context, _ *connect.Request[testingv1.SetLabelRequest]) (*connect.Response[testingv1.SetLabelResponse], error) {
	s.mu.Lock()
	s.calls++
	n := s.calls
	s.mu.Unlock()
	return connect.NewResponse(&testingv1.SetLabelResponse{Calls: n}), nil
}

// Run streams spec.lines data events of spec.line_bytes, then an exit event.
func (s *stubAgent) Run(_ context.Context, req *connect.Request[testingv1.RunRequest], stream *connect.ServerStream[testingv1.AttachResponse]) error {
	spec := req.Msg.GetSpec()
	lb := int(spec.GetLineBytes())
	for i := range int(spec.GetLines()) {
		if err := stream.Send(dataEvent(uint64(i*lb), lineData(i, lb))); err != nil { //nolint:gosec // test sizes are small
			return err
		}
	}
	return stream.Send(&testingv1.AttachResponse{Event: &testingv1.AttachResponse_Exit{Exit: &testingv1.ExitEvent{
		Status: testingv1.ExitStatus_EXIT_STATUS_EXITED, Code: spec.GetExitCode(),
		StdoutEnd: uint64(int(spec.GetLines()) * lb), //nolint:gosec // test sizes are small
	}}})
}

// Attach sends attachMessages data events of 100 bytes, then holds the
// stream open like a running command until the call ends.
func (s *stubAgent) Attach(ctx context.Context, _ *connect.Request[testingv1.AttachRequest], stream *connect.ServerStream[testingv1.AttachResponse]) error {
	for i := range attachMessages {
		if err := stream.Send(dataEvent(uint64(i*100), lineData(i, 100))); err != nil { //nolint:gosec // small
			return err
		}
	}
	select {
	case s.attachOpen <- struct{}{}:
	default:
	}
	<-ctx.Done()
	return ctx.Err()
}

// startStubAgent runs an agent serving stub and waits until gw serves it.
func (e *env) startStubAgent(id string, bs []byte, stub *stubAgent, dialer transport.Dialer) *testAgent {
	e.t.Helper()
	cfg := agentConfig(e, id, bs, defaultIdentity())
	cfg.Handler = stub.handler()
	if dialer != nil {
		cfg.Dialer = dialer
	}
	a := e.startAgent(cfg)
	a.waitConnected()
	return a
}

// recDialer records the hello of every dial.
type recDialer struct {
	d      transport.Dialer
	mu     sync.Mutex
	hellos []transport.Hello
}

func (r *recDialer) Dial(ctx context.Context, h transport.Hello) (net.Conn, transport.ConnInfo, error) {
	r.mu.Lock()
	r.hellos = append(r.hellos, h)
	r.mu.Unlock()
	return r.d.Dial(ctx, h)
}

func (r *recDialer) last() transport.Hello {
	r.mu.Lock()
	defer r.mu.Unlock()
	return r.hellos[len(r.hellos)-1]
}

// waitConnectedTo waits for the agent to connect to the named gateway.
func waitConnectedTo(a *testAgent, gw string) agent.ConnEvent {
	a.t.Helper()
	return a.waitEvent("connected to "+gw, func(ev agent.ConnEvent) bool {
		return ev.Kind == agent.KindConnected && ev.Gateway == gw
	})
}

// tcpCount returns the open TCP streams of the local session of a machine.
func tcpCount(gw *testGW, id string) int {
	s, _ := gw.lookup(id)
	if s == nil {
		return 0
	}
	s.mu.Lock()
	defer s.mu.Unlock()
	return s.tcpCount
}

// readAllString reads c until EOF or error and returns what it got.
func readAllString(c net.Conn) (string, error) {
	var sb strings.Builder
	_, err := io.Copy(&sb, c)
	return sb.String(), err
}

func processClientFor(c *http.Client, g *internalGW, id string) testingv1connect.ProcessClient {
	return testingv1connect.NewProcessClient(c, g.machineURL(id)+"/rpc")
}

// watchdog closes c after waitTimeout so a stuck read fails the test
// instead of hanging it (remote conns have no deadlines).
func watchdog(t *testing.T, c net.Conn) {
	t.Helper()
	timer := time.AfterFunc(waitTimeout, func() {
		t.Errorf("watchdog: closing a stuck conn after %s", waitTimeout)
		_ = c.Close()
	})
	t.Cleanup(func() { timer.Stop() })
}
