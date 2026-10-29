package gateway

import (
	"bufio"
	"bytes"
	"context"
	"crypto/rand"
	"crypto/sha256"
	"encoding/json"
	"errors"
	"io"
	"net"
	"net/http"
	"strconv"
	"strings"
	"testing"
	"time"

	"connectrpc.com/connect"
	"github.com/google/uuid"
	xhttp2 "golang.org/x/net/http2"

	"github.com/belov38/boat-dev-clone/libs/tunnel/registry"
	"github.com/belov38/boat-dev-clone/libs/tunnel/rpcconv"
	"github.com/belov38/boat-dev-clone/libs/tunnel/transport"
	testingv1 "github.com/belov38/boat-dev-clone/libs/tunnel/tunneltest/testpb/sbx/testing/v1"
	"github.com/belov38/boat-dev-clone/libs/tunnel/tunneltest/testpb/sbx/testing/v1/testingv1connect"
	"github.com/belov38/boat-dev-clone/libs/tunnel/wire"
)

const setLabelPath = "/sbx.testing.v1.Process/SetLabel"

func setLabel(ctx context.Context, t *testing.T, g *internalGW, id, token string) (*connect.Response[testingv1.SetLabelResponse], error) {
	t.Helper()
	return processClient(t, g, id, token).SetLabel(ctx, connect.NewRequest(&testingv1.SetLabelRequest{CommandId: "c1", Label: "x"}))
}

func TestServiceTokenRequired(t *testing.T) {
	e := newEnv(t)
	gw := e.internalGateway("gw-a", nil)
	id, bs := e.machine()
	stub := newStubAgent()
	e.startStubAgent(id, bs, stub, nil)
	waitMachine(t, gw.testGW, id)
	ctx := context.Background()
	rpcURL := gw.machineURL(id) + "/rpc" + setLabelPath

	for name, tok := range map[string]string{"missing": "", "wrong": "nope", "other caller's prefix": apiToken1 + "x"} {
		resp, _ := do(t, peerClient(t, tok), http.MethodPost, rpcURL, "application/json", []byte(`{}`))
		if resp.StatusCode != http.StatusUnauthorized {
			t.Fatalf("%s token: status %d, want 401", name, resp.StatusCode)
		}
		if _, err := setLabel(ctx, t, gw, id, tok); connect.CodeOf(err) != connect.CodeUnauthenticated {
			t.Fatalf("%s token: Connect error %v, want unauthenticated", name, err)
		}
		resp, _ = do(t, peerClient(t, tok), http.MethodGet, gw.machineURL(id)+"/files?path=x", "", nil)
		if resp.StatusCode != http.StatusUnauthorized {
			t.Fatalf("%s token on /files: status %d, want 401", name, resp.StatusCode)
		}
		_, err := DialRemoteTCP(ctx, NewPeerTransport(), gw.url, tok, id, 22, TCPOptions{})
		var de *transport.DialError
		if !errors.As(err, &de) || de.Status != http.StatusUnauthorized {
			t.Fatalf("%s token on CONNECT: err %v, want DialError 401", name, err)
		}
	}

	// The second token of a caller works; the agent sees the caller, never the token.
	c := peerClient(t, apiToken2)
	req := connect.NewRequest(&testingv1.SetLabelRequest{CommandId: "c1"})
	req.Header().Set(wire.HeaderCaller, "worker") // spoofed: replaced by the gateway
	if _, err := processClientFor(c, gw, id).SetLabel(ctx, req); err != nil {
		t.Fatalf("SetLabel with the second api token: %v", err)
	}
	h := stub.header(setLabelPath)
	if got := h.Values(wire.HeaderCaller); len(got) != 1 || got[0] != "api" {
		t.Fatalf("agent saw %s = %q, want [api]", wire.HeaderCaller, got)
	}
	if h.Get("Authorization") != "" {
		t.Fatalf("agent saw Authorization %q", h.Get("Authorization"))
	}
	if _, err := setLabel(ctx, t, gw, id, workerToken); err != nil {
		t.Fatalf("SetLabel with the worker token: %v", err)
	}
	if got := stub.header(setLabelPath).Get(wire.HeaderCaller); got != "worker" {
		t.Fatalf("agent saw %s = %q, want worker", wire.HeaderCaller, got)
	}
}

func TestTunnelServiceForbidden(t *testing.T) {
	e := newEnv(t)
	gw := e.internalGateway("gw-a", nil)
	id, bs := e.machine()
	stub := newStubAgent()
	e.startStubAgent(id, bs, stub, nil)
	waitMachine(t, gw.testGW, id)
	c := peerClient(t, apiToken1)

	for _, p := range []string{"/sbx.tunnel.v1.Control/Info", "/sbx.tunnel.v1.Control/SetToken", "/sbx.other.v1.X/Y"} {
		resp, _ := do(t, c, http.MethodPost, gw.machineURL(id)+"/rpc"+p, "application/json", []byte(`{}`))
		if resp.StatusCode != http.StatusForbidden {
			t.Fatalf("%s: status %d, want 403", p, resp.StatusCode)
		}
	}
	if h := stub.header("/sbx.other.v1.X/Y"); h != nil {
		t.Fatal("a forbidden call reached the agent")
	}

	// sbx.tunnel.v1 stays forbidden even when a prefix would allow it.
	wide := e.internalGateway("gw-wide", func(c *Config) { c.AllowedServicePrefixes = []string{"sbx."} })
	resp, _ := do(t, c, http.MethodPost, wide.machineURL(id)+"/rpc/sbx.tunnel.v1.Control/Info", "application/json", []byte(`{}`))
	if resp.StatusCode != http.StatusForbidden {
		t.Fatalf("tunnel service with prefix sbx.: status %d, want 403", resp.StatusCode)
	}
}

