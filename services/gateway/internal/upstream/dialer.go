// Package upstream opens streams to application ports inside machines (spec
// 7.2): locally over this instance's tunnel, or over a peer CONNECT to the
// instance that owns the machine's tunnel, waiting for the agent when the
// machine is not connected (spec 6.4). It also holds the HTTP transports to
// the applications, pooled per (machine, epoch, port).
package upstream

import (
	"context"
	"errors"
	"fmt"
	"log/slog"
	"net"
	"net/http"
	"time"

	"github.com/belov38/boat-dev-clone/libs/tunnel/gateway"
	"github.com/belov38/boat-dev-clone/libs/tunnel/registry"
	"github.com/belov38/boat-dev-clone/libs/tunnel/transport"
	"github.com/belov38/boat-dev-clone/libs/tunnel/wire"
	"github.com/belov38/boat-dev-clone/services/gateway/internal/obs"
)

// Error codes (the Sbx-Error of the gateway's answer, spec 7.6).
const (
	CodeAppNotListening  = "app_not_listening"
	CodeAppTimeout       = "app_timeout"
	CodeAgentUnavailable = "agent_unavailable"
	CodeOverloaded       = "overloaded"
	CodeUpstreamError    = "upstream_error"
)

// Metric reasons of sbx_gateway_upstream_dial_errors_total (spec 12.1, plus
// overloaded and upstream_error, which the spec's list does not name).
const (
	ReasonRefused          = "refused"
	ReasonTimeout          = "timeout"
	ReasonAgentUnavailable = "agent_unavailable"
	ReasonMoved            = "moved"
	ReasonPeerError        = "peer_error"
	ReasonOverloaded       = "overloaded"
	ReasonUpstreamError    = "upstream_error"
	// ReasonCanceled marks a dial abandoned by its caller; it is not counted.
	ReasonCanceled = "canceled"
)

// selfOwnerPoll is the poll interval while the registry names this instance
// as the owner but the session is not registered locally yet.
const selfOwnerPoll = 20 * time.Millisecond

// errDialTimeout is the cancel cause of a dial attempt that hit DialTimeout.
var errDialTimeout = errors.New("upstream: dial timeout")

// errAgentUnavailable is the cause of a dial that found no connected agent.
var errAgentUnavailable = errors.New("upstream: machine not connected")

// Error is a failed dial, already mapped to the gateway's answer.
type Error struct {
	// Status is the HTTP status of the gateway's answer.
	Status int
	// Code is the Sbx-Error code: one of the Code* constants.
	Code string
	// Reason is the metric label: one of the Reason* constants.
	Reason string
	// Err is the cause.
	Err error
}

func (e *Error) Error() string {
	return fmt.Sprintf("upstream: %s (%s): %v", e.Code, e.Reason, e.Err)
}

func (e *Error) Unwrap() error { return e.Err }

// LocalTunnels gives the machines connected to this instance.
type LocalTunnels interface {
	Machine(id string) (transport.MachineConn, bool)
}

// tcpDialer is the local tunnel's TCP dial with options; the concrete
// *gateway.MachineConn has it.
type tcpDialer interface {
	DialTCPWith(ctx context.Context, port uint16, opts gateway.TCPOptions) (net.Conn, error)
}

// Config configures a Dialer.
type Config struct {
	// Self is this instance's id.
	Self string
	// Local are this instance's tunnels.
	Local LocalTunnels
	// Owners caches the registry owners of machines.
	Owners *registry.OwnerCache
	// Store validates instance URLs from 421 answers.
	Store *registry.Store
	// PeerToken is sent to owner instances found in the registry.
	PeerToken string
	// AgentWait is how long a dial waits for a machine to connect.
	AgentWait time.Duration
	// DialTimeout bounds each dial attempt, the agent wait excluded.
	DialTimeout time.Duration
	// StaleAfter is the heartbeat age after which an instance is dead.
	StaleAfter time.Duration
	Metrics    *obs.Metrics
	Logger     *slog.Logger
}

// Dialer opens streams to application ports.
type Dialer struct {
	cfg  Config
	log  *slog.Logger
	peer *http.Transport
}

