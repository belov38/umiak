package routes_test

import (
	"net/http"
	"testing"

	"github.com/belov38/umiak/services/gateway/internal/cpapi"
	"github.com/belov38/umiak/services/gateway/internal/routes"
	"github.com/belov38/umiak/services/gateway/internal/umiakerr"
)

func TestDecide(t *testing.T) {
	tests := []struct {
		name  string
		route cpapi.Route
		ok    bool
		want  umiakerr.Error
	}{
		{"ready", cpapi.Route{SandboxState: "ready", MachineID: "m1"}, true, umiakerr.Error{}},
		{"running", cpapi.Route{SandboxState: "running", MachineID: "m1"}, true, umiakerr.Error{}},
		{"ready without machine", cpapi.Route{SandboxState: "ready"}, false,
			umiakerr.Error{Status: http.StatusServiceUnavailable, Code: umiakerr.CodeSandboxUnavailable}},
		{"running without machine", cpapi.Route{SandboxState: "running"}, false,
			umiakerr.Error{Status: http.StatusServiceUnavailable, Code: umiakerr.CodeSandboxUnavailable}},
		{"creating", cpapi.Route{SandboxState: "creating"}, false, starting()},
		{"starting", cpapi.Route{SandboxState: "starting", MachineID: "m1"}, false, starting()},
		{"resuming", cpapi.Route{SandboxState: "resuming"}, false, starting()},
		{"stopping", cpapi.Route{SandboxState: "stopping", MachineID: "m1"}, false,
			umiakerr.Error{Status: http.StatusServiceUnavailable, Code: umiakerr.CodeSandboxStopped}},
		{"stopped", cpapi.Route{SandboxState: "stopped"}, false,
			umiakerr.Error{Status: http.StatusServiceUnavailable, Code: umiakerr.CodeSandboxStopped}},
		{"deleting", cpapi.Route{SandboxState: "deleting"}, false,
			umiakerr.Error{Status: http.StatusNotFound, Code: umiakerr.CodeRouteNotFound}},
		{"deleted", cpapi.Route{SandboxState: "deleted"}, false,
			umiakerr.Error{Status: http.StatusNotFound, Code: umiakerr.CodeRouteNotFound}},
		{"error", cpapi.Route{SandboxState: "error"}, false,
			umiakerr.Error{Status: http.StatusServiceUnavailable, Code: umiakerr.CodeSandboxUnavailable}},
		{"unknown", cpapi.Route{SandboxState: "teleporting", MachineID: "m1"}, false,
			umiakerr.Error{Status: http.StatusServiceUnavailable, Code: umiakerr.CodeSandboxUnavailable}},
		{"empty state", cpapi.Route{}, false,
			umiakerr.Error{Status: http.StatusServiceUnavailable, Code: umiakerr.CodeSandboxUnavailable}},
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

func starting() umiakerr.Error {
	return umiakerr.Error{
		Status: http.StatusServiceUnavailable, Code: umiakerr.CodeSandboxStarting,
		Retryable: true, RetryAfter: 5, Refresh: true,
	}
}

func blocked(msg string) umiakerr.Error {
	return umiakerr.Error{Status: http.StatusForbidden, Code: umiakerr.CodeRouteBlocked, Message: msg}
}