func TestInternalBadRequests(t *testing.T) {
	e := newEnv(t)
	gw := e.internalGateway("gw-a", nil)
	c := peerClient(t, apiToken1)
	id := uuid.NewString()

	cases := []struct {
		method, path string
		status       int
	}{
		{http.MethodPost, "/v1/machines/not-a-uuid/rpc" + setLabelPath, http.StatusBadRequest},
		{http.MethodGet, "/v1/machines/" + strings.ReplaceAll(id, "-", "") + "/files?path=x", http.StatusBadRequest},
		{http.MethodPost, "/v1/machines/not-a-uuid/rotate-token", http.StatusBadRequest},
		{http.MethodGet, "/v1/machines/" + id + "/rotate-token", http.StatusMethodNotAllowed},
		{http.MethodGet, "/v1/machines/" + id + "/other", http.StatusNotFound},
		{http.MethodGet, "/v1/other", http.StatusNotFound},
		// Traversal and separator segments, escaped or not.
		{http.MethodGet, "/v1/machines/" + id + "/files/%2E%2E/x", http.StatusBadRequest},
		{http.MethodGet, "/v1/machines/" + id + "/files/../x", http.StatusBadRequest},
		{http.MethodGet, "/v1/machines/" + id + "/files/./x", http.StatusBadRequest},
		{http.MethodGet, "/v1/machines/" + id + "/files/a%2Fb", http.StatusBadRequest},
		{http.MethodGet, "/v1/machines/" + id + "/files/a%5Cb", http.StatusBadRequest},
		{http.MethodPost, "/v1/machines/" + id + "/rpc/sbx.agent.v1.X/..", http.StatusBadRequest},
		{http.MethodPost, "/v1/machines/" + id + "/rpc/sbx.agent.v1.X/%2E%2E", http.StatusBadRequest},
		{http.MethodPost, "/v1/machines/" + id + "/rpc/sbx.agent.v1.X/...", http.StatusBadRequest},
		{http.MethodPost, "/v1/machines/" + id + "/rpc/sbx.agent.v1.X/1Run", http.StatusBadRequest},
		{http.MethodPost, "/v1/machines/" + id + "/rpc/.sbx.agent.v1.X/Run", http.StatusBadRequest},
	}
	for _, tc := range cases {
		resp, _ := do(t, c, tc.method, gw.url+tc.path, "application/json", nil)
		if resp.StatusCode != tc.status {
			t.Errorf("%s %s: status %d, want %d", tc.method, tc.path, resp.StatusCode, tc.status)
		}
	}

	ctx := context.Background()
	for _, tc := range []struct {
		id   string
		port uint16
	}{{"not-a-uuid", 22}, {id, 0}} {
		_, err := DialRemoteTCP(ctx, NewPeerTransport(), gw.url, apiToken1, tc.id, tc.port, TCPOptions{})
		var de *transport.DialError
		if !errors.As(err, &de) || de.Status != http.StatusBadRequest {
			t.Errorf("CONNECT %s:%d: err %v, want DialError 400", tc.id, tc.port, err)
		}
	}
}

func TestUnaryAndStreamProxy(t *testing.T) {
	e := newEnv(t)
	gw := e.internalGateway("gw-a", nil)
	id, bs := e.machine()
	stub := newStubAgent()
	e.startStubAgent(id, bs, stub, nil)
	waitMachine(t, gw.testGW, id)
	c := processClient(t, gw, id, apiToken1)
	ctx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
	defer cancel()

	req := connect.NewRequest(&testingv1.SetLabelRequest{CommandId: "c1", Label: "x"})
	req.Header().Set(wire.HeaderRequestID, "req-1")
	resp, err := c.SetLabel(ctx, req)
	if err != nil {
		t.Fatalf("SetLabel: %v", err)
	}
	if resp.Msg.GetCalls() != 1 {
		t.Fatalf("calls = %d, want 1", resp.Msg.GetCalls())
	}
	h := stub.header(setLabelPath)
	if h.Get(wire.HeaderRequestID) != "req-1" {
		t.Fatalf("agent saw %s = %q", wire.HeaderRequestID, h.Get(wire.HeaderRequestID))
	}
	if h.Get("Connect-Timeout-Ms") == "" || h.Get("Connect-Protocol-Version") != "1" {
		t.Fatalf("agent did not see the Connect headers: %v", h)
	}

	stream, err := c.Run(ctx, connect.NewRequest(&testingv1.RunRequest{
		CommandId: "c2", Spec: &testingv1.CommandSpec{Lines: 100, LineBytes: 100, ExitCode: 3},
	}))
	if err != nil {
		t.Fatalf("Run: %v", err)
	}
	defer func() { _ = stream.Close() }()
	n := 0
	var exit *testingv1.ExitEvent
	for stream.Receive() {
		msg := stream.Msg()
		if d := msg.GetData(); d != nil {
			if d.GetOffset() != uint64(n*100) || !bytes.Equal(d.GetData(), lineData(n, 100)) { //nolint:gosec // small
				t.Fatalf("message %d: offset %d, data %q", n, d.GetOffset(), d.GetData())
			}
			n++
			continue
		}
		exit = msg.GetExit()
	}
	if err := stream.Err(); err != nil {
		t.Fatalf("Run stream: %v", err)
	}
	if n != 100 || exit == nil || exit.GetCode() != 3 || exit.GetStdoutEnd() != 10000 {
		t.Fatalf("got %d data messages, exit %v", n, exit)
	}

	// gRPC passes through too: its status travels in HTTP trailers.
	g := testingv1connect.NewProcessClient(peerClient(t, apiToken1), gw.machineURL(id)+"/rpc", connect.WithGRPC())
	if resp, err := g.SetLabel(ctx, connect.NewRequest(&testingv1.SetLabelRequest{CommandId: "c3"})); err != nil || resp.Msg.GetCalls() != 2 {
		t.Fatalf("gRPC SetLabel: %v, %v", resp, err)
	}
	gs, err := g.Run(ctx, connect.NewRequest(&testingv1.RunRequest{CommandId: "c4", Spec: &testingv1.CommandSpec{Lines: 10, LineBytes: 10}}))
	if err != nil {
		t.Fatalf("gRPC Run: %v", err)
	}
	n = 0
	for gs.Receive() {
		n++
	}
	if err := gs.Err(); err != nil || n != 11 {
		t.Fatalf("gRPC Run: %d messages, %v", n, err)
	}
	_ = gs.Close()
	if _, err := g.Signal(ctx, connect.NewRequest(&testingv1.SignalRequest{})); connect.CodeOf(err) != connect.CodeUnimplemented {
		t.Fatalf("gRPC error status: %v, want unimplemented from the agent", err)
	}
}

// checkUnavailable checks a Connect error from the internal listener.
func checkUnavailable(t *testing.T, err error, code, instanceURL string) {
	t.Helper()
	var cerr *connect.Error
	if !errors.As(err, &cerr) || cerr.Code() != connect.CodeUnavailable {
		t.Fatalf("err = %v, want Connect unavailable", err)
	}
	if cerr.Message() != code {
		t.Fatalf("message = %q, want %q", cerr.Message(), code)
	}
	d, ok := rpcconv.Detail(err)
	if !ok || d.GetCode() != code || !d.GetRetryable() || d.GetInstanceUrl() != instanceURL {
		t.Fatalf("detail = %v, want {%s retryable %q}", d, code, instanceURL)
	}
	if got := cerr.Meta().Get(wire.HeaderErrorCode); got != code {
		t.Fatalf("metadata %s = %q, want %q", wire.HeaderErrorCode, got, code)
	}
	if got := cerr.Meta().Get(wire.HeaderInstanceURL); got != instanceURL {
		t.Fatalf("metadata %s = %q, want %q", wire.HeaderInstanceURL, got, instanceURL)
	}
}

