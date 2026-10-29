package gateway

import (
	"errors"
	"fmt"
	"io"
	"net/http"
	"net/textproto"
	"net/url"
	"strings"

	"connectrpc.com/connect"

	"github.com/belov38/boat-dev-clone/libs/tunnel/wire"
)

// copyBufSize is the read size of the streaming proxy; every read is
// written and flushed at once, nothing is buffered beyond it.
const copyBufSize = 32 << 10

// hopHeaders are the hop-by-hop headers (RFC 9110 7.6.1) never forwarded.
var hopHeaders = []string{
	"Connection",
	"Keep-Alive",
	"Proxy-Connection",
	"Proxy-Authenticate",
	"Proxy-Authorization",
	"Te",
	"Trailer",
	"Transfer-Encoding",
	"Upgrade",
}

// copyHeader copies src into dst without the hop-by-hop headers and the
// headers named in Connection.
func copyHeader(dst, src http.Header) {
	for k, vv := range src {
		dst[k] = append([]string(nil), vv...)
	}
	for _, v := range src["Connection"] {
		for f := range strings.SplitSeq(v, ",") {
			if f = textproto.TrimString(f); f != "" {
				dst.Del(f)
			}
		}
	}
	for _, k := range hopHeaders {
		dst.Del(k)
	}
}

// isSbxHeader reports whether a header name is in the Sbx- namespace
// (case-insensitive). Towards callers only the gateway produces those: they
// are routing signals (Sbx-Error-Code, Sbx-Instance-Url) a caller acts on.
func isSbxHeader(k string) bool { return len(k) >= 4 && strings.EqualFold(k[:4], "sbx-") }

// isRedirectHeader reports whether a header points the caller at another
// URL or endpoint (Location, Content-Location, Refresh, Alt-Svc): an agent
// must not choose where a caller sends its next request.
func isRedirectHeader(k string) bool {
	switch textproto.CanonicalMIMEHeaderKey(k) {
	case "Location", "Content-Location", "Refresh", "Alt-Svc":
		return true
	}
	return false
}

// agentSbxHeaders are the agent-defined Sbx-* response headers passed to
// callers (canonical names). Additions need review: Sbx-* are gateway
// routing signals.
var agentSbxHeaders = map[string]bool{wire.HeaderUploadOffset: true}

// connectTrailerPrefix prefixes Connect unary trailers sent as headers;
// Connect clients merge them, without the prefix, into the call metadata.
const connectTrailerPrefix = "trailer-"

// blockedAgentHeader reports whether an agent response header or trailer is
// never passed to callers: Sbx-* and Trailer-Sbx-* except agentSbxHeaders
// (after the Trailer- prefix), and redirect headers.
func blockedAgentHeader(k string) bool {
	name := k
	if len(name) > len(connectTrailerPrefix) && strings.EqualFold(name[:len(connectTrailerPrefix)], connectTrailerPrefix) {
		name = name[len(connectTrailerPrefix):]
	}
	if isSbxHeader(name) {
		return !agentSbxHeaders[textproto.CanonicalMIMEHeaderKey(name)]
	}
	return isRedirectHeader(k)
}

// dropAgentHeaders removes the blocked agent headers from h.
func dropAgentHeaders(h http.Header) {
	for k := range h {
		if blockedAgentHeader(k) {
			delete(h, k)
		}
	}
}

// isRedirect reports whether an agent status is a redirect a client may
// follow: every 3xx but 304 Not Modified, which conditional /files GETs need.
func isRedirect(status int) bool {
	return status >= 300 && status < 400 && status != http.StatusNotModified
}

// wantsTrailers reports whether the request carries "TE: trailers".
func wantsTrailers(h http.Header) bool {
	for _, v := range h["Te"] {
		for f := range strings.SplitSeq(v, ",") {
			f, _, _ = strings.Cut(f, ";")
			if strings.EqualFold(textproto.TrimString(f), "trailers") {
				return true
			}
		}
	}
	return false
}

// upstreamHeader builds the headers sent to the agent: the client's
// headers without hop-by-hop ones, Authorization, Expect and any
// client-sent Sbx-Caller; Sbx-Caller is set to the authenticated caller.
func upstreamHeader(r *http.Request) http.Header {
	h := make(http.Header, len(r.Header)+1)
	copyHeader(h, r.Header)
	if wantsTrailers(r.Header) {
		h.Set("Te", "trailers")
	}
	h.Del("Authorization")
	h.Del("Expect")
	h.Del(wire.HeaderCaller)
	h.Set(wire.HeaderCaller, callerOf(r.Context()))
	return h
}

// isConnectStream reports whether a content type is a Connect streaming one.
func isConnectStream(ct string) bool { return strings.HasPrefix(ct, "application/connect+") }

