// Package h2 builds the HTTP/2 server and client connection used over a
// tunnel net.Conn (cleartext HTTP/2 with prior knowledge), using the standard
// library with the parameters fixed by the S2 spec.
package h2

import (
	"context"
	"errors"
	"net"
	"net/http"
	"sync"
	"time"
)

// ServerConfig holds the HTTP/2 server parameters of the agent side.
type ServerConfig struct {
	MaxConcurrentStreams int
	// StreamWindow is the per-stream receive buffer in bytes.
	StreamWindow int
	// ConnWindow is the per-connection receive buffer in bytes.
	ConnWindow int
	// MaxFrame is the maximum frame size the server accepts.
	MaxFrame int
}

// DefaultServerConfig returns the spec values: 1000 streams, 1 MiB / 16 MiB windows, 16 KiB frames.
func DefaultServerConfig() ServerConfig {
	return ServerConfig{
		MaxConcurrentStreams: 1000,
		StreamWindow:         1 << 20,
		ConnWindow:           16 << 20,
		MaxFrame:             16 << 10,
	}
}

// NewServer returns an http.Server that speaks only cleartext HTTP/2. Feed it
// connections with Serve and a ConnListener.
func NewServer(h http.Handler, cfg ServerConfig) *http.Server {
	var p http.Protocols
	p.SetUnencryptedHTTP2(true)
	return &http.Server{
		Handler:   h,
		Protocols: &p,
		HTTP2: &http.HTTP2Config{
			MaxConcurrentStreams:          cfg.MaxConcurrentStreams,
			MaxReceiveBufferPerStream:     cfg.StreamWindow,
			MaxReceiveBufferPerConnection: cfg.ConnWindow,
			MaxReadFrameSize:              cfg.MaxFrame,
		},
	}
}

// ErrListenerClosed is returned by ConnListener.Push after Close.
var ErrListenerClosed = errors.New("h2: conn listener closed")

// ConnListener is a net.Listener fed with already established connections, so
// that many tunnel connections can be served by a single http.Server.
type ConnListener struct {
	conns     chan net.Conn
	done      chan struct{}
	closeOnce sync.Once
}

// New returns an open ConnListener.
func New() *ConnListener {
	return &ConnListener{conns: make(chan net.Conn), done: make(chan struct{})}
}

// Push hands conn to the server. It blocks until Accept takes the connection
// or the listener is closed; in the latter case conn is not closed and
// ErrListenerClosed is returned.
func (l *ConnListener) Push(conn net.Conn) error {
	select {
	case <-l.done:
		return ErrListenerClosed
	default:
	}
	select {
	case l.conns <- conn:
		return nil
	case <-l.done:
		return ErrListenerClosed
	}
}

// Accept returns the next pushed connection, or net.ErrClosed after Close.
func (l *ConnListener) Accept() (net.Conn, error) {
	select {
	case c := <-l.conns:
		return c, nil
	case <-l.done:
		return nil, net.ErrClosed
	}
}

// Close unblocks Accept and Push. It is safe to call more than once.
func (l *ConnListener) Close() error {
	l.closeOnce.Do(func() { close(l.done) })
	return nil
}

type listenerAddr struct{}

func (listenerAddr) Network() string { return "tunnel" }
func (listenerAddr) String() string  { return "tunnel" }

// Addr returns a placeholder address.
func (*ConnListener) Addr() net.Addr { return listenerAddr{} }

// ClientConfig holds the HTTP/2 client parameters of the gateway side.
type ClientConfig struct {
	StreamWindow int
	ConnWindow   int
	MaxFrame     int
	// PingIdle is how long the connection may be idle before a PING is sent.
	PingIdle time.Duration
	// PingTimeout is how long to wait for the PING reply before closing.
	PingTimeout time.Duration
}

// DefaultClientConfig returns the spec values: 1 MiB / 16 MiB windows, 16 KiB frames, ping after 10 s idle, 5 s timeout.
func DefaultClientConfig() ClientConfig {
	return ClientConfig{
		StreamWindow: 1 << 20,
		ConnWindow:   16 << 20,
		MaxFrame:     16 << 10,
		PingIdle:     10 * time.Second,
		PingTimeout:  5 * time.Second,
	}
}

// NewClientConn runs cleartext HTTP/2 as a client over conn. The returned
// ClientConn owns conn.
func NewClientConn(ctx context.Context, conn net.Conn, cfg ClientConfig) (*http.ClientConn, error) {
	var p http.Protocols
	p.SetUnencryptedHTTP2(true)
	var once sync.Once
	tr := &http.Transport{
		Protocols: &p,
		HTTP2: &http.HTTP2Config{
			MaxReceiveBufferPerStream:     cfg.StreamWindow,
			MaxReceiveBufferPerConnection: cfg.ConnWindow,
			MaxReadFrameSize:              cfg.MaxFrame,
			SendPingTimeout:               cfg.PingIdle,
			PingTimeout:                   cfg.PingTimeout,
		},
		DialContext: func(context.Context, string, string) (net.Conn, error) {
			var c net.Conn
			once.Do(func() { c = conn })
			if c == nil {
				return nil, errors.New("h2: tunnel connection already used")
			}
			return c, nil
		},
	}
	return tr.NewClientConn(ctx, "http", "agent:80")
}