// New returns a Dialer. Close releases its peer connections.
func New(cfg Config) *Dialer {
	if cfg.Logger == nil {
		cfg.Logger = slog.Default()
	}
	peer := gateway.NewPeerTransport()
	// The proxy is byte-transparent.
	peer.DisableCompression = true
	return &Dialer{cfg: cfg, log: cfg.Logger, peer: peer}
}

// Close closes the idle peer connections.
func (d *Dialer) Close() { d.peer.CloseIdleConnections() }

// Epoch returns the tunnel epoch of a machine from the owner cache, for
// SyntheticHost. false means no connected agent.
func (d *Dialer) Epoch(ctx context.Context, machineID string) (uint64, bool, error) {
	o, ok, err := d.cfg.Owners.Lookup(ctx, machineID)
	if err != nil || !ok {
		return 0, false, err
	}
	return o.Epoch, true, nil
}

// Dial opens a TCP stream to port inside the machine. drain is how long the
// stream may keep running after its tunnel moved off a draining instance.
// Errors are *Error.
func (d *Dialer) Dial(ctx context.Context, machineID string, port uint16, drain time.Duration) (*Conn, error) {
	start := time.Now()
	c, err := d.dial(ctx, machineID, port, drain)
	if err != nil {
		ue := d.mapError(ctx, err)
		if ue.Reason != ReasonCanceled && d.cfg.Metrics != nil {
			d.cfg.Metrics.UpstreamDialErrors.WithLabelValues(ue.Reason).Inc()
		}
		return nil, ue
	}
	if d.cfg.Metrics != nil {
		d.cfg.Metrics.UpstreamDialDuration.WithLabelValues(c.Via).Observe(time.Since(start).Seconds())
	}
	return c, nil
}

// dial runs the owner resolution of spec 6.4: the local tunnel, else the
// registry owner over a peer CONNECT, else a wait for the agent.
func (d *Dialer) dial(ctx context.Context, id string, port uint16, drain time.Duration) (*Conn, error) {
	opts := gateway.TCPOptions{DrainDeadline: drain}
	var waitUntil time.Time
	for {
		if mc, ok := d.cfg.Local.Machine(id); ok {
			return d.dialLocal(ctx, id, mc, port, opts)
		}
		o, ok, err := d.lookup(ctx, id)
		if err != nil {
			return nil, err
		}
		if ok && o.InstanceID != d.cfg.Self {
			return d.dialPeer(ctx, id, o, port, opts)
		}

		// Not connected, or connected here but not registered locally yet
		// (make-before-break): wait for the agent.
		if waitUntil.IsZero() {
			waitUntil = time.Now().Add(d.cfg.AgentWait)
		}
		left := time.Until(waitUntil)
		if left <= 0 {
			return nil, errAgentUnavailable
		}
		if ok {
			t := time.NewTimer(min(selfOwnerPoll, left))
			select {
			case <-ctx.Done():
				t.Stop()
				return nil, ctx.Err()
			case <-t.C:
			}
			continue
		}
		if _, ok, err := d.cfg.Owners.Wait(ctx, id, left); err != nil {
			return nil, err
		} else if !ok {
			return nil, errAgentUnavailable
		}
	}
}

// lookup asks the owner cache, bounded by DialTimeout.
func (d *Dialer) lookup(ctx context.Context, id string) (registry.Owner, bool, error) {
	lctx, cancel := context.WithTimeoutCause(ctx, d.cfg.DialTimeout, errDialTimeout)
	defer cancel()
	o, ok, err := d.cfg.Owners.Lookup(lctx, id)
	if err != nil {
		if ctx.Err() != nil {
			return o, false, ctx.Err()
		}
		return o, false, &registryError{err: err}
	}
	return o, ok, nil
}

// registryError is a failed owner lookup.
type registryError struct{ err error }

func (e *registryError) Error() string { return "upstream: owner lookup: " + e.err.Error() }
func (e *registryError) Unwrap() error { return e.err }

// peerError is a transport failure talking to an owner instance.
type peerError struct{ err error }

func (e *peerError) Error() string { return "upstream: peer: " + e.err.Error() }
func (e *peerError) Unwrap() error { return e.err }

// movedError is a second 421 (or local ErrMachineMoved) after the one retry.
type movedError struct{ err error }

