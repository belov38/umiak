// Package reqcache makes mutating Connect calls retry-safe: a Connect
// interceptor that stores the outcome of a call under its Sbx-Request-Id and
// replays it for a repeat of the same request (spec section 15).
//
// A repeat is the same id with the same procedure and request body. The same
// id with another body is rejected with request_id_reused. A repeat that
// arrives while the first call still runs waits for it. Only final outcomes
// are stored: success and non-retryable errors (decision 2 of the executor
// notes). A success larger than Options.MaxResponseBytes keeps its hash only,
// so a repeat runs the handler again.
//
// The outcome is written with a context detached from the call, so a client
// that gave up does not lose it. While the agent's own filesystem is frozen
// (spec section 14.4) the store accepts no writes: outcomes are then kept in
// a bounded in-memory buffer, served to repeats from there and written to the
// store at the thaw. A response never waits on a frozen store.
package reqcache

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"errors"
	"fmt"
	"log/slog"
	"slices"
	"sync"
	"sync/atomic"
	"time"

	"connectrpc.com/connect"
	"google.golang.org/protobuf/proto"
	"google.golang.org/protobuf/reflect/protoreflect"
	"google.golang.org/protobuf/reflect/protoregistry"
	"google.golang.org/protobuf/types/dynamicpb"

	"github.com/belov38/boat-dev-clone/libs/proto/sbx/agent/v1/agentv1connect"
	"github.com/belov38/boat-dev-clone/libs/tunnel/rpcconv"
	"github.com/belov38/boat-dev-clone/libs/tunnel/wire"

	"github.com/belov38/boat-dev-clone/services/guest-agent/internal/errs"
	"github.com/belov38/boat-dev-clone/services/guest-agent/internal/store"
)

// Defaults of Options.
const (
	DefaultTTL              = 24 * time.Hour
	DefaultMaxEntries       = 10000
	DefaultMaxResponseBytes = 1 << 20
	DefaultMaxPending       = 10000

	// putTimeout bounds one write of an outcome to the store.
	putTimeout = 5 * time.Second
	// pruneEvery is the number of stored outcomes between two prune runs.
	pruneEvery = 256
	// pruneTimeout bounds one prune run.
	pruneTimeout = 30 * time.Second
)

// Options configures the interceptor. Zero values select the defaults.
type Options struct {
	// TTL is how long an outcome is kept. Default 24h.
	TTL time.Duration
	// MaxEntries is the most outcomes kept; the ones expiring first are
	// pruned beyond it. Default 10000.
	MaxEntries int
	// MaxResponseBytes is the largest encoded response that is stored.
	// Default 1 MiB.
	MaxResponseBytes int
	// MaxPending is the most outcomes buffered in memory while the store is
	// frozen; beyond it the oldest is dropped. Default 10000.
	MaxPending int
	// Exempt lists procedures that are never cached, even when the call
	// carries Sbx-Request-Id.
	Exempt []string
	// Now is the clock. Default time.Now.
	Now func() time.Time
	// Log receives store failures. Default slog.Default().
	Log *slog.Logger
}

func (o *Options) setDefaults() {
	if o.TTL <= 0 {
		o.TTL = DefaultTTL
	}
	if o.MaxEntries <= 0 {
		o.MaxEntries = DefaultMaxEntries
	}
	if o.MaxResponseBytes <= 0 {
		o.MaxResponseBytes = DefaultMaxResponseBytes
	}
	if o.MaxPending <= 0 {
		o.MaxPending = DefaultMaxPending
	}
	if o.Now == nil {
		o.Now = time.Now
	}
	if o.Log == nil {
		o.Log = slog.Default()
	}
}

// Interceptors returns the handler options every agent service with mutating
// calls uses: the Sbx-Request-Id requirement followed by the response cache.
// It is NewCache(st).Options(); the agent uses NewCache to flush the cache at
// shutdown.
func Interceptors(st *store.Store) []connect.HandlerOption {
	return NewCache(st).Options()
}

