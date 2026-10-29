package server

import (
	"context"
	"errors"
	"fmt"
	"sync"
	"time"

	"github.com/belov38/boat-dev-clone/libs/tunnel/gateway"
	"github.com/belov38/boat-dev-clone/services/gateway/internal/config"
)

// defaultEndpointWait is the gateway.Timing default (zero Timing fields
// take the libs/tunnel defaults).
const defaultEndpointWait = config.DefaultEndpointWait

const (
	// drainPoll is the period of the drain's waits for streams and SSH
	// sessions to end.
	drainPoll = 50 * time.Millisecond
	// drainGaugeEvery is the update period of
	// sbx_gateway_drain_open_streams.
	drainGaugeEvery = time.Second
	// sshCloseGrace is how long after the SSH drain deadline the drain
	// waits for the sessions before closing the SSH server.
	sshCloseGrace = 5 * time.Second
)

// DrainBudget is the longest a Drain takes with cfg and timing; see
// config.DrainBudget, which config.ValidateServe checks against the grace
// period.
func DrainBudget(cfg config.Config, timing gateway.Timing) time.Duration {
	return config.DrainBudget(cfg, timing)
}

func orDefault(v, def time.Duration) time.Duration {
	if v <= 0 {
		return def
	}
	return v
}

// Drain takes the instance out of service (spec 10), with t0 = now:
//
//  1. Ready turns false (/readyz 503) at once.
//  2. The tunnel gateway drains in the background: registry state
//     draining with drain_started_at and NOTIFY, EndpointWait, then
//     Control/Drain with the SSH drain deadline as tcp_deadline.
//  3. The SSH sessions get their deadline t0 + SSHDrainDeadline and the
//     first warning.
//  4. New conns are still accepted for EndpointWait while the load
//     balancer drops the pod; then the TLS, plain and SSH listeners close.
//  5. The public HTTP servers shut down gracefully until t0 +
//     HTTPDrainDeadline; then the long streams (WebSocket, SSE) and every
//     conn left are closed.
//  6. It waits for the SSH sessions, which close at their deadlines, the
//     HTTP shutdown and the tunnel drain, then shuts the internal listener
//     down gracefully.
//
// When ctx ends first, everything is closed and ctx's error is returned.
// Run returns once Drain finished. Drain is idempotent: later calls wait
// for the first one (or their own ctx).
//
// A Drain that comes before Run (a signal during startup) waits until Run
// serves, then drains as usual; it returns ctx's error if ctx ends first,
// and nil if Run returned without serving (nothing to drain).
func (i *Instance) Drain(ctx context.Context) error {
	select {
	case <-i.runStarted:
	case <-i.runEnded:
		return nil
	case <-ctx.Done():
		return ctx.Err()
	}
	if !i.drainStarted.CompareAndSwap(false, true) {
		select {
		case <-i.drained:
			return i.drainErr
		case <-ctx.Done():
			return ctx.Err()
		}
	}
	i.drainErr = i.drain(ctx)
	close(i.drained)
	return i.drainErr
}

func (i *Instance) drain(ctx context.Context) error {
	t0 := time.Now()
	i.draining.Store(true)
	i.log.Info("gateway: instance drain started")
	stopGauge := i.drainGauge()
	defer stopGauge()

	tunnelDone := make(chan error, 1)
	go func() { tunnelDone <- i.drainTunnel(ctx) }()
	if i.ssh != nil {
		// The SSH deadlines run on the sshgw clock (Deps.Now).
		i.ssh.Drain(i.deps.Now())
	}

	var wg sync.WaitGroup
	defer wg.Wait()
	if !sleepUntil(ctx, t0.Add(orDefault(i.deps.Timing.EndpointWait, defaultEndpointWait))) {
		return i.forceStop(ctx, tunnelDone)
	}

	// The servers' Shutdown closes the plain listener and the dispatcher's
	// sbx and tunnel listeners; closing the dispatcher closes the TLS port.
	httpCtx, cancelHTTP := context.WithDeadline(ctx, t0.Add(i.cfg.HTTPDrainDeadline))
	defer cancelHTTP()
	httpDone := make(chan struct{})
	wg.Go(func() {
		defer close(httpDone)
		i.drainHTTP(httpCtx)
	})
	if d := i.disp.Load(); d != nil {
		_ = d.Close()
	}
	sshDone := make(chan struct{})
	if i.ssh != nil {
		i.ssh.StopAccepting()
		wg.Go(func() {
			defer close(sshDone)
			i.waitSSH(ctx, t0.Add(i.cfg.SSHDrainDeadline+sshCloseGrace))
		})
	} else {
		close(sshDone)
	}

	var terr error
	for tunnelDone != nil || httpDone != nil || sshDone != nil {
		select {
		case terr = <-tunnelDone:
			tunnelDone = nil
		case <-httpDone:
			httpDone = nil
		case <-sshDone:
			sshDone = nil
		case <-ctx.Done():
			return i.forceStop(ctx, tunnelDone)
		}
	}
	err := terr
	if serr := i.internal.Shutdown(ctx); serr != nil {
		_ = i.internal.Close()
		err = errors.Join(err, fmt.Errorf("server: internal listener shutdown: %w", serr))
	}
	i.log.Info("gateway: instance drain finished", "took", time.Since(t0), "err", err)
	return err
}

