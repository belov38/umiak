package cpapitest

import (
	"crypto/subtle"
	"encoding/json"
	"errors"
	"io"
	"net/http"
	"net/http/httptest"

	"github.com/belov38/umiak/services/gateway/internal/cpapi"
)

// maxRequestBody bounds request bodies the test server reads.
const maxRequestBody = 1 << 20

// routeWire is the §6.1 response shape: machineId, tokenHash and blockReason
// are JSON null when empty.
type routeWire struct {
	Label        string  `json:"label"`
	SandboxID    string  `json:"sandboxId"`
	Slug         string  `json:"slug"`
	Port         uint16  `json:"port"`
	MachineID    *string `json:"machineId"`
	SandboxState string  `json:"sandboxState"`
	Access       string  `json:"access"`
	TokenHash    *string `json:"tokenHash"`
	AuthEpoch    int64   `json:"authEpoch"`
	Blocked      bool    `json:"blocked"`
	BlockReason  *string `json:"blockReason"`
	HostRewrite  string  `json:"hostRewrite"`
	AppProtocol  string  `json:"appProtocol"`
	TeamID       string  `json:"teamId"`
	Kind         string  `json:"kind"`
}

func nullable(s string) *string {
	if s == "" {
		return nil
	}
	return &s
}

// NewServer serves f on the three gateway paths and requires
// "Authorization: Bearer <token>" (401 otherwise). It lets the HTTP client be
// tested against the same fake that other tests use directly.
func NewServer(f *Fake, token string) *httptest.Server {
	mux := http.NewServeMux()
	want := []byte("Bearer " + token)

	mux.HandleFunc("GET /internal/v1/gateway/routes/{label}", func(w http.ResponseWriter, r *http.Request) {
		r2, err := f.LookupRoute(r.Context(), r.PathValue("label"))
		if err != nil {
			writeError(w, err)
			return
		}
		writeJSON(w, http.StatusOK, routeWire{
			Label: r2.Label, SandboxID: r2.SandboxID, Slug: r2.Slug, Port: r2.Port,
			MachineID: nullable(r2.MachineID), SandboxState: r2.SandboxState, Access: r2.Access,
			TokenHash: nullable(r2.TokenHash), AuthEpoch: r2.AuthEpoch, Blocked: r2.Blocked,
			BlockReason: nullable(r2.BlockReason), HostRewrite: r2.HostRewrite,
			AppProtocol: r2.AppProtocol, TeamID: r2.TeamID, Kind: r2.Kind,
		})
	})

	mux.HandleFunc("POST /internal/v1/gateway/port-auth/exchange", func(w http.ResponseWriter, r *http.Request) {
		var in struct {
			Code  string `json:"code"`
			Label string `json:"label"`
		}
		if !readJSON(w, r, &in) {
			return
		}
		g, err := f.ExchangePortAuthCode(r.Context(), in.Code, in.Label)
		if err != nil {
			writeError(w, err)
			return
		}
		writeJSON(w, http.StatusOK, g)
	})

	mux.HandleFunc("POST /internal/v1/gateway/ssh/authorize", func(w http.ResponseWriter, r *http.Request) {
		body, err := io.ReadAll(io.LimitReader(r.Body, maxRequestBody))
		if err != nil {
			http.Error(w, "bad body", http.StatusBadRequest)
			return
		}
		f.recordSSHBody(body)
		var in cpapi.SSHAuthorizeRequest
		if err := json.Unmarshal(body, &in); err != nil {
			writeJSON(w, http.StatusBadRequest, map[string]string{"code": "invalid_request"})
			return
		}
		a, err := f.AuthorizeSSH(r.Context(), in)
		if err != nil {
			writeError(w, err)
			return
		}
		writeJSON(w, http.StatusOK, a)
	})

	return httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if subtle.ConstantTimeCompare([]byte(r.Header.Get("Authorization")), want) != 1 {
			writeJSON(w, http.StatusUnauthorized, map[string]string{"code": "unauthorized"})
			return
		}
		mux.ServeHTTP(w, r)
	}))
}

func readJSON(w http.ResponseWriter, r *http.Request, v any) bool {
	if err := json.NewDecoder(io.LimitReader(r.Body, maxRequestBody)).Decode(v); err != nil {
		writeJSON(w, http.StatusBadRequest, map[string]string{"code": "invalid_request"})
		return false
	}
	return true
}

func writeError(w http.ResponseWriter, err error) {
	switch {
	case errors.Is(err, cpapi.ErrRouteNotFound):
		writeJSON(w, http.StatusNotFound, map[string]string{"code": "route_not_found"})
	case errors.Is(err, cpapi.ErrInvalidCode):
		writeJSON(w, http.StatusBadRequest, map[string]string{"code": "invalid_code"})
	default:
		writeJSON(w, http.StatusServiceUnavailable, map[string]string{"code": "unavailable"})
	}
}

func writeJSON(w http.ResponseWriter, status int, v any) {
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(status)
	_ = json.NewEncoder(w).Encode(v)
}
