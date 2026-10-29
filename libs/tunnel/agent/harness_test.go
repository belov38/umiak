package agent_test

import (
	"context"
	"crypto/rand"
	"errors"
	"fmt"
	"io"
	"log/slog"
	"net"
	"net/http"
	"sync"
	"sync/atomic"
	"testing"
	"time"

	"connectrpc.com/connect"

	tunnelv1 "github.com/belov38/boat-dev-clone/libs/proto/sbx/tunnel/v1"
	"github.com/belov38/boat-dev-clone/libs/proto/sbx/tunnel/v1/tunnelv1connect"
	"github.com/belov38/boat-dev-clone/libs/tunnel/agent"
	"github.com/belov38/boat-dev-clone/libs/tunnel/h2"
	"github.com/belov38/boat-dev-clone/libs/tunnel/transport"
	"github.com/belov38/boat-dev-clone/libs/tunnel/tunneltest/memnet"
)

const testMachineID = "machine-1"

// waitTimeout bounds every wait in these tests; it is generous on purpose.
const waitTimeout = 10 * time.Second

// attempt is one dial seen by the fake gateway.
type attempt struct {
	hello transport.Hello
	at    time.Time
	err   error
}

// gwConn is the gateway end of one admitted tunnel connection.
type gwConn struct {
	hello   transport.Hello
	info    transport.ConnInfo
	at      time.Time
	cc      *http.ClientConn
	control tunnelv1connect.ControlClient
	events  tunnelv1connect.EventsClient
}

// fakeGateway is a transport.Admitter on memnet. It records every hello,
// answers with the scripted reject (nil admits) and runs an HTTP/2 client on
// admitted connections.
type fakeGateway struct {
	t      *testing.T
	name   string
	epoch  atomic.Uint64
	reject func(n int, h transport.Hello) error // n counts attempts from 0

	mu       sync.Mutex
	attempts []attempt
	notify   chan struct{} // closed and replaced on every attempt
	conns    chan *gwConn
	all      []*gwConn
}

func newFakeGateway(t *testing.T, name string) *fakeGateway {
	g := &fakeGateway{t: t, name: name, notify: make(chan struct{}), conns: make(chan *gwConn, 64)}
	t.Cleanup(func() {
		g.mu.Lock()
		defer g.mu.Unlock()
		for _, c := range g.all {
			_ = c.cc.Close()
		}
	})
	return g
}

func (g *fakeGateway) Admit(_ context.Context, h transport.Hello) (transport.Admission, error) {
	g.mu.Lock()
	n := len(g.attempts)
	reject := g.reject
	g.mu.Unlock()
	var err error
	if reject != nil {
		err = reject(n, h)
	}
	g.mu.Lock()
	g.attempts = append(g.attempts, attempt{hello: h, at: time.Now(), err: err})
	close(g.notify)
	g.notify = make(chan struct{})
	g.mu.Unlock()
	if err != nil {
		return nil, err
	}
	ep := g.epoch.Add(1)
	return &fakeAdmission{g: g, hello: h, info: transport.ConnInfo{
		GatewayInstance: g.name,
		Epoch:           ep,
		ConnID:          fmt.Sprintf("%s-conn-%d", g.name, ep),
	}}, nil
}

func (g *fakeGateway) setReject(f func(n int, h transport.Hello) error) {
	g.mu.Lock()
	g.reject = f
	g.mu.Unlock()
}

// waitAttempts blocks until at least n attempts were seen and returns them.
func (g *fakeGateway) waitAttempts(n int) []attempt {
	g.t.Helper()
	deadline := time.After(waitTimeout)
	for {
		g.mu.Lock()
		if len(g.attempts) >= n {
			out := append([]attempt(nil), g.attempts...)
			g.mu.Unlock()
			return out
		}
		ch := g.notify
		g.mu.Unlock()
		select {
		case <-ch:
		case <-deadline:
			g.t.Fatalf("timed out waiting for %d dial attempts", n)
		}
	}
}

func (g *fakeGateway) attemptCount() int {
	g.mu.Lock()
	defer g.mu.Unlock()
	return len(g.attempts)
}