func (e *movedError) Error() string { return "upstream: machine moved again: " + e.err.Error() }
func (e *movedError) Unwrap() error { return e.err }

func (d *Dialer) dialLocal(ctx context.Context, id string, mc transport.MachineConn, port uint16, opts gateway.TCPOptions) (*Conn, error) {
	nc, err := d.dialLocalOnce(ctx, mc, port, opts)
	if err == nil {
		return &Conn{Conn: nc, Via: ViaLocal, OwnerInstance: d.cfg.Self}, nil
	}
	if !errors.Is(err, gateway.ErrMachineMoved) {
		return nil, err
	}
	// The session moved away between the lookup and the dial: one retry
	// with a fresh owner.
	d.cfg.Owners.Invalidate(id)
	return d.retryFresh(ctx, id, port, opts, err)
}

func (d *Dialer) dialLocalOnce(ctx context.Context, mc transport.MachineConn, port uint16, opts gateway.TCPOptions) (net.Conn, error) {
	dctx, cancel := context.WithTimeoutCause(ctx, d.cfg.DialTimeout, errDialTimeout)
	defer cancel()
	if td, ok := mc.(tcpDialer); ok {
		return td.DialTCPWith(dctx, port, opts)
	}
	return mc.DialTCP(dctx, port)
}

func (d *Dialer) dialPeer(ctx context.Context, id string, o registry.Owner, port uint16, opts gateway.TCPOptions) (*Conn, error) {
	c, err := d.dialPeerOnce(ctx, id, o, port, opts)
	var me *transport.MovedError
	if !errors.As(err, &me) {
		return c, err
	}
	d.cfg.Owners.Invalidate(id)
	// The answer's URL is only a hint: the token goes there only if the
	// registry knows a live instance at that URL.
	if me.InstanceURL != "" {
		vctx, cancel := context.WithTimeout(ctx, d.cfg.DialTimeout)
		inst, ok, verr := d.cfg.Store.InstanceByURL(vctx, me.InstanceURL, d.cfg.StaleAfter)
		cancel()
		switch {
		case verr != nil:
			d.log.Warn("upstream: instance url check failed", "machine_id", id, "err", verr)
		case ok && inst.ID == d.cfg.Self:
			return d.retryLocal(ctx, id, port, opts, err)
		case ok:
			return d.retryPeer(ctx, id, registry.Owner{InstanceID: inst.ID, InternalURL: inst.InternalURL}, port, opts)
		}
	}
	return d.retryFresh(ctx, id, port, opts, err)
}

// retryFresh is the one retry after a move, with a fresh registry lookup.
func (d *Dialer) retryFresh(ctx context.Context, id string, port uint16, opts gateway.TCPOptions, moved error) (*Conn, error) {
	o, ok, err := d.lookup(ctx, id)
	switch {
	case err != nil:
		return nil, err
	case !ok:
		return nil, &movedError{err: moved}
	case o.InstanceID == d.cfg.Self:
		return d.retryLocal(ctx, id, port, opts, moved)
	}
	return d.retryPeer(ctx, id, o, port, opts)
}

func (d *Dialer) retryLocal(ctx context.Context, id string, port uint16, opts gateway.TCPOptions, moved error) (*Conn, error) {
	mc, ok := d.cfg.Local.Machine(id)
	if !ok {
		return nil, &movedError{err: moved}
	}
	nc, err := d.dialLocalOnce(ctx, mc, port, opts)
	if err != nil {
		if errors.Is(err, gateway.ErrMachineMoved) {
			return nil, &movedError{err: err}
		}
		return nil, err
	}
	return &Conn{Conn: nc, Via: ViaLocal, OwnerInstance: d.cfg.Self}, nil
}

func (d *Dialer) retryPeer(ctx context.Context, id string, o registry.Owner, port uint16, opts gateway.TCPOptions) (*Conn, error) {
	c, err := d.dialPeerOnce(ctx, id, o, port, opts)
	var me *transport.MovedError
	if errors.As(err, &me) {
		d.cfg.Owners.Invalidate(id)
		return nil, &movedError{err: err}
	}
	return c, err
}