// Cache is the request cache shared by the agent's services. Create it once
// and pass Options to every service handler: the services then share their
// in-flight calls and buffered outcomes, so the same id sent to two services
// is still one call.
type Cache struct {
	ic   *interceptor
	opts []connect.HandlerOption
}

// NewCache returns the agent's request cache over st: the Sbx-Request-Id
// requirement followed by the response cache. Process.Start is exempt from
// both, it is idempotent by its own command id.
func NewCache(st *store.Store) *Cache {
	exempt := []string{agentv1connect.ProcessStartProcedure}
	ic := newInterceptor(st, Options{Exempt: exempt})
	return &Cache{
		ic:   ic,
		opts: []connect.HandlerOption{connect.WithInterceptors(rpcconv.RequireRequestID(exempt...), ic)},
	}
}

// Options returns the handler options of the cache.
func (c *Cache) Options() []connect.HandlerOption {
	return slices.Clone(c.opts)
}

// Flush writes the outcomes buffered while the store was frozen, waiting for
// the thaw, and returns when the buffer is empty. Call it at shutdown before
// the store is flushed and closed: the background flusher discards what it
// has not written when the store closes, and a retry of a lost outcome would
// run the mutation again. It fails when ctx ends first or the store is
// closed.
func (c *Cache) Flush(ctx context.Context) error {
	return c.ic.flush(ctx)
}

// New returns the response cache interceptor. It acts on unary handler calls
// that carry Sbx-Request-Id and are not IDEMPOTENT, NO_SIDE_EFFECTS or listed
// in Options.Exempt; every other call passes through. Put it after
// rpcconv.RequireRequestID, which rejects mutating calls without an id. One
// interceptor value may be used by any number of services.
func New(st *store.Store, opts Options) connect.Interceptor {
	return newInterceptor(st, opts)
}

func newInterceptor(st *store.Store, opts Options) *interceptor {
	opts.setDefaults()
	exempt := make(map[string]struct{}, len(opts.Exempt))
	for _, p := range opts.Exempt {
		exempt[p] = struct{}{}
	}
	return &interceptor{
		st:      st,
		opts:    opts,
		exempt:  exempt,
		flights: &flights{m: make(map[string]*flight)},
		pending: newPendingSet(opts.MaxPending),
	}
}

// flights is the in-memory singleflight keyed by request id.
type flights struct {
	mu sync.Mutex
	m  map[string]*flight
}

// flight is a call that runs now. done is closed after rec is set (rec stays
// nil when the call produced no storable outcome).
type flight struct {
	hash string
	done chan struct{}
	rec  *store.Request
}

type interceptor struct {
	st      *store.Store
	opts    Options
	exempt  map[string]struct{}
	flights *flights
	pending *pendingSet
	puts    atomic.Uint64
	pruning atomic.Bool
}

// WrapUnary implements connect.Interceptor.
func (i *interceptor) WrapUnary(next connect.UnaryFunc) connect.UnaryFunc {
	return func(ctx context.Context, req connect.AnyRequest) (connect.AnyResponse, error) {
		spec := req.Spec()
		if spec.IsClient {
			return next(ctx, req)
		}
		switch spec.IdempotencyLevel {
		case connect.IdempotencyIdempotent, connect.IdempotencyNoSideEffects:
			return next(ctx, req)
		case connect.IdempotencyUnknown:
		}
		if _, ok := i.exempt[spec.Procedure]; ok {
			return next(ctx, req)
		}
		id := req.Header().Get(wire.HeaderRequestID)
		md, hasSchema := spec.Schema.(protoreflect.MethodDescriptor)
		msg, isProto := req.Any().(proto.Message)
		if id == "" || !hasSchema || !isProto {
			if id != "" {
				i.opts.Log.Warn("reqcache: call without method descriptor is not cached", "procedure", spec.Procedure)
			}
			return next(ctx, req)
		}
		hash, err := hashRequest(spec.Procedure, msg)
		if err != nil {
			return nil, errs.New(connect.CodeInternal, errs.Internal, "request id cache: encode request")
		}
		return i.call(ctx, id, hash, md, spec.Procedure, req, next)
	}
}

