// Package cpapi is the gateway's contract with the control plane (`api`):
// route lookup (spec 6.1), the sso code exchange (8.4) and SSH authorization
// (9.2). The gateway never reads the `api` database schema; it only uses this
// interface.
package cpapi

import (
	"context"
	"encoding/json"
	"errors"
	"time"
)

var (
	// ErrRouteNotFound means api answered 404 route_not_found.
	ErrRouteNotFound = errors.New("cpapi: route not found")
	// ErrInvalidCode means api rejected a port-auth code: unknown, expired,
	// already used, or issued for another label.
	ErrInvalidCode = errors.New("cpapi: invalid code")
	// ErrUnavailable covers everything else: network errors, timeouts, 5xx,
	// authentication failures of the gateway itself, and malformed answers.
	ErrUnavailable = errors.New("cpapi: control plane unavailable")
)

// Route kinds.
const (
	KindPort    = "port"
	KindDesktop = "desktop"
)

// Route is the answer of GET /internal/v1/gateway/routes/{label}. The gateway
// takes no policy decisions of its own; blocked, public_disabled and the
// owner are all computed by api.
type Route struct {
	Label        string `json:"label"`
	SandboxID    string `json:"sandboxId"`
	Slug         string `json:"slug"`
	Port         uint16 `json:"port"`
	MachineID    string `json:"machineId"` // JSON null decodes to ""
	SandboxState string `json:"sandboxState"`
	Access       string `json:"access"`    // public, token, sso
	TokenHash    string `json:"tokenHash"` // hex sha256; only for access=token
	AuthEpoch    int64  `json:"authEpoch"`
	Blocked      bool   `json:"blocked"`
	BlockReason  string `json:"blockReason"` // operator, public_disabled, abuse
	HostRewrite  string `json:"hostRewrite"` // preserve, localhost
	AppProtocol  string `json:"appProtocol"` // http1, h2c
	TeamID       string `json:"teamId"`
	Kind         string `json:"kind"` // port (default) or desktop
}

// normalize fills defaults for fields api may omit.
func (r *Route) normalize() {
	if r.Kind == "" {
		r.Kind = KindPort
	}
}

// PortAuthGrant is the answer of the sso code exchange.
type PortAuthGrant struct {
	UserID    string `json:"userId"`
	Email     string `json:"email"`
	Label     string `json:"label"`
	AuthEpoch int64  `json:"authEpoch"`
}

// SSHAuthorizeRequest is the body of POST /internal/v1/gateway/ssh/authorize.
// Either PublicKey and Fingerprint (a registered user key) or Certificate (a
// short-lived login certificate that the gateway already verified) is set.
//
// Recheck marks the re-check of an open session after the gateway's LISTEN
// reconnected (spec 9.5). The request is the one of the original login.
// api must check the identity as on a login (the user is active and a
// member of the sandbox's team, the key is not revoked or expired and has
// ssh:connect) and must skip the certificate's validity: the gateway
// checked it at login, and sessions outlive the 10-minute certificates.
type SSHAuthorizeRequest struct {
	Sandbox     string       `json:"sandbox"`
	PublicKey   string       `json:"publicKey,omitempty"`
	Fingerprint string       `json:"fingerprint,omitempty"`
	Certificate *SSHCertInfo `json:"certificate,omitempty"`
	Recheck     bool         `json:"recheck,omitempty"`
}

// SSHCertInfo carries the fields of a verified login certificate.
type SSHCertInfo struct {
	KeyID       string    `json:"keyId"`
	Serial      string    `json:"serial"`
	Principal   string    `json:"principal"`
	ValidBefore time.Time `json:"validBefore"`
}

// MarshalJSON writes validBefore as RFC 3339 in UTC with second precision.
func (c SSHCertInfo) MarshalJSON() ([]byte, error) {
	type wire struct {
		KeyID       string `json:"keyId"`
		Serial      string `json:"serial"`
		Principal   string `json:"principal"`
		ValidBefore string `json:"validBefore"`
	}
	return json.Marshal(wire{
		KeyID: c.KeyID, Serial: c.Serial, Principal: c.Principal,
		ValidBefore: c.ValidBefore.UTC().Format(time.RFC3339),
	})
}

// SSHActor says who is behind an allowed SSH login: a user ("user") or a team
// API key ("team_key").
type SSHActor struct {
	Kind     string `json:"kind"`
	UserID   string `json:"userId,omitempty"`
	Email    string `json:"email,omitempty"`
	APIKeyID string `json:"apiKeyId,omitempty"`
}

// SSHAuthorization is the answer of ssh/authorize. TeamID is the sandbox's
// team in public format; the revoke matching of spec 9.5 needs it, so an
// allowed answer without it is refused as an api failure.
type SSHAuthorization struct {
	Allowed      bool     `json:"allowed"`
	Actor        SSHActor `json:"actor"`
	UserID       string   `json:"userId"`
	Email        string   `json:"email"`
	SandboxID    string   `json:"sandboxId"`
	MachineID    string   `json:"machineId"` // JSON null decodes to ""
	SandboxState string   `json:"sandboxState"`
	LoginUser    string   `json:"loginUser"`
	TeamID       string   `json:"teamId"`
}

// Client is the gateway's view of the control plane.
type Client interface {
	// LookupRoute returns ErrRouteNotFound or ErrUnavailable on failure.
	LookupRoute(ctx context.Context, label string) (Route, error)
	// ExchangePortAuthCode burns a one-time code. It returns ErrInvalidCode
	// or ErrUnavailable on failure.
	ExchangePortAuthCode(ctx context.Context, code, label string) (PortAuthGrant, error)
	// AuthorizeSSH returns a result with Allowed=false for a denial and
	// ErrUnavailable when api cannot answer.
	AuthorizeSSH(ctx context.Context, req SSHAuthorizeRequest) (SSHAuthorization, error)
}

// Unavailable returns a Client whose every call fails with ErrUnavailable.
// It stands in for api in local runs without a control plane
// (SBX_GATEWAY_API_URL=none): routes answer 503 route_lookup_unavailable
// and SSH logins are refused.
func Unavailable() Client { return unavailable{} }

type unavailable struct{}

func (unavailable) LookupRoute(context.Context, string) (Route, error) {
	return Route{}, ErrUnavailable
}

func (unavailable) ExchangePortAuthCode(context.Context, string, string) (PortAuthGrant, error) {
	return PortAuthGrant{}, ErrUnavailable
}

func (unavailable) AuthorizeSSH(context.Context, SSHAuthorizeRequest) (SSHAuthorization, error) {
	return SSHAuthorization{}, ErrUnavailable
}