// nextConn returns the next admitted connection with a running HTTP/2 client.
func (g *fakeGateway) nextConn() *gwConn {
	g.t.Helper()
	select {
	case c := <-g.conns:
		return c
	case <-time.After(waitTimeout):
		g.t.Fatal("timed out waiting for a tunnel connection")
		return nil
	}
}

type fakeAdmission struct {
	g     *fakeGateway
	hello transport.Hello
	info  transport.ConnInfo
}

func (a *fakeAdmission) Info() transport.ConnInfo { return a.info }
func (a *fakeAdmission) Abort(error)              {}

func (a *fakeAdmission) Serve(conn net.Conn) {
	at := time.Now()
	go func() {
		cc, err := h2.NewClientConn(context.Background(), conn, h2.DefaultClientConfig())
		if err != nil {
			_ = conn.Close()
			return
		}
		hc := &http.Client{Transport: cc}
		c := &gwConn{
			hello:   a.hello,
			info:    a.info,
			at:      at,
			cc:      cc,
			control: tunnelv1connect.NewControlClient(hc, "http://agent"),
			events:  tunnelv1connect.NewEventsClient(hc, "http://agent"),
		}
		a.g.mu.Lock()
		a.g.all = append(a.g.all, c)
		a.g.mu.Unlock()
		a.g.conns <- c
	}()
}

// fakeCreds is a Credentials that counts Bootstrap calls.
type fakeCreds struct {
	bs    []byte
	calls atomic.Int32
}

func newFakeCreds(t *testing.T) *fakeCreds {
	t.Helper()
	bs := make([]byte, 32)
	if _, err := rand.Read(bs); err != nil {
		t.Fatal(err)
	}
	return &fakeCreds{bs: bs}
}

func (c *fakeCreds) Bootstrap(context.Context) (string, []byte, error) {
	c.calls.Add(1)
	return testMachineID, c.bs, nil
}

// env is one agent client on a memnet network with one fake gateway.
type env struct {
	t      *testing.T
	net    *memnet.Network
	gw     *fakeGateway
	creds  *fakeCreds
	cancel   context.CancelFunc
	done     chan error
	stopOnce sync.Once

	evMu   sync.Mutex
	events []agent.ConnEvent
}

// fastConfig returns a config with small timings; the caller fills Dialer
// and Credentials via startEnv.
func fastConfig() agent.Config {
	return agent.Config{
		Identity: agent.Identity{BootID: "boot-1", InstanceID: "inst-1", Vmgenid: "gen-1", Version: "1.2.3"},
		Backoff:  agent.Backoff{First: 5 * time.Millisecond, Base: 10 * time.Millisecond, Max: 20 * time.Millisecond, ResetAfter: time.Minute},
		RejectDelays: agent.RejectDelays{
			BadBootstrap: 20 * time.Millisecond,
			Retired:      20 * time.Millisecond,
			Outdated:     20 * time.Millisecond,
		},
		DrainJitter:     5 * time.Millisecond,
		DrainCloseExtra: 50 * time.Millisecond,
		Logger:          slog.New(slog.DiscardHandler),
	}
}

func startEnv(t *testing.T, cfg agent.Config, setup func(*fakeGateway)) *env {
	t.Helper()
	e := &env{t: t, net: memnet.New(memnet.Options{}), creds: newFakeCreds(t), done: make(chan error, 1)}
	e.gw = newFakeGateway(t, "gw-a")
	if setup != nil {
		setup(e.gw)
	}
	e.net.AddGateway("gw-a", e.gw, nil)
	cfg.Dialer = e.net.Dialer()
	if cfg.Credentials == nil {
		cfg.Credentials = e.creds
	}
	user := cfg.OnConnEvent
	cfg.OnConnEvent = func(ev agent.ConnEvent) {
		e.evMu.Lock()
		e.events = append(e.events, ev)
		e.evMu.Unlock()
		if user != nil {
			user(ev)
		}
	}
	c, err := agent.New(cfg)
	if err != nil {
		t.Fatal(err)
	}
	ctx, cancel := context.WithCancel(context.Background())
	e.cancel = cancel
	go func() { e.done <- c.Run(ctx) }()
	t.Cleanup(e.stop)
	return e
}

