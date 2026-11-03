// Package httpproxy is the public HTTP proxy of published ports (spec 7):
// http(s)://<slug>-<port>.<umiak-domain> → limits, host, reserved /__umiak/ paths,
// route, sandbox state, access check, the header policy and the stream to
// the application, with an access log line and metrics per request.
package httpproxy

import (
	"context"
	"errors"
	"log"
	"log/slog"
	"net"
	"net/http"
	"net/http/httptrace"
	"net/http/httputil"
	"net/netip"
	"strconv"
	"strings"
	"time"

	"github.com/belov38/umiak/services/gateway/internal/cpapi"
	"github.com/belov38/umiak/services/gateway/internal/obs"
	"github.com/belov38/umiak/services/gateway/internal/portauth"
	"github.com/belov38/umiak/services/gateway/internal/ratelimit"
	"github.com/belov38/umiak/services/gateway/internal/routes"
	"github.com/belov38/umiak/services/gateway/internal/upstream"
)

const accessPublic = "public"

// Config configures the proxy. Metrics and AccessLog may be nil.
type Config struct {
	UmiakDomain   string
	PreviewScheme string
	PreviewPort   int
	Grammar       routes.Grammar
	Routes        *routes.Cache
	Auth          *portauth.Auth
	Limits        *ratelimit.Limits
	Upstream      *upstream.Dialer
	Transports    *upstream.AppTransports
	// TrustedProxies are the peers whose X-Forwarded-For is believed
	// (plain mode behind an ingress, spec 5.2). They are ignored for
	// requests that arrived over TLS: the gateway is the edge there.
	TrustedProxies      []netip.Prefix
	StripCookiePrefixes []string
	Metrics             *obs.Metrics
	AccessLog           *obs.AccessLog
	// Streams tracks the long streams for the drain; nil gets a new one.
	Streams *StreamTracker
	// Desktop serves the desktop kind (S10). nil: desktop labels are 404.
	// It is called after the route and state checks, without the port
	// access check.
	Desktop http.Handler
	// DesktopAPI exchanges tickets and starts the paired streamer.
	DesktopAPI cpapi.DesktopClient
	// Logger gets the internal details of failures; nil is slog.Default.
	Logger *slog.Logger
}

type handler struct {
	cfg    Config
	log    *slog.Logger
	errLog *log.Logger
}

// New returns the proxy handler.
func New(cfg Config) http.Handler {
	if cfg.PreviewScheme == "" {
		cfg.PreviewScheme = "https"
	}
	if cfg.PreviewPort == 0 {
		cfg.PreviewPort = 443
		if cfg.PreviewScheme == "http" {
			cfg.PreviewPort = 80
		}
	}
	if cfg.Streams == nil {
		cfg.Streams = NewStreamTracker()
	}
	if cfg.Logger == nil {
		cfg.Logger = slog.Default()
	}
	return &handler{
		cfg:    cfg,
		log:    cfg.Logger,
		errLog: slog.NewLogLogger(cfg.Logger.Handler(), slog.LevelDebug),
	}
}

func (h *handler) ServeHTTP(w http.ResponseWriter, r *http.Request) {
	// A per-request cancel lets the drain end a long response.
	ctx, cancel := context.WithCancel(r.Context())
	defer cancel()
	r = r.WithContext(ctx)

	x := &exchange{h: h, start: time.Now(), r: r, cancel: cancel}
	x.rid = requestID(r.Header.Get("X-Request-Id"))
	trusted := h.cfg.TrustedProxies
	if r.TLS != nil {
		trusted = nil
	}
	x.ip = ClientIP(r, trusted)
	x.w = &recorder{rw: w, start: x.start, in: &x.in, onHijack: func(c net.Conn) { x.track(c) }}
	if r.Body != nil && r.Body != http.NoBody {
		r.Body = &countingBody{ReadCloser: r.Body, n: &x.in}
	}
	// Answers written by portauth carry the id too.
	x.w.Header().Set("X-Request-Id", x.rid)
	defer x.finish()

	h.serve(x, trusted) //nolint:contextcheck // the request context travels in x.r
}

