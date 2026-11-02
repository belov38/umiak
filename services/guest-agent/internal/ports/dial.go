package ports

import (
	"context"
	"errors"
	"net"
	"net/netip"
	"strconv"
	"strings"
	"sync/atomic"
	"syscall"
	"time"

	"github.com/belov38/umiak/libs/tunnel/agent"
)

// Dial defaults.
const (
	defaultAttempt = time.Second
	defaultTotal   = 10 * time.Second
)

// Dial error reasons reported to the gateway (Umiak-Dial-Error).
const (
	ReasonRefused = "refused"
	ReasonTimeout = "timeout"
)

// Dialer opens CONNECT targets inside the VM (spec section 12). Its Dial
// method fits agent.Config.Dial.
type Dialer struct {
	// LocalAddrs lists the VM interface addresses; nil means InterfaceAddrs.
	LocalAddrs func() []netip.Addr
	// Attempt bounds one connection attempt; zero means 1 s.
	Attempt time.Duration
	// Total bounds the whole Dial; zero means 10 s. The tunnel library gives
	// the hook a context without a deadline.
	Total time.Duration
	// Counter, if set, counts the connections returned by Dial until closed.
	Counter *Counter

	// dial replaces the network dial in tests.
	dial func(ctx context.Context, network, addr string) (net.Conn, error)
}

// InterfaceAddrs returns the unicast addresses of the VM's network
// interfaces, IPv4-mapped IPv6 unmapped and zones dropped.
func InterfaceAddrs() []netip.Addr {
	addrs, err := net.InterfaceAddrs()
	if err != nil {
		return nil
	}
	out := make([]netip.Addr, 0, len(addrs))
	for _, a := range addrs {
		var ip net.IP
		switch v := a.(type) {
		case *net.IPNet:
			ip = v.IP
		case *net.IPAddr:
			ip = v.IP
		}
		if addr, ok := netip.AddrFromSlice(ip); ok {
			out = append(out, addr.Unmap().WithZone(""))
		}
	}
	return out
}

// Dial connects to host:port inside the VM. For "", "localhost" (any case)
// and 127.0.0.1 it tries 127.0.0.1, ::1, the interface IPv4 addresses and
// the interface IPv6 addresses in turn; any other host is dialled alone.
// Failures are *agent.DialError with reason "refused" or "timeout".
func (d Dialer) Dial(ctx context.Context, host string, port int) (net.Conn, error) {
	attempt, total := d.Attempt, d.Total
	if attempt <= 0 {
		attempt = defaultAttempt
	}
	if total <= 0 {
		total = defaultTotal
	}
	dial := d.dial
	if dial == nil {
		var nd net.Dialer
		dial = nd.DialContext
	}
	localAddrs := d.LocalAddrs
	if localAddrs == nil {
		localAddrs = InterfaceAddrs
	}

	parent := ctx
	ctx, cancel := context.WithTimeout(ctx, total)
	defer cancel()

	var (
		timedOut bool
		lastErr  error
	)
	for _, host := range candidates(host, localAddrs) {
		if ctx.Err() != nil {
			break
		}
		actx, acancel := context.WithTimeout(ctx, attempt)
		conn, err := dial(actx, "tcp", net.JoinHostPort(host, strconv.Itoa(port)))
		acancel()
		if err == nil {
			return d.wrap(conn), nil
		}
		lastErr = err
		if isTimeout(err) {
			timedOut = true
		}
	}
	if err := parent.Err(); err != nil {
		return nil, err
	}
	if timedOut || ctx.Err() != nil {
		return nil, &agent.DialError{Reason: ReasonTimeout, Err: lastErr}
	}
	return nil, &agent.DialError{Reason: ReasonRefused, Err: lastErr}
}

func (d Dialer) wrap(conn net.Conn) net.Conn {
	if d.Counter == nil {
		return conn
	}
	d.Counter.Inc()
	return &countedConn{Conn: conn, c: d.Counter}
}

// candidates lists the hosts to try for the requested one.
func candidates(host string, localAddrs func() []netip.Addr) []string {
	if host != "" && !strings.EqualFold(host, "localhost") && host != "127.0.0.1" {
		return []string{host}
	}
	out := []string{"127.0.0.1", "::1"}
	seen := map[netip.Addr]bool{
		netip.MustParseAddr("127.0.0.1"): true,
		netip.IPv6Loopback():             true,
	}
	var v4, v6 []string
	for _, a := range localAddrs() {
		a = a.Unmap().WithZone("")
		if !a.IsValid() || seen[a] || a.IsUnspecified() || a.IsMulticast() || a.IsLinkLocalUnicast() {
			continue
		}
		seen[a] = true
		if a.Is4() {
			v4 = append(v4, a.String())
		} else {
			v6 = append(v6, a.String())
		}
	}
	out = append(out, v4...)
	return append(out, v6...)
}

// isRefused reports whether err is a connection refusal. Windows reports
// WSAECONNREFUSED, which is not syscall.ECONNREFUSED there.
func isRefused(err error) bool {
	return errors.Is(err, syscall.ECONNREFUSED) || isConnRefusedOS(err)
}

// isTimeout reports whether err is a dial timeout rather than a refusal.
func isTimeout(err error) bool {
	if isRefused(err) {
		return false
	}
	if errors.Is(err, context.DeadlineExceeded) {
		return true
	}
	var ne net.Error
	return errors.As(err, &ne) && ne.Timeout()
}

// countedConn decrements its Counter exactly once on Close.
type countedConn struct {
	net.Conn
	c    *Counter
	done atomic.Bool
}

// Close closes the connection and releases the counter slot.
func (c *countedConn) Close() error {
	err := c.Conn.Close()
	if c.done.CompareAndSwap(false, true) {
		c.c.Dec()
	}
	return err
}

// CloseWrite half-closes the write side when the connection supports it, so
// the tunnel can pass END_STREAM through.
func (c *countedConn) CloseWrite() error {
	if cw, ok := c.Conn.(interface{ CloseWrite() error }); ok {
		return cw.CloseWrite()
	}
	return errors.ErrUnsupported
}
