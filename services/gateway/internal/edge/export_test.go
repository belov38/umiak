package edge

import (
	"net/netip"
	"time"
)

// SetPollInterval changes the mtime poll interval of c; call before Run.
func (c *CertSource) SetPollInterval(d time.Duration) { c.pollEvery = d }

// HandshakesInFlight returns the general and the exempt handshake slots in
// use.
func (d *Dispatcher) HandshakesInFlight() (general, exempt int) {
	return len(d.handshakes), len(d.exemptHandshakes)
}

// HandshakesInFlightOf returns the per-IP handshake slots in use of the
// bucket of ip.
func (d *Dispatcher) HandshakesInFlightOf(ip netip.Addr) int { return d.perIP.count(ip) }