// filesError is the JSON body of 421/503 on /files and other non-RPC routes.
type filesError struct {
	Code        string `json:"code"`
	InstanceURL string `json:"instanceUrl"`
}

func checkRaw(t *testing.T, resp rawResp, body []byte, status int, code, instanceURL string) {
	t.Helper()
	if resp.StatusCode != status {
		t.Fatalf("status %d, want %d (body %s)", resp.StatusCode, status, body)
	}
	if got := resp.Header.Values(wire.HeaderErrorCode); len(got) != 1 || got[0] != code {
		t.Fatalf("%s = %q, want [%s]", wire.HeaderErrorCode, got, code)
	}
	if got := resp.Header.Values(wire.HeaderInstanceURL); strings.Join(got, ",") != instanceURL {
		t.Fatalf("%s = %q, want %q", wire.HeaderInstanceURL, got, instanceURL)
	}
	if ct := resp.Header.Get("Content-Type"); ct != "application/json" {
		t.Fatalf("Content-Type = %q, want application/json", ct)
	}
	wantRetry := ""
	if status == http.StatusServiceUnavailable {
		wantRetry = "1"
	}
	if got := resp.Header.Get("Retry-After"); got != wantRetry {
		t.Fatalf("Retry-After = %q, want %q", got, wantRetry)
	}
}

func checkRPCBody(t *testing.T, body []byte, code string) {
	t.Helper()
	var wireErr struct {
		Code    string `json:"code"`
		Message string `json:"message"`
		Details []struct {
			Type  string `json:"type"`
			Value string `json:"value"`
		} `json:"details"`
	}
	if err := json.Unmarshal(body, &wireErr); err != nil {
		t.Fatalf("body %s: %v", body, err)
	}
	if wireErr.Code != "unavailable" || wireErr.Message != code || len(wireErr.Details) != 1 ||
		wireErr.Details[0].Type != "sbx.tunnel.v1.ErrorDetail" || wireErr.Details[0].Value == "" {
		t.Fatalf("body = %s", body)
	}
}

func checkFilesBody(t *testing.T, body []byte, code, instanceURL string) {
	t.Helper()
	var fe filesError
	if err := json.Unmarshal(body, &fe); err != nil {
		t.Fatalf("body %s: %v", body, err)
	}
	if fe.Code != code || fe.InstanceURL != instanceURL {
		t.Fatalf("body = %s", body)
	}
}

func TestMachineMoved421(t *testing.T) {
	e := newEnv(t)
	gwA := e.internalGateway("gw-a", nil)
	gwB := e.internalGateway("gw-b", nil)
	gwA.routed.Store(false)
	id, bs := e.machine()
	stub := newStubAgent()
	e.startStubAgent(id, bs, stub, nil)
	waitMachine(t, gwB.testGW, id)
	ctx := context.Background()
	c := peerClient(t, apiToken1)

	_, err := setLabel(ctx, t, gwA, id, apiToken1)
	checkUnavailable(t, err, wire.CodeMachineMoved, gwB.url)

	resp, body := do(t, c, http.MethodPost, gwA.machineURL(id)+"/rpc"+setLabelPath, "application/json", []byte(`{}`))
	checkRaw(t, resp, body, http.StatusMisdirectedRequest, wire.CodeMachineMoved, gwB.url)
	checkRPCBody(t, body, wire.CodeMachineMoved)
	t.Logf("421 unary rpc: headers %v body %s", resp.Header, body)

	// A server stream gets the same answer.
	stream, err := processClient(t, gwA, id, apiToken1).Run(ctx, connect.NewRequest(&testingv1.RunRequest{CommandId: "c"}))
	if err == nil {
		if stream.Receive() {
			t.Fatal("stream to the wrong instance received a message")
		}
		err = stream.Err()
		_ = stream.Close()
	}
	if err == nil {
		t.Fatal("stream to the wrong instance succeeded")
	}
	// connect-go's streaming client does not surface the headers of a
	// non-200 answer: check them on a raw h2c streaming request.
	resp, body = do(t, c, http.MethodPost, gwA.machineURL(id)+"/rpc/sbx.testing.v1.Process/Run", "application/connect+proto", []byte{0, 0, 0, 0, 0})
	if resp.ProtoMajor != 2 {
		t.Fatalf("raw stream request over HTTP/%d, want h2c", resp.ProtoMajor)
	}
	checkRaw(t, resp, body, http.StatusMisdirectedRequest, wire.CodeMachineMoved, gwB.url)
	checkRPCBody(t, body, wire.CodeMachineMoved)
	t.Logf("421 stream rpc: headers %v body %s", resp.Header, body)

	resp, body = do(t, c, http.MethodGet, gwA.machineURL(id)+"/files?path=x", "", nil)
	checkRaw(t, resp, body, http.StatusMisdirectedRequest, wire.CodeMachineMoved, gwB.url)
	checkFilesBody(t, body, wire.CodeMachineMoved, gwB.url)
	t.Logf("421 files: headers %v body %s", resp.Header, body)

	resp, body = do(t, c, http.MethodPost, gwA.machineURL(id)+"/rotate-token", "", nil)
	checkRaw(t, resp, body, http.StatusMisdirectedRequest, wire.CodeMachineMoved, gwB.url)

	// B serves it.
	if _, err := setLabel(ctx, t, gwB, id, apiToken1); err != nil {
		t.Fatalf("SetLabel on the owner: %v", err)
	}
}

