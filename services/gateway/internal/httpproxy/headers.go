package httpproxy

import (
	"io"
	"mime"
	"net/http"
	"strings"
	"sync"

	"github.com/belov38/boat-dev-clone/services/gateway/internal/portauth"
)

// Response trailer caps (not in the spec): a trailer block above either is
// dropped whole and logged. Each field counts len(name)+len(value)+32, like
// the HTTP/2 header list size.
const (
	maxTrailerBytes  = 64 << 10
	maxTrailerFields = 100
	fieldOverhead    = 32
)

const robotsTag = "noindex, nofollow"

// identityHeaders are request headers an identity-aware proxy would set;
// a client could forge them, so they never reach the application (spec 7.4).
// X-Forwarded-Port and X-Request-Id are set again by the gateway.
var identityHeaders = map[string]bool{
	"x-forwarded-email":              true,
	"x-forwarded-user":               true,
	"x-forwarded-groups":             true,
	"x-forwarded-preferred-username": true,
	"x-forwarded-access-token":       true,
	"x-real-ip":                      true,
	"x-forwarded-port":               true,
	"x-request-id":                   true,
}

// stripRequestHeaders removes the client headers of spec 7.4: every Sbx-*
// and X-Sbx-* (the gateway sets its own), X-Auth-Request-* and the identity
// headers. Names are compared case-insensitively, so non-canonical keys are
// caught too. Cookies, _token and Sbx-Port-Token are portauth.StripRequest's.
func stripRequestHeaders(h http.Header) {
	for k := range h {
		lk := strings.ToLower(k)
		if strings.HasPrefix(lk, "sbx-") || strings.HasPrefix(lk, "x-sbx-") ||
			strings.HasPrefix(lk, "x-auth-request-") || identityHeaders[lk] {
			delete(h, k)
		}
	}
}

// cleanResponseHeader applies the response policy of spec 7.4 to an
// application's headers: no Set-Cookie of a gateway cookie (the app shares
// the host), no Sbx-* (an app must not forge a gateway error) and no Alt-Svc
// (the app does not know how it is published). X-Request-Id is removed too:
// the gateway sets its own.
func cleanResponseHeader(h http.Header) {
	for k := range h {
		if hasPrefixFold(k, "sbx-") || strings.EqualFold(k, "alt-svc") || strings.EqualFold(k, "x-request-id") {
			delete(h, k)
		}
	}
	cookies := h["Set-Cookie"]
	if len(cookies) == 0 {
		return
	}
	kept := make([]string, 0, len(cookies))
	for _, c := range cookies {
		if !gatewayCookieName(setCookieName(c)) {
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

func gatewayCookieName(name string) bool {
	return strings.EqualFold(name, portauth.AuthCookie) || hasPrefixFold(name, portauth.StateCookiePrefix)
}

func hasPrefixFold(s, prefix string) bool {
	return len(s) >= len(prefix) && strings.EqualFold(s[:len(prefix)], prefix)
}

// sanitizeTrailers removes Sbx-* trailers, then drops every trailer when the
// block exceeds maxTrailerBytes or maxTrailerFields. It reports the drop.
func sanitizeTrailers(t http.Header) bool {
	for k := range t {
		if hasPrefixFold(k, "sbx-") {
			delete(t, k)
		}
	}
	fields, size := 0, 0
	for k, vv := range t {
		for _, v := range vv {
			fields++
			size += len(k) + len(v) + fieldOverhead
		}
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
	if err == io.EOF {
		g.check()
	}
	return n, err
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
