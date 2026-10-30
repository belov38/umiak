package edge

import (
	"net/http"
	"time"

	"github.com/belov38/boat-dev-clone/services/gateway/internal/config"
)

// Limits of the public servers (spec 7.7, constraints of the tunnel
// listener). Zero config values take the defaults.
const (
	defaultReadHeaderTimeout = 10 * time.Second
	defaultMaxHeaderBytes    = 64 << 10
	clientIdleTimeout        = 120 * time.Second

	// tunnelReadHeaderTimeout closes a tunnel conn that has not sent its
	// request header, and (as the idle timeout) a keep-alive tunnel conn
	// without an upgrade: such conns hold a per-IP tunnel slot.
	tunnelReadHeaderTimeout = 5 * time.Second
	tunnelMaxHeaderBytes    = 16 << 10
)

// NewSbxServer returns the server of *.sbx conns from Dispatcher.Sbx: HTTP/1
// and HTTP/2 over the pre-handshaked *tls.Conn (the negotiated ALPN picks
// the protocol), so it needs no TLSConfig. HTTP/2 SETTINGS carry no
// ENABLE_CONNECT_PROTOCOL: the process never sets GODEBUG=http2xconnect
// (spec 7.3). net/http recovers handler panics per conn.
func NewSbxServer(h http.Handler, t config.Timeouts) *http.Server {
	var p http.Protocols
	p.SetHTTP1(true)
	p.SetHTTP2(true)
	return &http.Server{
		Handler:           h,
		Protocols:         &p,
		ReadHeaderTimeout: orDefault(t.ReadHeader, defaultReadHeaderTimeout),
		IdleTimeout:       orDefault(t.ClientIdle, clientIdleTimeout),
		MaxHeaderBytes:    orDefault(t.MaxHeaderBytes, defaultMaxHeaderBytes),
	}
}

// NewTunnelServer returns the server of tunnel conns from
// Dispatcher.Tunnel: HTTP/1 only (WebSocket upgrade), MaxHeaderBytes 16 KiB,
// and t.TunnelReadHeader (default 5 s) as both the header and the idle
// timeout, so a conn without an upgrade is closed soon. An upgraded conn is
// hijacked and no longer subject to either.
func NewTunnelServer(h http.Handler, t config.Timeouts) *http.Server {
	var p http.Protocols
	p.SetHTTP1(true)
	timeout := orDefault(t.TunnelReadHeader, tunnelReadHeaderTimeout)
	return &http.Server{
		Handler:           h,
		Protocols:         &p,
		ReadHeaderTimeout: timeout,
		IdleTimeout:       timeout,
		MaxHeaderBytes:    tunnelMaxHeaderBytes,
	}
}

// NewPlainServer returns the server of the plain listener (spec 5.2): HTTP/1
// and cleartext HTTP/2 with prior knowledge, with the timeouts of the sbx
// server.
func NewPlainServer(h http.Handler, t config.Timeouts) *http.Server {
	s := NewSbxServer(h, t)
	var p http.Protocols
	p.SetHTTP1(true)
	p.SetUnencryptedHTTP2(true)
	s.Protocols = &p
	return s
}

func orDefault[T time.Duration | int](v, def T) T {
	if v <= 0 {
		return def
	}
	return v
}
