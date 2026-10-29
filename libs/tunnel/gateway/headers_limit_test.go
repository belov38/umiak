package gateway

import (
	"context"
	"errors"
	"fmt"
	"io"
	"net/http"
	"strings"
	"testing"
	"time"

	"connectrpc.com/connect"
	"google.golang.org/protobuf/proto"

	tunnelv1 "github.com/belov38/boat-dev-clone/libs/proto/sbx/tunnel/v1"
	"github.com/belov38/boat-dev-clone/libs/tunnel/h2"
	testingv1 "github.com/belov38/boat-dev-clone/libs/tunnel/tunneltest/testpb/sbx/testing/v1"
	"github.com/belov38/boat-dev-clone/libs/tunnel/tunneltest/testpb/sbx/testing/v1/testingv1connect"
	"github.com/belov38/boat-dev-clone/libs/tunnel/wire"
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
	trailer := func(ct, v string) http.HandlerFunc {
		return func(w http.ResponseWriter, r *http.Request) {
			_, _ = io.Copy(io.Discard, r.Body)
			w.Header().Set("Content-Type", ct)
			w.Header().Set("Trailer", "X-Big")
			if strings.HasPrefix(ct, "application/connect+") {
				_, _ = w.Write([]byte{0, 0, 0, 0, 0})
			} else {
				_, _ = io.WriteString(w, "body")
			}
			w.Header().Set("X-Big", v)
		}
	}
	// A trailer block of exactly maxForwardHeaderBytes is over Node's
	// default maxHeaderListSize (65535).
	edgeTrailer := strings.Repeat("e", maxForwardHeaderBytes-32-len("X-Big"))
	fitTrailer := strings.Repeat("f", 60<<10)
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
		mux.HandleFunc("/files/big-trailer", trailer("application/octet-stream", big))
		mux.HandleFunc("/files/edge-trailer", trailer("application/octet-stream", edgeTrailer))
		mux.HandleFunc("/files/fit-trailer", trailer("application/octet-stream", fitTrailer))
		mux.HandleFunc("/sbx.testing.v1.Forge/BigHeader", header("X-Big", big))
		mux.HandleFunc("/sbx.testing.v1.Forge/EdgeHeader", header("X-Edge", edge))
		mux.HandleFunc("/sbx.testing.v1.Forge/BigTrailer", trailer("application/connect+proto", big))
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
		{"/files/edge-trailer", ""},
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
	fitReq, _ := http.NewRequestWithContext(ctx, http.MethodPost, gw.machineURL(id)+"/files/fit-trailer", strings.NewReader(`{}`))
	fitReq.Header.Set("Te", "trailers")
	fit, err := c.Do(fitReq)
	if err != nil {
		t.Fatal(err)
	}
	_, err = io.ReadAll(fit.Body)
	_ = fit.Body.Close()
	if err != nil || fit.Trailer.Get("X-Big") != fitTrailer {
		t.Errorf("fit trailer: %v, trailer of %d bytes; want it passed", err, len(fit.Trailer.Get("X-Big")))
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

// The gateway counts the header block it writes, not the agent's: Go's HTTP/2
// client moves the agent's Trailer declarations out of resp.Header, and the
// gateway re-emits each name as a Trailer field. A long declared name, too
// many names or too many fields would otherwise reach a Node caller as a
// block or field list it cannot take, and it destroys the session with every
// machine's calls on it. Such an answer is a 502 (a reset for trailers) for
// that one call; a server stream of another machine on the same caller
// connection completes.
func TestAgentTrailerDeclarationsCounted(t *testing.T) {
	e := newEnv(t)
	gw := e.internalGateway("gw-a", nil)

	// Machine B: a server stream held open until release, then completed.
	idB, bsB := e.machine()
	release := make(chan struct{})
	cfgB := agentConfig(e, idB, bsB, defaultIdentity())
	cfgB.Handler = newStubAgent().handlerWith(func(mux *http.ServeMux) {
		mux.Handle(testingv1connect.ProcessRunProcedure, connect.NewServerStreamHandler(testingv1connect.ProcessRunProcedure,
			func(ctx context.Context, _ *connect.Request[testingv1.RunRequest], s *connect.ServerStream[testingv1.AttachResponse]) error {
				if err := s.Send(dataEvent(0, lineData(0, 10))); err != nil {
					return err
				}
				select {
				case <-release:
				case <-ctx.Done():
					return ctx.Err()
				}
				if err := s.Send(dataEvent(10, lineData(1, 10))); err != nil {
					return err
				}
				return s.Send(&testingv1.AttachResponse{Event: &testingv1.AttachResponse_Exit{Exit: &testingv1.ExitEvent{
					Status: testingv1.ExitStatus_EXIT_STATUS_EXITED, StdoutEnd: 20,
				}}})
			}))
	})
	e.startAgent(cfgB).waitConnected()
	waitMachine(t, gw.testGW, idB)

	// Machine A: the hostile agent.
	idA, bsA := e.machine()
	names := func(n, size int) []string {
		var out []string
		for i := range n {
			p := fmt.Sprintf("X-T%03d-", i)
			out = append(out, p+strings.Repeat("n", size-len(p)))
		}
		return out
	}
	declare := func(trailers []string, fill string, fields int) http.HandlerFunc {
		return func(w http.ResponseWriter, r *http.Request) {
			_, _ = io.Copy(io.Discard, r.Body)
			for _, k := range trailers {
				w.Header().Add("Trailer", k)
			}
			if fill != "" {
				w.Header().Set("X-Fill", fill)
			}
			for i := range fields {
				w.Header().Set(fmt.Sprintf("X-Field-%03d", i), "v")
			}
			w.Header().Set("Content-Type", "application/json")
			_, _ = io.WriteString(w, `{}`)
			if len(trailers) > 0 && len(trailers[0]) <= maxTrailerNameBytes {
				w.Header().Set(trailers[0], "sent")
			}
		}
	}
	longName := "X-" + strings.Repeat("n", 140000)
	fill := strings.Repeat("f", maxForwardHeaderBytes-4<<10)
	cfgA := agentConfig(e, idA, bsA, defaultIdentity())
	cfgA.Handler = newStubAgent().handlerWith(func(mux *http.ServeMux) {
		mux.HandleFunc("/files/long-name", declare([]string{longName}, "", 0))
		mux.HandleFunc("/files/long-names", declare(names(12, 60000), "", 0))
		mux.HandleFunc("/files/name-over-cap", declare(names(1, maxTrailerNameBytes+1), "", 0))
		mux.HandleFunc("/files/too-many-names", declare(names(maxDeclaredTrailers+1, 16), "", 0))
		mux.HandleFunc("/files/names-over-block", declare(names(maxDeclaredTrailers, maxTrailerNameBytes), fill, 0))
		mux.HandleFunc("/files/too-many-fields", declare(nil, "", maxForwardHeaderFields))
		mux.HandleFunc("/files/fit", declare(names(maxDeclaredTrailers, maxTrailerNameBytes), "", 50))
		mux.HandleFunc("/sbx.testing.v1.Forge/LongName", declare([]string{longName}, "", 0))
		mux.HandleFunc("/sbx.testing.v1.Forge/ManyFields", declare(nil, "", maxForwardHeaderFields))
		mux.HandleFunc("/files/many-trailer-fields", func(w http.ResponseWriter, r *http.Request) {
			_, _ = io.Copy(io.Discard, r.Body)
			_, _ = io.WriteString(w, "body")
			for i := range maxForwardHeaderFields + 1 {
				w.Header().Set(fmt.Sprintf("%sX-Tf-%03d", http.TrailerPrefix, i), "v")
			}
		})
	})
	e.startAgent(cfgA).waitConnected()
	waitMachine(t, gw.testGW, idA)

	c := peerClient(t, apiToken1)
	ctx, cancel := context.WithTimeout(context.Background(), waitTimeout)
	defer cancel()
	run, err := processClientFor(c, gw, idB).Run(ctx, connect.NewRequest(&testingv1.RunRequest{}))
	if err != nil {
		t.Fatal(err)
	}
	if !run.Receive() {
		t.Fatalf("machine B stream: no first message: %v", run.Err())
	}

	for _, tc := range []struct {
		path, ct string
		want     int
	}{
		{"/files/long-name", "", http.StatusBadGateway},
		{"/files/long-names", "", http.StatusBadGateway},
		{"/files/name-over-cap", "", http.StatusBadGateway},
		{"/files/too-many-names", "", http.StatusBadGateway},
		{"/files/names-over-block", "", http.StatusBadGateway},
		{"/files/too-many-fields", "", http.StatusBadGateway},
		{"/files/fit", "", http.StatusOK},
		{"/rpc/sbx.testing.v1.Forge/LongName", "application/json", http.StatusBadGateway},
		{"/rpc/sbx.testing.v1.Forge/ManyFields", "application/json", http.StatusBadGateway},
	} {
		req, _ := http.NewRequestWithContext(ctx, http.MethodPost, gw.machineURL(idA)+tc.path, strings.NewReader(`{}`))
		if tc.ct != "" {
			req.Header.Set("Content-Type", tc.ct)
		}
		req.Header.Set("Te", "trailers")
		resp, err := c.Do(req)
		if err != nil {
			t.Fatalf("%s: %v", tc.path, err)
		}
		body, err := io.ReadAll(resp.Body)
		_ = resp.Body.Close()
		if err != nil {
			t.Fatalf("%s: read body: %v", tc.path, err)
		}
		if resp.StatusCode != tc.want {
			t.Errorf("%s: status %d, want %d (body %.200s)", tc.path, resp.StatusCode, tc.want, body)
		}
		// What the caller got: the header block with the Trailer fields the
		// Go client moved into resp.Trailer.
		got, fields := headerBlockSize(resp.Header), 0
		for _, vv := range resp.Header {
			fields += len(vv)
		}
		for k := range resp.Trailer {
			got += len("Trailer") + len(k) + 32
			fields++
		}
		if got > maxForwardHeaderBytes || fields > maxForwardHeaderFields {
			t.Errorf("%s: caller got a header block of %d bytes, %d fields", tc.path, got, fields)
		}
		if tc.want == http.StatusBadGateway && !strings.Contains(string(body), "header") {
			t.Errorf("%s: body %s does not name the header limit", tc.path, body)
		}
		if tc.want == http.StatusOK && resp.Trailer.Get(names(1, maxTrailerNameBytes)[0]) != "sent" {
			t.Errorf("%s: declared trailer lost: %v", tc.path, resp.Trailer)
		}
	}

	req, _ := http.NewRequestWithContext(ctx, http.MethodPost, gw.machineURL(idA)+"/files/many-trailer-fields", strings.NewReader(`{}`))
	req.Header.Set("Te", "trailers")
	resp, err := c.Do(req)
	if err != nil {
		t.Fatal(err)
	}
	b, err := io.ReadAll(resp.Body)
	_ = resp.Body.Close()
	if err == nil {
		t.Errorf("many trailer fields: body %q and %d trailers passed, want a reset", b, len(resp.Trailer))
	}

	close(release)
	n := 1
	for run.Receive() {
		n++
	}
	if err := run.Err(); err != nil || n != 3 {
		t.Fatalf("machine B stream: %d messages, err %v; want 3 and a clean end", n, err)
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

// A refused agent answer ends a Connect call with a non-retryable error: a
// Connect stream gets it as the end-stream message of a 200 answer (Connect
// clients read a stream's 502 as unavailable and retry it until their wait
// budget ends), a unary call as a 502 JSON error; both are Code internal with
// ErrorDetail bad_agent_response. Trailers over the limit on a Connect unary
// answer are dropped and the call completes: a reset would make the client
// retry a call the agent already answered.
func TestBadAgentAnswerNotRetryable(t *testing.T) {
	e := newEnv(t)
	gw := e.internalGateway("gw-a", nil)
	id, bs := e.machine()
	big := strings.Repeat("a", 200<<10)
	overTrailer := strings.Repeat("t", maxForwardHeaderBytes)
	answer, err := proto.Marshal(&testingv1.EchoResponse{Payload: []byte("payload")})
	if err != nil {
		t.Fatal(err)
	}
	cfg := agentConfig(e, id, bs, defaultIdentity())
	cfg.Handler = newStubAgent().handlerWith(func(mux *http.ServeMux) {
		mux.HandleFunc(testingv1connect.ProcessEchoStreamProcedure, func(w http.ResponseWriter, r *http.Request) {
			_, _ = io.Copy(io.Discard, r.Body)
			switch r.Header.Get("X-Mode") {
			case "header":
				w.Header().Set("X-Big", big)
			case "redirect":
				w.Header().Set("Location", "http://example.invalid/")
				w.WriteHeader(http.StatusTemporaryRedirect)
				return
			}
			w.Header().Set("Content-Type", r.Header.Get("Content-Type"))
			_, _ = w.Write([]byte{2, 0, 0, 0, 2, '{', '}'})
		})
		mux.HandleFunc(testingv1connect.ProcessEchoProcedure, func(w http.ResponseWriter, r *http.Request) {
			_, _ = io.Copy(io.Discard, r.Body)
			w.Header().Set("Content-Type", "application/proto")
			switch r.Header.Get("X-Mode") {
			case "header":
				w.Header().Set("X-Big", big)
			case "redirect":
				w.Header().Set("Location", "http://example.invalid/")
				w.WriteHeader(http.StatusTemporaryRedirect)
				return
			}
			_, _ = w.Write(answer)
			switch r.Header.Get("X-Mode") {
			case "trailer":
				w.Header().Set(http.TrailerPrefix+"X-Big", overTrailer)
			case "huge-trailer":
				// Fields up to h2.MaxResponseHeaderBytes, then one that
				// crosses it: the gateway->agent transport fails the body
				// read (isHeaderListTooLarge). The crossing field sorts last,
				// so it ends the block's last frame; a CONTINUATION frame
				// after the limit is crossed would close the agent's tunnel.
				v := strings.Repeat("h", 4<<10)
				for i := range h2.MaxResponseHeaderBytes / (len("X-Huge-0000") + len(v) + 32) {
					w.Header().Set(fmt.Sprintf("%sX-Huge-%04d", http.TrailerPrefix, i), v)
				}
				w.Header().Set(http.TrailerPrefix+"X-Zz-Over", strings.Repeat("z", 8<<10))
			}
		})
	})
	e.startAgent(cfg).waitConnected()
	waitMachine(t, gw.testGW, id)
	c := peerClient(t, apiToken1)
	pc := processClientFor(c, gw, id)
	ctx, cancel := context.WithTimeout(context.Background(), waitTimeout)
	defer cancel()

	badAgent := func(what string, err error) {
		t.Helper()
		if connect.CodeOf(err) != connect.CodeInternal {
			t.Errorf("%s: err %v, want Code internal", what, err)
			return
		}
		var ce *connect.Error
		if !errors.As(err, &ce) {
			t.Errorf("%s: %T is not a connect error", what, err)
			return
		}
		for _, d := range ce.Details() {
			if v, derr := d.Value(); derr == nil {
				if ed, ok := v.(*tunnelv1.ErrorDetail); ok && ed.GetCode() == wire.CodeBadAgentResponse && !ed.GetRetryable() {
					return
				}
			}
		}
		t.Errorf("%s: err %v has no ErrorDetail bad_agent_response", what, err)
	}
	for _, mode := range []string{"header", "redirect"} {
		req := connect.NewRequest(&testingv1.EchoStreamRequest{Count: 1})
		req.Header().Set("X-Mode", mode)
		st, err := pc.EchoStream(ctx, req)
		if err != nil {
			t.Fatalf("stream %s: %v", mode, err)
		}
		if st.Receive() {
			t.Errorf("stream %s: got a message", mode)
		}
		badAgent("stream "+mode, st.Err())
		_ = st.Close()

		ureq := connect.NewRequest(&testingv1.EchoRequest{})
		ureq.Header().Set("X-Mode", mode)
		_, err = pc.Echo(ctx, ureq)
		badAgent("unary "+mode, err)
	}

	// Raw: the stream refusal is a 200 with the request's content type.
	sreq, _ := http.NewRequestWithContext(ctx, http.MethodPost, gw.machineURL(id)+"/rpc"+testingv1connect.ProcessEchoStreamProcedure,
		strings.NewReader("\x00\x00\x00\x00\x02{}"))
	sreq.Header.Set("Content-Type", "application/connect+json")
	sreq.Header.Set("X-Mode", "header")
	sresp, err := c.Do(sreq)
	if err != nil {
		t.Fatal(err)
	}
	body, err := io.ReadAll(sresp.Body)
	_ = sresp.Body.Close()
	if err != nil || sresp.StatusCode != http.StatusOK || sresp.Header.Get("Content-Type") != "application/connect+json" ||
		len(body) < 5 || body[0] != 2 || !strings.Contains(string(body), wire.CodeBadAgentResponse) || sresp.Header.Get("X-Big") != "" {
		t.Errorf("raw stream refusal: status %d, type %q, body %q, err %v", sresp.StatusCode, sresp.Header.Get("Content-Type"), body, err)
	}

	// Trailers over the limit on a unary answer (trailer), and over what the
	// gateway->agent transport reads (huge-trailer): dropped, the call
	// completes with the agent's body and no reset.
	for _, mode := range []string{"trailer", "huge-trailer"} {
		ureq := connect.NewRequest(&testingv1.EchoRequest{})
		ureq.Header().Set("X-Mode", mode)
		res, err := pc.Echo(ctx, ureq)
		if err != nil || string(res.Msg.GetPayload()) != "payload" || len(res.Trailer()) != 0 {
			t.Fatalf("unary %s: %v, %v; want the answer without trailers", mode, res, err)
		}
		rreq, _ := http.NewRequestWithContext(ctx, http.MethodPost, gw.machineURL(id)+"/rpc"+testingv1connect.ProcessEchoProcedure, strings.NewReader(""))
		rreq.Header.Set("Content-Type", "application/proto")
		rreq.Header.Set("Te", "trailers")
		rreq.Header.Set("X-Mode", mode)
		raw, err := c.Do(rreq)
		if err != nil {
			t.Fatal(err)
		}
		b, err := io.ReadAll(raw.Body)
		_ = raw.Body.Close()
		if err != nil || string(b) != string(answer) || len(raw.Trailer) != 0 {
			t.Errorf("raw unary %s: body %q, err %v, %d trailers; want the body without them", mode, b, err, len(raw.Trailer))
		}
	}
}
