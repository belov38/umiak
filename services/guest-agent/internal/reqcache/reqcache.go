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
package reqcache

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"errors"
	"log/slog"
	"sync"
	"sync/atomic"
	"time"

	"connectrpc.com/connect"
	"google.golang.org/protobuf/proto"
	"google.golang.org/protobuf/reflect/protoreflect"
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
	if o.Now == nil {
		o.Now = time.Now
	}
	if o.Log == nil {
		o.Log = slog.Default()
	}
}

// Interceptors returns the handler options every agent service with mutating
// calls uses: the Sbx-Request-Id requirement (Process.Start is exempt, it is
// idempotent by its own command id) followed by the response cache.
func Interceptors(st *store.Store) []connect.HandlerOption {
	return []connect.HandlerOption{
		connect.WithInterceptors(
			rpcconv.RequireRequestID(agentv1connect.ProcessStartProcedure),
			New(st, Options{}),
		),
	}
}

// New returns the response cache interceptor. It acts on unary handler calls
// that carry Sbx-Request-Id and are not IDEMPOTENT or NO_SIDE_EFFECTS; every
// other call passes through. Put it after rpcconv.RequireRequestID, which
// rejects mutating calls without an id.
func New(st *store.Store, opts Options) connect.Interceptor {
	opts.setDefaults()
	return &interceptor{st: st, opts: opts, flights: flightsOf(st)}
}

// flightRegistry shares the in-flight calls of all interceptors of one
// store, so the same id sent to two services is still one call.
var flightRegistry sync.Map // *store.Store -> *flights

func flightsOf(st *store.Store) *flights {
	v, _ := flightRegistry.LoadOrStore(st, &flights{m: make(map[string]*flight)})
	return v.(*flights)
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
	flights *flights
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
	stored, found, gerr := i.st.GetRequest(id)
	if gerr != nil {
		i.opts.Log.Error("reqcache: read outcome", "err", gerr)
		return nil, nil, nil, errs.New(connect.CodeInternal, errs.Internal, "request id cache unavailable")
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
	rec := i.outcome(procedure, hash, res, err)
	if rec == nil {
		return res, err
	}
	// The outcome is visible to waiting duplicates even if storing fails.
	if !rec.Truncated {
		f.rec = rec
	}
	if perr := i.st.PutRequest(ctx, id, rec); perr != nil {
		i.opts.Log.Warn("reqcache: store outcome", "procedure", procedure, "err", perr)
	} else if i.puts.Add(1)%pruneEvery == 1 {
		i.prune(ctx)
	}
	return res, err
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

// prune removes expired and surplus outcomes in the background; one run at
// a time.
func (i *interceptor) prune(ctx context.Context) {
	if !i.pruning.CompareAndSwap(false, true) {
		return
	}
	// Detached from the call: the prune outlives the response.
	ctx = context.WithoutCancel(ctx)
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
// The response is a dynamicpb message of the method's output type, taken
// from the method descriptor of the call. connect-go's unary handler does
// not type-assert what an interceptor returns: it only reads Header,
// Trailer and Any() of the AnyResponse and hands Any() to the codec, which
// accepts any proto.Message. So the replay needs no generated type and
// works the same after a restart, when nothing has run in this process yet.
func replay(rec *store.Request, md protoreflect.MethodDescriptor) (connect.AnyResponse, error) {
	if rec.Code != 0 {
		code := connect.Code(rec.Code)
		if rec.Detail != "" {
			return nil, rpcconv.NewError(code, rec.Detail, rec.Message)
		}
		return nil, connect.NewError(code, errors.New(rec.Message))
	}
	out := dynamicpb.NewMessage(md.Output())
	if err := proto.Unmarshal(rec.Response, out); err != nil {
		return nil, errs.New(connect.CodeInternal, errs.Internal, "request id cache: stored response is unreadable")
	}
	return connect.NewResponse(out), nil
}
