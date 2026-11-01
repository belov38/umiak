package registry_test

import (
	"context"
	"errors"
	"net"
	"net/url"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/jackc/pgx/v5/pgxpool"

	"github.com/belov38/umiak/libs/tunnel/registry"
	"github.com/belov38/umiak/libs/tunnel/transport"
	"github.com/belov38/umiak/libs/tunnel/tunneltest/pgtest"
	"github.com/belov38/umiak/libs/tunnel/wire"
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

// Extra channels are LISTENed on the same connection: their notifications
// reach their handlers, and after a reconnect every handler, extra ones
// included, gets "".
func TestListenExtraChannels(t *testing.T) {
	s, pool := setup(t)
	ctx, cancel := context.WithCancel(context.Background())
	ev := newEvents()
	routes := make(chan string, 64)
	other := make(chan string, 64)
	h := ev.handlers()
	h.Channels = map[string]func(string){
		"umiak_routes": func(p string) { routes <- p },
		"Mixed Case.x": func(p string) { other <- p },
	}
	done := make(chan error, 1)
	go func() { done <- s.Listen(ctx, h) }()
	t.Cleanup(func() {
		cancel()
		select {
		case err := <-done:
			if !errors.Is(err, context.Canceled) {
				t.Errorf("Listen returned %v, want context.Canceled", err)
			}
		case <-time.After(10 * time.Second):
			t.Error("Listen did not return after cancel")
		}
	})
	expect(t, ev.session, "", "initial session resync")
	expect(t, ev.instance, "", "initial instance resync")
	expect(t, routes, "", "initial umiak_routes resync")
	expect(t, other, "", "initial quoted channel resync")

	if _, err := pool.Exec(ctx, `SELECT pg_notify('umiak_routes', 'a')`); err != nil {
		t.Fatal(err)
	}
	expect(t, routes, "a", "umiak_routes notification")
	if _, err := pool.Exec(ctx, `SELECT pg_notify('Mixed Case.x', 'b')`); err != nil {
		t.Fatal(err)
	}
	expect(t, other, "b", "quoted channel notification")

	// The tunnel channels keep working next to the extra ones.
	id, bs := machine(t, s)
	if _, err := s.Admit(ctx, params(id, "gw-1", transport.AuthBootstrap, bs)); err != nil {
		t.Fatal(err)
	}
	expect(t, ev.session, id, "admit")

	drain(ev.session)
	drain(ev.instance)
	drain(routes)
	drain(other)
	var killed int
	err := pool.QueryRow(ctx, `SELECT count(pg_terminate_backend(pid)) FROM pg_stat_activity
		WHERE datname = current_database() AND pid <> pg_backend_pid() AND query ILIKE 'listen %'`).Scan(&killed)
	if err != nil || killed != 1 {
		t.Fatalf("terminate listener: killed=%d err=%v", killed, err)
	}
	expect(t, ev.session, "", "session resync after reconnect")
	expect(t, ev.instance, "", "instance resync after reconnect")
	expect(t, routes, "", "umiak_routes resync after reconnect")
	expect(t, other, "", "quoted channel resync after reconnect")

	if _, err := pool.Exec(ctx, `SELECT pg_notify('umiak_routes', 'c')`); err != nil {
		t.Fatal(err)
	}
	expect(t, routes, "c", "umiak_routes notification after reconnect")
}

// Channel names that clash with the tunnel channels, or that Postgres would
// reject or truncate, are refused before connecting.
func TestListenRejectsBadChannels(t *testing.T) {
	for _, name := range []string{wire.NotifyChannel, wire.NotifyInstancesChannel, "", strings.Repeat("x", 64)} {
		h := registry.ListenHandlers{Channels: map[string]func(string){name: func(string) {}}}
		if err := h.Validate(); err == nil {
			t.Errorf("Validate accepted channel %q", name)
		}
	}
	ok := registry.ListenHandlers{Channels: map[string]func(string){"umiak_routes": nil, strings.Repeat("x", 63): func(string) {}}}
	if err := ok.Validate(); err != nil {
		t.Fatalf("Validate = %v", err)
	}
	// Listen refuses them too, without needing a database.
	s := registry.New(nil)
	bad := registry.ListenHandlers{Channels: map[string]func(string){wire.NotifyChannel: func(string) {}}}
	if err := s.Listen(context.Background(), bad); err == nil {
		t.Fatal("Listen accepted a tunnel channel as an extra channel")
	}
}
