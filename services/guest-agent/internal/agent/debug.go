package agent

// The debug socket is a test and QGA aid, not a production interface:
// `sbx-agent run --debug-listen unix:<path>` serves the agent mux (the same
// handler the tunnel serves), sbx.tunnel.v1.Control/Info and a read-only
// sbx.tunnel.v1.Events/Subscribe on a local unix socket, over HTTP/1.1 or
// h2c, without the tunnel library. It lets tests drive the agent and read
// its journal without a gateway. Events/Ack is not served, so a debug
// client never drops events the gateway has not seen.
//
// A Control/Info call on the socket is not the gateway's Control/Info: it does
// not count toward the update confirmation (spec 17.4 step 6) unless the flag
// --debug-confirm is set, which lets the debug Info alone confirm a pending
// update without a tunnel connection.

import (
	"context"
	"fmt"
	"net"
	"net/http"
	"os"
	"path/filepath"
	"slices"
	"strings"
	"time"

	"connectrpc.com/connect"

	tunnelv1 "github.com/belov38/boat-dev-clone/libs/proto/sbx/tunnel/v1"
	"github.com/belov38/boat-dev-clone/libs/proto/sbx/tunnel/v1/tunnelv1connect"
)

// tunnelPackage is the proto package of the tunnel control API.
const tunnelPackage = "sbx.tunnel.v1"

// debugShutdown bounds the wait for in-flight debug requests at shutdown.
// Streaming calls (Attach) do not end on their own and hold it to the bound.
const debugShutdown = 3 * time.Second

// startDebug starts the debug socket server. The socket is 0600 and removed
// when ctx ends. At shutdown the server stops accepting and waits (bounded)
// for in-flight requests, so they finish before the store closes.
func (a *agent) startDebug(ctx context.Context) error {
	path, ok := strings.CutPrefix(a.d.DebugListen, "unix:")
	if !ok || path == "" {
		return fmt.Errorf("agent: --debug-listen %q: want unix:<path>", a.d.DebugListen)
	}
	ln, err := listenPrivate(ctx, path)
	if err != nil {
		return err
	}
	a.log.Warn("agent: debug socket enabled (test aid)", "path", path, "debug_confirm", a.d.DebugConfirm)
	a.serveLocal(ctx, ln, path, a.apiHandler())
	return nil
}

// apiHandler is the handler of the debug and admin sockets: the agent mux,
// Control/Info and a read-only Events/Subscribe.
func (a *agent) apiHandler() http.Handler {
	ctlPath, ctl := tunnelv1connect.NewControlHandler(debugControl{a: a})
	evPath, ev := tunnelv1connect.NewEventsHandler(debugEvents{a: a})
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		switch {
		case strings.HasPrefix(r.URL.Path, ctlPath):
			ctl.ServeHTTP(w, r)
		case strings.HasPrefix(r.URL.Path, evPath):
			ev.ServeHTTP(w, r)
		default:
			a.mux.ServeHTTP(w, r)
		}
	})
}

// serveLocal serves h on the local socket ln (HTTP/1.1 and h2c) until ctx
// ends; then it stops accepting, waits (bounded) for in-flight requests and
// removes the socket file at path.
func (a *agent) serveLocal(ctx context.Context, ln net.Listener, path string, h http.Handler) {
	var protos http.Protocols
	protos.SetHTTP1(true)
	protos.SetUnencryptedHTTP2(true)
	srv := &http.Server{Handler: h, Protocols: &protos, ReadHeaderTimeout: 10 * time.Second}
	a.goBG(func() { _ = srv.Serve(ln) })
	a.goBG(func() {
		<-ctx.Done()
		sctx, cancel := context.WithTimeout(context.Background(), debugShutdown)
		defer cancel()
		if err := srv.Shutdown(sctx); err != nil { //nolint:contextcheck // runs after the run context ended
			_ = srv.Close()
		}
		_ = os.Remove(path)
	})
}

// listenPrivate listens on a unix socket at path that nobody but the owner
// can connect to at any moment: the socket is created in a fresh 0700
// directory next to path, made 0600 (on Windows given the DACL of the admin
// socket) and only then renamed into place.
func listenPrivate(ctx context.Context, path string) (net.Listener, error) {
	dir, err := os.MkdirTemp(filepath.Dir(path), ".sbx-debug-")
	if err != nil {
		return nil, fmt.Errorf("agent: debug socket dir: %w", err)
	}
	defer func() { _ = os.RemoveAll(dir) }()
	tmp := filepath.Join(dir, "s")
	var lc net.ListenConfig
	ln, err := lc.Listen(ctx, "unix", tmp)
	if err != nil {
		return nil, fmt.Errorf("agent: debug listen: %w", err)
	}
	// The listener must not unlink tmp on close; the caller removes path.
	if ul, ok := ln.(*net.UnixListener); ok {
		ul.SetUnlinkOnClose(false)
	}
	_ = os.Remove(path) // a socket left by a killed run
	err = secureSocket(tmp, socketAdmin, "")
	if err == nil {
		err = os.Rename(tmp, path)
	}
	if err != nil {
		_ = ln.Close()
		return nil, fmt.Errorf("agent: debug socket: %w", err)
	}
	return ln, nil
}

// debugControl serves Control/Info on the debug socket; SetToken and Drain
// are unimplemented.
type debugControl struct {
	tunnelv1connect.UnimplementedControlHandler
	a *agent
}

// Info implements tunnelv1connect.ControlHandler.
func (c debugControl) Info(context.Context, *connect.Request[tunnelv1.InfoRequest]) (*connect.Response[tunnelv1.InfoResponse], error) {
	res := c.a.infoResponse()
	if !slices.Contains(res.ProtoPackages, tunnelPackage) {
		res.ProtoPackages = append(res.ProtoPackages, tunnelPackage)
	}
	c.a.confirm.debugInfo()
	return connect.NewResponse(res), nil
}

// debugEventsBatch is the most events read from the journal per Read.
const debugEventsBatch = 100

// debugEvents serves Events/Subscribe on the debug socket; Ack is
// unimplemented.
type debugEvents struct {
	tunnelv1connect.UnimplementedEventsHandler
	a *agent
}

// Subscribe implements tunnelv1connect.EventsHandler: it streams the journal
// after after_seq (default 0, the whole journal) until the client goes away.
func (e debugEvents) Subscribe(ctx context.Context, req *connect.Request[tunnelv1.SubscribeRequest], stream *connect.ServerStream[tunnelv1.SubscribeResponse]) error {
	after := req.Msg.GetAfterSeq()
	// Send the headers now: the journal may stay quiet for a long time.
	if err := stream.Send(nil); err != nil {
		return err
	}
	j := e.a.st.Journal()
	for {
		evs, err := j.Read(ctx, after, debugEventsBatch)
		if err != nil {
			if ctx.Err() != nil {
				return connect.NewError(connect.CodeCanceled, ctx.Err())
			}
			return connect.NewError(connect.CodeInternal, err)
		}
		for _, ev := range evs {
			if err := stream.Send(&tunnelv1.SubscribeResponse{Event: ev}); err != nil {
				return err
			}
			after = ev.GetSeq()
		}
	}
}