// serve runs the pipeline of spec 7.1.
func (h *handler) serve(x *exchange, trusted []netip.Prefix) {
	r := x.r
	// Per-IP limit first; the label bucket only once a route exists, so
	// random hosts cannot create buckets.
	if ok, _, wait := h.cfg.Limits.AllowRequest(x.ip, ""); !ok {
		x.fail(rateLimited(wait))
		return
	}
	l, ok := routes.ParseHost(r.Host, h.cfg.UmiakDomain, h.cfg.Grammar)
	if _, port, err := net.SplitHostPort(r.Host); err == nil && port != strconv.Itoa(h.cfg.PreviewPort) {
		ok = false
	}
	if !ok {
		x.fail(notFound())
		return
	}
	x.label = l
	desktop := l.Kind == routes.KindDesktop
	if desktop && h.cfg.Desktop == nil && h.cfg.DesktopAPI == nil {
		x.fail(notFound())
		return
	}

	reserved := strings.HasPrefix(r.URL.Path, portauth.ReservedPrefix)
	rt, err := h.cfg.Routes.Get(r.Context(), l)
	switch {
	case err == nil:
		x.route = &rt
	case errors.Is(err, cpapi.ErrRouteNotFound):
		if !reserved {
			x.fail(notFound())
			return
		}
	case r.Context().Err() != nil:
		x.clientGone = true
		return
	default:
		x.fail(lookupUnavailable())
		return
	}
	if reserved {
		// The gateway's own endpoints: never proxied (spec 8.4).
		h.cfg.Auth.ServeReserved(x.w, r, l, x.route, x.ip, x.rid)
		return
	}

	if ok, wait := h.cfg.Limits.AllowLabel(l.Raw); !ok {
		x.fail(rateLimited(wait))
		return
	}
	if ok, e := routes.Decide(rt); !ok {
		x.fail(e)
		return
	}
	if desktop != (rt.Kind == cpapi.KindDesktop) {
		x.fail(notFound())
		return
	}
	if desktop && h.cfg.Desktop != nil {
		h.cfg.Desktop.ServeHTTP(x.w, r)
		return
	}

	// A preflight skips the access check (spec 8.5), but never one that asks
	// for an upgrade: that would open a raw channel without authorization.
	var auth portauth.Result
	preflight := !desktop && portauth.IsPreflight(r) && !hasUpgrade(r.Header)
	if desktop {
		if rt.Port != 47800 || rt.AppProtocol != "http1" {
			x.fail(notFound())
			return
		}
		auth = h.cfg.Auth.CheckDesktop(x.w, r, l, rt, x.ip, x.rid, h.cfg.DesktopAPI)
		if !auth.Proceed {
			return
		}
		if auth.SetCookie != nil {
			x.w.Header().Add("Set-Cookie", auth.SetCookie.String())
			auth.SetCookie = nil
		}
		if h.desktopOpen(x) {
			return
		}
	} else if rt.Access != accessPublic && !preflight {
		auth = h.cfg.Auth.Check(x.w, r, l, rt, x.ip, x.rid)
		x.authResult, x.userID = auth.AuthResult, auth.UserID
		if !auth.Proceed {
			return
		}
	}

	// Only a WebSocket upgrade on GET is forwarded (spec 7.3). Any other
	// upgrade (h2c, custom tokens) is dropped and the request proxied as a
	// plain one, so a lenient app cannot be switched to another protocol.
	if up := upgradeType(r.Header); up != "" {
		if !strings.EqualFold(up, "websocket") || r.Method != http.MethodGet {
			dropUpgrade(r.Header)
		} else {
			if rt.AppProtocol == upstream.AppProtocolH2C {
				// HTTP/2 has no Upgrade; ReverseProxy cannot bridge it.
				x.fail(upstreamError())
				return
			}
			x.upgrade = "websocket"
		}
	}

	// Not connected or unknown (ok false, also when the registry fails)
	// still proxies with epoch 0: the dial then resolves the owner itself,
	// waits for the agent (spec 6.4) and maps its own errors. The only
	// error is the client's own cancellation.
	epoch, _, err := h.cfg.Upstream.Epoch(r.Context(), rt.MachineID)
	if err != nil {
		x.clientGone = true
		return
	}
	h.proxy(x, rt, auth, upstream.SyntheticHost(rt.MachineID, epoch, rt.Port), trusted)
}

func (h *handler) proxy(x *exchange, rt cpapi.Route, auth portauth.Result, target string, trusted []netip.Prefix) {
	// ReverseProxy adds the app's headers to the writer's and clears the
	// writer's headers after a 1xx; the id is set on the app's response
	// in ModifyResponse and on errors in fail instead.
	x.w.Header().Del("X-Request-Id")
	rp := &httputil.ReverseProxy{
		Rewrite: func(pr *httputil.ProxyRequest) {
			h.rewrite(x, pr, rt, auth, target, trusted)
		},
		Transport:     h.cfg.Transports.For(rt.AppProtocol),
		FlushInterval: -1,
		ModifyResponse: func(res *http.Response) error {
			return h.modifyResponse(x, res, auth.SetCookie)
		},
		ErrorHandler: func(_ http.ResponseWriter, _ *http.Request, err error) {
			h.proxyError(x, err)
		},
		ErrorLog: h.errLog,
	}
	rp.ServeHTTP(x.w, x.r)
}

