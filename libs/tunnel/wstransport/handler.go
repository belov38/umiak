package wstransport

import (
	"context"
	"errors"
	"log/slog"
	"net"
	"net/http"
	"strconv"
	"strings"
	"time"

	"github.com/coder/websocket"

	"github.com/belov38/boat-dev-clone/libs/tunnel/transport"
	"github.com/belov38/boat-dev-clone/libs/tunnel/wire"
)

// HandlerOptions configures the gateway-side upgrade handler.
type HandlerOptions struct {
	// Subprotocols are the accepted WebSocket subprotocols, in order of
	// preference. Default: [wire.Subprotocol].
	Subprotocols []string
}

type handler struct {
	adm    transport.Admitter
	protos []string
}

// NewHandler returns the http.Handler for the tunnel upgrade endpoint
// (wire.ConnectPath). It parses the Hello, asks adm to admit the connection,
// completes the WebSocket upgrade and hands the resulting net.Conn to the
// Admission.
func NewHandler(adm transport.Admitter, opts HandlerOptions) http.Handler {
	protos := opts.Subprotocols
	if len(protos) == 0 {
		protos = []string{wire.Subprotocol}
	}
	return &handler{adm: adm, protos: append([]string(nil), protos...)}
}

func (h *handler) ServeHTTP(w http.ResponseWriter, r *http.Request) {
	proto, ok := h.negotiate(r)
	if !ok {
		http.Error(w, "unsupported subprotocol, want "+strings.Join(h.protos, ", "), http.StatusUpgradeRequired)
		return
	}
	hello, err := transport.ParseHello(r.Header)
	if err != nil {
		writeError(w, err)
		return
	}
	hello.ProtoVersion = proto

	adm, err := h.adm.Admit(r.Context(), hello)
	if err != nil {
		writeError(w, err)
		return
	}

	// Headers set before Accept become part of the 101 response.
	info := adm.Info()
	w.Header().Set(wire.HeaderGatewayInstance, info.GatewayInstance)
	w.Header().Set(wire.HeaderConnEpoch, strconv.FormatUint(info.Epoch, 10))
	w.Header().Set(wire.HeaderConnID, info.ConnID)

	ws, err := websocket.Accept(w, r, &websocket.AcceptOptions{Subprotocols: []string{proto}})
	if err != nil {
		// Accept has already written the error response.
		adm.Abort(err)
		return
	}
	// The conn outlives this handler (and r.Context()), so it gets its own context.
	adm.Serve(websocket.NetConn(context.Background(), ws, websocket.MessageBinary)) //nolint:contextcheck // the conn outlives the request
}

// negotiate returns the first accepted subprotocol that the client offered.
func (h *handler) negotiate(r *http.Request) (string, bool) {
	var offered []string
	for _, v := range r.Header.Values("Sec-WebSocket-Protocol") {
		for p := range strings.SplitSeq(v, ",") {
			offered = append(offered, strings.TrimSpace(p))
		}
	}
	for _, want := range h.protos {
		for _, got := range offered {
			if strings.EqualFold(want, got) {
				return want, true
			}
		}
	}
	return "", false
}

// writeError answers a refused upgrade. Only *transport.RejectError text is
// sent to the client; anything else is logged and reported as a plain 500.
func writeError(w http.ResponseWriter, err error) {
	var rej *transport.RejectError
	if !errors.As(err, &rej) {
		slog.Error("tunnel admit failed", "err", err)
		http.Error(w, "internal error", http.StatusInternalServerError)
		return
	}
	if rej.RetryAfter > 0 {
		secs := max(1, int64((rej.RetryAfter+time.Second-1)/time.Second))
		w.Header().Set("Retry-After", strconv.FormatInt(secs, 10))
	}
	http.Error(w, rej.Reason, rej.Status)
}

// ListenConfig returns a net.ListenConfig for the tunnel listener with TCP
// keepalive enabled (idle and interval keepAlive, three probes) and, on Linux,
// TCP_USER_TIMEOUT set to userTimeout. Sockets accepted from the listener
// inherit the options.
func ListenConfig(keepAlive, userTimeout time.Duration) *net.ListenConfig {
	return &net.ListenConfig{
		KeepAliveConfig: keepAliveConfig(keepAlive),
		Control:         userTimeoutControl(userTimeout),
	}
}
