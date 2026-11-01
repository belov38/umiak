package agent

// The local sockets of the agent on Windows (S9 Decision 4, spec 12.7):
// Layout.AdminSocket serves the full agent API, like --debug-listen, to
// SYSTEM and Administrators (its clients are `umiak-agent exec`, `call`,
// `selftest --pty` and `thaw --force`); Layout.EnvSocket serves only the
// session env to `umiak-agent env` for SSH session profiles, also to the
// default user. AF_UNIX has no peer credentials on Windows: the ACL of the
// socket file decides who connects, and it is set right after Listen.
// Layouts without the paths (Linux) open neither socket.

import (
	"context"
	"encoding/json"
	"fmt"
	"net"
	"net/http"
	"os"
	"path/filepath"
)

// EnvPath is the path of the session env on the env socket.
const EnvPath = "/env"

// EnvResponse is the JSON answer of EnvPath.
type EnvResponse struct {
	// Env holds KEY=VALUE entries (claim.EnvBuilder.SessionEnv).
	Env []string `json:"env"`
}

// socketKind selects the ACL of a local socket.
type socketKind int

const (
	socketAdmin socketKind = iota
	socketEnv
)

type adminCallKey struct{}

// isAdminCall reports whether ctx belongs to a request on the admin socket.
// Such a request comes from a local administrator: Process/Start does not
// wait for pending secrets or for the boot step then, so `umiak-agent exec`
// works before a claim, after PrepareStop and on a machine whose boot step
// failed.
func isAdminCall(ctx context.Context) bool {
	v, _ := ctx.Value(adminCallKey{}).(bool)
	return v
}

// markAdmin marks the requests h serves as admin calls.
func markAdmin(h http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		h.ServeHTTP(w, r.WithContext(context.WithValue(r.Context(), adminCallKey{}, true)))
	})
}

// startLocalSockets opens the admin and env sockets of the layout. A
// socket that cannot be opened is logged and skipped: the agent still
// serves the tunnel.
func (a *agent) startLocalSockets(ctx context.Context) {
	if p := a.l.AdminSocket; p != "" {
		if ln, err := listenLocal(ctx, p, socketAdmin, ""); err != nil {
			a.log.Error("agent: admin socket", "path", p, "err", err)
		} else {
			a.serveLocal(ctx, ln, p, markAdmin(a.apiHandler()))
		}
	}
	if p := a.l.EnvSocket; p != "" {
		if ln, err := listenLocal(ctx, p, socketEnv, a.cfg.DefaultUser); err != nil {
			a.log.Error("agent: env socket", "path", p, "err", err)
		} else {
			a.serveLocal(ctx, ln, p, a.envHandler())
		}
	}
}

// envHandler serves GET EnvPath: the session env as EnvResponse.
func (a *agent) envHandler() http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path != EnvPath {
			http.NotFound(w, r)
			return
		}
		if r.Method != http.MethodGet {
			http.Error(w, "method not allowed", http.StatusMethodNotAllowed)
			return
		}
		w.Header().Set("Content-Type", "application/json")
		w.Header().Set("Cache-Control", "no-store")
		_ = json.NewEncoder(w).Encode(EnvResponse{Env: a.claim.EnvBuilder().SessionEnv()})
	})
}

// listenLocal listens on a unix socket at path, replacing a socket file
// left by a killed run, and secures the file for kind. The listener does
// not unlink path on close; serveLocal removes it.
func listenLocal(ctx context.Context, path string, kind socketKind, user string) (net.Listener, error) {
	if err := os.MkdirAll(filepath.Dir(path), 0o700); err != nil {
		return nil, err
	}
	if err := os.Remove(path); err != nil && !os.IsNotExist(err) {
		return nil, fmt.Errorf("remove old socket: %w", err)
	}
	var lc net.ListenConfig
	ln, err := lc.Listen(ctx, "unix", path)
	if err != nil {
		return nil, err
	}
	if ul, ok := ln.(*net.UnixListener); ok {
		ul.SetUnlinkOnClose(false)
	}
	if err := secureSocket(path, kind, user); err != nil {
		_ = ln.Close()
		_ = os.Remove(path)
		return nil, err
	}
	return ln, nil
}
