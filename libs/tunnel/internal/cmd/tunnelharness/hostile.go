package main

import (
	"context"
	"crypto/rand"
	"fmt"
	"io"
	"net/http"
	"slices"
	"strings"
	"sync"

	"connectrpc.com/connect"

	testingv1 "github.com/belov38/umiak/libs/tunnel/tunneltest/testpb/umiak/testing/v1"
	"github.com/belov38/umiak/libs/tunnel/tunneltest/testpb/umiak/testing/v1/testingv1connect"
)

// The gateway's limits on what it passes from an agent answer to a caller
// (libs/tunnel/gateway/proxy.go): header block and trailer block bytes
// (HTTP/2 size: name, value and 32 per field), fields per block, declared
// trailer names and their length.
const (
	gwMaxBlockBytes      = 64 << 10
	gwMaxFields          = 100
	gwMaxDeclared        = 32
	gwMaxTrailerName     = 256
	gwServerHeaderBytes  = 4*32 + 128 // reserved for :status, Date, Content-Length, Content-Type
	gwTrailerReserve     = 32         // keeps a trailer block below Node's 65535
	fieldOverhead        = 32
	dateFieldBytes       = len("Date") + len("Mon, 02 Jan 2006 15:04:05 GMT") + fieldOverhead
	contentLengthMaxSize = len("Content-Length") + 8 + fieldOverhead
)

// headerCallID is the request header the test sets on every call to the
// hostile machine; the harness counts the requests that reached the agent
// per value (GET /hostile).
const headerCallID = "X-Call-Id"

// attack is one way a hostile agent shapes its answer: head runs on the
// response header just before it is written (Trailer declarations
// included), tail after the body (trailer values).
type attack struct {
	head func(h http.Header)
	tail func(h http.Header)
}

// trailerNames returns n trailer names of size bytes each.
func trailerNames(n, size int) []string {
	out := make([]string, 0, n)
	for i := range n {
		p := fmt.Sprintf("X-T%03d-", i)
		out = append(out, p+strings.Repeat("n", size-len(p)))
	}
	return out
}

func declare(names ...string) func(h http.Header) {
	return func(h http.Header) {
		for _, k := range names {
			h.Add("Trailer", k)
		}
	}
}

// sendTrailers sets a short value for each declared name.
func sendTrailers(names ...string) func(h http.Header) {
	return func(h http.Header) {
		for _, k := range names {
			h.Set(k, "t")
		}
	}
}

func fields(n int) func(h http.Header) {
	return func(h http.Header) {
		for i := range n {
			h.Set(fmt.Sprintf("X-Field-%03d", i), "v")
		}
	}
}

// trailerFields sets n undeclared trailers.
func trailerFields(n int) func(h http.Header) {
	return func(h http.Header) {
		for i := range n {
			h.Set(fmt.Sprintf("%sX-Tf-%03d", http.TrailerPrefix, i), "v")
		}
	}
}

// printable returns n random printable ASCII bytes (poorly compressible by
// HPACK), or n times "r" when repeated.
func printable(n int, repeated bool) string {
	if repeated {
		return strings.Repeat("r", n)
	}
	b := make([]byte, n)
	_, _ = rand.Read(b)
	for i := range b {
		b[i] = 0x21 + b[i]%(0x7f-0x21)
	}
	return string(b)
}

// blockSize is the HTTP/2 size of h, a Trailer field per declared name as
// the gateway re-emits them.
func blockSize(h http.Header) int {
	n := 0
	for k, vv := range h {
		for _, v := range vv {
			n += len(k) + len(v) + fieldOverhead
		}
	}
	return n
}

// fillTo adds X-Fill-NN headers (values of at most 4 KiB) so that the block
// the gateway counts (its reserve, h, the Date and Content-Length the agent's
// server adds) is target bytes. With under, the Content-Length estimate is
// counted so the real block is at most target; otherwise it is left out, so
// the real block is at least target.
func fillTo(h http.Header, target int, under, repeated bool) {
	size := gwServerHeaderBytes + blockSize(h) + dateFieldBytes
	if under {
		size += contentLengthMaxSize
	}
	for i := 0; size < target; i++ {
		k := fmt.Sprintf("X-Fill-%02d", i)
		n := min(4<<10, target-size-len(k)-fieldOverhead)
		if n <= 0 {
			break
		}
		h.Set(k, printable(n, repeated))
		size += len(k) + n + fieldOverhead
	}
}

