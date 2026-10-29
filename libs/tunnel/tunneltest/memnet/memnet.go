// Package memnet is an in-memory transport for tests. It implements
// transport.Dialer on the agent side and routes dials to registered
// transport.Admitter gateways, and it can inject faults into every link: cut,
// stall, and dial failures.
//
// The conns it hands out are full net.Conn implementations (deadlines,
// bounded buffers with backpressure) and need no background goroutines.
package memnet

import (
	"context"
	"net"
	"sync"
	"sync/atomic"
	"time"

	"github.com/belov38/boat-dev-clone/libs/tunnel/transport"
)

const (
	defaultBufferSize = 256 << 10
	defaultDeadAfter  = 15 * time.Second
)

// Options configures a Network.
type Options struct {
	// BufferSize is the per-direction buffer in bytes (default 256 KiB). A
	// writer blocks once this many unread bytes are queued.
	BufferSize int
	// DeadAfter emulates the WebSocket liveness timeout (default 15 s): a
	// stall of at least this long closes the link when it elapses.
	DeadAfter time.Duration
}

type gateway struct {
	name  string
	adm   transport.Admitter
	ready func() bool
}

// Network is a set of gateways and the links dialed to them.
type Network struct {
	opts Options

	mu    sync.Mutex
	gws   []*gateway
	rr    int
	fault func(transport.Hello) error
	links map[string][]*Link // by machine id, oldest first
}

// New returns an empty Network.
func New(opts Options) *Network {
	if opts.BufferSize <= 0 {
		opts.BufferSize = defaultBufferSize
	}
	if opts.DeadAfter <= 0 {
		opts.DeadAfter = defaultDeadAfter
	}
	return &Network{opts: opts, links: map[string][]*Link{}}
}

// AddGateway registers a gateway. A nil ready means always ready. Adding a
// name that exists replaces the gateway in place.
func (n *Network) AddGateway(name string, adm transport.Admitter, ready func() bool) {
	if ready == nil {
		ready = func() bool { return true }
	}
	n.mu.Lock()
	defer n.mu.Unlock()
	g := &gateway{name: name, adm: adm, ready: ready}
	for i, old := range n.gws {
		if old.name == name {
			n.gws[i] = g
			return
		}
	}
	n.gws = append(n.gws, g)
}

// RemoveGateway stops routing new dials to the gateway. Existing links are
// not touched; use CutGateway to kill them as well.
func (n *Network) RemoveGateway(name string) {
	n.mu.Lock()
	defer n.mu.Unlock()
	for i, g := range n.gws {
		if g.name == name {
			n.gws = append(n.gws[:i:i], n.gws[i+1:]...)
			if n.rr > i {
				n.rr--
			}
			return
		}
	}
}

// SetDialFault installs a hook that runs on every dial after a gateway was
// picked and before admission. A non-nil error is returned from Dial
// unchanged. nil clears the hook.
func (n *Network) SetDialFault(f func(transport.Hello) error) {
	n.mu.Lock()
	n.fault = f
	n.mu.Unlock()
}

// Dialer returns the agent-side dialer of the network ("ingress").
func (n *Network) Dialer() transport.Dialer { return dialer{n} }

// Links returns the live links of a machine, oldest first.
func (n *Network) Links(machineID string) []*Link {
	n.mu.Lock()
	defer n.mu.Unlock()
	return append([]*Link(nil), n.links[machineID]...)
}

// CutAll cuts every live link.
func (n *Network) CutAll() { n.cutWhere(func(*Link) bool { return true }) }

// CutGateway cuts every live link served by the named gateway.
func (n *Network) CutGateway(name string) {
	n.cutWhere(func(l *Link) bool { return l.Gateway == name })
}

func (n *Network) cutWhere(match func(*Link) bool) {
	n.mu.Lock()
	var victims []*Link
	for _, ls := range n.links {
		for _, l := range ls {
			if match(l) {
				victims = append(victims, l)
			}
		}
	}
	n.mu.Unlock()
	for _, l := range victims {
		l.Cut()
	}
}

func (n *Network) register(l *Link) {
	n.mu.Lock()
	defer n.mu.Unlock()
	if l.isClosed() {
		return // died before it was registered
	}
	n.links[l.MachineID] = append(n.links[l.MachineID], l)
}

func (n *Network) unregister(l *Link) {
	n.mu.Lock()
	defer n.mu.Unlock()
	ls := n.links[l.MachineID]
	for i, x := range ls {
		if x == l {
			ls = append(ls[:i:i], ls[i+1:]...)
			break
		}
	}
	if len(ls) == 0 {
		delete(n.links, l.MachineID)
	} else {
		n.links[l.MachineID] = ls
	}
}

// pick returns the next ready gateway in round-robin order.
func (n *Network) pick() *gateway {
	n.mu.Lock()
	gws := append([]*gateway(nil), n.gws...)
	start := n.rr
	n.mu.Unlock()
	// ready runs without the lock: it may call back into the network.
	for i := range gws {
		idx := (start + i) % len(gws)
		if gws[idx].ready() {
			n.mu.Lock()
			n.rr = idx + 1
			n.mu.Unlock()
			return gws[idx]
		}
	}
	return nil
}

type dialer struct{ n *Network }