// WrapStreamingClient implements connect.Interceptor.
func (*interceptor) WrapStreamingClient(next connect.StreamingClientFunc) connect.StreamingClientFunc {
	return next
}

// WrapStreamingHandler implements connect.Interceptor.
func (*interceptor) WrapStreamingHandler(next connect.StreamingHandlerFunc) connect.StreamingHandlerFunc {
	return next
}

func (i *interceptor) call(
	ctx context.Context, id, hash string, md protoreflect.MethodDescriptor, procedure string,
	req connect.AnyRequest, next connect.UnaryFunc,
) (connect.AnyResponse, error) {
	for {
		rec, f, lead, err := i.enter(id, hash)
		if err != nil {
			return nil, err
		}
		switch {
		case rec != nil:
			return replay(rec, md)
		case lead != nil:
			return i.execute(ctx, id, hash, procedure, lead, req, next)
		}
		// Another call with this id runs: wait for its outcome.
		select {
		case <-f.done:
		case <-ctx.Done():
			return nil, ctx.Err()
		}
		if f.rec != nil {
			return replay(f.rec, md)
		}
		// The first call left nothing to replay (retryable error, canceled,
		// oversized response): look again, probably run it ourselves.
	}
}

// enter decides what a call with this id does. It returns the stored outcome
// to replay, or the running flight to wait for, or a new flight this call
// leads. A conflicting body is an error. The store is read under the lock so
// that a leader finishing between the check and the registration is seen.
func (i *interceptor) enter(id, hash string) (rec *store.Request, wait, lead *flight, err error) {
	fl := i.flights
	fl.mu.Lock()
	defer fl.mu.Unlock()

	if f, ok := fl.m[id]; ok {
		if f.hash != hash {
			return nil, nil, nil, reusedError(id)
		}
		return nil, f, nil, nil
	}
	// A buffered outcome is newer than anything in the store.
	stored, found := i.pending.get(id)
	if !found {
		var gerr error
		stored, found, gerr = i.st.GetRequest(id)
		if gerr != nil {
			i.opts.Log.Error("reqcache: read outcome", "err", gerr)
			return nil, nil, nil, errs.New(connect.CodeInternal, errs.Internal, "request id cache unavailable")
		}
	}
	if found && stored.ExpiresAt.After(i.opts.Now()) {
		if stored.Hash != hash {
			return nil, nil, nil, reusedError(id)
		}
		if !stored.Truncated {
			return stored, nil, nil, nil
		}
		// The outcome was too large to keep: run the handler again.
	}
	f := &flight{hash: hash, done: make(chan struct{})}
	fl.m[id] = f
	return nil, nil, f, nil
}

// execute runs the handler as the leader of f and stores a final outcome.
func (i *interceptor) execute(
	ctx context.Context, id, hash, procedure string, f *flight,
	req connect.AnyRequest, next connect.UnaryFunc,
) (connect.AnyResponse, error) {
	defer func() {
		i.flights.mu.Lock()
		delete(i.flights.m, id)
		i.flights.mu.Unlock()
		close(f.done)
	}()

	res, err := next(ctx, req)
	var rec *store.Request
	// An error after the call context ended may come from the cancellation
	// itself, whatever its code: it is not final. A success is.
	if err == nil || ctx.Err() == nil {
		rec = i.outcome(procedure, hash, res, err)
	}
	if rec == nil {
		return res, err
	}
	// The outcome is visible to waiting duplicates even if storing fails.
	if !rec.Truncated {
		f.rec = rec
	}
	i.save(context.WithoutCancel(ctx), id, procedure, rec)
	return res, err
}

// save stores the outcome of a finished call. The write is detached from the
// call (ctx is not cancelable): a client that gave up must not cost the
// outcome, or its retry would run the mutation again. While the store is
// frozen, or freezes under the write, the outcome is buffered and written at
// the thaw instead.
func (i *interceptor) save(ctx context.Context, id, procedure string, rec *store.Request) {
	if i.st.Frozen() {
		i.buffer(ctx, id, rec)
		return
	}
	switch err := i.put(ctx, id, rec); {
	case err == nil:
	case errors.Is(err, store.ErrFrozen):
		i.buffer(ctx, id, rec)
	default:
		i.opts.Log.Warn("reqcache: store outcome", "procedure", procedure, "err", err)
	}
}

