package gateway

import (
	"context"
	"encoding/json"
	"errors"
	"net/http"
	"net/url"
	"strings"
	"time"

	"connectrpc.com/connect"
	"github.com/google/uuid"

	tunnelv1 "github.com/belov38/umiak/libs/proto/umiak/tunnel/v1"
	"github.com/belov38/umiak/libs/tunnel/wire"
)

// Internal listener parameters.
const (
	// internalMaxStreams is MAX_CONCURRENT_STREAMS of the internal listener (S4).
	internalMaxStreams = 10000
	// internalReadHeaderTimeout bounds reading request headers.
	internalReadHeaderTimeout = 10 * time.Second
	// rotateTimeout bounds one rotate-token request.
	rotateTimeout = 30 * time.Second
	// unavailableRetryAfter is the Retry-After of 503 agent_unavailable.
	unavailableRetryAfter = "1"
	// selfOwnerWait bounds how long a call waits for a local session the
	// registry already assigns to this instance (spec 7, make-before-break).
	selfOwnerWait = 2 * time.Second
)

// NewInternalServer returns the http.Server for the internal listener: HTTP/1
// and cleartext HTTP/2 (prior knowledge) with MAX_CONCURRENT_STREAMS 10000.
func NewInternalServer(h http.Handler) *http.Server {
	var p http.Protocols
	p.SetHTTP1(true)
	p.SetUnencryptedHTTP2(true)
	return &http.Server{
		Handler:           h,
		Protocols:         &p,
		ReadHeaderTimeout: internalReadHeaderTimeout,
		HTTP2: &http.HTTP2Config{
			MaxConcurrentStreams: internalMaxStreams,
		},
	}
}

// callerKey is the context key of the authenticated caller name.
type callerKey struct{}

func callerOf(ctx context.Context) string {
	c, _ := ctx.Value(callerKey{}).(string)
	return c
}

// internalHandler serves the internal listener (spec 5.5, 8.4, 9.5).
type internalHandler struct {
	g    *Gateway
	auth *authenticator
	mux  *http.ServeMux
	errw *connect.ErrorWriter
}

// InternalHandler returns the handler of the internal listener, called by
// api, worker and other gateway pods. Every route needs
// "Authorization: Bearer <service token>" from Config.ServiceTokens (401
// otherwise):
//
//   - /v1/machines/{id}/rpc/{service}/{method}  Connect/gRPC proxy to the agent
//   - /v1/machines/{id}/files[/{rest...}]       agent /files proxy
//     POST /v1/machines/{id}/rotate-token            machine token rotation
//     CONNECT <machineId>:<port>                     TCP stream into the machine
//
// A machine served by another instance gets 421 (Umiak-Error-Code:
// machine_moved, Umiak-Instance-Url: <owner>), a machine connected nowhere 503
// (Umiak-Error-Code: agent_unavailable, Retry-After: 1).
func (g *Gateway) InternalHandler() http.Handler {
	h := &internalHandler{g: g, auth: newAuthenticator(g.cfg.ServiceTokens), errw: connect.NewErrorWriter()}
	mux := http.NewServeMux()
	mux.HandleFunc("/v1/machines/{id}/rpc/{service}/{method}", h.serveRPC)
	mux.HandleFunc("/v1/machines/{id}/files", h.serveFiles)
	mux.HandleFunc("/v1/machines/{id}/files/{rest...}", h.serveFiles)
	mux.HandleFunc("POST /v1/machines/{id}/rotate-token", h.serveRotate)
	h.mux = mux
	return h
}

func (h *internalHandler) ServeHTTP(w http.ResponseWriter, r *http.Request) {
	caller, ok := h.auth.caller(r.Header.Get("Authorization"))
	if !ok {
		w.Header().Set("Www-Authenticate", "Bearer")
		http.Error(w, "unauthenticated: missing or invalid service token", http.StatusUnauthorized)
		return
	}
	r = r.WithContext(context.WithValue(r.Context(), callerKey{}, caller))
	if r.Method == http.MethodConnect {
		h.serveTCP(w, r)
		return
	}
	// Dot segments are refused before the mux, which would redirect them to
	// the cleaned path.
	if hasDotSegment(r.URL.EscapedPath()) {
		f := fmtJSON
		if strings.Contains(r.URL.EscapedPath(), "/rpc/") {
			f = fmtRPC
		}
		h.writeRequestError(w, f, connect.CodeInvalidArgument, "path must not contain . or .. segments")
		return
	}
	h.mux.ServeHTTP(w, r)
}

