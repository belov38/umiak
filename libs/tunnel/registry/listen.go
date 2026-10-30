package registry

import (
	"context"
	"errors"
	"fmt"
	"log/slog"
	"sort"
	"strings"
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
	// Channels are extra channels LISTENed on the same connection, by exact
	// (case-sensitive) name. Each non-nil handler is called with the NOTIFY
	// payload, and with "" after every (re)LISTEN. Names must be 1 to 63
	// bytes and differ from the tunnel channels (see Validate).
	Channels map[string]func(payload string)
}

// maxChannelLen is the longest channel name Postgres keeps as is
// (NAMEDATALEN - 1); longer names are truncated and would never match.
const maxChannelLen = 63

// Validate checks the extra channel names: they must be 1 to 63 bytes long
// and must not be one of the tunnel channels (wire.NotifyChannel,
// wire.NotifyInstancesChannel).
func (h ListenHandlers) Validate() error {
	for name := range h.Channels {
		switch {
		case name == wire.NotifyChannel || name == wire.NotifyInstancesChannel:
			return fmt.Errorf("registry: listen channel %q is reserved for the tunnel", name)
		case name == "" || len(name) > maxChannelLen || strings.IndexByte(name, 0) >= 0:
			return fmt.Errorf("registry: invalid listen channel name %q", name)
		}
	}
	return nil
}

// listenSQL returns the LISTEN statements for the tunnel and extra channels.
func (h ListenHandlers) listenSQL() string {
	names := []string{wire.NotifyChannel, wire.NotifyInstancesChannel}
	extra := make([]string, 0, len(h.Channels))
	for name := range h.Channels {
		extra = append(extra, name)
	}
	sort.Strings(extra)
	names = append(names, extra...)
	stmts := make([]string, len(names))
	for i, name := range names {
		stmts[i] = "LISTEN " + pgx.Identifier{name}.Sanitize()
	}
	return strings.Join(stmts, "; ")
}

// Listen LISTENs on the session and instance channels, plus h.Channels, over
// one dedicated connection and calls the handlers until ctx is done. After every successful
// (re)LISTEN each non-nil handler is called with "" because notifications may
// have been missed while the connection was down. Connection errors are
// retried with backoff from 250 ms to 5 s. An idle connection is pinged
// every 30 s; a ping that fails or takes over 5 s counts as a connection
// error. Listen returns ctx.Err(), or the Validate error of h at once.
func (s *Store) Listen(ctx context.Context, h ListenHandlers) error {
	if err := h.Validate(); err != nil {
		return err
	}
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

	if _, err = conn.Exec(ctx, h.listenSQL()); err != nil {
		return err
	}
	established()
	if h.Session != nil {
		h.Session("")
	}
	if h.Instance != nil {
		h.Instance("")
	}
	for _, fn := range h.Channels {
		if fn != nil {
			fn("")
		}
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
		default:
			if fn := h.Channels[n.Channel]; fn != nil {
				fn(n.Payload)
			}
		}
	}
}
