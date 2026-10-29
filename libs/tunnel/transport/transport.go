// Package transport defines the interfaces between the tunnel logic and the
// byte transport (WebSocket in production, in-memory in tests), plus the
// connection handshake data.
package transport

import (
	"context"
	"encoding/json"
	"fmt"
	"log/slog"
	"net"
	"net/http"
	"strings"
	"time"

	"github.com/google/uuid"

	"github.com/belov38/boat-dev-clone/libs/tunnel/wire"
)

// AuthScheme selects which secret the agent presents.
type AuthScheme int

const (
	// AuthBootstrap presents the bootstrap secret (BS) from SMBIOS.
	AuthBootstrap AuthScheme = iota
	// AuthToken presents the machine token (MT).
	AuthToken
)

// Hello is the handshake data sent by the agent in the upgrade request. Its
// String, GoString, LogValue and MarshalJSON never print Secret.
type Hello struct {
	MachineID       string
	BootID          string
	AgentInstanceID string
	Vmgenid         string
	AgentVersion    string
	Scheme          AuthScheme
	Secret          []byte
	// ProtoVersion is the negotiated subprotocol, set by the transport on the gateway side.
	ProtoVersion string
}

// redacted stands in for the secret in formatted, logged and JSON output.
const redacted = "[REDACTED]"

func (h Hello) schemeName() string {
	if h.Scheme == AuthBootstrap {
		return "bootstrap"
	}
	return "token"
}

// String formats h like %+v without the secret.
func (h Hello) String() string {
	return fmt.Sprintf("{MachineID:%s BootID:%s AgentInstanceID:%s Vmgenid:%s AgentVersion:%s Scheme:%s Secret:%s ProtoVersion:%s}",
		h.MachineID, h.BootID, h.AgentInstanceID, h.Vmgenid, h.AgentVersion, h.schemeName(), redacted, h.ProtoVersion)
}

// GoString formats h like %#v without the secret.
func (h Hello) GoString() string {
	return fmt.Sprintf("transport.Hello{MachineID:%q, BootID:%q, AgentInstanceID:%q, Vmgenid:%q, AgentVersion:%q, Scheme:%d, Secret:%s, ProtoVersion:%q}",
		h.MachineID, h.BootID, h.AgentInstanceID, h.Vmgenid, h.AgentVersion, h.Scheme, redacted, h.ProtoVersion)
}

// LogValue logs h without the secret.
func (h Hello) LogValue() slog.Value {
	return slog.GroupValue(
		slog.String("machine_id", h.MachineID),
		slog.String("boot_id", h.BootID),
		slog.String("agent_instance_id", h.AgentInstanceID),
		slog.String("vmgenid", h.Vmgenid),
		slog.String("agent_version", h.AgentVersion),
		slog.String("scheme", h.schemeName()),
		slog.String("secret", redacted),
		slog.String("proto_version", h.ProtoVersion),
	)
}

// MarshalJSON encodes h without the secret, for a Hello nested in a value
// that slog's JSON handler or encoding/json serializes.
func (h Hello) MarshalJSON() ([]byte, error) {
	return json.Marshal(struct {
		MachineID, BootID, AgentInstanceID, Vmgenid, AgentVersion, Scheme, Secret, ProtoVersion string
	}{h.MachineID, h.BootID, h.AgentInstanceID, h.Vmgenid, h.AgentVersion, h.schemeName(), redacted, h.ProtoVersion})
}

// ConnInfo identifies an admitted connection.
type ConnInfo struct {
	GatewayInstance string
	Epoch           uint64
	ConnID          string
}

// Dialer opens the byte transport to a gateway (agent side).
type Dialer interface {
	Dial(ctx context.Context, hello Hello) (net.Conn, ConnInfo, error)
}

// Admitter decides whether a connection is accepted (gateway side). The error
// is a *RejectError for HTTP-level refusals.
type Admitter interface {
	Admit(ctx context.Context, hello Hello) (Admission, error)
}

// Admission is an accepted but not yet served connection.
type Admission interface {
	// Info returns the identity to report to the agent in the upgrade response.
	Info() ConnInfo
	// Serve takes ownership of conn and returns immediately.
	Serve(conn net.Conn)
	// Abort reports that the transport failed after admission, before Serve.
	Abort(err error)
}

// RejectError is an HTTP-level refusal of a connection.
type RejectError struct {
	Status     int
	RetryAfter time.Duration
	Reason     string
}

