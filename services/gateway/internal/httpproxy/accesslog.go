package httpproxy

import (
	"crypto/rand"
	"encoding/binary"
	"net"
	"net/http"
	"net/netip"
	"strconv"
	"sync"
	"sync/atomic"
	"time"

	"github.com/belov38/boat-dev-clone/services/gateway/internal/cpapi"
	"github.com/belov38/boat-dev-clone/services/gateway/internal/obs"
	"github.com/belov38/boat-dev-clone/services/gateway/internal/routes"
	"github.com/belov38/boat-dev-clone/services/gateway/internal/sbxerr"
	"github.com/belov38/boat-dev-clone/services/gateway/internal/upstream"
)

const (
	// maxLogField caps client-controlled access log fields (host, method,
	// path, userAgent).
	maxLogField = 512
	// maxRequestID is the longest client X-Request-Id kept (spec 7.4).
	maxRequestID = 128
	// statusClientGone is logged when the client left before an answer.
	statusClientGone = 499
	// noneLabel is the metric label value of an unknown access or via.
	noneLabel = "none"
)

// exchange is the state of one request: what the access log line and the
// metrics need, collected along the pipeline.
type exchange struct {
	h      *handler
	start  time.Time
	r      *http.Request
	w      *recorder
	cancel func()
	rid    string
	ip     netip.Addr

	label      routes.Label
	route      *cpapi.Route
	authResult string
	userID     string
	upgrade    string
	clientGone bool
	streams    []func()

	in atomic.Int64

	mu    sync.Mutex // guards via and owner, set from a transport hook
	via   string
	owner string
}

// gotConn records where the application stream runs. For h2c the transport
// reports the conn wrapped in a fake *tls.Conn, so wrappers are peeled.
func (x *exchange) gotConn(c net.Conn) {
	for range 4 {
		switch t := c.(type) {
		case *upstream.Conn:
			x.mu.Lock()
			x.via, x.owner = t.Via, t.OwnerInstance
			x.mu.Unlock()
			return
		case interface{ UnencryptedNetConn() net.Conn }:
			c = t.UnencryptedNetConn()
		case interface{ NetConn() net.Conn }:
			c = t.NetConn()
		default:
			return
		}
	}
}

// track registers a long stream with the tracker and the active gauge until
// the request ends.
func (x *exchange) track(c interface{ Close() error }) {
	done := x.h.cfg.Streams.Track(c)
	m := x.h.cfg.Metrics
	if m != nil {
		m.HTTPActiveStreams.Inc()
	}
	x.streams = append(x.streams, func() {
		done()
		if m != nil {
			m.HTTPActiveStreams.Dec()
		}
	})
}

// fail writes a gateway answer unless something was written already.
func (x *exchange) fail(e sbxerr.Error) {
	if x.w.status != 0 || x.w.hijacked {
		return
	}
	e.RequestID = x.rid
	x.w.Header().Set("X-Request-Id", x.rid)
	sbxerr.Write(x.w, x.r, e)
}

// finish writes the access log line and the metrics. It runs when the
// handler returns, so a long stream is logged when it closes.
func (x *exchange) finish() {
	for _, done := range x.streams {
		done()
	}
	dur := time.Since(x.start)
	status, ttfb := x.w.status, x.w.ttfb
	switch {
	case status == 0 && x.clientGone:
		status, ttfb = statusClientGone, dur
	case status == 0:
		// The server answers 200 to a handler that wrote nothing.
		status, ttfb = http.StatusOK, dur
	}
	access := noneLabel
	e := obs.HTTPEntry{
		Time:       x.start,
		RequestID:  x.rid,
		ClientIP:   addrString(x.ip),
		Host:       capField(x.r.Host),
		Label:      x.label.Raw,
		Method:     capField(x.r.Method),
		Path:       capField(x.r.URL.Path),
		Status:     status,
		SbxError:   x.w.sbxError,
		BytesIn:    x.in.Load(),
		BytesOut:   x.w.out.Load(),
		DurationMs: dur.Milliseconds(),
		TTFBMs:     ttfb.Milliseconds(),
		AuthResult: x.authResult,
		UserID:     x.userID,
		Upgrade:    x.upgrade,
		UserAgent:  capField(x.r.UserAgent()),
	}
	if rt := x.route; rt != nil {
		access = rt.Access
		e.SandboxID, e.MachineID, e.Port, e.Access = rt.SandboxID, rt.MachineID, int(rt.Port), rt.Access
	}
	x.mu.Lock()
	e.Via, e.OwnerInstance = x.via, x.owner
	x.mu.Unlock()
	via := e.Via
	if via == "" {
		via = noneLabel
	}
	if access == "" {
		access = noneLabel
	}

	if m := x.h.cfg.Metrics; m != nil {
		m.HTTPRequests.WithLabelValues(access, codeClass(status), e.SbxError, via).Inc()
		m.HTTPDuration.WithLabelValues(access, via).Observe(ttfb.Seconds())
		m.HTTPBytes.WithLabelValues("in").Add(float64(e.BytesIn))
		m.HTTPBytes.WithLabelValues("out").Add(float64(e.BytesOut))
	}
	if l := x.h.cfg.AccessLog; l != nil {
		l.HTTP(e)
	}
}

func codeClass(status int) string {
	return strconv.Itoa(status/100) + "xx"
}

func addrString(a netip.Addr) string {
	if !a.IsValid() {
		return ""
	}
	return a.String()
}

func capField(s string) string {
	if len(s) > maxLogField {
		return s[:maxLogField]
	}
	return s
}

// requestID returns the client's X-Request-Id when it is 1-128 printable
// ASCII characters, else a new ULID (spec 7.4).
func requestID(v string) string {
	if len(v) == 0 || len(v) > maxRequestID {
		return newULID()
	}
	for i := range len(v) {
		if v[i] < 0x20 || v[i] > 0x7e {
			return newULID()
		}
	}
	return v
}

// crockford is the ULID alphabet.
const crockford = "0123456789ABCDEFGHJKMNPQRSTVWXYZ"

// newULID returns a ULID: 48 bits of Unix milliseconds and 80 random bits,
// 26 Crockford base32 characters.
func newULID() string {
	var b [16]byte
	ms := uint64(time.Now().UnixMilli())
	binary.BigEndian.PutUint16(b[0:2], uint16(ms>>32))
	binary.BigEndian.PutUint32(b[2:6], uint32(ms))
	_, _ = rand.Read(b[6:])
	hi, lo := binary.BigEndian.Uint64(b[:8]), binary.BigEndian.Uint64(b[8:])
	var out [26]byte
	for i := len(out) - 1; i >= 0; i-- {
		out[i] = crockford[lo&31]
		lo = lo>>5 | hi<<59
		hi >>= 5
	}
	return string(out[:])
}
