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

	"github.com/belov38/umiak/libs/tunnel/gateway"
	"github.com/belov38/umiak/libs/tunnel/registry"
	"github.com/belov38/umiak/libs/tunnel/transport"
	"github.com/belov38/umiak/libs/tunnel/wire"
	"github.com/belov38/umiak/services/gateway/internal/obs"
)

// Error codes (the Umiak-Error of the gateway's answer, spec 7.6).
const (
	CodeAppNotListening  = "app_not_listening"
	CodeAppTimeout       = "app_timeout"
	CodeAgentUnavailable = "agent_unavailable"
	CodeOverloaded       = "overloaded"
	CodeUpstreamError    = "upstream_error"
)

// Metric reasons of umiak_gateway_upstream_dial_errors_total (spec 12.1, plus
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

// Defaults of Config.
const (
	defaultDialTimeout = 10 * time.Second
	defaultStaleAfter  = 15 * time.Second
)

// selfOwnerPoll is the first poll interval while the registry names this
// instance as the owner but the session is not registered locally yet, or
// names an owner that answered 503 (no session). It doubles up to
// selfOwnerPollMax; the whole wait is still bounded by AgentWait.
const (
	selfOwnerPoll    = 20 * time.Millisecond
	selfOwnerPollMax = 200 * time.Millisecond
)

// epochLookupMax caps the owner lookup of Epoch.
const epochLookupMax = 2 * time.Second

// errDialTimeout is the cancel cause of a dial that used up DialTimeout.
var errDialTimeout = errors.New("upstream: dial timeout")

// errAgentUnavailable is the cause of a dial that found no connected agent.
var errAgentUnavailable = errors.New("upstream: machine not connected")

// Error is a failed dial, already mapped to the gateway's answer.
type Error struct {
	// Status is the HTTP status of the gateway's answer.
	Status int
	// Code is the Umiak-Error code: one of the Code* constants.
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

// epocher gives the epoch of a local session; the concrete
// *gateway.MachineConn has it.
type epocher interface{ Epoch() uint64 }

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
	// DialTimeout bounds the whole dial (owner lookups, CONNECTs, the move
	// retry), the agent wait excluded (10 s).
	DialTimeout time.Duration
	// StaleAfter is the heartbeat age after which an instance is dead (15 s).
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
	if cfg.DialTimeout <= 0 {
		cfg.DialTimeout = defaultDialTimeout
	}
	if cfg.StaleAfter <= 0 {
		cfg.StaleAfter = defaultStaleAfter
	}
	peer := gateway.NewPeerTransport()
	// The proxy is byte-transparent.
	peer.DisableCompression = true
	return &Dialer{cfg: cfg, log: cfg.Logger, peer: peer}
}

// Close closes the idle peer connections.
func (d *Dialer) Close() { d.peer.CloseIdleConnections() }