func TestAgentUnavailable503(t *testing.T) {
	e := newEnv(t)
	gw := e.internalGateway("gw-a", nil)
	id, _ := e.machine() // credentials, but no agent
	ctx := context.Background()
	c := peerClient(t, apiToken1)

	_, err := setLabel(ctx, t, gw, id, apiToken1)
	checkUnavailable(t, err, wire.CodeAgentUnavailable, "")

	resp, body := do(t, c, http.MethodPost, gw.machineURL(id)+"/rpc"+setLabelPath, "application/json", []byte(`{}`))
	checkRaw(t, resp, body, http.StatusServiceUnavailable, wire.CodeAgentUnavailable, "")
	checkRPCBody(t, body, wire.CodeAgentUnavailable)
	t.Logf("503 unary rpc: headers %v body %s", resp.Header, body)

	stream, err := processClient(t, gw, id, apiToken1).Run(ctx, connect.NewRequest(&testingv1.RunRequest{CommandId: "c"}))
	if err == nil {
		if stream.Receive() {
			t.Fatal("stream received a message")
		}
		err = stream.Err()
		_ = stream.Close()
	}
	if connect.CodeOf(err) != connect.CodeUnavailable {
		t.Fatalf("stream err = %v, want unavailable", err)
	}
	resp, body = do(t, c, http.MethodPost, gw.machineURL(id)+"/rpc/sbx.testing.v1.Process/Run", "application/connect+proto", []byte{0, 0, 0, 0, 0})
	if resp.ProtoMajor != 2 {
		t.Fatalf("raw stream request over HTTP/%d, want h2c", resp.ProtoMajor)
	}
	checkRaw(t, resp, body, http.StatusServiceUnavailable, wire.CodeAgentUnavailable, "")
	checkRPCBody(t, body, wire.CodeAgentUnavailable)

	resp, body = do(t, c, http.MethodGet, gw.machineURL(id)+"/files?path=x", "", nil)
	checkRaw(t, resp, body, http.StatusServiceUnavailable, wire.CodeAgentUnavailable, "")
	checkFilesBody(t, body, wire.CodeAgentUnavailable, "")
	t.Logf("503 files: headers %v body %s", resp.Header, body)

	resp, body = do(t, c, http.MethodPost, gw.machineURL(id)+"/rotate-token", "", nil)
	checkRaw(t, resp, body, http.StatusServiceUnavailable, wire.CodeAgentUnavailable, "")

	_, err = DialRemoteTCP(ctx, NewPeerTransport(), gw.url, apiToken1, id, 22, TCPOptions{})
	var de *transport.DialError
	if !errors.As(err, &de) || de.Status != http.StatusServiceUnavailable {
		t.Fatalf("CONNECT: err %v, want DialError 503", err)
	}

	// A machine nobody knows is unavailable too.
	_, err = setLabel(ctx, t, gw, uuid.NewString(), apiToken1)
	checkUnavailable(t, err, wire.CodeAgentUnavailable, "")
}

func TestStreamAbortedWithUnavailableOnMove(t *testing.T) {
	e := newEnv(t)
	gwA := e.internalGateway("gw-a", nil)
	gwB := e.internalGateway("gw-b", nil)
	gwB.routed.Store(false)
	id, bs := e.machine()
	stub := newStubAgent()
	a := e.startStubAgent(id, bs, stub, nil)
	mc := waitMachine(t, gwA.testGW, id)
	ctx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
	defer cancel()

	stream, err := processClient(t, gwA, id, apiToken1).Attach(ctx, connect.NewRequest(&testingv1.AttachRequest{CommandId: "c"}))
	if err != nil {
		t.Fatalf("Attach: %v", err)
	}
	defer func() { _ = stream.Close() }()
	for i := range attachMessages {
		if !stream.Receive() {
			t.Fatalf("message %d: %v", i, stream.Err())
		}
	}
	select {
	case <-stub.attachOpen:
	case <-time.After(waitTimeout):
		t.Fatal("Attach did not start")
	}

	gwA.routed.Store(false)
	gwB.routed.Store(true)
	if err := mc.Drain(ctx, transport.DrainOptions{Reason: "test"}); err != nil {
		t.Fatalf("Drain: %v", err)
	}
	waitConnectedTo(a, "gw-b")

	start := time.Now()
	if stream.Receive() {
		t.Fatalf("unexpected message after the move: %v", stream.Msg())
	}
	if d := time.Since(start); d > waitTimeout {
		t.Fatalf("stream ended %s after the move", d)
	}
	checkUnavailable(t, stream.Err(), wire.CodeMachineMoved, gwB.url)

	// New calls to A are sent to B.
	_, err = setLabel(ctx, t, gwA, id, apiToken1)
	checkUnavailable(t, err, wire.CodeMachineMoved, gwB.url)
	if _, err := setLabel(ctx, t, gwB, id, apiToken1); err != nil {
		t.Fatalf("SetLabel on B: %v", err)
	}
}

func TestFilesProxy(t *testing.T) {
	e := newEnv(t)
	gw := e.internalGateway("gw-a", nil)
	id, bs := e.machine()
	stub := newStubAgent()
	e.startStubAgent(id, bs, stub, nil)
	waitMachine(t, gw.testGW, id)
	c := peerClient(t, apiToken1)
	ctx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
	defer cancel()

	req, _ := http.NewRequestWithContext(ctx, http.MethodGet, gw.machineURL(id)+"/files?path=x", nil)
	req.Header.Set("Range", "bytes=10-19")
	resp, err := c.Do(req)
	if err != nil {
		t.Fatal(err)
	}
	body, err := io.ReadAll(resp.Body)
	_ = resp.Body.Close()
	if err != nil {
		t.Fatal(err)
	}
	if resp.StatusCode != http.StatusPartialContent || !bytes.Equal(body, fileContent[10:20]) ||
		resp.Header.Get("Content-Range") != "bytes 10-19/1000" {
		t.Fatalf("range GET: status %d, Content-Range %q, body %q", resp.StatusCode, resp.Header.Get("Content-Range"), body)
	}
	if h := stub.header("/files"); h.Get("Range") != "bytes=10-19" || h.Get(wire.HeaderCaller) != "api" {
		t.Fatalf("agent saw headers %v", h)
	}

	// A 4 MiB upload is streamed intact.
	data := make([]byte, 4<<20)
	if _, err := rand.Read(data); err != nil {
		t.Fatal(err)
	}
	pr, pw := io.Pipe()
	go func() {
		for off := 0; off < len(data); off += 64 << 10 {
			if _, err := pw.Write(data[off : off+64<<10]); err != nil {
				return
			}
		}
		_ = pw.Close()
	}()
	req, _ = http.NewRequestWithContext(ctx, http.MethodPut, gw.machineURL(id)+"/files/uploads/u1?offset=0", pr)
	resp, err = c.Do(req)
	if err != nil {
		t.Fatal(err)
	}
	body, _ = io.ReadAll(resp.Body)
	_ = resp.Body.Close()
	if resp.StatusCode != http.StatusOK || string(body) != `{"size":4194304}` {
		t.Fatalf("upload: status %d body %s", resp.StatusCode, body)
	}
	u, ok := stub.lastUpload()
	if !ok || u.path != "/files/uploads/u1" || u.query != "offset=0" || u.size != int64(len(data)) || u.sum != sha256.Sum256(data) {
		t.Fatalf("agent got upload %+v", u)
	}
	if u.header.Get("Authorization") != "" {
		t.Fatal("agent saw Authorization")
	}
}

