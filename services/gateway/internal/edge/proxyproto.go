package edge

import (
	"errors"
	"net"
	"net/netip"
	"time"

	proxyproto "github.com/pires/go-proxyproto"
)

// errProxyVersion refuses a PROXY header other than v2.
var errProxyVersion = errors.New("edge: only PROXY protocol v2 is accepted")

// WrapProxyProtocol wraps ln with PROXY protocol v2 parsing and the
// trusted-source policy of spec 5.1: a peer in trusted may send a header
// (its source becomes RemoteAddr) or not; any other peer is served as is
// when it sends no header, and its conn fails on the first read when it
// does (the server then closes it). A v1 header fails the same way, also
// from a trusted peer. headerTimeout bounds the wait for the
// header (0 means DefaultProxyHeaderTimeout); use the dispatcher's
// ProxyHeaderTimeout.
//
// The policy runs in Accept without I/O. RemoteAddr of an accepted conn
// blocks until the header is read, so call it only after the first read
// (the TLS handshake or the SSH version exchange).
func WrapProxyProtocol(ln net.Listener, trusted []netip.Prefix, headerTimeout time.Duration) net.Listener {
	if headerTimeout <= 0 {
		headerTimeout = DefaultProxyHeaderTimeout
	}
	trusted = append([]netip.Prefix(nil), trusted...)
	return &proxyproto.Listener{
		Listener: ln,
		ConnPolicy: func(o proxyproto.ConnPolicyOptions) (proxyproto.Policy, error) {
			if ip := addrIP(o.Upstream); ip.IsValid() && inPrefixes(ip, trusted) {
				return proxyproto.USE, nil
			}
			return proxyproto.REJECT, nil
		},
		ValidateHeader: func(h *proxyproto.Header) error {
			if h.Version != 2 {
				return errProxyVersion
			}
			return nil
		},
		ReadHeaderTimeout: headerTimeout,
	}
}

// addrIP returns the unmapped IP of a TCP address, or the zero Addr.
func addrIP(a net.Addr) netip.Addr {
	if a == nil {
		return netip.Addr{}
	}
	if ta, ok := a.(*net.TCPAddr); ok {
		ip, _ := netip.AddrFromSlice(ta.IP)
		return ip.Unmap()
	}
	ap, err := netip.ParseAddrPort(a.String())
	if err != nil {
		return netip.Addr{}
	}
	return ap.Addr().Unmap()
}

func inPrefixes(ip netip.Addr, ps []netip.Prefix) bool {
	ip = ip.WithZone("")
	for _, p := range ps {
		if p.Contains(ip) {
			return true
		}
	}
	return false
}
