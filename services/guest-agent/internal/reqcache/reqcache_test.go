package reqcache_test

import (
	"context"
	"errors"
	"net/http"
	"net/http/httptest"
	"path/filepath"
	"slices"
	"sync"
	"sync/atomic"
	"testing"
	"time"

	"connectrpc.com/connect"
	"google.golang.org/protobuf/proto"

	agentv1 "github.com/belov38/boat-dev-clone/libs/proto/sbx/agent/v1"
	"github.com/belov38/boat-dev-clone/libs/proto/sbx/agent/v1/agentv1connect"
	"github.com/belov38/boat-dev-clone/libs/tunnel/rpcconv"
	"github.com/belov38/boat-dev-clone/libs/tunnel/wire"

	"github.com/belov38/boat-dev-clone/services/guest-agent/internal/errs"
	"github.com/belov38/boat-dev-clone/services/guest-agent/internal/reqcache"
	"github.com/belov38/boat-dev-clone/services/guest-agent/internal/store"
)

const (
	id1 = "0f8fad5b-d9cb-469f-a165-70867728950e"
	id2 = "01ARZ3NDEKTSV4RRFFQ69G5FAV"
)

// fsStub counts executions of MakeDir and Stat.
type fsStub struct {
	agentv1connect.UnimplementedFilesystemHandler
	makeDirCalls atomic.Int32
	statCalls    atomic.Int32
	// makeDir overrides the MakeDir body; the call is counted before it runs.
	makeDir func(path string) (*agentv1.MakeDirResponse, error)
	// onCtx runs with the handler context right after the call is counted.
	onCtx func(ctx context.Context)
}

func (f *fsStub) MakeDir(ctx context.Context, req *connect.Request[agentv1.MakeDirRequest]) (*connect.Response[agentv1.MakeDirResponse], error) {
	n := f.makeDirCalls.Add(1)
	if f.onCtx != nil {
		f.onCtx(ctx)
	}
	if f.makeDir != nil {
		res, err := f.makeDir(req.Msg.GetPath())
		if err != nil {
			return nil, err
		}
		return connect.NewResponse(res), nil
	}
	return connect.NewResponse(&agentv1.MakeDirResponse{
		Created: true,
		Info:    &agentv1.FileInfo{Path: req.Msg.GetPath(), Size: uint64(n)},
	}), nil
}

func (f *fsStub) Stat(_ context.Context, req *connect.Request[agentv1.StatRequest]) (*connect.Response[agentv1.StatResponse], error) {
	f.statCalls.Add(1)
	return connect.NewResponse(&agentv1.StatResponse{Info: &agentv1.FileInfo{Path: req.Msg.GetPath()}}), nil
}

func openStore(t *testing.T, path string) *store.Store {
	t.Helper()
	st, err := store.Open(path, store.Options{})
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = st.Close() })
	return st
}

func newClient(t *testing.T, st *store.Store, opts reqcache.Options, stub *fsStub) agentv1connect.FilesystemClient {
	t.Helper()
	return newClientWith(t, st, opts, stub)
}

// newClientWith is newClient with extra handler interceptors in front of the
// cache and client options.
func newClientWith(
	t *testing.T, st *store.Store, opts reqcache.Options, stub *fsStub,
	outer ...connect.Interceptor,
) agentv1connect.FilesystemClient {
	t.Helper()
	return newClientOpts(t, st, opts, stub, outer)
}

func newClientOpts(
	t *testing.T, st *store.Store, opts reqcache.Options, stub *fsStub,
	outer []connect.Interceptor, copts ...connect.ClientOption,
) agentv1connect.FilesystemClient {
	t.Helper()
	chain := append(slices.Clone(outer), rpcconv.RequireRequestID(), reqcache.New(st, opts))
	path, h := agentv1connect.NewFilesystemHandler(stub, connect.WithInterceptors(chain...))
	mux := http.NewServeMux()
	mux.Handle(path, h)
	srv := httptest.NewServer(mux)
	t.Cleanup(srv.Close)
	return agentv1connect.NewFilesystemClient(srv.Client(), srv.URL, copts...)
}