func TestRemoteTCP(t *testing.T) {
	e := newEnv(t)
	gwA := e.internalGateway("gw-a", func(c *Config) { c.MaxTCPStreamsPerMachine = 1 })
	gwB := e.internalGateway("gw-b", nil)
	gwB.routed.Store(false)
	idA, bsA := e.machine()
	e.startStubAgent(idA, bsA, newStubAgent(), nil)
	waitMachine(t, gwA.testGW, idA)
	gwA.routed.Store(false)
	gwB.routed.Store(true)
	idB, bsB := e.machine()
	e.startStubAgent(idB, bsB, newStubAgent(), nil)
	waitMachine(t, gwB.testGW, idB)
	ctx := context.Background()
	rt := NewPeerTransport()
	t.Cleanup(rt.CloseIdleConnections)
	port := startEcho(t)

	conn, err := DialRemoteTCP(ctx, rt, gwA.url, apiToken1, idA, port, TCPOptions{DrainDeadline: 7 * time.Minute})
	if err != nil {
		t.Fatalf("DialRemoteTCP: %v", err)
	}
	watchdog(t, conn)
	echo(t, conn, "hello")
	s, _ := gwA.lookup(idA)
	if d := s.longestTCPDeadline(); d != 7*time.Minute {
		t.Fatalf("drain deadline on the owner = %s, want 7m", d)
	}

	// Over the limit.
	if _, err := DialRemoteTCP(ctx, rt, gwA.url, apiToken1, idA, port, TCPOptions{}); !errors.Is(err, ErrTooManyStreams) {
		t.Fatalf("second stream: err %v, want ErrTooManyStreams", err)
	}

	// Half-close: our EOF reaches the target, which answers and closes.
	if err := conn.(interface{ CloseWrite() error }).CloseWrite(); err != nil {
		t.Fatal(err)
	}
	rest, err := readAllString(conn)
	if err != nil || rest != "|eof" {
		t.Fatalf("after CloseWrite: read %q, %v", rest, err)
	}
	_ = conn.Close()
	eventually(t, waitTimeout, "tcp stream released on the owner", func() bool { return tcpCount(gwA.testGW, idA) == 0 })

	// A machine on B: moved.
	_, err = DialRemoteTCP(ctx, rt, gwA.url, apiToken1, idB, port, TCPOptions{})
	var moved *transport.MovedError
	if !errors.As(err, &moved) || moved.InstanceURL != gwB.url {
		t.Fatalf("machine on B: err %v, want MovedError{%s}", err, gwB.url)
	}

	// The agent refuses a port nobody listens on: its status is passed on.
	ln := listenLocal(t)
	closed := uint16(ln.Addr().(*net.TCPAddr).Port) //nolint:gosec // a TCP port fits in uint16
	_ = ln.Close()
	_, err = DialRemoteTCP(ctx, rt, gwA.url, apiToken1, idA, closed, TCPOptions{})
	var de *transport.DialError
	if !errors.As(err, &de) || de.Status != http.StatusBadGateway {
		t.Fatalf("closed port: err %v, want DialError 502", err)
	}

	// The target closing first ends the stream for the caller.
	conn, err = DialRemoteTCP(ctx, rt, gwA.url, apiToken1, idA, startBye(t), TCPOptions{})
	if err != nil {
		t.Fatal(err)
	}
	watchdog(t, conn)
	got, err := readAllString(conn)
	_ = conn.Close()
	if got != "bye" || err != nil {
		t.Fatalf("bye: read %q, %v", got, err)
	}
	eventually(t, waitTimeout, "tcp stream released on the owner", func() bool { return tcpCount(gwA.testGW, idA) == 0 })
}

func TestRemoteTCPOverHTTP1(t *testing.T) {
	e := newEnv(t)
	gw := e.internalGateway("gw-a", nil)
	id, bs := e.machine()
	e.startStubAgent(id, bs, newStubAgent(), nil)
	waitMachine(t, gw.testGW, id)
	port := startEcho(t)

	c := dialLocal(t, strings.TrimPrefix(gw.url, "http://"))
	defer func() { _ = c.Close() }()
	_ = c.SetDeadline(time.Now().Add(waitTimeout))
	authority := net.JoinHostPort(id, strconv.Itoa(int(port)))
	if _, err := io.WriteString(c, "CONNECT "+authority+" HTTP/1.1\r\nHost: "+authority+
		"\r\nAuthorization: Bearer "+apiToken1+"\r\n\r\n"); err != nil {
		t.Fatal(err)
	}
	br := bufio.NewReader(c)
	resp, err := http.ReadResponse(br, &http.Request{Method: http.MethodConnect})
	if err != nil {
		t.Fatal(err)
	}
	// A 200 to CONNECT has no body: the connection is the stream.
	_ = resp.Body.Close()
	if resp.StatusCode != http.StatusOK {
		t.Fatalf("CONNECT status %d", resp.StatusCode)
	}
	if _, err := io.WriteString(c, "over http/1.1"); err != nil {
		t.Fatal(err)
	}
	buf := make([]byte, len("over http/1.1"))
	if _, err := io.ReadFull(br, buf); err != nil || string(buf) != "over http/1.1" {
		t.Fatalf("echo %q, %v", buf, err)
	}
	if err := c.(*net.TCPConn).CloseWrite(); err != nil {
		t.Fatal(err)
	}
	rest, err := io.ReadAll(br)
	if err != nil || string(rest) != "|eof" {
		t.Fatalf("after CloseWrite: %q, %v", rest, err)
	}
	eventually(t, waitTimeout, "tcp stream released", func() bool { return tcpCount(gw.testGW, id) == 0 })
}

func TestInternalServerSettings(t *testing.T) {
	srv := NewInternalServer(http.NotFoundHandler())
	ln := listenLocal(t)
	go func() { _ = srv.Serve(ln) }()
	t.Cleanup(func() { _ = srv.Close() })

	c := dialLocal(t, ln.Addr().String())
	defer func() { _ = c.Close() }()
	_ = c.SetDeadline(time.Now().Add(waitTimeout))
	if _, err := io.WriteString(c, xhttp2.ClientPreface); err != nil {
		t.Fatal(err)
	}
	fr := xhttp2.NewFramer(c, c)
	if err := fr.WriteSettings(); err != nil {
		t.Fatal(err)
	}
	for {
		f, err := fr.ReadFrame()
		if err != nil {
			t.Fatalf("read frame: %v", err)
		}
		sf, ok := f.(*xhttp2.SettingsFrame)
		if !ok || sf.IsAck() {
			continue
		}
		v, ok := sf.Value(xhttp2.SettingMaxConcurrentStreams)
		if !ok || v != 10000 {
			t.Fatalf("MAX_CONCURRENT_STREAMS = %d (sent %v), want 10000", v, ok)
		}
		return
	}
}

