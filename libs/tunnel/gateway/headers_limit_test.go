package gateway

import (
	"context"
	"fmt"
	"io"
	"net/http"
	"strings"
	"testing"
	"time"

	"connectrpc.com/connect"

	"github.com/belov38/boat-dev-clone/libs/tunnel/h2"
	testingv1 "github.com/belov38/boat-dev-clone/libs/tunnel/tunneltest/testpb/sbx/testing/v1"
)

// An agent answer with a header block over 64 KiB would make the gateway
// write one the caller cannot take; a Node HTTP/2 client then destroys the
// session with every machine's calls on it. Such an answer is a 502 (a reset
// for trailers) for that one call, and a parallel call on the same caller
// connection goes on.
func TestAgentOversizedHeadersRefused(t *testing.T) {
	e := newEnv(t)
	gw := e.internalGateway("gw-a", nil)
	id, bs := e.machine()
	stub := newStubAgent()
	release := make(chan struct{})
	big := strings.Repeat("a", 200<<10)
	// Many small fields (48 bytes each) over the gateway->agent transport
	// limit, which net/http pads by 320 bytes: the transport fails that
	// stream (isHeaderListTooLarge), the block is never read.
	var many []string
	for i := range (h2.MaxResponseHeaderBytes+8<<10)/48 + 1 {
		many = append(many, fmt.Sprintf("X-Many-%08d", i))
	}
	// Just over the forwarded limit.
	edge := strings.Repeat("e", maxForwardHeaderBytes-32-len("X-Edge")+1)
	header := func(k, v string) http.HandlerFunc {
		return func(w http.ResponseWriter, r *http.Request) {
			_, _ = io.Copy(io.Discard, r.Body)
			w.Header().Set(k, v)
			w.Header().Set("Content-Type", "application/json")
			_, _ = io.WriteString(w, `{}`)
		}
	}
	trailer := func(ct string) http.HandlerFunc {
		return func(w http.ResponseWriter, r *http.Request) {
			_, _ = io.Copy(io.Discard, r.Body)
			w.Header().Set("Content-Type", ct)
			w.Header().Set("Trailer", "X-Big")
			if strings.HasPrefix(ct, "application/connect+") {
				_, _ = w.Write([]byte{0, 0, 0, 0, 0})
			} else {
				_, _ = io.WriteString(w, "body")
			}
			w.Header().Set("X-Big", big)
		}
	}
	cfg := agentConfig(e, id, bs, defaultIdentity())
	cfg.Handler = stub.handlerWith(func(mux *http.ServeMux) {
		mux.HandleFunc("/files/big-header", header("X-Big", big))
		mux.HandleFunc("/files/edge-header", header("X-Edge", edge))
		mux.HandleFunc("/files/many-headers", func(w http.ResponseWriter, r *http.Request) {
			_, _ = io.Copy(io.Discard, r.Body)
			for _, k := range many {
				w.Header().Set(k, "v")
			}
			_, _ = io.WriteString(w, `{}`)
		})
		mux.HandleFunc("/sbx.testing.v1.Forge/ManyTrailers", func(w http.ResponseWriter, r *http.Request) {
			_, _ = io.Copy(io.Discard, r.Body)
			w.Header().Set("Content-Type", "application/connect+proto")
			// A whole envelope: without the reset the gateway would end the
			// stream with agent_unavailable at this boundary.
			_, _ = w.Write([]byte{0, 0, 0, 0, 0})
			for _, k := range many {
				w.Header().Set(http.TrailerPrefix+k, "v")
			}
		})
		mux.HandleFunc("/files/fit-header", header("X-Fit", strings.Repeat("f", 32<<10)))
		mux.HandleFunc("/files/big-trailer", trailer("application/octet-stream"))
		mux.HandleFunc("/sbx.testing.v1.Forge/BigHeader", header("X-Big", big))
		mux.HandleFunc("/sbx.testing.v1.Forge/EdgeHeader", header("X-Edge", edge))
		mux.HandleFunc("/sbx.testing.v1.Forge/BigTrailer", trailer("application/connect+proto"))
		mux.HandleFunc("/files/slow", func(w http.ResponseWriter, _ *http.Request) {
			_, _ = io.WriteString(w, "first ")
			w.(http.Flusher).Flush()
			<-release
			_, _ = io.WriteString(w, "second")
		})
	})
	e.startAgent(cfg).waitConnected()
	waitMachine(t, gw.testGW, id)
	c := peerClient(t, apiToken1)
	ctx, cancel := context.WithTimeout(context.Background(), waitTimeout)
	defer cancel()

	// A parallel stream on the same caller connection, open throughout.
	slowReq, _ := http.NewRequestWithContext(ctx, http.MethodGet, gw.machineURL(id)+"/files/slow", nil)
	slow, err := c.Do(slowReq)
	if err != nil {
		t.Fatal(err)
	}
	defer func() { _ = slow.Body.Close() }()
	first := make([]byte, len("first "))
	if _, err := io.ReadFull(slow.Body, first); err != nil {
		t.Fatalf("slow stream: %v", err)
	}

	for _, tc := range []struct {
		path, ct string
		want     int
	}{
		{"/files/big-header", "", http.StatusBadGateway},
		{"/files/edge-header", "", http.StatusBadGateway},
		{"/files/many-headers", "", http.StatusBadGateway},
		{"/files/fit-header", "", http.StatusOK},
		{"/rpc/sbx.testing.v1.Forge/BigHeader", "application/json", http.StatusBadGateway},
		{"/rpc/sbx.testing.v1.Forge/EdgeHeader", "application/json", http.StatusBadGateway},
	} {
		resp, body := do(t, c, http.MethodPost, gw.machineURL(id)+tc.path, tc.ct, []byte(`{}`))
		if resp.StatusCode != tc.want {
			t.Errorf("%s: status %d, want %d (body %.200s)", tc.path, resp.StatusCode, tc.want, body)
		}
		if tc.want == http.StatusBadGateway && !strings.Contains(string(body), "header") {
			t.Errorf("%s: body %s does not name the header limit", tc.path, body)
		}
		for k := range resp.Header {
			if k == "X-Big" || k == "X-Edge" || strings.HasPrefix(k, "X-Many-") {
				t.Errorf("%s: agent header %s reached the caller", tc.path, k)
			}
		}
	}

	for _, tc := range []struct{ path, ct string }{
		{"/files/big-trailer", ""},
		{"/rpc/sbx.testing.v1.Forge/BigTrailer", "application/connect+json"},
		{"/rpc/sbx.testing.v1.Forge/ManyTrailers", "application/connect+json"},
	} {
		req, _ := http.NewRequestWithContext(ctx, http.MethodPost, gw.machineURL(id)+tc.path, strings.NewReader(`{}`))
		if tc.ct != "" {
			req.Header.Set("Content-Type", tc.ct)
		}
		req.Header.Set("Te", "trailers")
		resp, err := c.Do(req)
		if err != nil {
			t.Fatalf("%s: %v", tc.path, err)
		}
		b, err := io.ReadAll(resp.Body)
		_ = resp.Body.Close()
		if err == nil {
			t.Errorf("%s: body %q and trailer of %d bytes passed, want a reset", tc.path, b, len(resp.Trailer.Get("X-Big")))
		}
	}

	close(release)
	rest, err := io.ReadAll(slow.Body)
	if err != nil || string(rest) != "second" {
		t.Fatalf("parallel stream: %q, %v; want it unaffected", rest, err)
	}
	if _, err := processClientFor(c, gw, id).SetLabel(ctx, connect.NewRequest(&testingv1.SetLabelRequest{CommandId: "c1"})); err != nil {
		t.Fatalf("call after the oversized answers: %v", err)
	}
}