func makeDir(c agentv1connect.FilesystemClient, id, path string) (*agentv1.MakeDirResponse, error) {
	req := connect.NewRequest(&agentv1.MakeDirRequest{Path: path})
	if id != "" {
		req.Header().Set(wire.HeaderRequestID, id)
	}
	res, err := c.MakeDir(context.Background(), req)
	if err != nil {
		return nil, err
	}
	return res.Msg, nil
}

func wantCode(t *testing.T, err error, code connect.Code, detail string) {
	t.Helper()
	if connect.CodeOf(err) != code {
		t.Fatalf("code = %v (%v), want %v", connect.CodeOf(err), err, code)
	}
	d, ok := rpcconv.Detail(err)
	if detail != "" && (!ok || d.GetCode() != detail) {
		t.Fatalf("detail = %v, %v, want %q", d, ok, detail)
	}
}

func TestReplaySameBody(t *testing.T) {
	stub := &fsStub{}
	c := newClient(t, openStore(t, filepath.Join(t.TempDir(), "state.db")), reqcache.Options{}, stub)

	first, err := makeDir(c, id1, "/a")
	if err != nil {
		t.Fatal(err)
	}
	second, err := makeDir(c, id1, "/a")
	if err != nil {
		t.Fatal(err)
	}
	if n := stub.makeDirCalls.Load(); n != 1 {
		t.Fatalf("executions = %d, want 1", n)
	}
	if !proto.Equal(first, second) {
		t.Fatalf("responses differ: %v vs %v", first, second)
	}
	if !second.GetCreated() || second.GetInfo().GetPath() != "/a" {
		t.Fatalf("replayed response = %v", second)
	}

	// Another id executes again.
	if _, err := makeDir(c, id2, "/a"); err != nil {
		t.Fatal(err)
	}
	if n := stub.makeDirCalls.Load(); n != 2 {
		t.Fatalf("executions = %d, want 2", n)
	}
}

func TestSameIDOtherBody(t *testing.T) {
	stub := &fsStub{}
	c := newClient(t, openStore(t, filepath.Join(t.TempDir(), "state.db")), reqcache.Options{}, stub)

	if _, err := makeDir(c, id1, "/a"); err != nil {
		t.Fatal(err)
	}
	_, err := makeDir(c, id1, "/b")
	wantCode(t, err, connect.CodeInvalidArgument, errs.RequestIDReused)
	if n := stub.makeDirCalls.Load(); n != 1 {
		t.Fatalf("executions = %d, want 1", n)
	}
}

func TestParallelDuplicateWaits(t *testing.T) {
	started := make(chan struct{}, 4)
	release := make(chan struct{})
	stub := &fsStub{}
	stub.makeDir = func(path string) (*agentv1.MakeDirResponse, error) {
		started <- struct{}{}
		<-release
		return &agentv1.MakeDirResponse{Created: true, Info: &agentv1.FileInfo{Path: path}}, nil
	}
	c := newClient(t, openStore(t, filepath.Join(t.TempDir(), "state.db")), reqcache.Options{}, stub)

	type result struct {
		res *agentv1.MakeDirResponse
		err error
	}
	results := make(chan result, 3)
	call := func(path string) {
		res, err := makeDir(c, id1, path)
		results <- result{res, err}
	}
	go call("/a")
	<-started
	go call("/a")

	select {
	case r := <-results:
		t.Fatalf("duplicate returned before release: %+v", r)
	case <-time.After(150 * time.Millisecond):
	}

	// A duplicate with another body fails at once, without waiting.
	_, err := makeDir(c, id1, "/other")
	wantCode(t, err, connect.CodeInvalidArgument, errs.RequestIDReused)

	close(release)
	for range 2 {
		select {
		case r := <-results:
			if r.err != nil || !r.res.GetCreated() {
				t.Fatalf("result = %+v", r)
			}
		case <-time.After(5 * time.Second):
			t.Fatal("timeout waiting for the calls")
		}
	}
	if n := stub.makeDirCalls.Load(); n != 1 {
		t.Fatalf("executions = %d, want 1", n)
	}
}