// stop cancels Run and waits for it; it is safe to call twice.
func (e *env) stop() {
	e.stopOnce.Do(func() {
		e.cancel()
		select {
		case err := <-e.done:
			if err != nil {
				e.t.Errorf("Run returned %v", err)
			}
		case <-time.After(waitTimeout):
			e.t.Error("Run did not return after cancel")
		}
	})
}

func (e *env) connEvents() []agent.ConnEvent {
	e.evMu.Lock()
	defer e.evMu.Unlock()
	return append([]agent.ConnEvent(nil), e.events...)
}

// reject returns a reject func answering status to attempts matching pred.
func rejectWhen(pred func(n int, h transport.Hello) bool, rej *transport.RejectError) func(int, transport.Hello) error {
	return func(n int, h transport.Hello) error {
		if pred(n, h) {
			return rej
		}
		return nil
	}
}

func setToken(t *testing.T, c *gwConn, token []byte) {
	t.Helper()
	ctx, cancel := context.WithTimeout(context.Background(), waitTimeout)
	defer cancel()
	if _, err := c.control.SetToken(ctx, connect.NewRequest(&tunnelv1.SetTokenRequest{Token: token})); err != nil {
		t.Fatalf("SetToken: %v", err)
	}
}

func newToken(t *testing.T) []byte {
	t.Helper()
	b := make([]byte, 32)
	if _, err := rand.Read(b); err != nil {
		t.Fatal(err)
	}
	return b
}

// tcpStream is a CONNECT stream opened by the fake gateway.
type tcpStream struct {
	status int
	w      *io.PipeWriter
	body   io.ReadCloser
}

func dialConnect(t *testing.T, c *gwConn, authority string) *tcpStream {
	t.Helper()
	pr, pw := io.Pipe()
	req, err := http.NewRequestWithContext(context.Background(), http.MethodConnect, "", pr)
	if err != nil {
		t.Fatal(err)
	}
	req.Host = authority
	req.URL.Host = authority
	resp, err := c.cc.RoundTrip(req)
	if err != nil {
		t.Fatalf("CONNECT %s: %v", authority, err)
	}
	s := &tcpStream{status: resp.StatusCode, w: pw, body: resp.Body}
	t.Cleanup(func() {
		_ = pw.Close()
		_ = resp.Body.Close()
	})
	return s
}

// echo writes msg and expects it back.
func (s *tcpStream) echo(t *testing.T, msg string) {
	t.Helper()
	if _, err := io.WriteString(s.w, msg); err != nil {
		t.Fatalf("write: %v", err)
	}
	buf := make([]byte, len(msg))
	if _, err := io.ReadFull(s.body, buf); err != nil {
		t.Fatalf("read echo: %v", err)
	}
	if string(buf) != msg {
		t.Fatalf("echo = %q, want %q", buf, msg)
	}
}

// startEcho listens on 127.0.0.1 and echoes; after the client half-closes it
// writes "|eof" and closes.
func startEcho(t *testing.T) *net.TCPListener {
	t.Helper()
	ln, err := net.ListenTCP("tcp", &net.TCPAddr{IP: net.IPv4(127, 0, 0, 1)})
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = ln.Close() })
	go func() {
		for {
			c, err := ln.AcceptTCP()
			if err != nil {
				return
			}
			go func() {
				defer func() { _ = c.Close() }()
				if _, err := io.Copy(c, c); err != nil && !errors.Is(err, net.ErrClosed) {
					return
				}
				_, _ = io.WriteString(c, "|eof")
			}()
		}
	}()
	return ln
}

func waitClosed(t *testing.T, ch <-chan struct{}, what string) time.Time {
	t.Helper()
	select {
	case <-ch:
		return time.Now()
	case <-time.After(waitTimeout):
		t.Fatalf("timed out waiting for %s", what)
		return time.Time{}
	}
}