// A trailer the agent declares but never sends is not emitted: an empty
// declared trailer would keep the gateway's HTTP/2 server from ending the
// stream, and the call would hang until the caller's deadline.
func TestDeclaredTrailerNeverSent(t *testing.T) {
	e := newEnv(t)
	gw := e.internalGateway("gw-a", nil)
	id, bs := e.machine()
	declareOnly := func(ct string, body []byte, send bool) http.HandlerFunc {
		return func(w http.ResponseWriter, r *http.Request) {
			_, _ = io.Copy(io.Discard, r.Body)
			w.Header().Set("Content-Type", ct)
			w.Header().Set("Trailer", "X-Never, X-Sent")
			_, _ = w.Write(body)
			if send {
				w.Header().Set("X-Sent", "yes")
			}
		}
	}
	cfg := agentConfig(e, id, bs, defaultIdentity())
	cfg.Handler = newStubAgent().handlerWith(func(mux *http.ServeMux) {
		for _, send := range []bool{false, true} {
			sfx := map[bool]string{false: "Absent", true: "Sent"}[send]
			mux.HandleFunc("/files/declared"+sfx, declareOnly("application/octet-stream", []byte("body"), send))
			mux.HandleFunc("/sbx.testing.v1.Forge/Declared"+sfx, declareOnly("application/json", []byte(`{}`), send))
			mux.HandleFunc("/sbx.testing.v1.Forge/DeclaredStream"+sfx, declareOnly("application/connect+json", []byte{2, 0, 0, 0, 2, '{', '}'}, send))
		}
	})
	e.startAgent(cfg).waitConnected()
	waitMachine(t, gw.testGW, id)
	c := peerClient(t, apiToken1)

	for _, tc := range []struct {
		path, ct string
		sent     bool
	}{
		{"/files/declaredAbsent", "", false},
		{"/rpc/sbx.testing.v1.Forge/DeclaredAbsent", "application/json", false},
		{"/rpc/sbx.testing.v1.Forge/DeclaredStreamAbsent", "application/connect+json", false},
		{"/files/declaredSent", "", true},
		{"/rpc/sbx.testing.v1.Forge/DeclaredSent", "application/json", true},
		{"/rpc/sbx.testing.v1.Forge/DeclaredStreamSent", "application/connect+json", true},
	} {
		ctx, cancel := context.WithTimeout(context.Background(), waitTimeout)
		req, _ := http.NewRequestWithContext(ctx, http.MethodPost, gw.machineURL(id)+tc.path, strings.NewReader(`{}`))
		if tc.ct != "" {
			req.Header.Set("Content-Type", tc.ct)
		}
		req.Header.Set("Te", "trailers")
		start := time.Now()
		resp, err := c.Do(req)
		if err != nil {
			cancel()
			t.Fatalf("%s: %v", tc.path, err)
		}
		_, err = io.ReadAll(resp.Body)
		_ = resp.Body.Close()
		cancel()
		if d := time.Since(start); err != nil || d > 2*time.Second {
			t.Errorf("%s: status %d, body ended after %s with %v; want a prompt end", tc.path, resp.StatusCode, d, err)
			continue
		}
		want := ""
		if tc.sent {
			want = "yes"
		}
		if resp.StatusCode != http.StatusOK || resp.Trailer.Get("X-Sent") != want || resp.Trailer.Get("X-Never") != "" {
			t.Errorf("%s: status %d, trailers %v; want 200 with X-Sent %q only", tc.path, resp.StatusCode, resp.Trailer, want)
		}
	}
}