func TestRetryableNotCached(t *testing.T) {
	stub := &fsStub{}
	stub.makeDir = func(path string) (*agentv1.MakeDirResponse, error) {
		if stub.makeDirCalls.Load() == 1 {
			return nil, errs.New(connect.CodeUnavailable, errs.Quiesced, "quiesced")
		}
		return &agentv1.MakeDirResponse{Created: true, Info: &agentv1.FileInfo{Path: path}}, nil
	}
	c := newClient(t, openStore(t, filepath.Join(t.TempDir(), "state.db")), reqcache.Options{}, stub)

	_, err := makeDir(c, id1, "/a")
	wantCode(t, err, connect.CodeUnavailable, errs.Quiesced)
	res, err := makeDir(c, id1, "/a")
	if err != nil || !res.GetCreated() {
		t.Fatalf("second call = %v, %v", res, err)
	}
	if n := stub.makeDirCalls.Load(); n != 2 {
		t.Fatalf("executions = %d, want 2", n)
	}
	// The success is now cached.
	if _, err := makeDir(c, id1, "/a"); err != nil {
		t.Fatal(err)
	}
	if n := stub.makeDirCalls.Load(); n != 2 {
		t.Fatalf("executions = %d, want 2", n)
	}
}

func TestNonRetryableErrorCached(t *testing.T) {
	stub := &fsStub{}
	stub.makeDir = func(string) (*agentv1.MakeDirResponse, error) {
		return nil, errs.New(connect.CodeAlreadyExists, errs.AlreadyExists, "exists already")
	}
	c := newClient(t, openStore(t, filepath.Join(t.TempDir(), "state.db")), reqcache.Options{}, stub)

	for range 2 {
		_, err := makeDir(c, id1, "/a")
		wantCode(t, err, connect.CodeAlreadyExists, errs.AlreadyExists)
		var cerr *connect.Error
		if !errors.As(err, &cerr) || cerr.Message() != "exists already" {
			t.Fatalf("message = %v", err)
		}
	}
	if n := stub.makeDirCalls.Load(); n != 1 {
		t.Fatalf("executions = %d, want 1", n)
	}
}

func TestErrorWithoutDetailCached(t *testing.T) {
	stub := &fsStub{}
	stub.makeDir = func(string) (*agentv1.MakeDirResponse, error) {
		return nil, connect.NewError(connect.CodeFailedPrecondition, errors.New("plain"))
	}
	c := newClient(t, openStore(t, filepath.Join(t.TempDir(), "state.db")), reqcache.Options{}, stub)
	for range 2 {
		_, err := makeDir(c, id1, "/a")
		wantCode(t, err, connect.CodeFailedPrecondition, "")
		if _, ok := rpcconv.Detail(err); ok {
			t.Fatalf("unexpected detail on %v", err)
		}
	}
	if n := stub.makeDirCalls.Load(); n != 1 {
		t.Fatalf("executions = %d, want 1", n)
	}
}

func TestCanceledNotCached(t *testing.T) {
	stub := &fsStub{}
	stub.makeDir = func(string) (*agentv1.MakeDirResponse, error) {
		if stub.makeDirCalls.Load() == 1 {
			return nil, connect.NewError(connect.CodeCanceled, errors.New("canceled"))
		}
		return &agentv1.MakeDirResponse{Created: true}, nil
	}
	c := newClient(t, openStore(t, filepath.Join(t.TempDir(), "state.db")), reqcache.Options{}, stub)
	if _, err := makeDir(c, id1, "/a"); connect.CodeOf(err) != connect.CodeCanceled {
		t.Fatalf("err = %v", err)
	}
	if _, err := makeDir(c, id1, "/a"); err != nil {
		t.Fatal(err)
	}
	if n := stub.makeDirCalls.Load(); n != 2 {
		t.Fatalf("executions = %d, want 2", n)
	}
}

func TestIdempotentSkipped(t *testing.T) {
	stub := &fsStub{}
	st := openStore(t, filepath.Join(t.TempDir(), "state.db"))
	c := newClient(t, st, reqcache.Options{}, stub)

	for range 2 {
		req := connect.NewRequest(&agentv1.StatRequest{Path: "/a"})
		req.Header().Set(wire.HeaderRequestID, id1)
		if _, err := c.Stat(context.Background(), req); err != nil {
			t.Fatal(err)
		}
	}
	if n := stub.statCalls.Load(); n != 2 {
		t.Fatalf("executions = %d, want 2", n)
	}
	if _, ok, err := st.GetRequest(id1); err != nil || ok {
		t.Fatalf("GetRequest = %v, %v; Stat must not be stored", ok, err)
	}
}

