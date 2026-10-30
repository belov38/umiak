package httpproxy

import (
	"net/http"
	"net/netip"
	"slices"
	"strings"
)

// ClientIP returns the address of the client of r. It is the peer of the
// connection (RemoteAddr), unless that peer is a trusted proxy: then the
// X-Forwarded-For entries are walked right to left (see xffTail) and the
// client is the right-most untrusted entry, the left-most one when every
// entry is trusted, or the last trusted hop before a malformed entry.
// IPv4-mapped addresses are unmapped. An unparsable RemoteAddr gives the
// zero Addr.
func ClientIP(r *http.Request, trusted []netip.Prefix) netip.Addr {
	peer := remoteIP(r.RemoteAddr)
	if !peer.IsValid() || !isTrusted(peer, trusted) {
		return peer
	}
	if tail := xffTail(r.Header, trusted); len(tail) > 0 {
		return tail[0]
	}
	return peer
}

// forwardedFor returns the X-Forwarded-For value sent to the application.
// The gateway is the edge: a chain from an untrusted peer is replaced by the
// peer's address. Behind trusted proxies the chain from the client on (the
// entry ClientIP picked and the trusted entries after it) is kept and the
// peer is appended, like any proxy does; entries left of the client could
// be forged and are dropped.
func forwardedFor(r *http.Request, trusted []netip.Prefix) string {
	peer := remoteIP(r.RemoteAddr)
	if !peer.IsValid() {
		return ""
	}
	if !isTrusted(peer, trusted) {
		return peer.String()
	}
	var b strings.Builder
	for _, a := range xffTail(r.Header, trusted) {
		b.WriteString(a.String())
		b.WriteString(", ")
	}
	b.WriteString(peer.String())
	return b.String()
}

// forwardedHeader returns the RFC 7239 Forwarded value of one hop.
func forwardedHeader(ip netip.Addr, host string) string {
	var node string
	switch {
	case !ip.IsValid():
		node = "unknown"
	case ip.Is6():
		node = `"[` + ip.String() + `]"`
	default:
		node = ip.String()
	}
	return "for=" + node + ";proto=https;host=" + forwardedValue(host)
}

// forwardedValue returns s as an RFC 7239 value: a token as is, anything
// else as a quoted string.
func forwardedValue(s string) string {
	if s != "" && strings.IndexFunc(s, func(c rune) bool { return !isTokenChar(c) }) < 0 {
		return s
	}
	var b strings.Builder
	b.WriteByte('"')
	for i := range len(s) {
		if s[i] == '"' || s[i] == '\\' {
			b.WriteByte('\\')
		}
		b.WriteByte(s[i])
	}
	b.WriteByte('"')
	return b.String()
}

// isTokenChar reports an RFC 9110 tchar.
func isTokenChar(c rune) bool {
	switch {
	case c >= 'a' && c <= 'z', c >= 'A' && c <= 'Z', c >= '0' && c <= '9':
		return true
	}
	return strings.ContainsRune("!#$%&'*+-.^_`|~", c)
}

func isTrusted(a netip.Addr, trusted []netip.Prefix) bool {
	a = a.WithZone("")
	for _, p := range trusted {
		if p.Contains(a) {
			return true
		}
	}
	return false
}

// remoteIP parses "host:port" or a bare address.
func remoteIP(s string) netip.Addr {
	if ap, err := netip.ParseAddrPort(s); err == nil {
		return ap.Addr().Unmap()
	}
	if a, err := netip.ParseAddr(s); err == nil {
		return a.Unmap()
	}
	return netip.Addr{}
}

// xffTail walks the X-Forwarded-For entries (all lines, left to right)
// from the right, as seen by a trusted peer. Trusted valid entries are
// collected and skipped; the first untrusted valid entry is the client and
// ends the walk; a malformed entry also ends it, and the client is then the
// last trusted hop collected (the proxy closest to the malformed value), or
// the peer when there is none. It returns the entries from the client to
// the right end, so tail[0] is the client; empty means the peer is.
func xffTail(h http.Header, trusted []netip.Prefix) []netip.Addr {
	var parts []string
	for _, line := range h.Values("X-Forwarded-For") {
		parts = append(parts, strings.Split(line, ",")...)
	}
	var tail []netip.Addr
	for i := len(parts) - 1; i >= 0; i-- {
		a := remoteIP(strings.TrimSpace(parts[i]))
		if !a.IsValid() {
			break
		}
		tail = append(tail, a)
		if !isTrusted(a, trusted) {
			break
		}
	}
	slices.Reverse(tail)
	return tail
}