// Epoch returns the tunnel epoch of a machine, for SyntheticHost. A machine
// connected to this instance gets its session's epoch without a registry
// query (spec 6.4: local first), so previews of local machines survive a
// Postgres outage. Otherwise the owner cache is asked within
// min(DialTimeout, 2 s).
//
// false means no known owner. A failed or slow lookup is logged and also
// gives false: the dial then resolves the owner itself and maps its own
// errors. The error is only ever the caller's ctx error.
func (d *Dialer) Epoch(ctx context.Context, machineID string) (uint64, bool, error) {
	if mc, ok := d.cfg.Local.Machine(machineID); ok {
		if e, ok := mc.(epocher); ok {
			return e.Epoch(), true, nil
		}
	}
	lctx, cancel := context.WithTimeout(ctx, min(d.cfg.DialTimeout, epochLookupMax))
	defer cancel()
	o, ok, err := d.cfg.Owners.Lookup(lctx, machineID)
	switch {
	case ctx.Err() != nil:
		return 0, false, ctx.Err()
	case err != nil:
		d.log.Warn("upstream: owner lookup for the epoch failed", "machine_id", machineID, "err", err)
		return 0, false, nil
	case !ok:
		return 0, false, nil
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
//
// DialTimeout is one budget for the dial: lookups, the CONNECT, the URL
// check and the move retry share it. Waiting for the agent is not part of
// it: the budget starts again once the wait found an owner.
func (d *Dialer) dial(ctx context.Context, id string, port uint16, drain time.Duration) (*Conn, error) {
	opts := gateway.TCPOptions{DrainDeadline: drain}
	var waitUntil time.Time
	pollEvery := selfOwnerPoll
	for {
		bctx, cancel := context.WithTimeoutCause(ctx, d.cfg.DialTimeout, errDialTimeout)
		c, self, err := d.resolve(bctx, id, port, opts)
		cancel()
		// The owner answered 503: it holds no session for the machine any
		// more, the agent is reconnecting. Wait for it like for a machine
		// without an owner, polling, because the registry may still name
		// that owner for a moment.
		poll := ownerWithoutSession(err)
		if !poll && (c != nil || err != nil) {
			return c, err
		}

		// Not connected, or connected here but not registered locally yet
		// (make-before-break): wait for the agent.
		if waitUntil.IsZero() {
			waitUntil = time.Now().Add(d.cfg.AgentWait)
		}
		var interval time.Duration
		if self || poll {
			interval = pollEvery
			pollEvery = min(2*pollEvery, selfOwnerPollMax)
		}
		if err := d.waitAgent(ctx, id, interval, waitUntil); err != nil {
			return nil, err
		}
	}
}

// resolve dials the local session or the registry owner within the budget
// of ctx. It returns no conn and no error when the agent must be waited
// for; self then says that the registry names this instance.
func (d *Dialer) resolve(ctx context.Context, id string, port uint16, opts gateway.TCPOptions) (c *Conn, self bool, err error) {
	if mc, ok := d.cfg.Local.Machine(id); ok {
		c, err = d.dialLocal(ctx, id, mc, port, opts)
		return c, false, err
	}
	o, ok, err := d.lookup(ctx, id)
	switch {
	case err != nil:
		return nil, false, err
	case ok && o.InstanceID != d.cfg.Self:
		c, err = d.dialPeer(ctx, id, o, port, opts)
		return c, false, err
	}
	return nil, ok, nil
}

// ownerWithoutSession reports a peer CONNECT refused with 503: the owner
// instance has no serving session for the machine. An agent's own 503 on a
// local dial is not one: the agent is connected and refused the dial.
func ownerWithoutSession(err error) bool {
	var ne *noSessionError
	return errors.As(err, &ne)
}

// waitAgent waits until waitUntil for the machine to get an owner, or, when
// poll is set (the owner is already this instance, or the registry's owner
// had no session), for that poll interval. It returns errAgentUnavailable
// when the time is up without an owner.
func (d *Dialer) waitAgent(ctx context.Context, id string, poll time.Duration, waitUntil time.Time) error {
	left := time.Until(waitUntil)
	if left <= 0 {
		return errAgentUnavailable
	}
	if poll > 0 {
		t := time.NewTimer(min(poll, left))
		defer t.Stop()
		select {
		case <-ctx.Done():
			return ctx.Err()
		case <-t.C:
			return nil
		}
	}
	// The deadline also bounds the registry queries inside Wait.
	wctx, cancel := context.WithDeadline(ctx, waitUntil)
	defer cancel()
	_, ok, err := d.cfg.Owners.Wait(wctx, id, left)
	switch {
	case ctx.Err() != nil:
		return ctx.Err()
	case err != nil && wctx.Err() == nil:
		return &registryError{err: err}
	case !ok:
		return errAgentUnavailable
	}
	return nil
}

// lookup asks the owner cache within the dial budget of ctx.
func (d *Dialer) lookup(ctx context.Context, id string) (registry.Owner, bool, error) {
	o, ok, err := d.cfg.Owners.Lookup(ctx, id)
	if err != nil {
		if ctx.Err() != nil {
			return o, false, context.Cause(ctx)
		}
		return o, false, &registryError{err: err}
	}
	return o, ok, nil
}

// registryError is a failed owner lookup.
type registryError struct{ err error }

func (e *registryError) Error() string { return "upstream: owner lookup: " + e.err.Error() }
func (e *registryError) Unwrap() error { return e.err }

// noSessionError is a peer CONNECT refused with 503: the owner instance
// holds no session for the machine (any more).
type noSessionError struct{ err error }

func (e *noSessionError) Error() string { return "upstream: owner has no session: " + e.err.Error() }
func (e *noSessionError) Unwrap() error { return e.err }

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

// dialLocalOnce dials over the local session within the budget of ctx.
func (d *Dialer) dialLocalOnce(ctx context.Context, mc transport.MachineConn, port uint16, opts gateway.TCPOptions) (net.Conn, error) {
	if td, ok := mc.(tcpDialer); ok {
		return td.DialTCPWith(ctx, port, opts)
	}
	return mc.DialTCP(ctx, port)
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
		inst, ok, verr := d.cfg.Store.InstanceByURL(ctx, me.InstanceURL, d.cfg.StaleAfter)
		switch {
		case verr != nil && ctx.Err() != nil:
			return nil, context.Cause(ctx)
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

// dialPeerOnce sends one peer CONNECT to the owner o within the budget of
// ctx.
func (d *Dialer) dialPeerOnce(ctx context.Context, id string, o registry.Owner, port uint16, opts gateway.TCPOptions) (*Conn, error) {
	nc, err := gateway.DialRemoteTCP(ctx, d.peer, o.InternalURL, d.cfg.PeerToken, id, port, opts)
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
			return nil, &noSessionError{err: err}
		}
		return nil, err
	case ctx.Err() != nil:
		return nil, context.Cause(ctx)
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
		ne *noSessionError
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
	case errors.As(err, &ne):
		return e(http.StatusServiceUnavailable, CodeAgentUnavailable, ReasonAgentUnavailable)
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
	case de.Status == http.StatusBadGateway:
		return e(http.StatusBadGateway, CodeUpstreamError, ReasonUpstreamError)
	}
	// 400/403 from the agent, any other status from the agent (a 503, 421
	// or 429 there is not a gateway signal), or an unexpected status from a
	// peer (401, 5xx): a platform error, not the application's.
	d.log.Error("upstream: dial refused by the platform", "status", de.Status, "err", err)
	return e(http.StatusBadGateway, CodeUpstreamError, ReasonUpstreamError)
}