func TestRotateToken(t *testing.T) {
	e := newEnv(t)
	gw := e.internalGateway("gw-a", nil)
	id, bs := e.machine()
	rd := &recDialer{d: e.net.Dialer()}
	a := e.startStubAgent(id, bs, newStubAgent(), rd)
	eventually(t, waitTimeout, "first rotation after bootstrap", func() bool {
		mt, next := e.credentials(id)
		return mt != nil && next == nil
	})
	// Reconnect once so the token the agent holds is visible.
	e.net.Links(id)[0].Cut()
	waitConnectedTo(a, "gw-a")
	old := rd.last()
	if old.Scheme != transport.AuthToken {
		t.Fatalf("reconnect used %v, want the machine token", old.Scheme)
	}
	mt1, _ := e.credentials(id)
	if !bytes.Equal(wire.HashSecret(old.Secret), mt1) {
		t.Fatal("the agent's token does not match mt_hash")
	}
	waitMachine(t, gw.testGW, id)

	resp, body := do(t, peerClient(t, apiToken1), http.MethodPost, gw.machineURL(id)+"/rotate-token", "", nil)
	if resp.StatusCode != http.StatusOK || strings.TrimSpace(string(body)) != "{}" {
		t.Fatalf("rotate-token: status %d body %s", resp.StatusCode, body)
	}
	mt2, next := e.credentials(id)
	if bytes.Equal(mt1, mt2) || next != nil {
		t.Fatalf("after rotate-token: mt changed %v, next %x", !bytes.Equal(mt1, mt2), next)
	}

	// The next reconnect presents the new token.
	e.net.Links(id)[0].Cut()
	waitConnectedTo(a, "gw-a")
	if h := rd.last(); h.Scheme != transport.AuthToken || !bytes.Equal(wire.HashSecret(h.Secret), mt2) {
		t.Fatal("the reconnect did not use the rotated token")
	}
	// The old token is no longer accepted.
	_, err := gw.Admitter().Admit(context.Background(), transport.Hello{
		MachineID: id, Scheme: transport.AuthToken, Secret: old.Secret, AgentVersion: "1.5.0",
	})
	var rej *transport.RejectError
	if !errors.As(err, &rej) || rej.Status != http.StatusUnauthorized {
		t.Fatalf("Admit with the old token: err %v, want 401", err)
	}
}

func TestTCPDrainDeadlineClamped(t *testing.T) {
	e := newEnv(t)
	gw := e.internalGateway("gw-a", func(c *Config) { c.Timing.MaxTCPDrainDeadline = 5 * time.Minute })
	id, bs := e.machine()
	e.startStubAgent(id, bs, newStubAgent(), nil)
	mc := waitMachine(t, gw.testGW, id).(*MachineConn)
	ctx := context.Background()
	rt := NewPeerTransport()
	t.Cleanup(rt.CloseIdleConnections)
	port := startEcho(t)
	s, _ := gw.lookup(id)

	// Sbx-Tcp-Drain-Deadline-Ms above the cap.
	remote, err := DialRemoteTCP(ctx, rt, gw.url, apiToken1, id, port, TCPOptions{DrainDeadline: 1000 * time.Hour})
	if err != nil {
		t.Fatalf("DialRemoteTCP: %v", err)
	}
	watchdog(t, remote)
	echo(t, remote, "hello")
	if d := s.longestTCPDeadline(); d != 5*time.Minute {
		t.Fatalf("drain deadline from the header = %s, want the 5m cap", d)
	}
	_ = remote.Close()
	eventually(t, waitTimeout, "tcp stream released", func() bool { return tcpCount(gw.testGW, id) == 0 })

	// TCPOptions.DrainDeadline above the cap.
	local, err := mc.DialTCPWith(ctx, port, TCPOptions{DrainDeadline: 1000 * time.Hour})
	if err != nil {
		t.Fatal(err)
	}
	defer func() { _ = local.Close() }()
	echo(t, local, "hello")
	if d := s.longestTCPDeadline(); d != 5*time.Minute {
		t.Fatalf("drain deadline from TCPOptions = %s, want the 5m cap", d)
	}
}

// ownerRow records a connected session of machine id owned by instanceID
// without a tunnel behind it.
func ownerRow(t *testing.T, e *env, id string, bs []byte, instanceID string) {
	t.Helper()
	_, err := e.store.Admit(context.Background(), registry.AdmitParams{
		MachineID: id, InstanceID: instanceID, ConnID: "conn-" + uuid.NewString(),
		AgentInstanceID: "agent-x", BootID: "boot", Vmgenid: "vmgen", AgentVersion: "1.0.0", ProtoVersion: "1",
		Scheme: transport.AuthBootstrap, SecretHash: wire.HashSecret(bs),
	})
	if err != nil {
		t.Fatalf("Admit: %v", err)
	}
}

// A gateway restarted on the same pod IP must not send callers to itself:
// the old instance's row (fresh heartbeat, same URL) counts as no owner.
func TestOwnerWithOwnURLIsUnavailable(t *testing.T) {
	e := newEnv(t)
	gw := e.internalGateway("gw-new", nil)
	if err := e.store.RegisterInstance(context.Background(), "gw-old", gw.url+"/"); err != nil {
		t.Fatal(err)
	}
	id, bs := e.machine()
	ownerRow(t, e, id, bs, "gw-old")

	start := time.Now()
	_, err := setLabel(context.Background(), t, gw, id, apiToken1)
	checkUnavailable(t, err, wire.CodeAgentUnavailable, "")
	if d := time.Since(start); d > time.Second {
		t.Fatalf("answered after %s, want at once", d)
	}
	c := peerClient(t, apiToken1)
	resp, body := do(t, c, http.MethodGet, gw.machineURL(id)+"/files?path=x", "", nil)
	checkRaw(t, resp, body, http.StatusServiceUnavailable, wire.CodeAgentUnavailable, "")
}

