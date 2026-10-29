// Package wstransport carries the tunnel over a WebSocket: the agent-side
// Dialer and the gateway-side http.Handler. The WebSocket is exposed as a
// binary net.Conn that the HTTP/2 layer runs on.
package wstransport

import (
	"context"
	"crypto/tls"
	"crypto/x509"
	"errors"
	"fmt"
	"io"
	"net"
	"net/http"
	"strconv"
	"strings"
	"sync"
	"time"

	"github.com/coder/websocket"

	"github.com/belov38/boat-dev-clone/libs/tunnel/transport"
	"github.com/belov38/boat-dev-clone/libs/tunnel/wire"
)

// maxReasonLen caps the response body kept as RejectError.Reason.
const maxReasonLen = 1024

// Default timings (spec sections 6 and 7); zero fields of DialerConfig use them.
const (
	defaultPingInterval = 5 * time.Second
	defaultPingTimeout  = 15 * time.Second
	defaultKeepAlive    = 15 * time.Second
	defaultUserTimeout  = 20 * time.Second
)

// DialerConfig configures the agent-side WebSocket dialer.
type DialerConfig struct {
	// URL is the gateway endpoint, for example wss://tunnel.<domain>/v1/connect.
	URL string
	// RootCAs is the tunnel CA bundle. System roots are never used: a nil pool
	// trusts nothing.
	RootCAs *x509.CertPool
	// PingInterval is the time between WebSocket pings (default 5s).
	PingInterval time.Duration
	// PingTimeout is how long to wait for a pong before the connection is
	// considered dead and closed (default 15s).
	PingTimeout time.Duration
	// KeepAlive is the TCP keepalive idle time and probe interval (default 15s).
	KeepAlive time.Duration
	// UserTimeout is TCP_USER_TIMEOUT, Linux only (default 20s).
	UserTimeout time.Duration
}

func (c DialerConfig) withDefaults() DialerConfig {
	if c.PingInterval <= 0 {
		c.PingInterval = defaultPingInterval
	}
	if c.PingTimeout <= 0 {
		c.PingTimeout = defaultPingTimeout
	}
	if c.KeepAlive <= 0 {
		c.KeepAlive = defaultKeepAlive
	}
	if c.UserTimeout <= 0 {
		c.UserTimeout = defaultUserTimeout
	}
	return c
}

// keepAliveConfig is the TCP keepalive setting shared by dialer and listener:
// the first probe after idle and every interval, three probes before giving up.
func keepAliveConfig(d time.Duration) net.KeepAliveConfig {
	return net.KeepAliveConfig{Enable: true, Idle: d, Interval: d, Count: 3}
}

type dialer struct {
	cfg    DialerConfig
	client *http.Client
}

// NewDialer returns a transport.Dialer that opens the tunnel over a WebSocket.
func NewDialer(cfg DialerConfig) transport.Dialer {
	cfg = cfg.withDefaults()
	roots := cfg.RootCAs
	if roots == nil {
		// An empty pool, not nil: nil would make crypto/tls fall back to system roots.
		roots = x509.NewCertPool()
	}
	var protocols http.Protocols
	protocols.SetHTTP1(true) // WebSocket upgrade is HTTP/1.1 only
	tr := &http.Transport{
		// No Proxy: the tunnel never goes through an environment proxy.
		DialContext: (&net.Dialer{
			Timeout:         10 * time.Second,
			KeepAliveConfig: keepAliveConfig(cfg.KeepAlive),
			Control:         userTimeoutControl(cfg.UserTimeout),
		}).DialContext,
		TLSClientConfig:     &tls.Config{RootCAs: roots, MinVersion: tls.VersionTLS13},
		TLSHandshakeTimeout: 10 * time.Second,
		Protocols:           &protocols,
		DisableKeepAlives:   true, // every Dial is a one-shot upgrade
	}
	return &dialer{
		cfg: cfg,
		client: &http.Client{
			Transport: tr,
			// A redirect is a refusal, not something to follow with credentials.
			CheckRedirect: func(*http.Request, []*http.Request) error { return http.ErrUseLastResponse },
		},
	}
}