// put writes one outcome to the store with a bounded, uncancelable context
// and counts it toward the next prune.
func (i *interceptor) put(ctx context.Context, id string, rec *store.Request) error {
	pctx, cancel := context.WithTimeout(ctx, putTimeout)
	defer cancel()
	if err := i.st.PutRequest(pctx, id, rec); err != nil {
		return err
	}
	if i.puts.Add(1)%pruneEvery == 1 {
		i.prune(ctx)
	}
	return nil
}

// buffer keeps an outcome in memory until the store thaws.
func (i *interceptor) buffer(ctx context.Context, id string, rec *store.Request) {
	dropped, start := i.pending.add(id, rec)
	if dropped != "" {
		i.opts.Log.Warn("reqcache: frozen buffer is full, oldest outcome dropped",
			"limit", i.opts.MaxPending, "dropped_id", dropped)
	}
	if start {
		go i.flushPending(ctx)
	}
}

// flushPending writes the buffered outcomes once the store is not frozen. It
// runs until the buffer is empty; one at a time.
func (i *interceptor) flushPending(ctx context.Context) {
	for {
		<-i.st.Thawed()
		batch := i.pending.snapshot()
		if len(batch) == 0 {
			if i.pending.finish() {
				return
			}
			continue
		}
		if !i.flushBatch(ctx, batch) {
			return
		}
	}
}

// flush writes the buffered outcomes now (Cache.Flush). It runs alongside
// the background flusher: both write the same records, and an entry leaves
// the buffer only while it still holds the written record.
func (i *interceptor) flush(ctx context.Context) error {
	for {
		batch := i.pending.snapshot()
		if len(batch) == 0 {
			return nil
		}
		select {
		case <-i.st.Thawed():
		case <-ctx.Done():
			return fmt.Errorf("reqcache: %d buffered outcomes not written: %w", len(batch), ctx.Err())
		}
	writes:
		for _, e := range batch {
			err := i.put(ctx, e.id, e.rec)
			switch {
			case err == nil:
				i.pending.remove(e.id, e.rec)
			case errors.Is(err, store.ErrFrozen):
				break writes // frozen again: wait for the next thaw
			case errors.Is(err, store.ErrClosed):
				return err
			case ctx.Err() != nil:
				return fmt.Errorf("reqcache: buffered outcomes not written: %w", ctx.Err())
			default:
				i.opts.Log.Warn("reqcache: flush buffered outcome", "err", err)
				i.pending.remove(e.id, e.rec)
			}
		}
	}
}

// outcome builds the record to store for a finished call, or nil when the
// outcome is not final: retryable and canceled errors, frozen store, errors
// that carry no Connect code.
func (i *interceptor) outcome(procedure, hash string, res connect.AnyResponse, err error) *store.Request {
	rec := &store.Request{
		Procedure: procedure,
		Hash:      hash,
		ExpiresAt: i.opts.Now().Add(i.opts.TTL),
	}
	if err != nil {
		var cerr *connect.Error
		if !errors.As(err, &cerr) || errors.Is(err, store.ErrFrozen) ||
			cerr.Code() == connect.CodeCanceled || rpcconv.Retryable(cerr.Code()) {
			return nil
		}
		rec.Code = int(cerr.Code())
		rec.Message = cerr.Message()
		if d, ok := rpcconv.Detail(cerr); ok {
			rec.Detail = d.GetCode()
		}
		return rec
	}
	msg, ok := res.Any().(proto.Message)
	if !ok {
		return nil
	}
	b, merr := proto.MarshalOptions{Deterministic: true}.Marshal(msg)
	if merr != nil {
		return nil
	}
	if len(b) > i.opts.MaxResponseBytes {
		rec.Truncated = true
		return rec
	}
	rec.Response = b
	return rec
}

