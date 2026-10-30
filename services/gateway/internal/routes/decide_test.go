package routes_test

import (
	"net/http"
	"testing"

	"github.com/belov38/boat-dev-clone/services/gateway/internal/cpapi"
	"github.com/belov38/boat-dev-clone/services/gateway/internal/routes"
	"github.com/belov38/boat-dev-clone/services/gateway/internal/sbxerr"
)

func TestDecide(t *testing.T) {
	tests := []struct {
		name  string
		route cpapi.Route
		ok    bool
		want  sbxerr.Error
	}{
		{"ready", cpapi.Route{SandboxState: "ready", MachineID: "m1"}, true, sbxerr.Error{}},
		{"running", cpapi.Route{SandboxState: "running", MachineID: "m1"}, true, sbxerr.Error{}},
		{"ready without machine", cpapi.Route{SandboxState: "ready"}, false,
			sbxerr.Error{Status: http.StatusServiceUnavailable, Code: sbxerr.CodeSandboxUnavailable}},
		{"running without machine", cpapi.Route{SandboxState: "running"}, false,
			sbxerr.Error{Status: http.StatusServiceUnavailable, Code: sbxerr.CodeSandboxUnavailable}},
		{"creating", cpapi.Route{SandboxState: "creating"}, false, starting()},
		{"starting", cpapi.Route{SandboxState: "starting", MachineID: "m1"}, false, starting()},
		{"resuming", cpapi.Route{SandboxState: "resuming"}, false, starting()},
		{"stopping", cpapi.Route{SandboxState: "stopping", MachineID: "m1"}, false,
			sbxerr.Error{Status: http.StatusServiceUnavailable, Code: sbxerr.CodeSandboxStopped}},
		{"stopped", cpapi.Route{SandboxState: "stopped"}, false,
			sbxerr.Error{Status: http.StatusServiceUnavailable, Code: sbxerr.CodeSandboxStopped}},
		{"deleting", cpapi.Route{SandboxState: "deleting"}, false,
			sbxerr.Error{Status: http.StatusNotFound, Code: sbxerr.CodeRouteNotFound}},
		{"deleted", cpapi.Route{SandboxState: "deleted"}, false,
			sbxerr.Error{Status: http.StatusNotFound, Code: sbxerr.CodeRouteNotFound}},
		{"error", cpapi.Route{SandboxState: "error"}, false,
			sbxerr.Error{Status: http.StatusServiceUnavailable, Code: sbxerr.CodeSandboxUnavailable}},
		{"unknown", cpapi.Route{SandboxState: "teleporting", MachineID: "m1"}, false,
			sbxerr.Error{Status: http.StatusServiceUnavailable, Code: sbxerr.CodeSandboxUnavailable}},
		{"empty state", cpapi.Route{}, false,
			sbxerr.Error{Status: http.StatusServiceUnavailable, Code: sbxerr.CodeSandboxUnavailable}},
		{"blocked operator", cpapi.Route{SandboxState: "ready", MachineID: "m1", Blocked: true, BlockReason: "operator"}, false,
			blocked("blocked by the operator")},
		{"blocked public_disabled", cpapi.Route{SandboxState: "ready", MachineID: "m1", Blocked: true, BlockReason: "public_disabled"}, false,
			blocked("public links are disabled")},
		{"blocked abuse", cpapi.Route{SandboxState: "ready", MachineID: "m1", Blocked: true, BlockReason: "abuse"}, false,
			blocked("blocked for abuse")},
		{"blocked unknown reason", cpapi.Route{SandboxState: "ready", MachineID: "m1", Blocked: true, BlockReason: "???"}, false,
			blocked("")},
		{"blocked stopped sandbox", cpapi.Route{SandboxState: "stopped", Blocked: true, BlockReason: "abuse"}, false,
			blocked("blocked for abuse")},
	}
	for _, tc := range tests {
		t.Run(tc.name, func(t *testing.T) {
			ok, e := routes.Decide(tc.route)
			if ok != tc.ok {
				t.Fatalf("ok = %v, want %v (error %+v)", ok, tc.ok, e)
			}
			if e != tc.want {
				t.Fatalf("error = %+v, want %+v", e, tc.want)
			}
		})
	}
}

func starting() sbxerr.Error {
	return sbxerr.Error{
		Status: http.StatusServiceUnavailable, Code: sbxerr.CodeSandboxStarting,
		Retryable: true, RetryAfter: 5, Refresh: true,
	}
}

func blocked(msg string) sbxerr.Error {
	return sbxerr.Error{Status: http.StatusForbidden, Code: sbxerr.CodeRouteBlocked, Message: msg}
}