func TestMissingHeaderPassesThrough(t *testing.T) {
	// Without RequireRequestID in front, a call without the header just runs.
	stub := &fsStub{}
	st := openStore(t, filepath.Join(t.TempDir(), "state.db"))
	path, h := agentv1connect.NewFilesystemHandler(stub, connect.WithInterceptors(reqcache.New(st, reqcache.Options{})))
	mux := http.NewServeMux()
	mux.Handle(path, h)
	srv := httptest.NewServer(mux)
	t.Cleanup(srv.Close)
	c := agentv1connect.NewFilesystemClient(srv.Client(), srv.URL)
	for range 2 {
		if _, err := makeDir(c, "", "/a"); err != nil {
			t.Fatal(err)
		}
	}
	if n := stub.makeDirCalls.Load(); n != 2 {
		t.Fatalf("executions = %d, want 2", n)
	}
}

func TestLargeResponseNotStored(t *testing.T) {
	stub := &fsStub{}
	c := newClient(t, openStore(t, filepath.Join(t.TempDir(), "state.db")), reqcache.Options{MaxResponseBytes: 10}, stub)

	for want := int32(1); want <= 2; want++ {
		res, err := makeDir(c, id1, "/a/long/path/exceeding/ten/bytes")
		if err != nil || !res.GetCreated() {
			t.Fatalf("call %d = %v, %v", want, res, err)
		}
		if n := stub.makeDirCalls.Load(); n != want {
			t.Fatalf("executions = %d, want %d", n, want)
		}
	}
	// The hash is kept: another body under the same id is rejected.
	_, err := makeDir(c, id1, "/b")
	wantCode(t, err, connect.CodeInvalidArgument, errs.RequestIDReused)
	if n := stub.makeDirCalls.Load(); n != 2 {
		t.Fatalf("executions = %d, want 2", n)
	}
}

func TestEmptyResponseReplayed(t *testing.T) {
	stub := &fsStub{}
	stub.makeDir = func(string) (*agentv1.MakeDirResponse, error) { return &agentv1.MakeDirResponse{}, nil }
	c := newClient(t, openStore(t, filepath.Join(t.TempDir(), "state.db")), reqcache.Options{}, stub)
	for range 2 {
		if _, err := makeDir(c, id1, "/a"); err != nil {
			t.Fatal(err)
		}
	}
	if n := stub.makeDirCalls.Load(); n != 1 {
		t.Fatalf("executions = %d, want 1", n)
	}
}

func TestSurvivesReopen(t *testing.T) {
	dbPath := filepath.Join(t.TempDir(), "state.db")
	stub := &fsStub{}

	st1, err := store.Open(dbPath, store.Options{})
	if err != nil {
		t.Fatal(err)
	}
	c1 := newClient(t, st1, reqcache.Options{}, stub)
	first, err := makeDir(c1, id1, "/a")
	if err != nil {
		t.Fatal(err)
	}
	if err := st1.Close(); err != nil {
		t.Fatal(err)
	}

	// New store, new interceptor: nothing is left in memory.
	st2 := openStore(t, dbPath)
	c2 := newClient(t, st2, reqcache.Options{}, stub)
	second, err := makeDir(c2, id1, "/a")
	if err != nil {
		t.Fatal(err)
	}
	if n := stub.makeDirCalls.Load(); n != 1 {
		t.Fatalf("executions = %d, want 1", n)
	}
	if !proto.Equal(first, second) {
		t.Fatalf("responses differ: %v vs %v", first, second)
	}
	_, err = makeDir(c2, id1, "/b")
	wantCode(t, err, connect.CodeInvalidArgument, errs.RequestIDReused)
}