// hasDotSegment reports whether a segment of the escaped path is . or ..
// after unescaping.
func hasDotSegment(escaped string) bool {
	for seg := range strings.SplitSeq(escaped, "/") {
		if u, err := url.PathUnescape(seg); err == nil && (u == "." || u == "..") {
			return true
		}
	}
	return false
}

// parseMachineID accepts only the canonical 36-character UUID form and
// returns it in lower case.
func parseMachineID(s string) (string, bool) {
	if len(s) != 36 {
		return "", false
	}
	u, err := uuid.Parse(s)
	if err != nil {
		return "", false
	}
	return u.String(), true
}

// errFormat selects the body of an error answer.
type errFormat int

const (
	// fmtRPC is a Connect unary JSON error.
	fmtRPC errFormat = iota
	// fmtJSON is a small JSON object {"code", "instanceUrl", "message"}.
	fmtJSON
)

// target returns the local session that serves calls for a machine. When
// there is none it answers 421 or 503 itself and returns nil. When the
// registry already names this instance (make-before-break: admitted, not
// registered locally yet) it waits up to selfOwnerWait for the session.
func (h *internalHandler) target(w http.ResponseWriter, r *http.Request, id string, f errFormat) *session {
	if s, st := h.g.lookup(id); s != nil && st.serving() {
		return s
	}
	u, self := h.owner(r.Context(), id)
	if self {
		if s := h.g.waitLocal(r.Context(), id, selfOwnerWait); s != nil {
			return s
		}
		u, _ = h.owner(r.Context(), id)
	}
	h.writeNotServed(w, f, u)
	return nil
}

// notServed answers a call this instance cannot serve: 421 with the owner's
// URL when another live instance holds the machine, 503 otherwise (no owner,
// the owner is this instance but the session is not local or no longer
// serves, or the registry failed).
func (h *internalHandler) notServed(w http.ResponseWriter, r *http.Request, id string, f errFormat) {
	h.writeNotServed(w, f, h.otherOwner(r.Context(), id))
}

func (h *internalHandler) writeNotServed(w http.ResponseWriter, f errFormat, ownerURL string) {
	if ownerURL != "" {
		h.writeUnavailable(w, f, http.StatusMisdirectedRequest, wire.CodeMachineMoved, ownerURL)
		return
	}
	h.writeUnavailable(w, f, http.StatusServiceUnavailable, wire.CodeAgentUnavailable, "")
}

// otherOwner returns the internal URL of the live instance other than this
// one that owns the machine, or "".
func (h *internalHandler) otherOwner(ctx context.Context, id string) string {
	u, _ := h.owner(ctx, id)
	return u
}

// owner looks the machine's owner up in the registry. It returns the
// owner's internal URL when another live instance holds it, and self when
// the owner is this instance. An owner row with this instance's URL but
// another id (an earlier instance on the same pod IP) counts as no owner:
// a 421 would send the caller back here.
func (h *internalHandler) owner(ctx context.Context, id string) (url string, self bool) {
	ctx, cancel := context.WithTimeout(ctx, dbTimeout)
	defer cancel()
	o, ok, err := h.g.store.Owner(ctx, id, h.g.cfg.Timing.StaleAfter)
	if err != nil {
		if ctx.Err() == nil {
			h.g.log.Warn("gateway: owner lookup failed", "machine_id", id, "err", err)
		}
		return "", false
	}
	switch {
	case !ok:
		return "", false
	case o.InstanceID == h.g.cfg.InstanceID:
		return "", true
	case sameURL(o.InternalURL, h.g.cfg.InternalURL):
		return "", false
	}
	return o.InternalURL, false
}