// proxy forwards r to the agent of machine id: path is the upstream path
// (rpc), or escPath the escaped upstream path (files). The request body is
// streamed as is, the response is copied with a flush after every read.
func (h *internalHandler) proxy(w http.ResponseWriter, r *http.Request, id, path, escPath string, f errFormat) {
	u := &url.URL{Scheme: "http", Host: agentHost, Path: path, RawQuery: r.URL.RawQuery}
	if escPath != "" {
		p, err := url.PathUnescape(escPath)
		if err != nil {
			h.writeRequestError(w, f, connect.CodeInvalidArgument, "malformed path")
			return
		}
		u.Path, u.RawPath = p, escPath
	}
	s := h.target(w, r, id, f)
	if s == nil {
		return
	}
	out, err := http.NewRequestWithContext(r.Context(), r.Method, u.String(), nil)
	if err != nil {
		h.writeRequestError(w, f, connect.CodeInvalidArgument, "malformed request")
		return
	}
	out.URL = u
	out.Host = agentHost
	out.Header = upstreamHeader(r)
	out.Body, out.ContentLength = r.Body, r.ContentLength
	if r.ContentLength == 0 {
		out.Body = http.NoBody
	}

	rc := http.NewResponseController(w)
	// HTTP/1.1 callers stream the request body while the response flows.
	_ = rc.EnableFullDuplex()

	resp, err := s.mc.RoundTrip(out)
	if err != nil {
		if r.Context().Err() != nil {
			return // the caller went away
		}
		s.log.Debug("gateway: proxied request failed before the response", "err", err, "path", u.Path)
		// The session may have moved or closed meanwhile: route again.
		h.notServed(w, r, id, f)
		return
	}
	defer func() { _ = resp.Body.Close() }()

	// A redirect would make the caller resend the request, with its service
	// token when the host stays the same, to a URL the agent chose (another
	// machine's route, any server): it is refused (spec 16.1).
	if isRedirect(resp.StatusCode) {
		s.log.Warn("gateway: agent answered with a redirect, refused", "status", resp.StatusCode, "path", u.Path)
		msg := fmt.Sprintf("agent answered with redirect status %d, which the gateway does not pass on", resp.StatusCode)
		if f == fmtRPC {
			h.writeConnectUnary(w, http.StatusBadGateway, connect.NewError(connect.CodeInternal, errors.New(msg)))
		} else {
			writeJSONError(w, http.StatusBadGateway, jsonError{Code: "bad_agent_response", Message: msg})
		}
		return
	}

	// The agent's Sbx-* (but agentSbxHeaders) and redirect headers and
	// trailers are dropped: a compromised agent must not be able to forge a
	// gateway answer such as 421 machine_moved with an Sbx-Instance-Url of
	// its choosing, nor point the caller elsewhere (spec 16.1).
	hdr := w.Header()
	copyHeader(hdr, resp.Header)
	dropAgentHeaders(hdr)
	declared := make(map[string]bool, len(resp.Trailer))
	for k := range resp.Trailer {
		if blockedAgentHeader(k) {
			continue
		}
		hdr.Add("Trailer", k)
		declared[k] = true
	}
	w.WriteHeader(resp.StatusCode)
	_ = rc.Flush()

	ct := resp.Header.Get("Content-Type")
	if err := h.copyBody(w, rc, resp.Body, isConnectStream(ct)); err != nil {
		if r.Context().Err() != nil {
			return
		}
		h.abortBody(w, rc, r, id, ct, err)
		return
	}
	for k, vv := range resp.Trailer {
		if blockedAgentHeader(k) {
			continue
		}
		if declared[k] {
			hdr[k] = vv
		} else {
			hdr[http.TrailerPrefix+k] = vv
		}
	}
}

// copyBody copies the upstream body with a flush after every read. It
// returns nil at the upstream EOF and when the caller went away, and the
// upstream read error otherwise. For Connect streams it tracks envelope
// boundaries in tr so abortBody can end the stream cleanly.
func (h *internalHandler) copyBody(w http.ResponseWriter, rc *http.ResponseController, src io.Reader, connectStream bool) error {
	var tr *envelopeTracker
	if connectStream {
		tr = &envelopeTracker{}
	}
	buf := make([]byte, copyBufSize)
	for {
		n, err := src.Read(buf)
		if n > 0 {
			if tr != nil {
				tr.feed(buf[:n])
			}
			if _, werr := w.Write(buf[:n]); werr != nil {
				return nil // the caller went away; its context ends the upstream call
			}
			_ = rc.Flush()
		}
		switch {
		case err == nil:
		case errors.Is(err, io.EOF):
			return nil
		default:
			return &upstreamError{err: err, tr: tr}
		}
	}
}

// upstreamError is an upstream body failure after the response started.
type upstreamError struct {
	err error
	tr  *envelopeTracker // nil when the body is not a Connect stream
}

func (e *upstreamError) Error() string { return e.err.Error() }
func (e *upstreamError) Unwrap() error { return e.err }