func TestExpiredEntryExecutesAgain(t *testing.T) {
	var mu sync.Mutex
	now := time.Date(2026, 1, 1, 0, 0, 0, 0, time.UTC)
	clock := func() time.Time { mu.Lock(); defer mu.Unlock(); return now }
	stub := &fsStub{}
	c := newClient(t, openStore(t, filepath.Join(t.TempDir(), "state.db")),
		reqcache.Options{TTL: time.Hour, Now: clock}, stub)

	if _, err := makeDir(c, id1, "/a"); err != nil {
		t.Fatal(err)
	}
	mu.Lock()
	now = now.Add(2 * time.Hour)
	mu.Unlock()
	// Expired: the id is free again, even for another body.
	if _, err := makeDir(c, id1, "/b"); err != nil {
		t.Fatal(err)
	}
	if n := stub.makeDirCalls.Load(); n != 2 {
		t.Fatalf("executions = %d, want 2", n)
	}
}

func TestStoreFailureStillReturnsResponse(t *testing.T) {
	stub := &fsStub{}
	st := openStore(t, filepath.Join(t.TempDir(), "state.db"))
	// The client's deadline would also end the server ctx; give the cache a
	// shorter ctx than the client has, like a call near its deadline.
	short := connect.UnaryInterceptorFunc(func(next connect.UnaryFunc) connect.UnaryFunc {
		return func(ctx context.Context, req connect.AnyRequest) (connect.AnyResponse, error) {
			ctx, cancel := context.WithTimeout(ctx, 200*time.Millisecond)
			defer cancel()
			return next(ctx, req)
		}
	})
	path, h := agentv1connect.NewFilesystemHandler(stub,
		connect.WithInterceptors(short, reqcache.New(st, reqcache.Options{})))
	mux := http.NewServeMux()
	mux.Handle(path, h)
	srv := httptest.NewServer(mux)
	t.Cleanup(srv.Close)
	c := agentv1connect.NewFilesystemClient(srv.Client(), srv.URL)

	// Frozen store: the put waits for the thaw until the ctx ends.
	st.SetFrozen(true)
	t.Cleanup(func() { st.SetFrozen(false) })
	res, err := makeDir(c, id1, "/a")
	if err != nil || !res.GetCreated() {
		t.Fatalf("MakeDir = %v, %v", res, err)
	}
	if n := stub.makeDirCalls.Load(); n != 1 {
		t.Fatalf("executions = %d, want 1", n)
	}
}

func TestInterceptorsOptions(t *testing.T) {
	st := openStore(t, filepath.Join(t.TempDir(), "state.db"))
	opts := reqcache.Interceptors(st)
	if len(opts) == 0 {
		t.Fatal("no options")
	}
	stub := &fsStub{}
	path, h := agentv1connect.NewFilesystemHandler(stub, opts...)
	mux := http.NewServeMux()
	mux.Handle(path, h)
	srv := httptest.NewServer(mux)
	t.Cleanup(srv.Close)
	c := agentv1connect.NewFilesystemClient(srv.Client(), srv.URL)

	_, err := makeDir(c, "", "/a")
	wantCode(t, err, connect.CodeInvalidArgument, wire.CodeRequestIDRequired)
	if _, err := makeDir(c, id1, "/a"); err != nil {
		t.Fatal(err)
	}
}

func TestPrunesExpiredEntries(t *testing.T) {
	st := openStore(t, filepath.Join(t.TempDir(), "state.db"))
	old := &store.Request{Procedure: "p", Hash: "h", ExpiresAt: time.Now().Add(-time.Hour)}
	if err := st.PutRequest(context.Background(), "old", old); err != nil {
		t.Fatal(err)
	}
	c := newClient(t, st, reqcache.Options{}, &fsStub{})
	if _, err := makeDir(c, id1, "/a"); err != nil {
		t.Fatal(err)
	}
	deadline := time.Now().Add(5 * time.Second)
	for {
		_, ok, err := st.GetRequest("old")
		if err != nil {
			t.Fatal(err)
		}
		if !ok {
			break
		}
		if time.Now().After(deadline) {
			t.Fatal("expired entry was not pruned")
		}
		time.Sleep(10 * time.Millisecond)
	}
	if _, ok, _ := st.GetRequest(id1); !ok {
		t.Fatal("fresh entry was pruned")
	}
}

// processStub counts executions of Process.Start.
type processStub struct {
	agentv1connect.UnimplementedProcessHandler
	calls atomic.Int32
}

