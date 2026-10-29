package gateway

import (
	"context"
	"errors"
	"fmt"
	"log/slog"
	"net"
	"net/http"
	"sync"
	"time"

	"connectrpc.com/connect"
	"google.golang.org/protobuf/types/known/timestamppb"

	tunnelv1 "github.com/belov38/boat-dev-clone/libs/proto/sbx/tunnel/v1"
	"github.com/belov38/boat-dev-clone/libs/proto/sbx/tunnel/v1/tunnelv1connect"
	"github.com/belov38/boat-dev-clone/libs/tunnel/registry"
	"github.com/belov38/boat-dev-clone/libs/tunnel/transport"
	"github.com/belov38/boat-dev-clone/libs/tunnel/wire"
)

// sessionState is the lifecycle of a local session (spec 7, 8.3):
//
//	active → draining (Drain sent) → moved (fenced while draining) → closed
//	active → closed (fenced while not draining, retired, conn died, shutdown)
//
// A moved session refuses new calls (Task 8 answers 421), has its RPC
// streams aborted with ErrMachineMoved, and keeps each TCP stream and
// unary call in flight until its own drain deadline counted from the move;
// the connection closes once none of them remain.
type sessionState int32

const (
	stateActive sessionState = iota
	stateDraining
	stateMoved
	stateClosed
)

func (st sessionState) String() string {
	switch st {
	case stateActive:
		return "active"
	case stateDraining:
		return "draining"
	case stateMoved:
		return "moved"
	default:
		return "closed"
	}
}

// serving reports whether new calls may be sent on a session in this state.
func (st sessionState) serving() bool { return st == stateActive || st == stateDraining }

// Connection event types (spec 9.6).
const (
	evConnected       = "connected"
	evDisconnected    = "disconnected"
	evAgentRestarted  = "agent_restarted"
	evRebooted        = "rebooted"
	evIdentityChanged = "identity_changed"
)

// Timeouts of background calls.
const (
	// rotateRetry is the wait before retrying a failed token rotation.
	rotateRetry = 30 * time.Second
	// maxMessageBytes is the Connect message limit (spec 4.3).
	maxMessageBytes = 16 << 20
)

// errNotActive refuses token rotation on a session that is not active.
var errNotActive = errors.New("gateway: token rotation needs an active session")

// session is one admitted agent connection on this instance.
type session struct {
	g         *Gateway
	log       *slog.Logger
	machineID string
	hello     transport.Hello
	info      transport.ConnInfo
	res       registry.AdmitResult
	conn      *watchedConn
	cc        *http.ClientConn
	mc        *MachineConn
	control   tunnelv1connect.ControlClient
	events    tunnelv1connect.EventsClient

	// ctx lives as long as the session; it stops its goroutines.
	ctx    context.Context
	cancel context.CancelFunc
	wg     sync.WaitGroup // goroutines started by start
	done   chan struct{}  // closed when the session is fully finished
	rotMu  sync.Mutex     // serializes token rotations

	mu       sync.Mutex
	st       sessionState
	reason   string // first close or fence reason
	streams  map[*stream]struct{}
	tcpCount int
	movedAt  time.Time
}

func newSession(g *Gateway, hello transport.Hello, info transport.ConnInfo, res registry.AdmitResult,
	conn *watchedConn, cc *http.ClientConn,
) *session {
	s := &session{
		g:         g,
		log:       g.log.With("machine_id", hello.MachineID, "conn_id", info.ConnID, "epoch", info.Epoch),
		machineID: hello.MachineID,
		hello:     hello,
		info:      info,
		res:       res,
		conn:      conn,
		cc:        cc,
		done:      make(chan struct{}),
		streams:   map[*stream]struct{}{},
	}
	s.ctx, s.cancel = context.WithCancel(g.bg)
	s.mc = &MachineConn{s: s}
	hc := &http.Client{Transport: s.mc}
	opts := []connect.ClientOption{connect.WithReadMaxBytes(maxMessageBytes), connect.WithSendMaxBytes(maxMessageBytes)}
	s.control = tunnelv1connect.NewControlClient(hc, agentBaseURL, opts...)
	s.events = tunnelv1connect.NewEventsClient(hc, agentBaseURL, opts...)
	return s
}