// Dial opens the tunnel. The returned conn must be read continuously (the
// HTTP/2 layer does) so that pongs are processed. Do not set read or write
// deadlines on it: coder/websocket closes the connection when one expires.
func (d *dialer) Dial(ctx context.Context, hello transport.Hello) (net.Conn, transport.ConnInfo, error) {
	ws, resp, err := websocket.Dial(ctx, d.cfg.URL, &websocket.DialOptions{
		HTTPClient:   d.client,
		HTTPHeader:   hello.Header(),
		Subprotocols: []string{wire.Subprotocol},
	})
	if err != nil {
		if resp != nil && resp.StatusCode != http.StatusSwitchingProtocols {
			return nil, transport.ConnInfo{}, rejectFromResponse(resp)
		}
		return nil, transport.ConnInfo{}, fmt.Errorf("tunnel websocket dial: %w", err)
	}
	if ws.Subprotocol() != wire.Subprotocol {
		_ = ws.CloseNow()
		return nil, transport.ConnInfo{}, fmt.Errorf("tunnel websocket dial: gateway chose subprotocol %q, want %q", ws.Subprotocol(), wire.Subprotocol)
	}
	info, err := connInfoFromResponse(resp)
	if err != nil {
		_ = ws.CloseNow()
		return nil, transport.ConnInfo{}, err
	}

	// The dial ctx only bounds the handshake; the connection outlives it.
	nc := websocket.NetConn(context.Background(), ws, websocket.MessageBinary) //nolint:contextcheck // the conn outlives the dial ctx
	loopCtx, stop := context.WithCancel(context.Background())
	c := &conn{Conn: nc, ws: ws, stop: stop}
	go c.pingLoop(loopCtx, d.cfg.PingInterval, d.cfg.PingTimeout) //nolint:contextcheck // stopped by conn.Close
	return c, info, nil
}

// rejectFromResponse maps a non-101 response to a *transport.RejectError.
func rejectFromResponse(resp *http.Response) *transport.RejectError {
	rej := &transport.RejectError{Status: resp.StatusCode}
	// Only integer seconds are honoured; an HTTP-date is ignored.
	if secs, err := strconv.Atoi(strings.TrimSpace(resp.Header.Get("Retry-After"))); err == nil && secs > 0 {
		rej.RetryAfter = time.Duration(secs) * time.Second
	}
	if resp.Body != nil {
		b, _ := io.ReadAll(io.LimitReader(resp.Body, maxReasonLen))
		_ = resp.Body.Close()
		rej.Reason = strings.TrimSpace(string(b))
	}
	return rej
}

func connInfoFromResponse(resp *http.Response) (transport.ConnInfo, error) {
	epoch, err := strconv.ParseUint(resp.Header.Get(wire.HeaderConnEpoch), 10, 64)
	if err != nil {
		return transport.ConnInfo{}, fmt.Errorf("tunnel websocket dial: bad %s header: %w", wire.HeaderConnEpoch, err)
	}
	info := transport.ConnInfo{
		GatewayInstance: resp.Header.Get(wire.HeaderGatewayInstance),
		Epoch:           epoch,
		ConnID:          resp.Header.Get(wire.HeaderConnID),
	}
	if info.GatewayInstance == "" {
		return transport.ConnInfo{}, fmt.Errorf("tunnel websocket dial: missing %s header", wire.HeaderGatewayInstance)
	}
	return info, nil
}

// conn is the agent-side tunnel connection: the WebSocket net.Conn plus the
// ping loop that closes it when the peer stops answering.
type conn struct {
	net.Conn
	ws   *websocket.Conn
	stop context.CancelFunc

	closeOnce sync.Once
	closeErr  error
}

// Close stops the ping loop and closes the WebSocket without a close
// handshake, so it never blocks on an unresponsive peer.
func (c *conn) Close() error {
	c.closeOnce.Do(func() {
		c.stop()
		// CloseNow first: it drops the TCP connection and unblocks pending
		// reads. The netConn Close that follows only releases its timers.
		_ = c.ws.CloseNow()
		if err := c.Conn.Close(); err != nil && !errors.Is(err, net.ErrClosed) {
			c.closeErr = err
		}
	})
	return c.closeErr
}

// pingLoop pings every interval and closes the connection when a pong does not
// arrive within timeout. It returns when ctx is cancelled (by Close) or the
// connection is dead.
func (c *conn) pingLoop(ctx context.Context, interval, timeout time.Duration) {
	t := time.NewTicker(interval)
	defer t.Stop()
	for {
		select {
		case <-ctx.Done():
			return
		case <-t.C:
		}
		pctx, cancel := context.WithTimeout(ctx, timeout)
		err := c.ws.Ping(pctx)
		cancel()
		if err != nil {
			if ctx.Err() == nil {
				_ = c.Close()
			}
			return
		}
	}
}