// rewrite builds the request to the application (spec 7.4). ReverseProxy
// has already removed the hop-by-hop headers, Forwarded and
// X-Forwarded-{For,Host,Proto}.
func (h *handler) rewrite(x *exchange, pr *httputil.ProxyRequest, rt cpapi.Route, auth portauth.Result, target string, trusted []netip.Prefix) {
	in, out := pr.In, pr.Out
	out.URL.Scheme = "http"
	out.URL.Host = target
	out.Host = in.Host
	if rt.HostRewrite == "localhost" {
		out.Host = "localhost:" + strconv.Itoa(int(rt.Port))
	}

	hd := out.Header
	portauth.StripRequest(hd, out.URL, h.cfg.StripCookiePrefixes)
	stripRequestHeaders(hd)
	if xff := forwardedFor(in, trusted); xff != "" {
		hd.Set("X-Forwarded-For", xff)
	}
	hd.Set("X-Forwarded-Proto", h.cfg.PreviewScheme)
	hd.Set("X-Forwarded-Host", in.Host)
	hd.Set("X-Forwarded-Port", strconv.Itoa(h.cfg.PreviewPort))
	hd.Set("Forwarded", forwardedHeader(x.ip, in.Host, h.cfg.PreviewScheme))
	hd.Set("X-Request-Id", x.rid)
	if rt.Kind == cpapi.KindDesktop {
		hd.Set("X-Umiak-Desktop-User", "umiak")
		q := out.URL.Query()
		q.Del("_ticket")
		out.URL.RawQuery = q.Encode()
	}
	if rt.Access == portauth.AccessSSO && auth.Email != "" {
		hd.Set("X-Umiak-User-Email", auth.Email)
	}

	trace := &httptrace.ClientTrace{GotConn: func(info httptrace.GotConnInfo) { x.gotConn(info.Conn) }}
	pr.Out = out.WithContext(httptrace.WithClientTrace(out.Context(), trace))
}

// errAmbiguousFraming refuses an application response whose head carried
// both Content-Length and Transfer-Encoding.
var errAmbiguousFraming = errors.New("httpproxy: application response with both Content-Length and Transfer-Encoding")

// errHeaderBlockTooLarge refuses an application response whose header block
// is over maxHeaderBytes as HTTP/2 would carry it.
var errHeaderBlockTooLarge = errors.New("httpproxy: application response header block over the limit")

// modifyResponse applies the response policy (spec 7.4) and registers long
// streams. An error makes the answer 502 upstream_error.
func (h *handler) modifyResponse(x *exchange, res *http.Response, setCookie *http.Cookie) error {
	if x.ambiguousFraming() {
		// RFC 9112 6.3: Content-Length with Transfer-Encoding may be an
		// attempt at response smuggling. net/http has already framed the
		// body as chunked; refuse it, and the transport drops the conn
		// because the body is closed unread.
		h.log.Warn("httpproxy: response with both Content-Length and Transfer-Encoding refused",
			"label", x.label.Raw, "request_id", x.rid)
		return errAmbiguousFraming
	}
	if n := responseBlockSize(res); n > maxHeaderBytes {
		h.log.Warn("httpproxy: response header block over the limit",
			"label", x.label.Raw, "request_id", x.rid, "bytes", n, "limit", maxHeaderBytes)
		return errHeaderBlockTooLarge
	}
	cleanResponseHeader(res.Header)
	res.Header.Set("X-Robots-Tag", robotsTag)
	if x.route != nil && x.route.Kind == cpapi.KindDesktop {
		res.Header.Set("Cache-Control", "no-store")
		res.Header.Set("Referrer-Policy", "no-referrer")
	}
	res.Header.Set("X-Request-Id", x.rid)
	if setCookie != nil {
		if v := setCookie.String(); v != "" {
			res.Header.Add("Set-Cookie", v)
		}
	}
	// Declared trailers: ReverseProxy announces res.Trailer's keys.
	for k := range res.Trailer {
		if strippedTrailer(k) {
			delete(res.Trailer, k)
		}
	}
	if res.StatusCode == http.StatusSwitchingProtocols {
		// The body is the upgraded conn; Hijack tracks the stream.
		return nil
	}
	if res.Body != nil && res.Body != http.NoBody {
		res.Body = &trailerGuard{ReadCloser: res.Body, res: res, dropped: func() {
			h.log.Warn("httpproxy: response trailers over the limit dropped",
				"label", x.label.Raw, "request_id", x.rid)
		}}
	}
	if longResponse(res) {
		x.track(closerFunc(x.cancel))
	}
	return nil
}

// proxyError answers a failed round trip. When the client is gone nothing
// is written and the access log says 499.
func (h *handler) proxyError(x *exchange, err error) {
	if x.r.Context().Err() != nil {
		x.clientGone = true
		h.log.Debug("httpproxy: request ended by the client", "label", x.label.Raw, "request_id", x.rid, "err", err)
		return
	}
	e := mapProxyError(err)
	h.log.Debug("httpproxy: upstream failed", "label", x.label.Raw, "request_id", x.rid, "code", e.Code, "err", err)
	x.fail(e)
}
