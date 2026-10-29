package portauth

import (
	"net/http"
	"net/url"
	"strings"
)

// IsPreflight reports a CORS preflight: OPTIONS with Origin and
// Access-Control-Request-Method. Preflights skip authorization (spec 8.5).
func IsPreflight(r *http.Request) bool {
	return r.Method == http.MethodOptions &&
		r.Header.Get("Origin") != "" &&
		r.Header.Get("Access-Control-Request-Method") != ""
}

// StripRequest removes the gateway's credentials from a request to the
// application (spec 7.4): the gateway cookies (__Host-sbx_auth and every
// __Host-sbx_state*, case-insensitive) and the cookies whose names
// start with one of prefixes, the _token query parameters and the
// Sbx-Port-Token header. Other cookie pairs are kept byte-for-byte and in
// order (joined into one Cookie header when anything was removed); other
// query parameters are kept raw and in order.
func StripRequest(h http.Header, u *url.URL, prefixes []string) {
	h.Del(TokenHeader)
	stripCookies(h, prefixes)
	if u != nil {
		if _, found, rest := splitToken(u.RawQuery); found {
			u.RawQuery = rest
			u.ForceQuery = false
		}
	}
}

func stripCookies(h http.Header, prefixes []string) {
	lines := h.Values("Cookie")
	if len(lines) == 0 {
		return
	}
	var kept []string
	dropped := false
	for _, line := range lines {
		for pair := range strings.SplitSeq(line, ";") {
			pair = strings.TrimSpace(pair)
			if pair == "" {
				continue
			}
			name, _, _ := strings.Cut(pair, "=")
			if gatewayCookie(strings.TrimSpace(name), prefixes) {
				dropped = true
				continue
			}
			kept = append(kept, pair)
		}
	}
	if !dropped {
		return
	}
	if len(kept) == 0 {
		h.Del("Cookie")
		return
	}
	h.Set("Cookie", strings.Join(kept, "; "))
}

func gatewayCookie(name string, prefixes []string) bool {
	if strings.EqualFold(name, AuthCookie) || isStateCookie(name) {
		return true
	}
	for _, p := range prefixes {
		if p != "" && strings.HasPrefix(name, p) {
			return true
		}
	}
	return false
}
