package registry

import (
	"context"
	"errors"
	"fmt"
	"log/slog"
	"time"

	"github.com/jackc/pgx/v5"

	"github.com/belov38/boat-dev-clone/libs/tunnel/wire"
)

// Backoff bounds for reconnecting the LISTEN connection.
const (
	listenBackoffMin = 250 * time.Millisecond
	listenBackoffMax = 5 * time.Second
)

// Liveness of the LISTEN connection: after listenIdle without a
// notification the connection is pinged; a ping that fails or takes longer
// than listenPingTimeout (a half-open connection) causes a reconnect and a
// resync.
const (
	listenIdle        = 30 * time.Second
	listenPingTimeout = 5 * time.Second
)

// ListenHandlers receive Postgres notifications. A nil field is ignored.
// Handlers run sequentially on the listener goroutine, so they must not block
// for long.
type ListenHandlers struct {
	// Session is called with the machine id of a changed tunnel session or
	// credentials row, or with "" after (re)connecting, meaning "resync all".
	Session func(machineID string)
	// Instance is called with the id of a changed gateway instance, or with ""
	// after (re)connecting, meaning "resync all".
	Instance func(instanceID string)
}

// Listen LISTENs on the session and instance channels over one dedicated
// connection and calls the handlers until ctx is done. After every successful
// (re)LISTEN each non-nil handler is called with "" because notifications may
// have been missed while the connection was down. Connection errors are
// retried with backoff from 250 ms to 5 s. An idle connection is pinged
// every 30 s; a ping that fails or takes over 5 s counts as a connection
// error. Listen returns ctx.Err().
func (s *Store) Listen(ctx context.Context, h ListenHandlers) error {
	backoff := listenBackoffMin
	for {
		err := s.listenOnce(ctx, h, func() { backoff = listenBackoffMin })
		if ctx.Err() != nil {
			return ctx.Err()
		}
		slog.Warn("registry: listen connection lost", "err", err, "retry_in", backoff)
		select {
		case <-ctx.Done():
			return ctx.Err()
		case <-time.After(backoff):
		}
		backoff = min(backoff*2, listenBackoffMax)
	}
}

// listenOnce runs one LISTEN connection until it fails or ctx is done.
// established is called once LISTEN succeeded.
func (s *Store) listenOnce(ctx context.Context, h ListenHandlers, established func()) error {
	pc, err := s.pool.Acquire(ctx)
	if err != nil {
		return err
	}
	// The connection carries LISTEN state, so it must never go back to the pool.
	conn := pc.Hijack()
	defer func() {
		cctx, cancel := context.WithTimeout(context.WithoutCancel(ctx), 2*time.Second)
		defer cancel()
		_ = conn.Close(cctx)
	}()

	_, err = conn.Exec(ctx, "LISTEN "+pgx.Identifier{wire.NotifyChannel}.Sanitize()+
		"; LISTEN "+pgx.Identifier{wire.NotifyInstancesChannel}.Sanitize())
	if err != nil {
		return err
	}
	established()
	if h.Session != nil {
		h.Session("")
	}
	if h.Instance != nil {
		h.Instance("")
	}
	for {
		wctx, cancel := context.WithTimeout(ctx, s.listenIdle)
		n, err := conn.WaitForNotification(wctx)
		cancel()
		if err != nil {
			if ctx.Err() != nil || !errors.Is(err, context.DeadlineExceeded) {
				return err
			}
			// Idle: make sure the connection is still there. Notifications
			// that arrive meanwhile are queued by pgx for the next wait.
			s.listenPings.Add(1)
			pctx, pcancel := context.WithTimeout(ctx, s.listenPingTimeout)
			_, err = conn.Exec(pctx, "SELECT 1")
			pcancel()
			if err != nil {
				return fmt.Errorf("listen connection ping: %w", err)
			}
			continue
		}
		switch n.Channel {
		case wire.NotifyChannel:
			if h.Session != nil {
				h.Session(n.Payload)
			}
		case wire.NotifyInstancesChannel:
			if h.Instance != nil {
				h.Instance(n.Payload)
			}
		}
	}
}