func (p *processStub) Start(_ context.Context, _ *connect.Request[agentv1.StartRequest]) (*connect.Response[agentv1.StartResponse], error) {
	n := p.calls.Add(1)
	// created is true only for the first execution, like the real handler.
	return connect.NewResponse(&agentv1.StartResponse{Created: n == 1}), nil
}

func TestProcessStartNotCached(t *testing.T) {
	st := openStore(t, filepath.Join(t.TempDir(), "state.db"))
	stub := &processStub{}
	path, h := agentv1connect.NewProcessHandler(stub, reqcache.Interceptors(st)...)
	mux := http.NewServeMux()
	mux.Handle(path, h)
	srv := httptest.NewServer(mux)
	t.Cleanup(srv.Close)
	c := agentv1connect.NewProcessClient(srv.Client(), srv.URL)

	var created []bool
	for range 2 {
		req := connect.NewRequest(&agentv1.StartRequest{CommandId: "c1"})
		req.Header().Set(wire.HeaderRequestID, id1)
		res, err := c.Start(context.Background(), req)
		if err != nil {
			t.Fatal(err)
		}
		created = append(created, res.Msg.GetCreated())
	}
	if n := stub.calls.Load(); n != 2 {
		t.Fatalf("executions = %d, want 2 (Start is idempotent by command_id)", n)
	}
	if created[0] != true || created[1] != false {
		t.Fatalf("created = %v, want [true false]", created)
	}
	if _, ok, err := st.GetRequest(id1); err != nil || ok {
		t.Fatalf("GetRequest = %v, %v; Start must not be stored", ok, err)
	}
}

func TestExemptOption(t *testing.T) {
	st := openStore(t, filepath.Join(t.TempDir(), "state.db"))
	stub := &fsStub{}
	c := newClient(t, st, reqcache.Options{Exempt: []string{agentv1connect.FilesystemMakeDirProcedure}}, stub)
	for range 2 {
		if _, err := makeDir(c, id1, "/a"); err != nil {
			t.Fatal(err)
		}
	}
	if n := stub.makeDirCalls.Load(); n != 2 {
		t.Fatalf("executions = %d, want 2", n)
	}
}

func TestReplayJSONCodec(t *testing.T) {
	stub := &fsStub{}
	c := newClientOpts(t, openStore(t, filepath.Join(t.TempDir(), "state.db")), reqcache.Options{}, stub,
		nil, connect.WithProtoJSON())

	first, err := makeDir(c, id1, "/a")
	if err != nil {
		t.Fatal(err)
	}
	second, err := makeDir(c, id1, "/a")
	if err != nil {
		t.Fatal(err)
	}
	if n := stub.makeDirCalls.Load(); n != 1 {
		t.Fatalf("executions = %d, want 1", n)
	}
	if !proto.Equal(first, second) || !second.GetCreated() || second.GetInfo().GetPath() != "/a" {
		t.Fatalf("responses differ: %v vs %v", first, second)
	}
}

func TestOutcomeStoredAfterClientCancel(t *testing.T) {
	st := openStore(t, filepath.Join(t.TempDir(), "state.db"))
	stub := &fsStub{}
	callCtx, cancel := context.WithCancel(context.Background())
	defer cancel()
	stub.onCtx = func(ctx context.Context) {
		if stub.makeDirCalls.Load() != 1 {
			return
		}
		// The client gives up while the handler runs; the response is
		// produced after the call context is gone.
		cancel()
		<-ctx.Done()
	}
	c := newClient(t, st, reqcache.Options{}, stub)

	req := connect.NewRequest(&agentv1.MakeDirRequest{Path: "/a"})
	req.Header().Set(wire.HeaderRequestID, id1)
	if _, err := c.MakeDir(callCtx, req); connect.CodeOf(err) != connect.CodeCanceled {
		t.Fatalf("first call = %v, want canceled", err)
	}

	// The retry replays the outcome (it may first wait for the leader).
	res, err := makeDir(c, id1, "/a")
	if err != nil || !res.GetCreated() {
		t.Fatalf("retry = %v, %v", res, err)
	}
	if n := stub.makeDirCalls.Load(); n != 1 {
		t.Fatalf("executions = %d, want 1", n)
	}
	waitStored(t, st, id1)
}

