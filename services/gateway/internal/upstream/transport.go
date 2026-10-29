package upstream

import (
	"context"
	"fmt"
	"net"
	"net/http"
	"strconv"
	"strings"
	"time"

	"github.com/google/uuid"

	"github.com/belov38/boat-dev-clone/libs/tunnel/h2"
)

// Synthetic host grammar: m-<machineId>-e<epoch>-<port>.sbx.internal.
const (
	hostPrefix = "m-"
	hostSuffix = ".sbx.internal"
	uuidLen    = 36
)

// Defaults of TransportConfig.
const (
	defaultMaxIdlePerHost         = 8
	defaultIdleConnTimeout        = 30 * time.Second
	defaultMaxResponseHeaderBytes = 64 << 10
)

// AppProtocolH2C is the route appProtocol of cleartext HTTP/2 applications.
const AppProtocolH2C = "h2c"

// SyntheticHost returns the host of a request to port of a machine whose
// tunnel has the given epoch. http.Transport pools keep-alive conns per
// host, so each (machine, epoch, port) gets its own pool, and a new epoch
// never reuses a conn of the old tunnel (spec 7.2).
func SyntheticHost(machineID string, epoch uint64, port uint16) string {
	return hostPrefix + machineID + "-e" + strconv.FormatUint(epoch, 10) + "-" + strconv.FormatUint(uint64(port), 10) + hostSuffix
}

// parseSyntheticHost parses the DialContext address "<SyntheticHost>:80".
// Anything else, including non-canonical numbers or a non-canonical UUID,
// is refused.
func parseSyntheticHost(addr string) (machineID string, epoch uint64, port uint16, ok bool) {
	host, p, err := net.SplitHostPort(addr)
	if err != nil || p != "80" {
		return "", 0, 0, false
	}
	rest, found := strings.CutPrefix(host, hostPrefix)
	if !found {
		return "", 0, 0, false
	}
	rest, found = strings.CutSuffix(rest, hostSuffix)
	if !found || len(rest) < uuidLen {
		return "", 0, 0, false
	}
	id := rest[:uuidLen]
	if u, err := uuid.Parse(id); err != nil || u.String() != id {
		return "", 0, 0, false
	}
	rest, found = strings.CutPrefix(rest[uuidLen:], "-e")
	if !found {
		return "", 0, 0, false
	}
	es, ps, found := strings.Cut(rest, "-")
	if !found {
		return "", 0, 0, false
	}
	e, err := strconv.ParseUint(es, 10, 64)
	if err != nil || strconv.FormatUint(e, 10) != es {
		return "", 0, 0, false
	}
	pn, err := strconv.ParseUint(ps, 10, 16)
	if err != nil || pn == 0 || strconv.FormatUint(pn, 10) != ps {
		return "", 0, 0, false
	}
	return id, e, uint16(pn), true
}

// TransportConfig configures the application transports.
type TransportConfig struct {
	// HTTPDrain is the drain deadline of HTTP streams (2 min).
	HTTPDrain time.Duration
	// ResponseHeaderTimeout bounds the wait for the application's response
	// headers (5 min).
	ResponseHeaderTimeout time.Duration
	// StreamIdle closes a stream without a byte either way (60 min).
	StreamIdle time.Duration
	// MaxIdlePerHost is the keep-alive pool size per synthetic host (8).
	MaxIdlePerHost int
	// IdleConnTimeout closes pooled conns (30 s).
	IdleConnTimeout time.Duration
	// MaxResponseHeaderBytes caps the response header block (64 KiB).
	MaxResponseHeaderBytes int64
}

// AppTransports are the HTTP transports to applications: HTTP/1.1, and
// prior-knowledge cleartext HTTP/2 for appProtocol h2c. Both dial through
// the Dialer, never compress, use no proxy and no TLS.
type AppTransports struct {
	http1 *http.Transport
	h2c   *http.Transport
}

// NewAppTransports returns the transports over d.
func NewAppTransports(d *Dialer, cfg TransportConfig) *AppTransports {
	if cfg.MaxIdlePerHost <= 0 {
		cfg.MaxIdlePerHost = defaultMaxIdlePerHost
	}
	if cfg.IdleConnTimeout <= 0 {
		cfg.IdleConnTimeout = defaultIdleConnTimeout
	}
	if cfg.MaxResponseHeaderBytes <= 0 {
		cfg.MaxResponseHeaderBytes = defaultMaxResponseHeaderBytes
	}
	dialContext := func(ctx context.Context, _, addr string) (net.Conn, error) {
		id, _, port, ok := parseSyntheticHost(addr)
		if !ok {
			return nil, fmt.Errorf("upstream: not a synthetic application host: %q", addr)
		}
		c, err := d.Dial(ctx, id, port, cfg.HTTPDrain)
		if err != nil {
			return nil, err
		}
		c.SetIdleTimeout(cfg.StreamIdle)
		return c, nil
	}
	newTransport := func(p *http.Protocols) *http.Transport {
		return &http.Transport{
			Proxy:                  nil,
			DialContext:            dialContext,
			Protocols:              p,
			ForceAttemptHTTP2:      false,
			DisableCompression:     true,
			MaxIdleConnsPerHost:    cfg.MaxIdlePerHost,
			IdleConnTimeout:        cfg.IdleConnTimeout,
			ResponseHeaderTimeout:  cfg.ResponseHeaderTimeout,
			MaxResponseHeaderBytes: cfg.MaxResponseHeaderBytes,
		}
	}

	var p1 http.Protocols
	p1.SetHTTP1(true)
	var p2 http.Protocols
	p2.SetUnencryptedHTTP2(true)
	h2cT := newTransport(&p2)
	// Receive windows like the tunnel's own streams: larger ones would not
	// help, the tunnel stream below has the same window.
	def := h2.DefaultClientConfig()
	h2cT.HTTP2 = &http.HTTP2Config{
		MaxReceiveBufferPerStream:     def.StreamWindow,
		MaxReceiveBufferPerConnection: def.ConnWindow,
		MaxReadFrameSize:              def.MaxFrame,
	}
	return &AppTransports{http1: newTransport(&p1), h2c: h2cT}
}

// For returns the transport of a route's appProtocol: h2c, else HTTP/1.1.
func (a *AppTransports) For(appProtocol string) http.RoundTripper {
	if appProtocol == AppProtocolH2C {
		return a.h2c
	}
	return a.http1
}

// CloseIdleConnections closes the pooled conns of both transports.
func (a *AppTransports) CloseIdleConnections() {
	a.http1.CloseIdleConnections()
	a.h2c.CloseIdleConnections()
}
