// Package wire holds the constants and small codecs of the agent <-> gateway
// tunnel protocol (S2 spec section 4): paths, header names, auth schemes,
// error codes and secret encoding.
package wire

// Connection setup (spec 4.1).
const (
	// ConnectPath is the WebSocket upgrade path the agent connects to.
	ConnectPath = "/v1/connect"
	// Subprotocol is the WebSocket subprotocol of this protocol version.
	Subprotocol = "sbx-tunnel.v1"
)

// Request headers sent by the agent in the upgrade request.
const (
	HeaderMachineID       = "Sbx-Machine-Id"
	HeaderBootID          = "Sbx-Boot-Id"
	HeaderAgentInstanceID = "Sbx-Agent-Instance-Id"
	HeaderVmgenid         = "Sbx-Vmgenid"
	HeaderAgentVersion    = "Sbx-Agent-Version"
	// HeaderLane is reserved for a future bulk connection; v1 does not use it.
	HeaderLane = "Sbx-Lane"
)

// Response headers of the upgrade (101) response.
const (
	HeaderGatewayInstance = "Sbx-Gateway-Instance"
	HeaderConnEpoch       = "Sbx-Conn-Epoch"
	// HeaderConnID is additive to the spec and is used in agent logs.
	HeaderConnID = "Sbx-Conn-Id"
)

// Headers used on RPC calls and error responses.
const (
	HeaderRequestID   = "Sbx-Request-Id"
	HeaderCaller      = "Sbx-Caller"
	HeaderErrorCode   = "Sbx-Error-Code"
	HeaderInstanceURL = "Sbx-Instance-Url"
	// HeaderTCPDrainDeadline carries the drain deadline in milliseconds of a
	// peer CONNECT stream on the gateway internal listener (additive, S4).
	HeaderTCPDrainDeadline = "Sbx-Tcp-Drain-Deadline-Ms"
)

// HeaderDialError carries why a CONNECT dial failed. The agent sets it on its
// 502 answer, and the gateway repeats it on the peer CONNECT 502. Its value
// is one of the DialError* constants. A gateway never copies an arbitrary
// value: anything outside the closed set is dropped.
const HeaderDialError = "Sbx-Dial-Error"

// Values of HeaderDialError.
const (
	DialErrorRefused = "refused"
	DialErrorTimeout = "timeout"
)

// NormalizeDialError returns v if it is a known HeaderDialError value, else "".
func NormalizeDialError(v string) string {
	switch v {
	case DialErrorRefused, DialErrorTimeout:
		return v
	}
	return ""
}

// Agent-defined response headers the gateway passes to callers. Every other
// Sbx-* header of an agent response is dropped: Sbx-* are gateway routing
// signals, so an addition here needs a security review.
const (
	// HeaderUploadOffset is the current size of a resumable upload (S3 files
	// API: HEAD /files/uploads/{id} and the 409 offset mismatch).
	HeaderUploadOffset = "Sbx-Upload-Offset"
)

// Authorization header schemes.
const (
	// SchemeBearer carries the machine token (MT).
	SchemeBearer = "Bearer"
	// SchemeBootstrap carries the bootstrap secret (BS).
	SchemeBootstrap = "Sbx-Bootstrap"
)

// NotifyChannel is the Postgres LISTEN/NOTIFY channel for session changes.
const NotifyChannel = "tunnel_sessions"

// NotifyInstancesChannel is the Postgres LISTEN/NOTIFY channel for gateway
// instance changes (insert, delete, state or drain start). The payload is the
// instance id.
const NotifyInstancesChannel = "gateway_instances"

// Error codes carried in tunnelv1.ErrorDetail.Code and the Sbx-Error-Code header.
const (
	CodeMachineMoved      = "machine_moved"
	CodeAgentUnavailable  = "agent_unavailable"
	CodeAgentOutdated     = "agent_outdated"
	CodeRequestIDRequired = "request_id_required"
	CodeBadAgentResponse  = "bad_agent_response"
)

// EventTypeTooLarge is the type of the stub the agent sends in place of a
// journal event above its MaxEventBytes: same seq, time and boot_id, no
// payload (spec 9.6).
const EventTypeTooLarge = "sbx.tunnel.event_too_large"

// Service name prefixes used for routing and authorization.
const (
	ServicePrefixAgent  = "sbx.agent.v1."
	ServicePrefixTunnel = "sbx.tunnel.v1."
)

// SecretLen is the length in bytes of the bootstrap secret and the machine token.
const SecretLen = 32