// waitStored waits until the outcome of id is in the store.
func waitStored(t *testing.T, st *store.Store, id string) {
	t.Helper()
	deadline := time.Now().Add(5 * time.Second)
	for {
		_, ok, err := st.GetRequest(id)
		if err != nil {
			t.Fatal(err)
		}
		if ok {
			return
		}
		if time.Now().After(deadline) {
			t.Fatalf("outcome of %s was not stored", id)
		}
		time.Sleep(5 * time.Millisecond)
	}
}

func TestFrozenStoreBuffersOutcome(t *testing.T) {
	dbPath := filepath.Join(t.TempDir(), "state.db")
	st, err := store.Open(dbPath, store.Options{})
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = st.Close() })
	stub := &fsStub{}
	c := newClient(t, st, reqcache.Options{}, stub)

	st.SetFrozen(true)
	start := time.Now()
	first, err := makeDir(c, id1, "/a")
	if err != nil || !first.GetCreated() {
		t.Fatalf("first = %v, %v", first, err)
	}
	if d := time.Since(start); d > time.Second {
		t.Fatalf("response took %v on a frozen store", d)
	}

	// Replay is served from memory while the store is frozen.
	second, err := makeDir(c, id1, "/a")
	if err != nil {
		t.Fatal(err)
	}
	if n := stub.makeDirCalls.Load(); n != 1 {
		t.Fatalf("executions = %d, want 1", n)
	}
	if !proto.Equal(first, second) {
		t.Fatalf("responses differ: %v vs %v", first, second)
	}
	_, err = makeDir(c, id1, "/b")
	wantCode(t, err, connect.CodeInvalidArgument, errs.RequestIDReused)
	if _, ok, _ := st.GetRequest(id1); ok {
		t.Fatal("outcome reached the store while frozen")
	}

	// The thaw flushes the buffer.
	st.SetFrozen(false)
	waitStored(t, st, id1)
	if err := st.Close(); err != nil {
		t.Fatal(err)
	}

	st2 := openStore(t, dbPath)
	c2 := newClient(t, st2, reqcache.Options{}, stub)
	third, err := makeDir(c2, id1, "/a")
	if err != nil || !proto.Equal(first, third) {
		t.Fatalf("after reopen = %v, %v", third, err)
	}
	if n := stub.makeDirCalls.Load(); n != 1 {
		t.Fatalf("executions = %d, want 1", n)
	}
}

func TestFrozenBufferIsBounded(t *testing.T) {
	st := openStore(t, filepath.Join(t.TempDir(), "state.db"))
	stub := &fsStub{}
	c := newClient(t, st, reqcache.Options{MaxPending: 2}, stub)

	ids := []string{
		"0f8fad5b-d9cb-469f-a165-70867728950a",
		"0f8fad5b-d9cb-469f-a165-70867728950b",
		"0f8fad5b-d9cb-469f-a165-70867728950c",
	}
	st.SetFrozen(true)
	for _, id := range ids {
		if _, err := makeDir(c, id, "/a"); err != nil {
			t.Fatal(err)
		}
	}
	// The oldest was dropped: its id executes again; the others replay.
	if _, err := makeDir(c, ids[2], "/a"); err != nil {
		t.Fatal(err)
	}
	if n := stub.makeDirCalls.Load(); n != 3 {
		t.Fatalf("executions = %d, want 3", n)
	}
	if _, err := makeDir(c, ids[0], "/a"); err != nil {
		t.Fatal(err)
	}
	if n := stub.makeDirCalls.Load(); n != 4 {
		t.Fatalf("executions = %d, want 4 (oldest dropped)", n)
	}
	st.SetFrozen(false)
	waitStored(t, st, ids[2])
}

func TestFreezeDuringHandlerBuffers(t *testing.T) {
	// The store freezes while the handler runs (System/Quiesce).
	st := openStore(t, filepath.Join(t.TempDir(), "state.db"))
	stub := &fsStub{}
	stub.onCtx = func(context.Context) { st.SetFrozen(true) }
	c := newClient(t, st, reqcache.Options{}, stub)

	if _, err := makeDir(c, id1, "/a"); err != nil {
		t.Fatal(err)
	}
	if _, err := makeDir(c, id1, "/a"); err != nil {
		t.Fatal(err)
	}
	if n := stub.makeDirCalls.Load(); n != 1 {
		t.Fatalf("executions = %d, want 1", n)
	}
	st.SetFrozen(false)
	waitStored(t, st, id1)
}

