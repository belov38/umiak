package httpproxy

import (
	"errors"
	"math"
	"net"
	"net/http"
	"time"

	"github.com/belov38/boat-dev-clone/services/gateway/internal/sbxerr"
	"github.com/belov38/boat-dev-clone/services/gateway/internal/upstream"
)

// retryAfterAgent is the Retry-After of agent_unavailable (spec 7.6).
const retryAfterAgent = 5

func notFound() sbxerr.Error {
	return sbxerr.Error{Status: http.StatusNotFound, Code: sbxerr.CodeRouteNotFound}
}

func lookupUnavailable() sbxerr.Error {
	return sbxerr.Error{Status: http.StatusServiceUnavailable, Code: sbxerr.CodeRouteLookupUnavailable, Retryable: true}
}

func agentUnavailable() sbxerr.Error {
	return sbxerr.Error{
		Status: http.StatusServiceUnavailable, Code: sbxerr.CodeAgentUnavailable,
		Retryable: true, RetryAfter: retryAfterAgent, Refresh: true,
	}
}

func upstreamError() sbxerr.Error {
	return sbxerr.Error{Status: http.StatusBadGateway, Code: sbxerr.CodeUpstreamError}
}

// rateLimited answers a refused request; Retry-After is the wait rounded up
// to whole seconds, at least 1.
func rateLimited(wait time.Duration) sbxerr.Error {
	return sbxerr.Error{
		Status: http.StatusTooManyRequests, Code: sbxerr.CodeRateLimited,
		Retryable: true, RetryAfter: max(1, int(math.Ceil(wait.Seconds()))),
	}
}

// mapProxyError maps a failed round trip to the gateway's answer (spec 7.2,
// 7.6, 7.7). Dial failures arrive as *upstream.Error; a response header
// timeout is a net.Error with Timeout; everything else (the application
// closed the conn, sent invalid HTTP or too large a header) is
// upstream_error. The error text never reaches the client.
func mapProxyError(err error) sbxerr.Error {
	var ue *upstream.Error
	if errors.As(err, &ue) {
		e := sbxerr.Error{Status: ue.Status, Code: ue.Code}
		switch ue.Code {
		case upstream.CodeAgentUnavailable:
			e = agentUnavailable()
		case upstream.CodeOverloaded, upstream.CodeAppTimeout:
			e.Retryable = true
		}
		return e
	}
	var ne net.Error
	if errors.As(err, &ne) && ne.Timeout() {
		return sbxerr.Error{Status: http.StatusGatewayTimeout, Code: sbxerr.CodeAppTimeout, Retryable: true}
	}
	return upstreamError()
}
