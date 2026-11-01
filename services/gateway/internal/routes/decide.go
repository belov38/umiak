package routes

import (
	"net/http"

	"github.com/belov38/umiak/services/gateway/internal/cpapi"
	"github.com/belov38/umiak/services/gateway/internal/umiakerr"
)

// Decide maps a route to the gateway's action. It returns ok=true when the
// request may be proxied; otherwise e is the answer, with RequestID left
// empty for the proxy to fill.
//
// Sandbox states follow the S7 decision O3 (it overrides spec 6.3): "running"
// is treated as "ready" and "resuming" as "starting" for compatibility.
// A deleted sandbox answers 404 whatever else the route says; a blocked route
// is refused in every other state.
func Decide(r cpapi.Route) (ok bool, e umiakerr.Error) {
	switch r.SandboxState {
	case "deleting", "deleted":
		return false, umiakerr.Error{Status: http.StatusNotFound, Code: umiakerr.CodeRouteNotFound}
	}
	if r.Blocked {
		return false, umiakerr.Error{
			Status: http.StatusForbidden, Code: umiakerr.CodeRouteBlocked,
			Message: blockMessage(r.BlockReason),
		}
	}
	switch r.SandboxState {
	case "ready", "running":
		if r.MachineID == "" {
			// The state says the machine exists but api sent none.
			return false, unavailable()
		}
		return true, umiakerr.Error{}
	case "creating", "starting", "resuming":
		return false, umiakerr.Error{
			Status: http.StatusServiceUnavailable, Code: umiakerr.CodeSandboxStarting,
			Retryable: true, RetryAfter: 5, Refresh: true,
		}
	case "stopping", "stopped":
		return false, umiakerr.Error{Status: http.StatusServiceUnavailable, Code: umiakerr.CodeSandboxStopped}
	default:
		return false, unavailable()
	}
}

func unavailable() umiakerr.Error {
	return umiakerr.Error{Status: http.StatusServiceUnavailable, Code: umiakerr.CodeSandboxUnavailable}
}

// blockMessage returns the text for a block reason; empty selects the
// default message of the error code.
func blockMessage(reason string) string {
	switch reason {
	case "operator":
		return "blocked by the operator"
	case "public_disabled":
		return "public links are disabled"
	case "abuse":
		return "blocked for abuse"
	default:
		return ""
	}
}