// start registers the session, runs it until its connection dies and then
// finishes it. It blocks for the whole life of the session.
func (s *session) start() {
	g := s.g
	g.mu.Lock()
	var old *session
	switch cur := g.sessions[s.machineID]; {
	case g.closing:
		g.mu.Unlock()
		s.close("gateway shutting down")
		s.finish()
		return
	case cur != nil && cur.info.Epoch > s.info.Epoch:
		g.mu.Unlock()
		s.close("superseded by a newer local session")
		s.finish()
		return
	default:
		old = cur
		g.sessions[s.machineID] = s
	}
	g.mu.Unlock()
	if old != nil {
		old.close("replaced by a newer connection")
	}
	s.log.Info("gateway: session started", "auth", authName(s.hello.Scheme), "agent_instance_id", s.hello.AgentInstanceID)
	// A fence that arrived between admission and registration found no
	// local session: check once more now.
	g.fenceQ.push(s.machineID)

	s.cc.SetStateHook(func(cc *http.ClientConn) {
		if cc.Err() != nil {
			s.conn.markDead()
		}
	})
	s.sendConnectedEvents()
	s.wg.Go(s.pumpEvents)
	s.wg.Go(s.infoAndRotation)
	<-s.conn.done
	s.finish()
}

// state returns the current state.
func (s *session) state() sessionState {
	s.mu.Lock()
	defer s.mu.Unlock()
	return s.st
}

// markDraining moves an active session to draining. It reports whether the
// session is draining now.
func (s *session) markDraining() bool {
	s.mu.Lock()
	defer s.mu.Unlock()
	if s.st == stateActive {
		s.st = stateDraining
	}
	return s.st == stateDraining
}

// close closes the connection; finish runs once the connection is dead.
func (s *session) close(reason string) {
	s.mu.Lock()
	if s.reason == "" {
		s.reason = reason
	}
	s.st = stateClosed
	s.mu.Unlock()
	_ = s.cc.Close()
	_ = s.conn.Close()
}

// fence handles a session superseded in the registry: a draining session
// moves, any other one closes now.
func (s *session) fence(reason string) {
	s.mu.Lock()
	switch s.st {
	case stateDraining:
		s.st = stateMoved
		s.movedAt = time.Now()
		if s.reason == "" {
			s.reason = reason
		}
		var abort []*stream
		lingering := 0
		for st := range s.streams {
			if st.kind == kindRPCStream {
				abort = append(abort, st)
				continue
			}
			lingering++
			st.timer = time.AfterFunc(st.deadline, func() {
				st.cancel(ErrMachineMoved)
				s.untrack(st)
			})
		}
		s.mu.Unlock()
		s.log.Info("gateway: session moved while draining", "reason", reason,
			"aborted_rpc_streams", len(abort), "lingering_streams", lingering)
		for _, st := range abort {
			st.cancel(ErrMachineMoved)
		}
		if lingering == 0 {
			s.close("moved: no streams left")
		}
	case stateActive:
		s.mu.Unlock()
		s.log.Info("gateway: session fenced", "reason", reason)
		s.close(reason)
	default:
		s.mu.Unlock()
	}
}

// finish tears the session down after its connection died: it aborts the
// tracked requests, unregisters the session, marks it disconnected in the
// registry (fenced by epoch), queues disconnected when that write changed
// the row, and waits for its goroutines. The registry write never waits for
// event delivery.
func (s *session) finish() {
	g := s.g
	s.mu.Lock()
	s.st = stateClosed
	reason := s.reason
	if reason == "" {
		reason = "connection lost"
	}
	streams := make([]*stream, 0, len(s.streams))
	for st := range s.streams {
		streams = append(streams, st)
		if st.timer != nil {
			st.timer.Stop()
		}
	}
	s.mu.Unlock()
	for _, st := range streams {
		st.cancel(ErrSessionClosed)
	}
	s.cancel()
	_ = s.cc.Close()
	_ = s.conn.Close()

	g.mu.Lock()
	if g.sessions[s.machineID] == s {
		delete(g.sessions, s.machineID)
	}
	g.mu.Unlock()

	if !g.abandoned.Load() {
		ctx, cancel := context.WithTimeout(g.bg, dbTimeout)
		changed, err := g.store.Disconnect(ctx, s.machineID, g.cfg.InstanceID, s.info.Epoch)
		cancel()
		switch {
		case err != nil:
			s.log.Warn("gateway: marking session disconnected failed", "err", err)
		case changed:
			g.goEvents(newConnectionEvent(s.machineID, s.info.Epoch, evDisconnected,
				s.hello.AgentInstanceID, time.Now()))
		}
	}
	s.wg.Wait()
	s.log.Info("gateway: session closed", "reason", reason)
	close(s.done)
}

// sendConnectedEvents queues connected and the identity changes derived
// from the previous session (spec 5.1).
func (s *session) sendConnectedEvents() {
	now := time.Now()
	types := []string{evConnected}
	if p := s.res.Prev; p != nil {
		switch {
		case p.BootID != s.hello.BootID:
			types = append(types, evRebooted)
		case p.AgentInstanceID != s.hello.AgentInstanceID:
			types = append(types, evAgentRestarted)
		}
		if p.Vmgenid != s.hello.Vmgenid {
			types = append(types, evIdentityChanged)
		}
	}
	evs := make([]*tunnelv1.ConnectionEvent, 0, len(types))
	for _, typ := range types {
		evs = append(evs, newConnectionEvent(s.machineID, s.info.Epoch, typ, s.hello.AgentInstanceID, now))
	}
	s.g.goEvents(evs...)
}

