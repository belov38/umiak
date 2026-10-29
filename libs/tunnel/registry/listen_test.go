package registry_test

import (
	"context"
	"errors"
	"net"
	"net/url"
	"sync"
	"testing"
	"time"

	"github.com/jackc/pgx/v5/pgxpool"

	"github.com/belov38/boat-dev-clone/libs/tunnel/registry"
	"github.com/belov38/boat-dev-clone/libs/tunnel/transport"
	"github.com/belov38/boat-dev-clone/libs/tunnel/tunneltest/pgtest"
)

// freezeProxy forwards TCP to a target. freeze makes every connection open
// so far go silent in both directions without closing it: a half-open
// connection as seen by the client.
type freezeProxy struct {
	ln     net.Listener
	target string

	mu     sync.Mutex
	frozen []chan struct{}
	conns  []net.Conn
}

func newFreezeProxy(t *testing.T, target string) *freezeProxy {
	t.Helper()
	ln, err := (&net.ListenConfig{}).Listen(context.Background(), "tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatal(err)
	}
	p := &freezeProxy{ln: ln, target: target}
	go p.serve()
	t.Cleanup(func() {
		_ = ln.Close()
		p.mu.Lock()
		defer p.mu.Unlock()
		for _, c := range p.conns {
			_ = c.Close()
		}
	})
	return p
}

func (p *freezeProxy) serve() {
	for {
		c, err := p.ln.Accept()
		if err != nil {
			return
		}
		up, err := (&net.Dialer{}).DialContext(context.Background(), "tcp", p.target)
		if err != nil {
			_ = c.Close()
			continue
		}
		stop := make(chan struct{})
		p.mu.Lock()
		p.frozen = append(p.frozen, stop)
		p.conns = append(p.conns, c, up)
		p.mu.Unlock()
		go pipe(up, c, stop)
		go pipe(c, up, stop)
	}
}

// pipe copies src to dst until stop is closed; then it keeps reading src
// into nowhere so neither side sees an error.
func pipe(dst, src net.Conn, stop <-chan struct{}) {
	buf := make([]byte, 32<<10)
	for {
		n, err := src.Read(buf)
		if err != nil {
			return
		}
		select {
		case <-stop:
			continue
		default:
		}
		if _, err := dst.Write(buf[:n]); err != nil {
			return
		}
	}
}

func (p *freezeProxy) freeze() {
	p.mu.Lock()
	defer p.mu.Unlock()
	for _, ch := range p.frozen {
		close(ch)
	}
	p.frozen = nil
}

func (p *freezeProxy) addr() string { return p.ln.Addr().String() }

// An idle LISTEN connection is pinged; the pings neither reconnect nor lose
// notifications sent around them.
func TestListenPingKeepsNotifications(t *testing.T) {
	s, _ := setup(t)
	registry.SetListenLiveness(s, 30*time.Millisecond, time.Second)
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	ev := newEvents()
	done := make(chan error, 1)
	go func() { done <- s.Listen(ctx, ev.handlers()) }()
	expect(t, ev.session, "", "initial resync")
	expect(t, ev.instance, "", "initial instance resync")

	var ids []string
	for i := range 10 {
		id, bs := machine(t, s)
		ids = append(ids, id)
		if _, err := s.Admit(ctx, params(id, "gw-1", transport.AuthBootstrap, bs)); err != nil {
			t.Fatal(err)
		}
		// Spread the notifications over several ping periods.
		time.Sleep(time.Duration(5+i*7) * time.Millisecond)
	}
	for _, id := range ids {
		expect(t, ev.session, id, "admit "+id)
	}
	if n := registry.ListenPings(s); n < 2 {
		t.Fatalf("%d liveness pings, want several", n)
	}
	select {
	case got := <-ev.session:
		t.Fatalf("unexpected session notification %q (a resync means the pings reconnected)", got)
	case <-time.After(200 * time.Millisecond):
	}
	cancel()
	if err := <-done; !errors.Is(err, context.Canceled) {
		t.Fatalf("Listen = %v", err)
	}
}

// A half-open LISTEN connection (no error, no data) is detected by the ping
// and replaced: a resync follows and notifications resume.
func TestListenDetectsHalfOpenConnection(t *testing.T) {
	_, dsn := pgtest.New(t)
	u, err := url.Parse(dsn)
	if err != nil {
		t.Fatal(err)
	}
	proxy := newFreezeProxy(t, u.Host)
	u.Host = proxy.addr()
	pool, err := pgxpool.New(context.Background(), u.String())
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(pool.Close)
	s := registry.New(pool)
	registry.SetListenLiveness(s, 100*time.Millisecond, 300*time.Millisecond)

	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	ev := newEvents()
	done := make(chan error, 1)
	go func() { done <- s.Listen(ctx, ev.handlers()) }()
	expect(t, ev.session, "", "initial resync")
	expect(t, ev.instance, "", "initial instance resync")

	// Writers go through fresh pool connections; freeze only what exists now.
	pool.Reset()
	proxy.freeze()
	start := time.Now()
	expect(t, ev.session, "", "resync after the half-open connection was replaced")
	if d := time.Since(start); d > 5*time.Second {
		t.Fatalf("half-open connection detected after %s", d)
	}
	id, bs := machine(t, s)
	if _, err := s.Admit(ctx, params(id, "gw-1", transport.AuthBootstrap, bs)); err != nil {
		t.Fatal(err)
	}
	expect(t, ev.session, id, "admit after reconnect")
	cancel()
	select {
	case err := <-done:
		if !errors.Is(err, context.Canceled) {
			t.Fatalf("Listen = %v", err)
		}
	case <-time.After(10 * time.Second):
		t.Fatal("Listen did not return")
	}
}
