package httpproxy

import (
	"errors"
	"io"
	"mime"
	"net/http"
	"net/textproto"
	"strings"
	"sync"

	"github.com/belov38/boat-dev-clone/services/gateway/internal/portauth"
)

// Response header and trailer caps (not in the spec). Each field counts
// len(name)+len(value)+32, like the HTTP/2 header list size: what a browser
// gets on a conn it may share with other labels. A header block above
// maxHeaderBytes is a 502; a trailer block above either trailer cap is
// dropped whole and logged.
const (
	maxHeaderBytes   = 64 << 10
	maxTrailerBytes  = 64 << 10
	maxTrailerFields = 100
	fieldOverhead    = 32
)

// responseBlockSize returns the HTTP/2 size of an application's response
// header block as the client would get it: the header fields and the
// Trailer field that announces the declared trailer names.
func responseBlockSize(res *http.Response) int {
	n := headerSize(res.Header)
	if len(res.Trailer) > 0 {
		n += len("Trailer") + fieldOverhead
		for k := range res.Trailer {
			n += len(k) + len(", ")
		}
	}
	return n
}

const robotsTag = "noindex, nofollow"

// strippedHeaders are request headers a client could forge, compared after
// normalizeName.
//   - Spec 7.4: the identity headers an identity-aware proxy would set.
//   - Set again by the gateway: Forwarded, X-Forwarded-For/Host/Proto/Port and
//     X-Request-Id. ReverseProxy deletes only the exact spellings of some of
//     them; the underscore spellings must go too.
//   - Hardening beyond spec 7.4: other client-IP headers that frameworks
//     and CDNs trust (True-Client-Ip, X-Client-Ip, Client-Ip,
//     Cf-Connecting-Ip, X-Original-Forwarded-For).
var strippedHeaders = map[string]bool{
	"x-forwarded-email":              true,
	"x-forwarded-user":               true,
	"x-forwarded-groups":             true,
	"x-forwarded-preferred-username": true,
	"x-forwarded-access-token":       true,
	"x-real-ip":                      true,

	"forwarded":         true,
	"x-forwarded-for":   true,
	"x-forwarded-host":  true,
	"x-forwarded-proto": true,
	"x-forwarded-port":  true,
	"x-request-id":      true,

	"true-client-ip":           true,
	"x-client-ip":              true,
	"client-ip":                true,
	"cf-connecting-ip":         true,
	"x-original-forwarded-for": true,
}

// normalizeName lower-cases a header name and maps "_" to "-". CGI, WSGI
// and Rack turn both into the same variable (HTTP_X_SBX_USER_EMAIL), so an
// underscore spelling must be treated like the dashed one.
func normalizeName(k string) string {
	return strings.ReplaceAll(strings.ToLower(k), "_", "-")
}

// stripRequestHeaders removes the client headers of spec 7.4: every Sbx-*
// and X-Sbx-* (the gateway sets its own), X-Auth-Request-* and
// strippedHeaders. Names are compared after normalizeName, so non-canonical
// and underscore spellings are caught too. Cookies, _token and
// Sbx-Port-Token are portauth.StripRequest's.
func stripRequestHeaders(h http.Header) {
	for k := range h {
		n := normalizeName(k)
		if strings.HasPrefix(n, "sbx-") || strings.HasPrefix(n, "x-sbx-") ||
			strings.HasPrefix(n, "x-auth-request-") || strippedHeaders[n] {
			delete(h, k)
		}
	}
}

// hasUpgrade reports a request that asks for any protocol upgrade.
func hasUpgrade(h http.Header) bool {
	return upgradeType(h) != "" || len(h.Values("Upgrade")) > 0
}

// dropUpgrade removes the Upgrade header and the "upgrade" token of
// Connection, so the request is proxied as a plain one.
func dropUpgrade(h http.Header) {
	h.Del("Upgrade")
	conn := h.Values("Connection")
	if len(conn) == 0 {
		return
	}
	var kept []string
	for _, v := range conn {
		for tok := range strings.SplitSeq(v, ",") {
			tok = strings.TrimSpace(tok)
			if tok != "" && !strings.EqualFold(tok, "upgrade") {
				kept = append(kept, tok)
			}
		}
	}
	if len(kept) == 0 {
		h.Del("Connection")
		return
	}
	h["Connection"] = []string{strings.Join(kept, ", ")}
}

// userEmailHeader is the identity header the gateway sets on sso requests
// (spec 8.4), compared after normalizeName.
const userEmailHeader = "x-sbx-user-email"

// cleanResponseHeader applies the response policy of spec 7.4 to an
// application's headers: no Set-Cookie of a gateway cookie (the app shares
// the host), no Sbx-* (an app must not forge a gateway error) and no Alt-Svc
// (the app does not know how it is published). X-Request-Id is removed too:
// the gateway sets its own; and X-Sbx-User-Email, in any spelling, so an app
// cannot pass off an identity as the gateway's.
func cleanResponseHeader(h http.Header) {
	for k := range h {
		if hasPrefixFold(k, "sbx-") || strings.EqualFold(k, "alt-svc") || strings.EqualFold(k, "x-request-id") ||
			normalizeName(k) == userEmailHeader {
			delete(h, k)
		}
	}
	cookies := h["Set-Cookie"]
	if len(cookies) == 0 {
		return
	}
	kept := make([]string, 0, len(cookies))
	for _, c := range cookies {
		if !gatewaySetCookie(c) {
			kept = append(kept, c)
		}
	}
	if len(kept) == 0 {
		delete(h, "Set-Cookie")
		return
	}
	h["Set-Cookie"] = kept
}