// dialPeerOnce sends one peer CONNECT to the owner o.
func (d *Dialer) dialPeerOnce(ctx context.Context, id string, o registry.Owner, port uint16, opts gateway.TCPOptions) (*Conn, error) {
	dctx, cancel := context.WithTimeoutCause(ctx, d.cfg.DialTimeout, errDialTimeout)
	defer cancel()
	nc, err := gateway.DialRemoteTCP(dctx, d.peer, o.InternalURL, d.cfg.PeerToken, id, port, opts)
	if err == nil {
		return &Conn{Conn: nc, Via: ViaPeer, OwnerInstance: o.InstanceID}, nil
	}
	var (
		me *transport.MovedError
		de *transport.DialError
	)
	switch {
	case errors.As(err, &me), errors.Is(err, gateway.ErrTooManyStreams):
		return nil, err
	case errors.As(err, &de):
		if de.Status == http.StatusServiceUnavailable {
			// The owner has no session (any more): the cached owner is stale.
			d.cfg.Owners.Invalidate(id)
		}
		return nil, err
	case dctx.Err() != nil:
		return nil, context.Cause(dctx)
	}
	// The owner instance is unreachable or broke the stream: next time ask
	// the registry again.
	d.cfg.Owners.Invalidate(id)
	return nil, &peerError{err: err}
}

// mapError maps a dial failure to the gateway's answer (spec 7.2, 7.6).
func (d *Dialer) mapError(ctx context.Context, err error) *Error {
	e := func(status int, code, reason string) *Error {
		return &Error{Status: status, Code: code, Reason: reason, Err: err}
	}
	var (
		de *transport.DialError
		pe *peerError
		me *movedError
		re *registryError
	)
	switch {
	case errors.Is(err, errDialTimeout):
		return e(http.StatusGatewayTimeout, CodeAppTimeout, ReasonTimeout)
	case ctx.Err() != nil:
		// The caller gave up; its answer does not matter.
		if errors.Is(ctx.Err(), context.DeadlineExceeded) {
			return e(http.StatusGatewayTimeout, CodeAppTimeout, ReasonCanceled)
		}
		return e(http.StatusBadGateway, CodeUpstreamError, ReasonCanceled)
	case errors.Is(err, gateway.ErrTooManyStreams):
		return e(http.StatusServiceUnavailable, CodeOverloaded, ReasonOverloaded)
	case errors.As(err, &de):
		return d.mapDialError(err, de)
	case errors.As(err, &me):
		return e(http.StatusServiceUnavailable, CodeAgentUnavailable, ReasonMoved)
	case errors.As(err, &pe):
		d.log.Warn("upstream: peer dial failed", "err", err)
		return e(http.StatusServiceUnavailable, CodeAgentUnavailable, ReasonPeerError)
	case errors.As(err, &re):
		d.log.Warn("upstream: owner lookup failed", "err", err)
		return e(http.StatusServiceUnavailable, CodeAgentUnavailable, ReasonAgentUnavailable)
	}
	// errAgentUnavailable, ErrSessionClosed and other tunnel errors.
	return e(http.StatusServiceUnavailable, CodeAgentUnavailable, ReasonAgentUnavailable)
}

func (d *Dialer) mapDialError(err error, de *transport.DialError) *Error {
	e := func(status int, code, reason string) *Error {
		return &Error{Status: status, Code: code, Reason: reason, Err: err}
	}
	switch {
	case de.Status == http.StatusBadGateway && de.Reason == wire.DialErrorRefused:
		return e(http.StatusBadGateway, CodeAppNotListening, ReasonRefused)
	case de.Status == http.StatusBadGateway && de.Reason == wire.DialErrorTimeout:
		return e(http.StatusGatewayTimeout, CodeAppTimeout, ReasonTimeout)
	case de.Status == http.StatusServiceUnavailable:
		return e(http.StatusServiceUnavailable, CodeAgentUnavailable, ReasonAgentUnavailable)
	case de.Status == http.StatusBadGateway:
		return e(http.StatusBadGateway, CodeUpstreamError, ReasonUpstreamError)
	}
	// 400/403 from the agent, or an unexpected status from a peer (401, 5xx):
	// a platform error, not the application's.
	d.log.Error("upstream: dial refused by the platform", "status", de.Status, "err", err)
	return e(http.StatusBadGateway, CodeUpstreamError, ReasonUpstreamError)
}