// flushBatch writes batch to the store and drops the written entries from the
// buffer. It stops early when the store froze again (the rest waits for the
// next thaw). It returns false when the store is closed: the buffer is then
// discarded and the flusher must end.
func (i *interceptor) flushBatch(ctx context.Context, batch []pendingEntry) bool {
	for _, e := range batch {
		err := i.put(ctx, e.id, e.rec)
		switch {
		case err == nil:
			i.pending.remove(e.id, e.rec)
		case errors.Is(err, store.ErrFrozen):
			return true
		case errors.Is(err, store.ErrClosed):
			i.pending.clear()
			i.pending.finish()
			return false
		default:
			i.opts.Log.Warn("reqcache: flush buffered outcome", "err", err)
			i.pending.remove(e.id, e.rec)
		}
	}
	return true
}

// prune removes expired and surplus outcomes in the background; one run at
// a time.
func (i *interceptor) prune(ctx context.Context) {
	if !i.pruning.CompareAndSwap(false, true) {
		return
	}
	go func() {
		defer i.pruning.Store(false)
		ctx, cancel := context.WithTimeout(ctx, pruneTimeout)
		defer cancel()
		if _, err := i.st.PruneRequests(ctx, i.opts.Now(), i.opts.MaxEntries); err != nil &&
			!errors.Is(err, store.ErrClosed) && !errors.Is(err, store.ErrFrozen) {
			i.opts.Log.Warn("reqcache: prune", "err", err)
		}
	}()
}

// hashRequest is sha256(procedure, 0x00, deterministic encoding of the
// request), hex encoded.
func hashRequest(procedure string, msg proto.Message) (string, error) {
	b, err := proto.MarshalOptions{Deterministic: true}.Marshal(msg)
	if err != nil {
		return "", err
	}
	h := sha256.New()
	h.Write([]byte(procedure))
	h.Write([]byte{0})
	h.Write(b)
	return hex.EncodeToString(h.Sum(nil)), nil
}

func reusedError(id string) error {
	return errs.New(connect.CodeInvalidArgument, errs.RequestIDReused,
		wire.HeaderRequestID+" "+id+" was already used for a different request")
}

// replay rebuilds the stored outcome.
//
// The response is a new instance of the method's output type: the registered
// generated type when there is one, so that it marshals exactly like the
// original, otherwise a dynamicpb message built from the method descriptor.
// connect-go's unary handler does not type-assert what an interceptor
// returns: it only reads Header, Trailer and Any() of the AnyResponse and
// hands Any() to the codec, which accepts any proto.Message. The replay works
// the same after a restart, when nothing has run in this process yet.
func replay(rec *store.Request, md protoreflect.MethodDescriptor) (connect.AnyResponse, error) {
	if rec.Code != 0 {
		code := connect.Code(rec.Code)
		if rec.Detail != "" {
			return nil, rpcconv.NewError(code, rec.Detail, rec.Message)
		}
		return nil, connect.NewError(code, errors.New(rec.Message))
	}
	out := newOutput(md.Output())
	if err := proto.Unmarshal(rec.Response, out); err != nil {
		return nil, errs.New(connect.CodeInternal, errs.Internal, "request id cache: stored response is unreadable")
	}
	return replayResponse{AnyResponse: connect.NewResponse(&out), msg: out}, nil
}

// replayResponse is an AnyResponse whose Any() is the replayed message itself
// (connect.Response[T].Any() needs the concrete T at compile time). Headers
// and trailers come from the embedded response.
type replayResponse struct {
	connect.AnyResponse
	msg proto.Message
}

// Any implements connect.AnyResponse.
func (r replayResponse) Any() any { return r.msg }

// newOutput returns an empty message of type md.
func newOutput(md protoreflect.MessageDescriptor) proto.Message {
	if mt, err := protoregistry.GlobalTypes.FindMessageByName(md.FullName()); err == nil {
		return mt.New().Interface()
	}
	return dynamicpb.NewMessage(md)
}