// bigTrailer sets one trailer of total HTTP/2 size n (name, value, 32).
func bigTrailer(name string, n int, prefix string) func(h http.Header) {
	return func(h http.Header) {
		h.Set(prefix+name, printable(n-len(name)-fieldOverhead, false))
	}
}

// attacks are the hostile answers by name. Under-limit ones pass the gateway
// and must reach the caller intact; the others are refused (502 or a Connect
// error) or, for trailers, reset that one stream.
var attacks = func() map[string]attack {
	names32 := trailerNames(gwMaxDeclared, gwMaxTrailerName)
	names200 := trailerNames(gwMaxDeclared, 200)
	// The largest trailer block the gateway passes, and one just over it.
	trailerUnder := gwMaxBlockBytes - gwTrailerReserve - 256
	trailerOver := gwMaxBlockBytes - gwTrailerReserve + 64
	headUnder := gwMaxBlockBytes - 512
	headOver := gwMaxBlockBytes + 64
	m := map[string]attack{
		"none":                 {},
		"trailer-name-140k":    {head: declare("X-" + strings.Repeat("n", 140000))},
		"trailer-names-12x60k": {head: declare(trailerNames(12, 60000)...)},
		"trailer-names-33":     {head: declare(trailerNames(gwMaxDeclared+1, 16)...), tail: sendTrailers(trailerNames(gwMaxDeclared+1, 16)...)},
		"trailer-name-257":     {head: declare(trailerNames(1, gwMaxTrailerName+1)...), tail: sendTrailers(trailerNames(1, gwMaxTrailerName+1)...)},
		"trailer-names-32x256": {head: declare(names32...), tail: sendTrailers(names32...)},
		"fields-85":            {head: fields(85)},
		"fields-100":           {head: fields(100)},
		"fields-101":           {head: fields(101)},
		"fields-140":           {head: fields(140)},
		"trailer-under":        {head: declare("X-Big-Trailer"), tail: bigTrailer("X-Big-Trailer", trailerUnder, "")},
		"trailer-over":         {tail: bigTrailer("X-Big-Trailer", trailerOver, http.TrailerPrefix)},
		// Exactly 64 KiB: over Node's default maxHeaderListSize (65535).
		"trailer-edge": {tail: bigTrailer("X-Big-Trailer", gwMaxBlockBytes, http.TrailerPrefix)},
		"trailer-over-declared": {
			head: declare("X-Big-Trailer"), tail: bigTrailer("X-Big-Trailer", trailerOver, ""),
		},
		"trailer-fields-90":  {tail: trailerFields(90)},
		"trailer-fields-101": {tail: trailerFields(gwMaxFields + 1)},
		"trailer-fields-140": {tail: trailerFields(140)},
		// Header and trailer blocks each just under their limit.
		"headers-and-trailers": {
			head: func(h http.Header) {
				declare("X-Big-Trailer")(h)
				fillTo(h, headUnder, true, false)
			},
			tail: bigTrailer("X-Big-Trailer", trailerUnder, ""),
		},
	}
	// Headers with 32 declared names, filled to just under or over the limit.
	for _, under := range []bool{true, false} {
		for _, repeated := range []bool{false, true} {
			name := map[bool]string{true: "headers-under", false: "headers-over"}[under] +
				map[bool]string{false: "-random", true: "-repeated"}[repeated]
			target := map[bool]int{true: headUnder, false: headOver}[under]
			m[name] = attack{
				head: func(h http.Header) {
					declare(names200...)(h)
					fillTo(h, target, under, repeated)
				},
				tail: sendTrailers(names200...),
			}
		}
	}
	return m
}()

// attackNames returns the attack names, sorted.
func attackNames() []string {
	out := make([]string, 0, len(attacks))
	for k := range attacks {
		out = append(out, k)
	}
	slices.Sort(out)
	return out
}

// hostileCalls counts the requests that reached a hostile agent per call id.
type hostileCalls struct {
	mu sync.Mutex
	n  map[string]int
}

func (c *hostileCalls) add(id string) {
	if id == "" {
		return
	}
	c.mu.Lock()
	c.n[id]++
	c.mu.Unlock()
}