func (e *RejectError) Error() string {
	s := fmt.Sprintf("tunnel connection rejected: status %d", e.Status)
	if e.Reason != "" {
		s += ": " + e.Reason
	}
	if e.RetryAfter > 0 {
		s += fmt.Sprintf(" (retry after %s)", e.RetryAfter)
	}
	return s
}

// DrainOptions controls MachineConn.Drain.
type DrainOptions struct {
	Reason      string
	TCPDeadline time.Duration
}

// MachineConn is the gateway-side handle to one admitted agent connection (spec 4.5).
type MachineConn interface {
	RoundTrip(req *http.Request) (*http.Response, error)
	DialTCP(ctx context.Context, port uint16) (net.Conn, error)
	Ping(ctx context.Context) error
	Drain(ctx context.Context, opts DrainOptions) error
	Close() error
}

// DialError reports a CONNECT refused by the agent (400, 403 or 502).
type DialError struct{ Status int }

func (e *DialError) Error() string {
	return fmt.Sprintf("agent refused tcp dial: status %d", e.Status)
}

// MovedError reports that the machine is connected to another gateway
// instance (a remote /tcp/ request was answered with 421).
//
// InstanceURL is a hint taken from a response, not a trusted route: callers
// must check it against the registry (registry.Store.InstanceByURL, or a fresh
// Owner lookup) before sending a service token or other credentials there.
type MovedError struct{ InstanceURL string }

func (e *MovedError) Error() string {
	return "machine moved to " + e.InstanceURL
}

// Header returns the upgrade request headers for h.
func (h Hello) Header() http.Header {
	out := http.Header{}
	scheme := wire.SchemeBearer
	if h.Scheme == AuthBootstrap {
		scheme = wire.SchemeBootstrap
	}
	out.Set("Authorization", scheme+" "+wire.EncodeSecret(h.Secret))
	set := func(k, v string) {
		if v != "" {
			out.Set(k, v)
		}
	}
	set(wire.HeaderMachineID, h.MachineID)
	set(wire.HeaderBootID, h.BootID)
	set(wire.HeaderAgentInstanceID, h.AgentInstanceID)
	set(wire.HeaderVmgenid, h.Vmgenid)
	set(wire.HeaderAgentVersion, h.AgentVersion)
	return out
}

// ParseHello parses upgrade request headers. A malformed or missing
// Authorization yields *RejectError{Status: 401}; a missing or non-UUID
// machine id 400. The machine id is returned in canonical lower-case form.
func ParseHello(h http.Header) (Hello, error) {
	var out Hello
	auth := h.Get("Authorization")
	scheme, enc, ok := strings.Cut(auth, " ")
	if !ok {
		return Hello{}, &RejectError{Status: http.StatusUnauthorized, Reason: "missing or malformed Authorization"}
	}
	switch {
	case strings.EqualFold(scheme, wire.SchemeBearer):
		out.Scheme = AuthToken
	case strings.EqualFold(scheme, wire.SchemeBootstrap):
		out.Scheme = AuthBootstrap
	default:
		return Hello{}, &RejectError{Status: http.StatusUnauthorized, Reason: "unsupported authorization scheme"}
	}
	secret, err := wire.DecodeSecret(strings.TrimSpace(enc))
	if err != nil {
		return Hello{}, &RejectError{Status: http.StatusUnauthorized, Reason: "malformed secret"}
	}
	out.Secret = secret

	rawID := h.Get(wire.HeaderMachineID)
	if rawID == "" {
		return Hello{}, &RejectError{Status: http.StatusBadRequest, Reason: "missing " + wire.HeaderMachineID}
	}
	// The registry, NOTIFY payloads and the internal listener use the
	// canonical lower-case form; agents may report upper-case or braced ids
	// (Windows WMI).
	id, err := uuid.Parse(rawID)
	if err != nil {
		return Hello{}, &RejectError{Status: http.StatusBadRequest, Reason: "malformed " + wire.HeaderMachineID}
	}
	out.MachineID = id.String()
	out.BootID = h.Get(wire.HeaderBootID)
	out.AgentInstanceID = h.Get(wire.HeaderAgentInstanceID)
	out.Vmgenid = h.Get(wire.HeaderVmgenid)
	out.AgentVersion = h.Get(wire.HeaderAgentVersion)
	return out, nil
}
