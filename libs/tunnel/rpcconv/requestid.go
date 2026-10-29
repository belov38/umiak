package rpcconv

import (
	"context"
	"strings"

	"connectrpc.com/connect"
	"github.com/google/uuid"

	"github.com/belov38/boat-dev-clone/libs/tunnel/wire"
)

// RequireRequestID returns a handler-side interceptor that makes the
// Sbx-Request-Id header (UUID or ULID) mandatory on mutating unary calls. A
// call is exempt when its idempotency level is IDEMPOTENT or NO_SIDE_EFFECTS,
// or when its procedure is in exempt. Streaming handlers pass through.
func RequireRequestID(exempt ...string) connect.Interceptor {
	skip := make(map[string]struct{}, len(exempt))
	for _, p := range exempt {
		skip[p] = struct{}{}
	}
	return requestIDInterceptor{exempt: skip}
}

type requestIDInterceptor struct{ exempt map[string]struct{} }

func (i requestIDInterceptor) WrapUnary(next connect.UnaryFunc) connect.UnaryFunc {
	return func(ctx context.Context, req connect.AnyRequest) (connect.AnyResponse, error) {
		spec := req.Spec()
		if spec.IsClient || i.skips(spec) {
			return next(ctx, req)
		}
		if !validRequestID(req.Header().Get(wire.HeaderRequestID)) {
			return nil, NewError(connect.CodeInvalidArgument, wire.CodeRequestIDRequired,
				wire.HeaderRequestID+" (UUID or ULID) is required for this call")
		}
		return next(ctx, req)
	}
}

func (requestIDInterceptor) WrapStreamingClient(next connect.StreamingClientFunc) connect.StreamingClientFunc {
	return next
}

func (requestIDInterceptor) WrapStreamingHandler(next connect.StreamingHandlerFunc) connect.StreamingHandlerFunc {
	return next
}

func (i requestIDInterceptor) skips(spec connect.Spec) bool {
	switch spec.IdempotencyLevel {
	case connect.IdempotencyIdempotent, connect.IdempotencyNoSideEffects:
		return true
	case connect.IdempotencyUnknown:
	}
	_, ok := i.exempt[spec.Procedure]
	return ok
}

func validRequestID(s string) bool {
	return validUUID(s) || validULID(s)
}

func validUUID(s string) bool {
	// uuid.Parse also accepts urn:, braced and dashless forms; require the canonical one.
	if len(s) != 36 {
		return false
	}
	_, err := uuid.Parse(s)
	return err == nil
}

const crockford = "0123456789ABCDEFGHJKMNPQRSTVWXYZ"

func validULID(s string) bool {
	if len(s) != 26 {
		return false
	}
	s = strings.ToUpper(s)
	// The first character carries 3 bits only: larger values overflow 128 bits.
	if s[0] < '0' || s[0] > '7' {
		return false
	}
	for i := 1; i < len(s); i++ {
		if strings.IndexByte(crockford, s[i]) < 0 {
			return false
		}
	}
	return true
}
