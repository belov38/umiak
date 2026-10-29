package agent

// The debug socket is a test and QGA aid, not a production interface:
// `sbx-agent run --debug-listen unix:<path>` serves the agent mux (the same
// handler the tunnel serves) and sbx.tunnel.v1.Control/Info on a local unix
// socket, over HTTP/1.1 or h2c, without the tunnel library. It lets tests
// drive the agent without a gateway.
//
// A Control/Info call on the socket counts as a served Control/Info for the
// update confirmation (spec 17.4 step 6). The confirmation additionally needs
// a tunnel connection, or the flag --debug-confirm, which lets the debug
// Info alone confirm.

import (
	"context"
	"fmt"
	"net"
	"net/http"
	"os"
	"slices"
	"strings"
	"time"

	"connectrpc.com/connect"

	tunnelv1 "github.com/belov38/boat-dev-clone/libs/proto/sbx/tunnel/v1"
	"github.com/belov38/boat-dev-clone/libs/proto/sbx/tunnel/v1/tunnelv1connect"
)

// tunnelPackage is the proto package of the tunnel control API.
const tunnelPackage = "sbx.tunnel.v1"

// startDebug starts the debug socket server. The socket is 0600 and removed
// when ctx ends.
func (a *agent) startDebug(ctx context.Context) error {
	path, ok := strings.CutPrefix(a.d.DebugListen, "unix:")
	if !ok || path == "" {
		return fmt.Errorf("agent: --debug-listen %q: want unix:<path>", a.d.DebugListen)
	}
	_ = os.Remove(path) // a socket left by a killed run
	var lc net.ListenConfig
	ln, err := lc.Listen(ctx, "unix", path)
	if err != nil {
		return fmt.Errorf("agent: debug listen: %w", err)
	}
	if err := os.Chmod(path, 0o600); err != nil {
		_ = ln.Close()
		return fmt.Errorf("agent: debug socket mode: %w", err)
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
		_ = srv.Close()
		_ = os.Remove(path)
	})
	return nil
}

// debugControl serves Control/Info on the debug socket; SetToken and Drain
// are unimplemented.
type debugControl struct {
	tunnelv1connect.UnimplementedControlHandler
	a *agent
}

// Info implements tunnelv1connect.ControlHandler.
func (c debugControl) Info(context.Context, *connect.Request[tunnelv1.InfoRequest]) (*connect.Response[tunnelv1.InfoResponse], error) {
	c.a.confirm.info()
	res := c.a.infoResponse()
	if !slices.Contains(res.ProtoPackages, tunnelPackage) {
		res.ProtoPackages = append(res.ProtoPackages, tunnelPackage)
	}
	return connect.NewResponse(res), nil
}