// drainTunnel drains the tunnel gateway once it is registered. Run starts
// it on its own goroutine, so a drain right after startup waits for the
// registration; a tunnel gateway that stopped (or never registered before
// ctx ended) has nothing to drain.
func (i *Instance) drainTunnel(ctx context.Context) error {
	for !i.tunnel.Ready() {
		select {
		case <-i.tunnelExited:
			return nil
		case <-ctx.Done():
			return ctx.Err()
		case <-time.After(drainPoll):
		}
	}
	return i.tunnel.Drain(ctx)
}

// drainHTTP shuts the public HTTP servers down gracefully until ctx ends,
// waits for the long streams (Shutdown does not see hijacked conns) and
// then closes whatever is left.
func (i *Instance) drainHTTP(ctx context.Context) {
	servers := i.edgeServers()
	var wg sync.WaitGroup
	for _, s := range servers {
		wg.Go(func() { _ = s.Shutdown(ctx) })
	}
	wg.Wait()
	waitFor(ctx, time.Time{}, func() bool { return i.streams.Count() == 0 })
	i.streams.CloseAll()
	for _, s := range servers {
		_ = s.Close()
	}
}

// waitSSH waits until no SSH session is left, ctx ends or until passes;
// then the SSH server is closed (nothing is accepted any more).
func (i *Instance) waitSSH(ctx context.Context, until time.Time) {
	waitFor(ctx, until, func() bool { return i.ssh.Sessions() == 0 })
	if n := i.ssh.Sessions(); n > 0 {
		i.log.Warn("gateway: closing SSH sessions left after the drain deadline", "sessions", n)
	}
	_ = i.ssh.Close()
}

// forceStop ends a drain whose ctx ended: every conn is closed, the tunnel
// drain (cut short by the same ctx) is awaited and ctx's error returned.
func (i *Instance) forceStop(ctx context.Context, tunnelDone <-chan error) error {
	i.log.Warn("gateway: drain cut short, closing everything", "err", ctx.Err())
	i.streams.CloseAll()
	for _, s := range i.edgeServers() {
		_ = s.Close()
	}
	if d := i.disp.Load(); d != nil {
		_ = d.Close()
	}
	if i.ssh != nil {
		_ = i.ssh.Close()
	}
	if tunnelDone != nil {
		if err := <-tunnelDone; err != nil && !errors.Is(err, ctx.Err()) {
			i.log.Warn("gateway: tunnel drain failed", "err", err)
		}
	}
	_ = i.internal.Close()
	return ctx.Err()
}

// drainGauge keeps sbx_gateway_drain_open_streams current during the
// drain; stop sets the final values.
func (i *Instance) drainGauge() (stop func()) {
	update := func() {
		i.metrics.DrainOpenStreams.WithLabelValues("http").Set(float64(i.streams.Count()))
		n := 0
		if i.ssh != nil {
			n = i.ssh.Sessions()
		}
		i.metrics.DrainOpenStreams.WithLabelValues("ssh").Set(float64(n))
	}
	update()
	done := make(chan struct{})
	var wg sync.WaitGroup
	wg.Go(func() {
		t := time.NewTicker(drainGaugeEvery)
		defer t.Stop()
		for {
			select {
			case <-done:
				return
			case <-t.C:
				update()
			}
		}
	})
	return func() {
		close(done)
		wg.Wait()
		update()
	}
}

// waitFor polls done every drainPoll until it holds, ctx ends or until
// (when not zero) passes.
func waitFor(ctx context.Context, until time.Time, done func() bool) {
	for !done() {
		d := drainPoll
		if !until.IsZero() {
			left := time.Until(until)
			if left <= 0 {
				return
			}
			d = min(d, left)
		}
		if !sleepCtx(ctx, d) {
			return
		}
	}
}

// sleepUntil waits until t or ctx is done; it reports whether t came.
func sleepUntil(ctx context.Context, t time.Time) bool {
	return sleepCtx(ctx, time.Until(t))
}

// sleepCtx waits d or until ctx is done; it reports whether d passed.
func sleepCtx(ctx context.Context, d time.Duration) bool {
	if d <= 0 {
		return ctx.Err() == nil
	}
	timer := time.NewTimer(d)
	defer timer.Stop()
	select {
	case <-timer.C:
		return true
	case <-ctx.Done():
		return false
	}
}
