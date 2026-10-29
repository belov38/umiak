package agent

// The debug socket is a test and QGA aid, not a production interface:
// `sbx-agent run --debug-listen unix:<path>` serves the agent mux (the same
// handler the tunnel serves) and sbx.tunnel.v1.Control/Info on a local unix
// socket, over HTTP/1.1 or h2c, without the tunnel library. It lets tests
// drive the agent without a gateway.
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
	ctlPath, ctl := tunnelv1connect.NewControlHandler(debugControl{a: a})
	h := http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if strings.HasPrefix(r.URL.Path, ctlPath) {
			ctl.ServeHTTP(w, r)
			return
		}
		a.mux.ServeHTTP(w, r)
	})
	var protos http.Protocols
	protos.SetHTTP1(true)
	protos.SetUnencryptedHTTP2(true)
	srv := &http.Server{Handler: h, Protocols: &protos, ReadHeaderTimeout: 10 * time.Second}
	a.log.Warn("agent: debug socket enabled (test aid)", "path", path, "debug_confirm", a.d.DebugConfirm)
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
	return nil
}

// listenPrivate listens on a unix socket at path that nobody but the owner
// can connect to at any moment: the socket is created in a fresh 0700
// directory next to path, made 0600 and only then renamed into place.
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
	err = os.Chmod(tmp, 0o600)
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