func TestWaiterRunsHandlerAfterRetryableLeader(t *testing.T) {
	started := make(chan struct{}, 2)
	release := make(chan struct{})
	stub := &fsStub{}
	stub.makeDir = func(path string) (*agentv1.MakeDirResponse, error) {
		if stub.makeDirCalls.Load() == 1 {
			started <- struct{}{}
			<-release
			return nil, errs.New(connect.CodeUnavailable, errs.Quiesced, "quiesced")
		}
		return &agentv1.MakeDirResponse{Created: true, Info: &agentv1.FileInfo{Path: path}}, nil
	}
	c := newClient(t, openStore(t, filepath.Join(t.TempDir(), "state.db")), reqcache.Options{}, stub)

	leaderErr := make(chan error, 1)
	go func() {
		_, err := makeDir(c, id1, "/a")
		leaderErr <- err
	}()
	<-started

	type result struct {
		res *agentv1.MakeDirResponse
		err error
	}
	dup := make(chan result, 1)
	go func() {
		res, err := makeDir(c, id1, "/a")
		dup <- result{res, err}
	}()
	select {
	case r := <-dup:
		t.Fatalf("duplicate returned before the leader: %+v", r)
	case <-time.After(150 * time.Millisecond):
	}

	close(release)
	wantCode(t, <-leaderErr, connect.CodeUnavailable, errs.Quiesced)
	select {
	case r := <-dup:
		if r.err != nil || !r.res.GetCreated() {
			t.Fatalf("duplicate = %+v", r)
		}
	case <-time.After(5 * time.Second):
		t.Fatal("duplicate did not run the handler")
	}
	if n := stub.makeDirCalls.Load(); n != 2 {
		t.Fatalf("executions = %d, want 2", n)
	}
}

func TestCanceledWaiterReturnsPromptly(t *testing.T) {
	started := make(chan struct{}, 1)
	release := make(chan struct{})
	stub := &fsStub{}
	stub.makeDir = func(string) (*agentv1.MakeDirResponse, error) {
		started <- struct{}{}
		<-release
		return &agentv1.MakeDirResponse{Created: true}, nil
	}
	// Records when each call leaves the cache, as seen by the server.
	returned := make(chan error, 4)
	observe := connect.UnaryInterceptorFunc(func(next connect.UnaryFunc) connect.UnaryFunc {
		return func(ctx context.Context, req connect.AnyRequest) (connect.AnyResponse, error) {
			res, err := next(ctx, req)
			returned <- err
			return res, err
		}
	})
	c := newClientWith(t, openStore(t, filepath.Join(t.TempDir(), "state.db")), reqcache.Options{}, stub, observe)

	leaderDone := make(chan struct{})
	go func() {
		defer close(leaderDone)
		_, _ = makeDir(c, id1, "/a")
	}()
	<-started

	ctx, cancel := context.WithCancel(context.Background())
	waiterDone := make(chan error, 1)
	go func() {
		req := connect.NewRequest(&agentv1.MakeDirRequest{Path: "/a"})
		req.Header().Set(wire.HeaderRequestID, id1)
		_, err := c.MakeDir(ctx, req)
		waiterDone <- err
	}()
	time.Sleep(100 * time.Millisecond)
	cancel()

	select {
	case err := <-waiterDone:
		if connect.CodeOf(err) != connect.CodeCanceled {
			t.Fatalf("waiter = %v, want canceled", err)
		}
	case <-time.After(2 * time.Second):
		t.Fatal("canceled waiter did not return")
	}
	// The server side of the waiter leaves while the leader still runs.
	select {
	case err := <-returned:
		if err == nil {
			t.Fatal("server-side call returned success; the leader is still blocked")
		}
	case <-time.After(2 * time.Second):
		t.Fatal("server did not release the canceled waiter")
	}
	close(release)
	<-leaderDone
	if n := stub.makeDirCalls.Load(); n != 1 {
		t.Fatalf("executions = %d, want 1", n)
	}
}
