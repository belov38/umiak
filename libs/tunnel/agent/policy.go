package agent

import (
	"fmt"
	"net"
	"net/http"
	"net/netip"
	"strings"
)

// DialPolicy decides whether a CONNECT target may be dialed. It returns nil
// to allow, otherwise a *PolicyError (other errors are treated as 403).
type DialPolicy func(host string, port int) error

// PolicyError is a refused CONNECT target: 400 for a bad port, 403 for a
// target that is not local.
type PolicyError struct {
	Status int
	Reason string
}

func (e *PolicyError) Error() string {
	return fmt.Sprintf("connect target refused: %d %s", e.Status, e.Reason)
}

// LocalOnly allows only targets inside the VM (spec 4.2): the name
// "localhost" (any case), loopback IPs and IPs of local interfaces, read at
// check time. Other host names are refused without DNS resolution, as are
// unspecified addresses (0.0.0.0, ::). Ports outside 1-65535 yield 400.
func LocalOnly() DialPolicy {
	return func(host string, port int) error {
		if port < 1 || port > 65535 {
			return &PolicyError{Status: http.StatusBadRequest, Reason: "port out of range"}
		}
		if strings.EqualFold(host, "localhost") {
			return nil
		}
		ip, err := netip.ParseAddr(host)
		if err != nil {
			return &PolicyError{Status: http.StatusForbidden, Reason: "only local addresses are allowed"}
		}
		ip = ip.Unmap().WithZone("")
		if ip.IsUnspecified() {
			return &PolicyError{Status: http.StatusForbidden, Reason: "unspecified address"}
		}
		if ip.IsLoopback() || isInterfaceAddr(ip) {
			return nil
		}
		return &PolicyError{Status: http.StatusForbidden, Reason: "not a local address"}
	}
}

func isInterfaceAddr(ip netip.Addr) bool {
	addrs, err := net.InterfaceAddrs()
	if err != nil {
		return false
	}
	for _, a := range addrs {
		var raw net.IP
		switch v := a.(type) {
		case *net.IPNet:
			raw = v.IP
		case *net.IPAddr:
			raw = v.IP
		default:
			continue
		}
		if local, ok := netip.AddrFromSlice(raw); ok && local.Unmap() == ip {
			return true
		}
	}
	return false
}