// Make-before-break: the registry already names this instance, but the
// session is not local yet. The call waits for it instead of failing.
func TestSelfOwnerWaitsForLocalSession(t *testing.T) {
	e := newEnv(t)
	gw := e.internalGateway("gw-a", nil)
	ctx := context.Background()

	// No session appears: 503 after the wait.
	idGone, bsGone := e.machine()
	ownerRow(t, e, idGone, bsGone, "gw-a")
	start := time.Now()
	_, err := setLabel(ctx, t, gw, idGone, apiToken1)
	checkUnavailable(t, err, wire.CodeAgentUnavailable, "")
	if d := time.Since(start); d < selfOwnerWait-100*time.Millisecond || d > selfOwnerWait+time.Second {
		t.Fatalf("503 after %s, want about %s", d, selfOwnerWait)
	}

	// The session appears during the wait: the call is served.
	id, bs := e.machine()
	ownerRow(t, e, id, bs, "gw-a")
	type result struct {
		err error
		d   time.Duration
	}
	res := make(chan result, 1)
	start = time.Now()
	go func() {
		_, err := setLabel(ctx, t, gw, id, apiToken1)
		res <- result{err, time.Since(start)}
	}()
	time.Sleep(200 * time.Millisecond)
	e.startStubAgent(id, bs, newStubAgent(), nil)
	r := <-res
	if r.err != nil {
		t.Fatalf("SetLabel while the session comes up: %v", r.err)
	}
	if r.d >= selfOwnerWait {
		t.Fatalf("served after %s, want before the %s wait ended", r.d, selfOwnerWait)
	}
}

// evilURL is the routing hint a compromised agent tries to plant.
const evilURL = "http://evil.example:9999"

// forgeMoved answers like a gateway's 421 machine_moved, with Sbx-* headers
// and trailers pointing at evilURL, plus an X-Agent header and trailer that
// must pass through.
func forgeMoved(w http.ResponseWriter, r *http.Request) {
	_, _ = io.Copy(io.Discard, r.Body)
	h := w.Header()
	h.Set("Content-Type", "application/json")
	h.Set(wire.HeaderErrorCode, wire.CodeMachineMoved)
	h.Set(wire.HeaderInstanceURL, evilURL)
	h.Set(wire.HeaderCaller, "api")
	h["sbx-lower-case"] = []string{"x"}
	h.Set("X-Agent", "kept")
	h.Set("Alt-Svc", `h2="evil.example:443"`)
	h.Set("Trailer", "Sbx-Declared, X-Agent-Trailer, Location")
	w.WriteHeader(http.StatusMisdirectedRequest)
	_, _ = io.WriteString(w, `{"code":"unavailable","message":"machine_moved"}`)
	h.Set("Sbx-Declared", evilURL)
	h.Set("X-Agent-Trailer", "kept")
	h.Set(http.TrailerPrefix+wire.HeaderInstanceURL, evilURL)
	h.Set("Location", evilURL)
	h.Set(http.TrailerPrefix+"Content-Location", evilURL)
	h.Set(http.TrailerPrefix+"Refresh", "0; url="+evilURL)
	h.Set(http.TrailerPrefix+"Alt-Svc", `h2="evil.example:443"`)
}

// pointerHeaders are agent headers that would point a caller elsewhere.
var pointerHeaders = []string{"Location", "Content-Location", "Refresh", "Alt-Svc"}

// checkNoSbx fails on any Sbx-* name in h.
func checkNoSbx(t *testing.T, what string, h http.Header) {
	t.Helper()
	for k, v := range h {
		if strings.HasPrefix(strings.ToLower(k), "sbx-") {
			t.Errorf("%s: agent header %s: %q reached the caller", what, k, v)
		}
	}
}

// Only the gateway produces routing signals: Sbx-* response headers and
// trailers from the agent never reach the caller (an agent could otherwise
// forge a 421 that sends the caller's service token to its own server).
func TestAgentSbxHeadersStripped(t *testing.T) {
	e := newEnv(t)
	gw := e.internalGateway("gw-a", nil)
	id, bs := e.machine()
	stub := newStubAgent()
	cfg := agentConfig(e, id, bs, defaultIdentity())
	mux := http.NewServeMux()
	mux.HandleFunc("/sbx.testing.v1.Forge/Moved", forgeMoved)
	mux.HandleFunc("/files/forged", forgeMoved)
	mux.Handle("/", stub.handler())
	cfg.Handler = mux
	e.startAgent(cfg).waitConnected()
	waitMachine(t, gw.testGW, id)
	c := peerClient(t, apiToken1)
	ctx, cancel := context.WithTimeout(context.Background(), waitTimeout)
	defer cancel()

	for _, tc := range []struct{ name, method, url string }{
		{"rpc", http.MethodPost, gw.machineURL(id) + "/rpc/sbx.testing.v1.Forge/Moved"},
		{"files", http.MethodGet, gw.machineURL(id) + "/files/forged"},
	} {
		req, _ := http.NewRequestWithContext(ctx, tc.method, tc.url, strings.NewReader(`{}`))
		req.Header.Set("Content-Type", "application/json")
		req.Header.Set("Te", "trailers")
		resp, err := c.Do(req)
		if err != nil {
			t.Fatalf("%s: %v", tc.name, err)
		}
		_, _ = io.Copy(io.Discard, resp.Body)
		_ = resp.Body.Close()
		if resp.StatusCode != http.StatusMisdirectedRequest {
			t.Errorf("%s: status %d, want the agent's 421", tc.name, resp.StatusCode)
		}
		checkNoSbx(t, tc.name+" header", resp.Header)
		checkNoSbx(t, tc.name+" trailer", resp.Trailer)
		for _, k := range pointerHeaders {
			if v := resp.Header.Get(k) + resp.Trailer.Get(k); v != "" {
				t.Errorf("%s: agent %s %q reached the caller", tc.name, k, v)
			}
		}
		if resp.Header.Get("X-Agent") != "kept" || resp.Trailer.Get("X-Agent-Trailer") != "kept" {
			t.Errorf("%s: other agent headers lost: header %v trailer %v", tc.name, resp.Header, resp.Trailer)
		}
		t.Logf("%s: header %v trailer %v", tc.name, resp.Header, resp.Trailer)
	}
}