// setCookieName returns the cookie name of a Set-Cookie value.
func setCookieName(v string) string {
	if i := strings.IndexAny(v, "=;"); i >= 0 {
		v = v[:i]
	}
	return strings.TrimSpace(v)
}

// gatewaySetCookie reports a Set-Cookie for a gateway cookie. A nameless
// cookie ("=__Host-sbx_auth=v") counts too: a browser stores it with an
// empty name and sends it back as "__Host-sbx_auth=v".
func gatewaySetCookie(v string) bool {
	name := setCookieName(v)
	if name != "" {
		return gatewayCookieName(name)
	}
	_, value, _ := strings.Cut(v, "=")
	value = strings.TrimSpace(value)
	return hasPrefixFold(value, portauth.AuthCookie) || hasPrefixFold(value, portauth.StateCookiePrefix)
}

func gatewayCookieName(name string) bool {
	return strings.EqualFold(name, portauth.AuthCookie) || hasPrefixFold(name, portauth.StateCookiePrefix)
}

func hasPrefixFold(s, prefix string) bool {
	return len(s) >= len(prefix) && strings.EqualFold(s[:len(prefix)], prefix)
}

// headerSize returns the HTTP/2 size of h.
func headerSize(h http.Header) int {
	n := 0
	for k, vv := range h {
		for _, v := range vv {
			n += len(k) + len(v) + fieldOverhead
		}
	}
	return n
}

// sanitizeTrailers removes Sbx-* trailers, then drops every trailer when the
// block exceeds maxTrailerBytes or maxTrailerFields. It reports the drop.
func sanitizeTrailers(t http.Header) bool {
	for k := range t {
		if hasPrefixFold(k, "sbx-") {
			delete(t, k)
		}
	}
	fields, size := 0, headerSize(t)
	for _, vv := range t {
		fields += len(vv)
	}
	if fields > maxTrailerFields || size > maxTrailerBytes {
		clear(t)
		return true
	}
	return false
}

// trailerGuard wraps a response body. The transport fills res.Trailer when
// the body reaches EOF, before ReverseProxy copies the trailers to the
// client; the guard applies sanitizeTrailers right then.
type trailerGuard struct {
	io.ReadCloser
	res     *http.Response
	once    sync.Once
	dropped func()
}

func (g *trailerGuard) Read(p []byte) (int, error) {
	n, err := g.ReadCloser.Read(p)
	switch {
	case err == io.EOF:
		g.check()
	case err != nil && g.res.ProtoMajor == 1 && trailerReadError(err):
		// The body is complete; only the trailer block failed. Drop the
		// trailers and end the body cleanly. The transport does not reuse
		// the conn: its body never reached EOF.
		g.once.Do(func() {
			clear(g.res.Trailer)
			if g.dropped != nil {
				g.dropped()
			}
		})
		err = io.EOF
	}
	return n, err
}

// Errors net/http's HTTP/1.x body reader returns only after the last
// chunk, while reading the trailer block. They are not exported;
// TestTrailerReadFailure pins them.
var trailerErrorTexts = map[string]bool{
	// EOF inside the block.
	"http: unexpected EOF reading trailer": true,
	// A block longer than the reader's buffer.
	"http: suspiciously long trailer after chunked body": true,
	// Too many fields (textproto).
	"message too large": true,
}

// trailerReadError reports a trailer read error of an HTTP/1.x response:
// one of trailerErrorTexts or a malformed line (textproto.ProtocolError).
// A body cut inside a chunk is io.ErrUnexpectedEOF, which is not one of
// them. Callers check the protocol: HTTP/2 errors (GOAWAY debug text, for
// one) carry peer-chosen text and are never taken for these.
func trailerReadError(err error) bool {
	var pe textproto.ProtocolError
	if errors.As(err, &pe) {
		return true
	}
	return trailerErrorTexts[err.Error()]
}

func (g *trailerGuard) Close() error {
	err := g.ReadCloser.Close()
	g.check()
	return err
}

func (g *trailerGuard) check() {
	g.once.Do(func() {
		if sanitizeTrailers(g.res.Trailer) && g.dropped != nil {
			g.dropped()
		}
	})
}

// upgradeType returns the Upgrade protocol of a request that asks for one
// (Connection: upgrade), else "".
func upgradeType(h http.Header) string {
	for _, v := range h.Values("Connection") {
		for tok := range strings.SplitSeq(v, ",") {
			if strings.EqualFold(strings.TrimSpace(tok), "upgrade") {
				return h.Get("Upgrade")
			}
		}
	}
	return ""
}

// longResponse reports a response that may stay open for long: SSE or a
// body without a known length (streaming, gRPC).
func longResponse(res *http.Response) bool {
	if res.ContentLength < 0 {
		return true
	}
	ct, _, _ := mime.ParseMediaType(res.Header.Get("Content-Type"))
	return ct == "text/event-stream"
}
