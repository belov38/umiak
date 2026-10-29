package httpproxy

import (
	"net/http"
	"net/netip"
	"strings"
)

// ClientIP returns the address of the client of r. It is the peer of the
// connection (RemoteAddr), unless that peer is a trusted proxy: then it is
// the right-most X-Forwarded-For entry that is not trusted, or the left-most
// one when every entry is trusted (spec 5.2, 7.4). A malformed
// X-Forwarded-For is ignored and the peer is the client. IPv4-mapped
// addresses are unmapped. An unparsable RemoteAddr gives the zero Addr.
func ClientIP(r *http.Request, trusted []netip.Prefix) netip.Addr {
	peer := remoteIP(r.RemoteAddr)
	if !peer.IsValid() || !isTrusted(peer, trusted) {
		return peer
	}
	chain, ok := xffChain(r.Header)
	if !ok || len(chain) == 0 {
		return peer
	}
	return chain[clientIndex(chain, trusted)]
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
	chain, ok := xffChain(r.Header)
	if !ok || len(chain) == 0 {
		return peer.String()
	}
	var b strings.Builder
	for _, a := range chain[clientIndex(chain, trusted):] {
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

func clientIndex(chain []netip.Addr, trusted []netip.Prefix) int {
	for i := len(chain) - 1; i >= 0; i-- {
		if !isTrusted(chain[i], trusted) {
			return i
		}
	}
	return 0
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

// xffChain parses every X-Forwarded-For line, left to right. ok is false
// when any entry is not an address (with or without a port).
func xffChain(h http.Header) ([]netip.Addr, bool) {
	var chain []netip.Addr
	for _, line := range h.Values("X-Forwarded-For") {
		for part := range strings.SplitSeq(line, ",") {
			a := remoteIP(strings.TrimSpace(part))
			if !a.IsValid() {
				return nil, false
			}
			chain = append(chain, a)
		}
	}
	return chain, true
}