func (d dialer) Dial(ctx context.Context, hello transport.Hello) (net.Conn, transport.ConnInfo, error) {
	n := d.n
	if err := ctx.Err(); err != nil {
		return nil, transport.ConnInfo{}, err
	}
	g := n.pick()
	if g == nil {
		return nil, transport.ConnInfo{}, &transport.RejectError{
			Status:     503,
			RetryAfter: time.Second,
			Reason:     "no ready gateway",
		}
	}
	n.mu.Lock()
	fault := n.fault
	n.mu.Unlock()
	if fault != nil {
		if err := fault(hello); err != nil {
			return nil, transport.ConnInfo{}, err
		}
	}
	adm, err := g.adm.Admit(ctx, hello)
	if err != nil {
		return nil, transport.ConnInfo{}, err
	}
	if err := ctx.Err(); err != nil {
		adm.Abort(err)
		return nil, transport.ConnInfo{}, err
	}

	info := adm.Info()
	l := newLink(n, hello.MachineID, g.name, info)
	adm.Serve(l.gw)
	n.register(l)
	return l.agent, info, nil
}

// Link is one established agent-to-gateway connection.
type Link struct {
	MachineID string
	Gateway   string
	Info      transport.ConnInfo

	net   *Network
	agent *conn
	gw    *conn
	a2g   *half
	g2a   *half
	base  time.Time // monotonic reference for stallUntil

	closed     chan struct{}
	closedOnce sync.Once
	deadAfter  time.Duration
	stallEnds  atomic.Int64 // ns since base; delivery is stopped before this instant

	mu        sync.Mutex // guards the fields below
	stopped   bool       // timers are torn down: cut, or both ends closed
	ends      int        // number of closed ends
	wakeTimer *time.Timer
	deadTimer *time.Timer
}

func newLink(n *Network, machineID, gwName string, info transport.ConnInfo) *Link {
	l := &Link{
		MachineID: machineID,
		Gateway:   gwName,
		Info:      info,
		net:       n,
		base:      time.Now(),
		closed:    make(chan struct{}),
		deadAfter: n.opts.DeadAfter,
	}
	l.a2g = newHalf(l, n.opts.BufferSize)
	l.g2a = newHalf(l, n.opts.BufferSize)
	agentAddr := addr("agent:" + machineID)
	gwAddr := addr("gateway:" + gwName)
	l.agent = &conn{
		link: l, r: l.g2a, w: l.a2g, rd: newDeadline(), wd: newDeadline(),
		local: agentAddr, remote: gwAddr,
	}
	l.gw = &conn{
		link: l, r: l.a2g, w: l.g2a, rd: newDeadline(), wd: newDeadline(),
		local: gwAddr, remote: agentAddr,
	}
	return l
}

// Closed is closed once the link is dead: it was cut, either end was closed
// (including the agent end closed by a stall of DeadAfter or more).
func (l *Link) Closed() <-chan struct{} { return l.closed }

func (l *Link) isClosed() bool {
	select {
	case <-l.closed:
		return true
	default:
		return false
	}
}

// Cut kills the link now: both ends fail with an error wrapping
// net.ErrClosed and buffered data is discarded. It is safe to call
// repeatedly and concurrently.
func (l *Link) Cut() {
	l.a2g.doCut()
	l.g2a.doCut()
	for _, c := range []*conn{l.agent, l.gw} {
		c.rd.stop()
		c.wd.stop()
	}
	l.stopTimers()
	l.markClosed()
}

// endClosed records that one end was closed. The stall timers keep running
// until both ends are closed, so a stall still ends (and DeadAfter still
// closes the agent end) when the peer closed first.
func (l *Link) endClosed() {
	l.mu.Lock()
	l.ends++
	both := l.ends >= 2
	l.mu.Unlock()
	if both {
		l.stopTimers()
	}
	l.markClosed()
}

func (l *Link) stopTimers() {
	l.mu.Lock()
	defer l.mu.Unlock()
	l.stopped = true
	if l.wakeTimer != nil {
		l.wakeTimer.Stop()
	}
	if l.deadTimer != nil {
		l.deadTimer.Stop()
	}
}

// markClosed fires Closed() and removes the link from the network.
func (l *Link) markClosed() {
	l.closedOnce.Do(func() {
		close(l.closed)
		l.net.unregister(l)
	})
}

// now is the monotonic time since the link was created.
func (l *Link) now() int64 { return int64(time.Since(l.base)) }

func (l *Link) stalled() bool { return l.now() < l.stallEnds.Load() }

// Stall stops delivery in both directions for d. Writers can fill the buffer
// and then block; readers see nothing. Stalls do not shorten each other: the
// link stays stalled until the latest end. If d >= DeadAfter the agent end is
// closed when DeadAfter elapses (its WebSocket liveness timeout); the gateway
// end stays blackholed until the stall ends and only then sees the peer
// closed. Safe for concurrent use, also after one end was closed.
func (l *Link) Stall(d time.Duration) {
	if d <= 0 {
		return
	}
	l.mu.Lock()
	defer l.mu.Unlock()
	if l.stopped {
		return
	}
	end := l.now() + int64(d)
	if end > l.stallEnds.Load() {
		l.stallEnds.Store(end)
		// Wake stalled readers when the stall ends.
		if l.wakeTimer == nil {
			l.wakeTimer = time.AfterFunc(d, l.wake)
		} else {
			l.wakeTimer.Reset(d)
		}
	}
	if d >= l.deadAfter && l.deadTimer == nil {
		l.deadTimer = time.AfterFunc(l.deadAfter, func() { _ = l.agent.Close() })
	}
}

func (l *Link) wake() {
	l.a2g.wake()
	l.g2a.wake()
}