// infoAndRotation stores the agent's capabilities, then keeps the machine
// token fresh: right away after a bootstrap login or when the token is
// missing or older than TokenMaxAge, then every TokenMaxAge. It stops once
// the session is no longer active: only the active session of a machine
// rotates, so a draining or moved one cannot hand the agent a stale token.
func (s *session) infoAndRotation() {
	ctx := s.ctx
	ictx, cancel := context.WithTimeout(ctx, infoTimeout)
	resp, err := s.control.Info(ictx, connect.NewRequest(&tunnelv1.InfoRequest{}))
	cancel()
	if err != nil {
		if ctx.Err() == nil {
			s.log.Warn("gateway: Control/Info failed", "err", err)
		}
	} else {
		uctx, cancel := context.WithTimeout(ctx, dbTimeout)
		ok, err := s.g.store.UpdateSessionInfo(uctx, s.machineID, s.info.Epoch, resp.Msg.GetCapabilities())
		cancel()
		switch {
		case err != nil:
			s.log.Warn("gateway: storing capabilities failed", "err", err)
		case !ok:
			s.log.Debug("gateway: capabilities not stored, session superseded")
		}
	}

	maxAge := s.g.cfg.Timing.TokenMaxAge
	var wait time.Duration
	if s.hello.Scheme != transport.AuthBootstrap && s.res.MTIssuedAt != nil {
		wait = max(maxAge-time.Since(*s.res.MTIssuedAt), 0)
	}
	for {
		if wait > 0 {
			t := time.NewTimer(wait)
			select {
			case <-ctx.Done():
				t.Stop()
				return
			case <-t.C:
			}
		}
		if s.state() != stateActive {
			return
		}
		if err := s.rotateToken(ctx); err != nil {
			if ctx.Err() != nil || errors.Is(err, errNotActive) {
				return
			}
			s.log.Warn("gateway: machine token rotation failed", "err", err, "retry_in", rotateRetry)
			wait = min(rotateRetry, maxAge)
			continue
		}
		wait = maxAge
	}
}

// rotateToken issues a new machine token in two phases (spec 5.2):
// BeginRotation stores the next hash, Control/SetToken hands the token to the
// agent, CompleteRotation promotes it. If the agent reconnects with the next
// token first, Admit promotes it and CompleteRotation is a no-op. Only an
// active session rotates (errNotActive otherwise). Task 8's rotate-token
// endpoint calls this too.
func (s *session) rotateToken(ctx context.Context) error {
	s.rotMu.Lock()
	defer s.rotMu.Unlock()
	if st := s.state(); st != stateActive {
		return fmt.Errorf("%w (%s)", errNotActive, st)
	}
	tok, err := wire.NewSecret()
	if err != nil {
		return err
	}
	hash := wire.HashSecret(tok)
	if err := s.g.store.BeginRotation(ctx, s.machineID, hash); err != nil {
		return fmt.Errorf("begin rotation: %w", err)
	}
	if _, err := s.control.SetToken(ctx, connect.NewRequest(&tunnelv1.SetTokenRequest{Token: tok})); err != nil {
		return fmt.Errorf("Control/SetToken: %w", err)
	}
	promoted, err := s.g.store.CompleteRotation(ctx, s.machineID, hash)
	if err != nil {
		return fmt.Errorf("complete rotation: %w", err)
	}
	s.log.Info("gateway: machine token rotated", "promoted_now", promoted)
	return nil
}

func newConnectionEvent(machineID string, epoch uint64, typ, agentInstanceID string, at time.Time) *tunnelv1.ConnectionEvent {
	return &tunnelv1.ConnectionEvent{
		MachineId:  machineID,
		Epoch:      epoch,
		Type:       typ,
		Time:       timestamppb.New(at),
		InstanceId: agentInstanceID,
	}
}

// watchedConn reports the death of the tunnel connection: Close, or a read
// error seen by the HTTP/2 read loop.
type watchedConn struct {
	net.Conn
	once sync.Once
	done chan struct{}
}

func newWatchedConn(c net.Conn) *watchedConn {
	return &watchedConn{Conn: c, done: make(chan struct{})}
}

func (c *watchedConn) markDead() { c.once.Do(func() { close(c.done) }) }

func (c *watchedConn) Read(p []byte) (int, error) {
	n, err := c.Conn.Read(p)
	if err != nil {
		var ne net.Error
		if !errors.As(err, &ne) || !ne.Timeout() {
			c.markDead()
		}
	}
	return n, err
}

func (c *watchedConn) Close() error {
	err := c.Conn.Close()
	c.markDead()
	return err
}