// A compromised agent answering a peer CONNECT: its headers never reach the
// peer, and its 421 is not passed on as a gateway's machine_moved.
func TestAgentConnectAnswerNotForwarded(t *testing.T) {
	e := newEnv(t)
	gw := e.internalGateway("gw-a", nil)
	id, bs := e.machine()
	e.rawAgent(id, bs, http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.Method != http.MethodConnect {
			http.NotFound(w, r)
			return
		}
		w.Header().Set(wire.HeaderErrorCode, wire.CodeMachineMoved)
		w.Header().Set(wire.HeaderInstanceURL, evilURL)
		w.Header().Set("X-Agent", "dropped")
		w.Header().Set("Location", evilURL)
		// Ports below 600 answer with the port as the status.
		if _, p, _ := net.SplitHostPort(r.Host); len(p) == 3 {
			code, _ := strconv.Atoi(p)
			w.WriteHeader(code)
			return
		}
		duplexEcho(w, r)
	}))
	waitMachine(t, gw.testGW, id)
	ctx := context.Background()
	rt := NewPeerTransport()
	t.Cleanup(rt.CloseIdleConnections)

	// The agent's policy answers pass; any other refusal is a 502, never a
	// gateway signal (moved, too many streams, unavailable, auth).
	for status, want := range map[int]int{
		400: 400, 403: 403, 502: 502,
		302: 502, 307: 502, 401: 502, 404: 502, 421: 502, 429: 502, 500: 502, 503: 502,
	} {
		_, err := DialRemoteTCP(ctx, rt, gw.url, apiToken1, id, uint16(status), TCPOptions{}) //nolint:gosec // small
		var moved *transport.MovedError
		var de *transport.DialError
		if errors.As(err, &moved) || errors.Is(err, ErrTooManyStreams) || !errors.As(err, &de) || de.Status != want {
			t.Errorf("agent %d on CONNECT: err %v, want DialError %d", status, err, want)
		}
	}

	// The 200 the peer sees carries only gateway headers.
	pr, pw := io.Pipe()
	defer func() { _ = pw.Close() }()
	req, _ := http.NewRequestWithContext(ctx, http.MethodConnect, gw.url, pr)
	req.Host = net.JoinHostPort(id, "2")
	req.Header.Set("Authorization", "Bearer "+apiToken1)
	resp, err := rt.RoundTrip(req)
	if err != nil {
		t.Fatal(err)
	}
	defer func() { _ = resp.Body.Close() }()
	if resp.StatusCode != http.StatusOK {
		t.Fatalf("CONNECT status %d", resp.StatusCode)
	}
	checkNoSbx(t, "CONNECT", resp.Header)
	if resp.Header.Get("X-Agent") != "" || resp.Header.Get("Location") != "" {
		t.Errorf("CONNECT: agent header X-Agent reached the peer: %v", resp.Header)
	}
}

// noRedirects is a peer client that returns redirects instead of following them.
func noRedirects(t *testing.T) *http.Client {
	c := peerClient(t, apiToken1)
	c.CheckRedirect = func(*http.Request, []*http.Request) error { return http.ErrUseLastResponse }
	return c
}

// An agent's redirect would make a caller (Go clients follow same-host
// redirects with Authorization) resend the call to another machine's route:
// a 3xx becomes 502, and Location-like headers never pass.
func TestAgentRedirectsRefused(t *testing.T) {
	e := newEnv(t)
	gw := e.internalGateway("gw-a", nil)
	id, bs := e.machine()
	other := uuid.NewString()
	target := gw.machineURL(other) + "/files?path=/secret"
	answer := func(status int) http.HandlerFunc {
		return func(w http.ResponseWriter, r *http.Request) {
			_, _ = io.Copy(io.Discard, r.Body)
			w.Header().Set("Location", target)
			w.Header().Set("Content-Location", target)
			w.Header().Set("Refresh", "0; url="+target)
			w.Header().Set("X-Agent", "kept")
			w.WriteHeader(status)
			_, _ = io.WriteString(w, "agent body")
		}
	}
	cfg := agentConfig(e, id, bs, defaultIdentity())
	mux := http.NewServeMux()
	for _, st := range []int{200, 302, 304, 307} {
		mux.HandleFunc("/files/s"+strconv.Itoa(st), answer(st))
		mux.HandleFunc("/sbx.testing.v1.Forge/S"+strconv.Itoa(st), answer(st))
	}
	cfg.Handler = mux
	e.startAgent(cfg).waitConnected()
	waitMachine(t, gw.testGW, id)
	c := noRedirects(t)

	for _, st := range []int{200, 302, 304, 307} {
		for _, path := range []string{"/files/s" + strconv.Itoa(st), "/rpc/sbx.testing.v1.Forge/S" + strconv.Itoa(st)} {
			for _, method := range []string{http.MethodGet, http.MethodPut} {
				resp, body := do(t, c, method, gw.machineURL(id)+path, "application/json", []byte(`{}`))
				want := st
				if st == 302 || st == 307 {
					want = http.StatusBadGateway
				}
				if resp.StatusCode != want {
					t.Errorf("%s %s: status %d, want %d (body %s)", method, path, resp.StatusCode, want, body)
				}
				for _, h := range []string{"Location", "Content-Location", "Refresh"} {
					if v := resp.Header.Get(h); v != "" {
						t.Errorf("%s %s: agent %s %q reached the caller", method, path, h, v)
					}
				}
				if want == http.StatusBadGateway && !strings.Contains(string(body), strconv.Itoa(st)) {
					t.Errorf("%s %s: body %s does not name the agent status", method, path, body)
				}
			}
		}
	}
	// With the default redirect policy nothing reaches the other machine's route.
	resp, _ := do(t, peerClient(t, apiToken1), http.MethodPut, gw.machineURL(id)+"/files/s307", "", []byte("x"))
	if resp.StatusCode != http.StatusBadGateway {
		t.Errorf("following client: status %d, want 502", resp.StatusCode)
	}
}

// Sbx-Upload-Offset is the one agent-defined Sbx-* response header the
// gateway passes (resumable uploads, S3 files API); gateway signals forged
// next to it are still dropped.
func TestAgentUploadOffsetPasses(t *testing.T) {
	e := newEnv(t)
	gw := e.internalGateway("gw-a", nil)
	id, bs := e.machine()
	cfg := agentConfig(e, id, bs, defaultIdentity())
	cfg.Handler = http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		_, _ = io.Copy(io.Discard, r.Body)
		w.Header().Set(wire.HeaderUploadOffset, "4194304")
		w.Header().Set(wire.HeaderErrorCode, wire.CodeMachineMoved)
		w.Header().Set(wire.HeaderInstanceURL, evilURL)
		if r.Method == http.MethodPut {
			w.WriteHeader(http.StatusConflict)
		}
	})
	e.startAgent(cfg).waitConnected()
	waitMachine(t, gw.testGW, id)
	c := peerClient(t, apiToken1)

	for _, tc := range []struct {
		method string
		status int
	}{{http.MethodHead, http.StatusOK}, {http.MethodPut, http.StatusConflict}} {
		resp, _ := do(t, c, tc.method, gw.machineURL(id)+"/files/uploads/u1?offset=0", "", []byte("x"))
		if resp.StatusCode != tc.status {
			t.Errorf("%s: status %d, want %d", tc.method, resp.StatusCode, tc.status)
		}
		if got := resp.Header.Get(wire.HeaderUploadOffset); got != "4194304" {
			t.Errorf("%s: %s = %q, want 4194304", tc.method, wire.HeaderUploadOffset, got)
		}
		delete(resp.Header, wire.HeaderUploadOffset)
		checkNoSbx(t, tc.method, resp.Header)
	}
}
