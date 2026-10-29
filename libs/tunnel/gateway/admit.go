package gateway

import (
	"context"
	"errors"
	"log/slog"
	"net"
	"net/http"
	"time"

	"github.com/google/uuid"

	"github.com/belov38/boat-dev-clone/libs/tunnel/h2"
	"github.com/belov38/boat-dev-clone/libs/tunnel/registry"
	"github.com/belov38/boat-dev-clone/libs/tunnel/transport"
	"github.com/belov38/boat-dev-clone/libs/tunnel/wire"
)

// dbRetryAfter is the Retry-After of a 503 caused by a registry failure.
const dbRetryAfter = time.Second

type admitter struct{ g *Gateway }

// Admit checks a connection attempt (spec 5.3): draining or not running →
// 503, agent below MinAgentVersion → 426, then the registry checks the
// credentials and records the session with epoch+1 (401, 403; registry
// errors are a retryable 503).
func (a admitter) Admit(ctx context.Context, hello transport.Hello) (transport.Admission, error) {
	g := a.g
	log := g.log.With("machine_id", hello.MachineID)
	if g.draining.Load() || !g.running.Load() {
		return nil, g.reject(log, &transport.RejectError{
			Status: http.StatusServiceUnavailable, RetryAfter: g.cfg.Timing.DrainRetryAfter, Reason: "gateway draining",
		})
	}
	if g.cfg.MinAgentVersion != "" {
		c, err := wire.CompareVersions(hello.AgentVersion, g.cfg.MinAgentVersion)
		if err != nil || c < 0 {
			return nil, g.reject(log, &transport.RejectError{
				Status: http.StatusUpgradeRequired, Reason: "agent version " + hello.AgentVersion + " below minimum " + g.cfg.MinAgentVersion,
			})
		}
	}
	id, err := uuid.NewV7()
	if err != nil {
		return nil, g.reject(log, &transport.RejectError{Status: http.StatusServiceUnavailable, RetryAfter: dbRetryAfter, Reason: "conn id: " + err.Error()})
	}
	connID := id.String()
	res, err := g.store.Admit(ctx, registry.AdmitParams{
		MachineID:       hello.MachineID,
		InstanceID:      g.cfg.InstanceID,
		ConnID:          connID,
		AgentInstanceID: hello.AgentInstanceID,
		BootID:          hello.BootID,
		Vmgenid:         hello.Vmgenid,
		AgentVersion:    hello.AgentVersion,
		ProtoVersion:    hello.ProtoVersion,
		Scheme:          hello.Scheme,
		SecretHash:      wire.HashSecret(hello.Secret),
	})
	switch {
	case errors.Is(err, registry.ErrUnauthorized):
		return nil, g.reject(log, &transport.RejectError{Status: http.StatusUnauthorized, Reason: "unauthorized"})
	case errors.Is(err, registry.ErrRetired):
		return nil, g.reject(log, &transport.RejectError{Status: http.StatusForbidden, Reason: "machine retired"})
	case err != nil:
		log.Warn("gateway: admission registry error", "err", err)
		return nil, g.reject(log, &transport.RejectError{Status: http.StatusServiceUnavailable, RetryAfter: dbRetryAfter, Reason: "registry unavailable"})
	}
	log.Info("gateway: connection admitted", "conn_id", connID, "epoch", res.Epoch,
		"auth", authName(hello.Scheme), "agent_version", hello.AgentVersion)
	// The secret was only needed for the hash: nothing past admission
	// keeps it (fmt prints unexported Hello fields by reflection).
	return &admission{g: g, hello: hello.WithoutSecret(), res: res, info: transport.ConnInfo{
		GatewayInstance: g.cfg.InstanceID,
		Epoch:           res.Epoch,
		ConnID:          connID,
	}}, nil
}

func (g *Gateway) reject(log *slog.Logger, rej *transport.RejectError) error {
	log.Info("gateway: connection rejected", "status", rej.Status, "reason", rej.Reason)
	return rej
}

type admission struct {
	g     *Gateway
	hello transport.Hello
	res   registry.AdmitResult
	info  transport.ConnInfo
}

func (a *admission) Info() transport.ConnInfo { return a.info }

// Abort marks the admitted session disconnected (fenced by epoch): the
// transport failed before the connection could be served.
func (a *admission) Abort(err error) {
	g := a.g
	g.log.Info("gateway: admitted connection aborted", "machine_id", a.hello.MachineID,
		"conn_id", a.info.ConnID, "epoch", a.info.Epoch, "reason", errString(err))
	ctx, cancel := context.WithTimeout(context.WithoutCancel(g.bg), dbTimeout)
	defer cancel()
	if _, derr := g.store.Disconnect(ctx, a.hello.MachineID, g.cfg.InstanceID, a.info.Epoch); derr != nil {
		g.log.Warn("gateway: disconnect after abort failed", "machine_id", a.hello.MachineID, "epoch", a.info.Epoch, "err", derr)
	}
}

// Serve takes ownership of conn and returns at once; the HTTP/2 client and
// the session start in the background.
func (a *admission) Serve(conn net.Conn) {
	g := a.g
	g.mu.Lock()
	if g.closing {
		g.mu.Unlock()
		_ = conn.Close()
		if !g.abandoned.Load() {
			a.Abort(errors.New("gateway shutting down"))
		}
		return
	}
	g.sessWG.Add(1)
	g.mu.Unlock()
	go func() {
		defer g.sessWG.Done()
		a.serve(conn)
	}()
}

func (a *admission) serve(conn net.Conn) {
	g := a.g
	wc := newWatchedConn(conn)
	cc, err := h2.NewClientConn(g.bg, wc, g.cfg.HTTP2)
	if err != nil {
		_ = wc.Close()
		if !g.abandoned.Load() {
			a.Abort(err)
		}
		return
	}
	s := newSession(g, a.hello, a.info, a.res, wc, cc)
	s.start()
}

func authName(s transport.AuthScheme) string {
	if s == transport.AuthToken {
		return "token"
	}
	return "bootstrap"
}

func errString(err error) string {
	if err == nil {
		return ""
	}
	return err.Error()
}