// sameURL compares two internal URLs ignoring a trailing slash.
func sameURL(a, b string) bool {
	return strings.TrimSuffix(a, "/") == strings.TrimSuffix(b, "/")
}

// unavailableError is the Connect error of 421/503 answers and aborted
// streams: code unavailable, message and ErrorDetail.code = code,
// retryable, the owner's URL for machine_moved. The metadata carries
// Umiak-Error-Code and Umiak-Instance-Url.
func unavailableError(code, instanceURL string) *connect.Error {
	err := connect.NewError(connect.CodeUnavailable, errors.New(code))
	if d, derr := connect.NewErrorDetail(&tunnelv1.ErrorDetail{
		Code: code, Retryable: true, InstanceUrl: instanceURL,
	}); derr == nil {
		err.AddDetail(d)
	}
	err.Meta().Set(wire.HeaderErrorCode, code)
	if instanceURL != "" {
		err.Meta().Set(wire.HeaderInstanceURL, instanceURL)
	}
	return err
}

// writeUnavailable writes a 421 machine_moved or 503 agent_unavailable answer.
func (h *internalHandler) writeUnavailable(w http.ResponseWriter, f errFormat, status int, code, instanceURL string) {
	hdr := w.Header()
	hdr.Set(wire.HeaderErrorCode, code)
	if instanceURL != "" {
		hdr.Set(wire.HeaderInstanceURL, instanceURL)
	}
	if status == http.StatusServiceUnavailable {
		hdr.Set("Retry-After", unavailableRetryAfter)
	}
	if f == fmtRPC {
		err := unavailableError(code, instanceURL)
		// The headers are set above; connect would add its metadata again.
		clear(err.Meta())
		h.writeConnectUnary(w, status, err)
		return
	}
	writeJSONError(w, status, jsonError{Code: code, InstanceURL: instanceURL})
}

// unaryErrorRequest makes connect's ErrorWriter use the unary JSON format
// whatever the protocol of the real request.
var unaryErrorRequest = &http.Request{Method: http.MethodPost, Header: http.Header{}}

// writeConnectUnary writes err as a Connect unary JSON error
// (Content-Type application/json) with the given HTTP status.
func (h *internalHandler) writeConnectUnary(w http.ResponseWriter, status int, err *connect.Error) {
	_ = h.errw.Write(statusWriter{ResponseWriter: w, status: status}, unaryErrorRequest, err)
}

// statusWriter replaces the status connect's ErrorWriter derives from the code.
type statusWriter struct {
	http.ResponseWriter
	status int
}

func (s statusWriter) WriteHeader(int) { s.ResponseWriter.WriteHeader(s.status) }

// jsonError is the body of error answers outside /rpc/.
type jsonError struct {
	Code        string `json:"code"`
	InstanceURL string `json:"instanceUrl,omitempty"`
	Message     string `json:"message,omitempty"`
}

func writeJSONError(w http.ResponseWriter, status int, e jsonError) {
	w.Header().Set("Content-Type", "application/json")
	w.Header().Set("X-Content-Type-Options", "nosniff")
	w.WriteHeader(status)
	_ = json.NewEncoder(w).Encode(e)
}

// writeRequestError answers a malformed or refused request (400, 403).
func (h *internalHandler) writeRequestError(w http.ResponseWriter, f errFormat, code connect.Code, msg string) {
	if f == fmtRPC {
		h.writeConnectUnary(w, connectHTTPStatus(code), connect.NewError(code, errors.New(msg)))
		return
	}
	writeJSONError(w, connectHTTPStatus(code), jsonError{Code: code.String(), Message: msg})
}

func connectHTTPStatus(code connect.Code) int {
	switch code {
	case connect.CodeInvalidArgument:
		return http.StatusBadRequest
	case connect.CodePermissionDenied:
		return http.StatusForbidden
	default:
		return http.StatusInternalServerError
	}
}