func (c *hostileCalls) get(id string) int {
	c.mu.Lock()
	defer c.mu.Unlock()
	return c.n[id]
}

type attackKey struct{}

// attackState carries the attack a handler picked to the response writer.
type attackState struct {
	mu   sync.Mutex
	name string
}

func (s *attackState) set(name string) {
	s.mu.Lock()
	s.name = name
	s.mu.Unlock()
}

func (s *attackState) get() attack {
	s.mu.Lock()
	defer s.mu.Unlock()
	return attacks[s.name]
}

func pick(ctx context.Context, name string) error {
	if _, ok := attacks[name]; !ok {
		return connect.NewError(connect.CodeInvalidArgument, fmt.Errorf("unknown attack %q", name))
	}
	if s, ok := ctx.Value(attackKey{}).(*attackState); ok {
		s.set(name)
	}
	return nil
}

// attackWriter applies the picked attack to the response header when it is
// written.
type attackWriter struct {
	http.ResponseWriter
	st    *attackState
	wrote bool
}

func (w *attackWriter) WriteHeader(code int) {
	if !w.wrote {
		w.wrote = true
		if a := w.st.get(); a.head != nil {
			a.head(w.Header())
		}
	}
	w.ResponseWriter.WriteHeader(code)
}

func (w *attackWriter) Write(p []byte) (int, error) {
	if !w.wrote {
		w.WriteHeader(http.StatusOK)
	}
	return w.ResponseWriter.Write(p)
}

func (w *attackWriter) Flush() {
	if !w.wrote {
		w.WriteHeader(http.StatusOK)
	}
	if f, ok := w.ResponseWriter.(http.Flusher); ok {
		f.Flush()
	}
}

func (w *attackWriter) Unwrap() http.ResponseWriter { return w.ResponseWriter }

// withAttack counts the request and lets next pick an attack (pick), which
// is then applied to its answer: head when the header is written, tail
// after next returns.
func withAttack(calls *hostileCalls, next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		calls.add(r.Header.Get(headerCallID))
		st := &attackState{}
		aw := &attackWriter{ResponseWriter: w, st: st}
		next.ServeHTTP(aw, r.WithContext(context.WithValue(r.Context(), attackKey{}, st)))
		if !aw.wrote {
			aw.WriteHeader(http.StatusOK)
		}
		if a := st.get(); a.tail != nil {
			a.tail(w.Header())
		}
	})
}

// hostileHandlers registers the hostile machine's Echo, EchoStream and
// /files/hostile/{attack}; they take precedence over the Process double's.
func hostileHandlers(mux *http.ServeMux, calls *hostileCalls) {
	mux.Handle(testingv1connect.ProcessEchoProcedure, withAttack(calls, connect.NewUnaryHandler(
		testingv1connect.ProcessEchoProcedure,
		func(ctx context.Context, req *connect.Request[testingv1.EchoRequest]) (*connect.Response[testingv1.EchoResponse], error) {
			if err := pick(ctx, req.Msg.GetAttack()); err != nil {
				return nil, err
			}
			return connect.NewResponse(&testingv1.EchoResponse{Payload: req.Msg.GetPayload()}), nil
		})))
	mux.Handle(testingv1connect.ProcessEchoStreamProcedure, withAttack(calls, connect.NewServerStreamHandler(
		testingv1connect.ProcessEchoStreamProcedure,
		func(ctx context.Context, req *connect.Request[testingv1.EchoStreamRequest], s *connect.ServerStream[testingv1.EchoStreamResponse]) error {
			if err := pick(ctx, req.Msg.GetAttack()); err != nil {
				return err
			}
			for i := range req.Msg.GetCount() {
				if err := s.Send(&testingv1.EchoStreamResponse{Index: i, Payload: req.Msg.GetPayload()}); err != nil {
					return err
				}
			}
			return nil
		})))
	mux.Handle("/files/hostile/{attack}", withAttack(calls, http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		_, _ = io.Copy(io.Discard, r.Body)
		name := r.PathValue("attack")
		if err := pick(r.Context(), name); err != nil {
			http.Error(w, err.Error(), http.StatusNotFound)
			return
		}
		w.Header().Set("Content-Type", "application/octet-stream")
		_, _ = io.WriteString(w, "hostile files body: "+name)
	})))
}