// validName reports whether s is a protobuf service or method name: it
// starts with a letter or _ and has only letters, digits, _ and dots.
func validName(s string) bool {
	if s == "" {
		return false
	}
	if c := s[0]; (c < 'a' || c > 'z') && (c < 'A' || c > 'Z') && c != '_' {
		return false
	}
	for _, c := range s {
		switch {
		case c >= 'a' && c <= 'z', c >= 'A' && c <= 'Z', c >= '0' && c <= '9', c == '_', c == '.':
		default:
			return false
		}
	}
	return true
}

// serveRPC proxies /v1/machines/{id}/rpc/{service}/{method} to the agent's
// /{service}/{method}. umiak.tunnel.v1 and services outside
// AllowedServicePrefixes are refused with 403.
func (h *internalHandler) serveRPC(w http.ResponseWriter, r *http.Request) {
	id, ok := parseMachineID(r.PathValue("id"))
	if !ok {
		h.writeRequestError(w, fmtRPC, connect.CodeInvalidArgument, "machine id must be a uuid")
		return
	}
	svc, method := r.PathValue("service"), r.PathValue("method")
	if !validName(svc) || !validName(method) {
		h.writeRequestError(w, fmtRPC, connect.CodeInvalidArgument, "malformed rpc path")
		return
	}
	if !h.serviceAllowed(svc) {
		h.writeRequestError(w, fmtRPC, connect.CodePermissionDenied, "service "+svc+" is not available through the gateway")
		return
	}
	h.proxy(w, r, id, "/"+svc+"/"+method, "", fmtRPC)
}

func (h *internalHandler) serviceAllowed(svc string) bool {
	if strings.HasPrefix(svc, wire.ServicePrefixTunnel) {
		return false
	}
	for _, p := range h.g.cfg.AllowedServicePrefixes {
		if strings.HasPrefix(svc, p) {
			return true
		}
	}
	return false
}

// serveFiles proxies /v1/machines/{id}/files[/rest] to the agent's /files[/rest].
func (h *internalHandler) serveFiles(w http.ResponseWriter, r *http.Request) {
	id, ok := parseMachineID(r.PathValue("id"))
	if !ok {
		h.writeRequestError(w, fmtJSON, connect.CodeInvalidArgument, "machine id must be a uuid")
		return
	}
	// Keep the client's escaping of the rest of the path: the agent gets
	// the same bytes after /files.
	esc := r.URL.EscapedPath()
	parts := strings.SplitN(esc, "/", 5) // "", v1, machines, id, files[/rest]
	if len(parts) != 5 {
		h.writeRequestError(w, fmtJSON, connect.CodeInvalidArgument, "malformed files path")
		return
	}
	// No segment may become a traversal or a separator once the agent
	// unescapes it.
	for seg := range strings.SplitSeq(parts[4], "/") {
		u, err := url.PathUnescape(seg)
		if err != nil || u == "." || u == ".." || strings.ContainsAny(u, `/\`) {
			h.writeRequestError(w, fmtJSON, connect.CodeInvalidArgument, "malformed files path segment")
			return
		}
	}
	h.proxy(w, r, id, "", "/"+parts[4], fmtJSON)
}

// serveRotate rotates the machine token of an active local session.
func (h *internalHandler) serveRotate(w http.ResponseWriter, r *http.Request) {
	id, ok := parseMachineID(r.PathValue("id"))
	if !ok {
		h.writeRequestError(w, fmtJSON, connect.CodeInvalidArgument, "machine id must be a uuid")
		return
	}
	s := h.target(w, r, id, fmtJSON)
	if s == nil {
		return
	}
	// A rotation runs to the end even if the caller goes away, so the
	// agent and the registry do not stay between the two phases.
	ctx, cancel := context.WithTimeout(context.WithoutCancel(r.Context()), rotateTimeout)
	defer cancel()
	err := s.rotateToken(ctx)
	switch {
	case err == nil:
		w.Header().Set("Content-Type", "application/json")
		_, _ = w.Write([]byte("{}\n"))
	case errors.Is(err, errNotActive):
		h.notServed(w, r, id, fmtJSON)
	default:
		s.log.Warn("gateway: rotate-token failed", "err", err, "caller", callerOf(r.Context()))
		writeJSONError(w, http.StatusBadGateway, jsonError{Code: "rotation_failed", Message: err.Error()})
	}
}
