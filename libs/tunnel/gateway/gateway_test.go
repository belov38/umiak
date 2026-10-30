package gateway

import (
	"context"
	"errors"
	"io"
	"net"
	"net/http"
	"slices"
	"sync"
	"testing"
	"time"

	"connectrpc.com/connect"
	"github.com/google/uuid"

	tunnelv1 "github.com/belov38/boat-dev-clone/libs/proto/sbx/tunnel/v1"
	"github.com/belov38/boat-dev-clone/libs/proto/sbx/tunnel/v1/tunnelv1connect"
	"github.com/belov38/boat-dev-clone/libs/tunnel/agent"
	"github.com/belov38/boat-dev-clone/libs/tunnel/registry"
	"github.com/belov38/boat-dev-clone/libs/tunnel/transport"
	"github.com/belov38/boat-dev-clone/libs/tunnel/tunneltest/journal"
	"github.com/belov38/boat-dev-clone/libs/tunnel/wire"
)

// localSession waits for a local session of the machine in any live state.
func localSession(t *testing.T, gw *testGW, id string) *session {
	t.Helper()
	var s *session
	eventually(t, waitTimeout, "local session on "+gw.name, func() bool {
		s, _ = gw.lookup(id)
		return s != nil
	})
	return s
}

// waitMachine waits until the gateway serves the machine.
func waitMachine(t *testing.T, gw *testGW, id string) transport.MachineConn {
	t.Helper()
	var mc transport.MachineConn
	eventually(t, waitTimeout, "Machine on "+gw.name, func() bool {
		var ok bool
		mc, ok = gw.Machine(id)
		return ok
	})
	return mc
}

func waitDone(t *testing.T, s *session) {
	t.Helper()
	select {
	case <-s.done:
	case <-time.After(waitTimeout):
		t.Fatal("timed out waiting for the session to finish")
	}
}

func TestFirstConnectBootstrapThenRotation(t *testing.T) {
	e := newEnv(t)
	gw := e.gateway("gw-a", nil)
	id, bs := e.machine()
	caps := []string{"process.pty", "files.upload.v1"}
	cfg := agentConfig(e, id, bs, defaultIdentity())
	cfg.Info = func(context.Context) *tunnelv1.InfoResponse {
		return &tunnelv1.InfoResponse{AgentVersion: "1.5.0", Capabilities: caps}
	}
	a := e.startAgent(cfg)

	ev := a.waitConnected()
	if ev.Auth != transport.AuthBootstrap || ev.Epoch != 1 || ev.Gateway != "gw-a" || ev.ConnID == "" {
		t.Fatalf("first connect = %+v", ev)
	}
	if _, err := uuid.Parse(ev.ConnID); err != nil {
		t.Fatalf("conn id %q is not a uuid: %v", ev.ConnID, err)
	}
	eventually(t, waitTimeout, "session row with capabilities", func() bool {
		s := e.session(id)
		return s.State == registry.SessionConnected && s.Epoch == 1 && s.InstanceID == "gw-a" &&
			s.ConnID == ev.ConnID && slices.Equal(s.Capabilities, caps)
	})
	eventually(t, waitTimeout, "machine token rotated", func() bool {
		mt, next := e.credentials(id)
		return mt != nil && next == nil
	})
	eventually(t, waitTimeout, "connected event", func() bool { return gw.sink.hasConnEvent(id, 1, "connected") })

	links := e.net.Links(id)
	if len(links) != 1 {
		t.Fatalf("links = %d, want 1", len(links))
	}
	links[0].Cut()
	ev = a.waitConnected()
	if ev.Auth != transport.AuthToken || ev.Epoch != 2 {
		t.Fatalf("reconnect = %+v, want token auth at epoch 2", ev)
	}
	eventually(t, waitTimeout, "disconnected event for epoch 1", func() bool {
		return gw.sink.hasConnEvent(id, 1, "disconnected")
	})
}

func TestRejects(t *testing.T) {
	t.Run("unknown machine", func(t *testing.T) {
		e := newEnv(t)
		e.gateway("gw-a", nil)
		bs := make([]byte, wire.SecretLen)
		a := e.startAgent(agentConfig(e, uuid.NewString(), bs, defaultIdentity()))
		a.waitRejected(http.StatusUnauthorized)
	})
	t.Run("retired", func(t *testing.T) {
		e := newEnv(t)
		e.gateway("gw-a", nil)
		id, bs := e.machine()
		if err := e.store.Retire(context.Background(), id); err != nil {
			t.Fatal(err)
		}
		a := e.startAgent(agentConfig(e, id, bs, defaultIdentity()))
		a.waitRejected(http.StatusForbidden)
	})
	t.Run("agent version", func(t *testing.T) {
		e := newEnv(t)
		gw := e.gateway("gw-a", func(c *Config) { c.MinAgentVersion = "2.0.0" })
		id, bs := e.machine()
		a := e.startAgent(agentConfig(e, id, bs, defaultIdentity())) // version 1.5.0
		a.waitRejected(http.StatusUpgradeRequired)

		_, err := gw.Admitter().Admit(context.Background(), transport.Hello{
			MachineID: id, Scheme: transport.AuthBootstrap, Secret: bs, AgentVersion: "not-a-version",
		})
		var rej *transport.RejectError
		if !errors.As(err, &rej) || rej.Status != http.StatusUpgradeRequired {
			t.Fatalf("unparsable version: err = %v, want 426", err)
		}
	})
	t.Run("draining", func(t *testing.T) {
		e := newEnv(t)
		gw := e.gateway("gw-a", nil)
		id, bs := e.machine()
		gw.draining.Store(true)
		if gw.Ready() {
			t.Fatal("Ready() must be false while draining")
		}
		_, err := gw.Admitter().Admit(context.Background(), transport.Hello{
			MachineID: id, Scheme: transport.AuthBootstrap, Secret: bs, AgentVersion: "1.5.0",
		})
		var rej *transport.RejectError
		if !errors.As(err, &rej) || rej.Status != http.StatusServiceUnavailable || rej.RetryAfter != 1500*time.Millisecond {
			t.Fatalf("draining: err = %v, want 503 with RetryAfter 1.5s", err)
		}
	})
}

func TestReconnectToOtherGatewayFencesOld(t *testing.T) {
	e := newEnv(t)
	gwA := e.gateway("gw-a", nil)
	gwB := e.gateway("gw-b", nil)
	gwB.routed.Store(false)
	id, bs := e.machine()
	a := e.startAgent(agentConfig(e, id, bs, defaultIdentity()))
	if ev := a.waitConnected(); ev.Gateway != "gw-a" {
		t.Fatalf("connected to %s, want gw-a", ev.Gateway)
	}
	waitMachine(t, gwA, id)
	sA := localSession(t, gwA, id)

	// Half-open link: the agent end dies after DeadAfter, A's end is
	// blackholed, so only the NOTIFY can tell A that the machine moved.
	gwA.routed.Store(false)
	gwB.routed.Store(true)
	e.net.Links(id)[0].Stall(time.Minute)
	ev := a.waitEvent("connected to gw-b", func(ev agent.ConnEvent) bool {
		return ev.Kind == agent.KindConnected && ev.Gateway == "gw-b"
	})
	if ev.Epoch != 2 {
		t.Fatalf("epoch on B = %d, want 2", ev.Epoch)
	}
	eventually(t, time.Second, "A fences its session", func() bool {
		_, ok := gwA.Machine(id)
		return !ok
	})
	owner, ok, err := e.store.Owner(context.Background(), id, 15*time.Second)
	if err != nil || !ok || owner.InstanceID != "gw-b" || owner.Epoch != 2 {
		t.Fatalf("owner = %+v ok=%v err=%v, want gw-b epoch 2", owner, ok, err)
	}
	waitDone(t, sA)
	gwA.waitEventsIdle()
	for _, ev := range gwA.sink.connEvents(id) {
		if ev.GetType() == "disconnected" {
			t.Fatalf("A sent %v although it was fenced", ev)
		}
	}
}

func TestRetireClosesConnection(t *testing.T) {
	e := newEnv(t)
	gw := e.gateway("gw-a", nil)
	id, bs := e.machine()
	a := e.startAgent(agentConfig(e, id, bs, defaultIdentity()))
	a.waitConnected()
	waitMachine(t, gw, id)

	if err := e.store.Retire(context.Background(), id); err != nil {
		t.Fatal(err)
	}
	eventually(t, time.Second, "retired session closed", func() bool {
		s, _ := gw.lookup(id)
		return s == nil
	})
	a.waitEvent("disconnected", func(ev agent.ConnEvent) bool { return ev.Kind == agent.KindDisconnected })
	a.waitRejected(http.StatusForbidden)
}

func TestConnectionEvents(t *testing.T) {
	e := newEnv(t)
	gw := e.gateway("gw-a", nil)
	id, bs := e.machine()

	// run connects one agent process with ident, waits for its session to
	// end after the agent stops and returns the event types of the epoch.
	run := func(ident agent.Identity) (uint64, []string) {
		t.Helper()
		a := e.startAgent(agentConfig(e, id, bs, ident))
		ev := a.waitConnected()
		s := localSession(t, gw, id)
		eventually(t, waitTimeout, "connected event", func() bool { return gw.sink.hasConnEvent(id, ev.Epoch, "connected") })
		a.stop()
		waitDone(t, s)
		gw.waitEventsIdle()
		var types []string
		for _, ce := range gw.sink.connEvents(id) {
			if ce.GetEpoch() == ev.Epoch {
				types = append(types, ce.GetType())
				if ce.GetInstanceId() != "gw-a" || ce.GetAgentInstanceId() != ident.InstanceID {
					t.Errorf("event %v: instance id %q, agent instance id %q; want gw-a, %q",
						ce.GetType(), ce.GetInstanceId(), ce.GetAgentInstanceId(), ident.InstanceID)
				}
			}
		}
		return ev.Epoch, types
	}
	check := func(epoch uint64, got []string, want ...string) {
		t.Helper()
		for _, w := range want {
			if !slices.Contains(got, w) {
				t.Errorf("epoch %d: events %v lack %q", epoch, got, w)
			}
		}
		for _, typ := range []string{"agent_restarted", "rebooted", "identity_changed"} {
			if slices.Contains(got, typ) && !slices.Contains(want, typ) {
				t.Errorf("epoch %d: unexpected %q in %v", epoch, typ, got)
			}
		}
	}

	ident := agent.Identity{BootID: "boot-1", InstanceID: "inst-1", Vmgenid: "gen-1", Version: "1.5.0"}
	ep, got := run(ident)
	check(ep, got, "connected")

	ident.InstanceID = "inst-2"
	ep, got = run(ident)
	check(ep, got, "connected", "agent_restarted")

	ident.BootID, ident.InstanceID = "boot-2", "inst-3"
	ep, got = run(ident)
	check(ep, got, "connected", "rebooted")

	ident.Vmgenid = "gen-2"
	ep, got = run(ident)
	check(ep, got, "connected", "identity_changed")
}

// seqs flattens batches into their seq numbers.
func seqs(batches [][]*tunnelv1.Event) []uint64 {
	var out []uint64
	for _, b := range batches {
		for _, ev := range b {
			out = append(out, ev.GetSeq())
		}
	}
	return out
}

func checkContiguous(t *testing.T, got []uint64, n uint64) {
	t.Helper()
	if uint64(len(got)) != n {
		t.Fatalf("delivered %d events, want %d", len(got), n)
	}
	for i, s := range got {
		if s != uint64(i)+1 {
			t.Fatalf("delivered seq[%d] = %d, want %d", i, s, i+1)
		}
	}
}

func TestEventsPumpBatchesAndAcks(t *testing.T) {
	e := newEnv(t)
	gw := e.gateway("gw-a", nil)
	id, bs := e.machine()
	j := journal.New()
	for range 1200 {
		j.Append("test.event", nil)
	}
	cfg := agentConfig(e, id, bs, defaultIdentity())
	cfg.Journal = j
	e.startAgent(cfg).waitConnected()

	eventually(t, waitTimeout, "journal acked 1200", func() bool { return j.AckedSeq() == 1200 })
	attempts, batches := gw.sink.snapshot()
	for i, b := range batches {
		if len(b) == 0 || len(b) > 500 {
			t.Fatalf("batch %d has %d events", i, len(b))
		}
	}
	checkContiguous(t, seqs(batches), 1200)

	gw.sink.setFailNext(2)
	before := len(attempts)
	for range 10 {
		j.Append("test.event", nil)
	}
	eventually(t, waitTimeout, "journal acked 1210", func() bool { return j.AckedSeq() == 1210 })
	attempts, batches = gw.sink.snapshot()
	if len(attempts) < before+3 {
		t.Fatalf("attempts = %d, want at least %d", len(attempts), before+3)
	}
	for i := before; i < before+3; i++ {
		if first := attempts[i][0].GetSeq(); first != 1201 {
			t.Fatalf("attempt %d starts at seq %d, want 1201 (retry of the same batch)", i-before, first)
		}
	}
	checkContiguous(t, seqs(batches), 1210)
}

func TestSweepMarksCrashedInstance(t *testing.T) {
	e := newEnv(t)
	gwA := e.gateway("gw-a", nil)
	gwB := e.gateway("gw-b", func(c *Config) { c.Timing.StaleAfter = 300 * time.Millisecond })
	gwB.routed.Store(false) // the agent cannot reconnect, so its session stays A's
	id, bs := e.machine()
	ident := defaultIdentity()
	a := e.startAgent(agentConfig(e, id, bs, ident))
	if ev := a.waitConnected(); ev.Gateway != "gw-a" {
		t.Fatalf("connected to %s, want gw-a", ev.Gateway)
	}
	waitMachine(t, gwA, id)

	gwA.Abandon()
	eventually(t, waitTimeout, "A's instance row swept", func() bool {
		_, err := e.store.Instance(context.Background(), "gw-a")
		return errors.Is(err, registry.ErrNotFound)
	})
	if s := e.session(id); s.State != registry.SessionDisconnected || s.Epoch != 1 {
		t.Fatalf("session after sweep = %+v", s)
	}
	eventually(t, waitTimeout, "B sends disconnected", func() bool { return gwB.sink.hasConnEvent(id, 1, "disconnected") })
	if gwA.sink.hasConnEvent(id, 1, "disconnected") {
		t.Fatal("an abandoned gateway must not send events")
	}
	// The sweep event names the dead instance and the swept agent.
	for _, ce := range gwB.sink.connEvents(id) {
		if ce.GetType() == "disconnected" && (ce.GetInstanceId() != "gw-a" ||
			ce.GetAgentInstanceId() != ident.InstanceID) {
			t.Fatalf("sweep event: instance id %q, agent instance id %q; want gw-a, %q",
				ce.GetInstanceId(), ce.GetAgentInstanceId(), ident.InstanceID)
		}
	}
}

func TestResyncOnListenReconnect(t *testing.T) {
	e := newEnv(t)
	tp := e.togglePool("gw-a-listen-test")
	gwA := e.gateway("gw-a", func(c *Config) { c.Store = registry.New(tp.pool) })
	gwB := e.gateway("gw-b", nil)
	gwB.routed.Store(false)
	id, bs := e.machine()

	cfg1 := agentConfig(e, id, bs, defaultIdentity())
	cfg1.Dialer = &onceDialer{d: e.net.Dialer()}
	a1 := e.startAgent(cfg1)
	if ev := a1.waitConnected(); ev.Gateway != "gw-a" {
		t.Fatalf("connected to %s, want gw-a", ev.Gateway)
	}
	waitMachine(t, gwA, id)

	// Take A's database access down and kill its LISTEN backend.
	tp.down.Store(true)
	var killed int
	err := e.pool.QueryRow(context.Background(), `SELECT count(pg_terminate_backend(pid)) FROM pg_stat_activity
		WHERE datname = current_database() AND application_name = 'gw-a-listen-test' AND query ILIKE 'listen %'`).Scan(&killed)
	if err != nil || killed != 1 {
		t.Fatalf("terminate A's listener: killed=%d err=%v", killed, err)
	}

	// The same machine connects to B while A cannot hear the NOTIFY.
	gwA.routed.Store(false)
	gwB.routed.Store(true)
	a2 := e.startAgent(agentConfig(e, id, bs, defaultIdentity()))
	if ev := a2.waitConnected(); ev.Gateway != "gw-b" || ev.Epoch != 2 {
		t.Fatalf("second agent = %+v, want gw-b epoch 2", ev)
	}
	waitMachine(t, gwB, id)
	if _, ok := gwA.Machine(id); !ok {
		t.Fatal("A closed its session without the NOTIFY: the test does not exercise the resync")
	}

	tp.down.Store(false)
	eventually(t, waitTimeout, "A fences after LISTEN resync", func() bool {
		_, ok := gwA.Machine(id)
		return !ok
	})
	if _, ok := gwB.Machine(id); !ok {
		t.Fatal("B lost the session")
	}
}

func TestMachineConnDialTCPAndPing(t *testing.T) {
	e := newEnv(t)
	gw := e.gateway("gw-a", nil)
	id, bs := e.machine()
	cfg := agentConfig(e, id, bs, defaultIdentity())
	cfg.Handler = http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		_, _ = io.WriteString(w, r.Host+" "+r.URL.RequestURI())
	})
	e.startAgent(cfg).waitConnected()
	mc := waitMachine(t, gw, id)
	ctx := context.Background()

	if err := mc.Ping(ctx); err != nil {
		t.Fatalf("Ping: %v", err)
	}

	req, err := http.NewRequestWithContext(ctx, http.MethodGet, "https://elsewhere.example/files/a?b=1", nil)
	if err != nil {
		t.Fatal(err)
	}
	resp, err := mc.RoundTrip(req)
	if err != nil {
		t.Fatalf("RoundTrip: %v", err)
	}
	body, _ := io.ReadAll(resp.Body)
	_ = resp.Body.Close()
	if string(body) != "agent /files/a?b=1" {
		t.Fatalf("agent saw %q", body)
	}

	port := startEcho(t)
	c, err := mc.DialTCP(ctx, port)
	if err != nil {
		t.Fatalf("DialTCP: %v", err)
	}
	echo(t, c, "hello")
	cw, ok := c.(interface{ CloseWrite() error })
	if !ok {
		t.Fatal("tcp conn has no CloseWrite")
	}
	if err := cw.CloseWrite(); err != nil {
		t.Fatal(err)
	}
	rest, err := io.ReadAll(c)
	if err != nil || string(rest) != "|eof" {
		t.Fatalf("after half-close: %q, %v", rest, err)
	}
	if err := c.Close(); err != nil {
		t.Fatal(err)
	}

	// A closed port: the agent answers 502.
	var lc net.ListenConfig
	ln, err := lc.Listen(ctx, "tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatal(err)
	}
	closed := uint16(ln.Addr().(*net.TCPAddr).Port) //nolint:gosec // a TCP port fits in uint16
	_ = ln.Close()
	_, err = mc.DialTCP(ctx, closed)
	var de *transport.DialError
	if !errors.As(err, &de) || de.Status != http.StatusBadGateway {
		t.Fatalf("dial closed port: err = %v, want DialError 502", err)
	}
}

func TestTCPStreamLimit(t *testing.T) {
	e := newEnv(t)
	gw := e.gateway("gw-a", func(c *Config) { c.MaxTCPStreamsPerMachine = 3 })
	id, bs := e.machine()
	e.startAgent(agentConfig(e, id, bs, defaultIdentity())).waitConnected()
	mc := waitMachine(t, gw, id)
	port := startEcho(t)
	ctx := context.Background()

	var conns []net.Conn
	for i := range 3 {
		c, err := mc.DialTCP(ctx, port)
		if err != nil {
			t.Fatalf("dial %d: %v", i, err)
		}
		t.Cleanup(func() { _ = c.Close() })
		conns = append(conns, c)
	}
	if _, err := mc.DialTCP(ctx, port); !errors.Is(err, ErrTooManyStreams) {
		t.Fatalf("4th dial: err = %v, want ErrTooManyStreams", err)
	}
	if _, err := mc.(*MachineConn).DialTCPWith(ctx, port, TCPOptions{DrainDeadline: time.Minute}); !errors.Is(err, ErrTooManyStreams) {
		t.Fatalf("4th DialTCPWith: err = %v, want ErrTooManyStreams", err)
	}
	if err := conns[0].Close(); err != nil {
		t.Fatal(err)
	}
	c, err := mc.DialTCP(ctx, port)
	if err != nil {
		t.Fatalf("dial after close: %v", err)
	}
	echo(t, c, "ok")
	_ = c.Close()
}

func TestInstanceChangeHook(t *testing.T) {
	e := newEnv(t)
	got := make(chan string, 64)
	e.gateway("gw-b", func(c *Config) {
		c.OnInstanceChange = func(id string) {
			if id == "" {
				return
			}
			inst, err := e.store.Instance(context.Background(), id)
			if err == nil && inst.State == registry.InstanceDraining {
				select {
				case got <- id:
				default:
				}
			}
		}
	})
	e.gateway("gw-a", nil)
	if err := e.store.SetInstanceState(context.Background(), "gw-a", registry.InstanceDraining); err != nil {
		t.Fatal(err)
	}
	select {
	case id := <-got:
		if id != "gw-a" {
			t.Fatalf("hook got %q, want gw-a", id)
		}
	case <-time.After(waitTimeout):
		t.Fatal("OnInstanceChange was not called for gw-a")
	}
}

// OnSessionChange gets "" after the LISTEN connection is established and the
// machine id on admission. A blocked hook delays neither fencing nor the
// extra channel handlers.
func TestGatewayOnSessionChange(t *testing.T) {
	e := newEnv(t)
	got := make(chan string, 256)
	block := make(chan struct{})
	var blockOnce sync.Once
	routes := make(chan string, 64)
	gw := e.gateway("gw-a", func(c *Config) {
		c.OnSessionChange = func(id string) {
			got <- id
			if id == "" {
				// Hold the first call until the end of the test part that
				// checks fencing is not delayed.
				<-block
			}
		}
		c.ListenChannels = map[string]func(string){"sbx_routes": func(p string) { routes <- p }}
	})
	t.Cleanup(func() { blockOnce.Do(func() { close(block) }) })
	select {
	case id := <-got:
		if id != "" {
			t.Fatalf("first hook call %q, want \"\"", id)
		}
	case <-time.After(waitTimeout):
		t.Fatal("OnSessionChange was not called after LISTEN")
	}
	select {
	case p := <-routes:
		if p != "" {
			t.Fatalf("first sbx_routes call %q, want \"\"", p)
		}
	case <-time.After(waitTimeout):
		t.Fatal("ListenChannels handler was not called after LISTEN")
	}

	// The hook is blocked; a reconnect to another gateway still fences the
	// old session, and extra channels still deliver.
	id, bs := e.machine()
	a := e.startAgent(agentConfig(e, id, bs, defaultIdentity()))
	a.waitConnected()
	old := localSession(t, gw, id)
	gw.routed.Store(false)
	e.gateway("gw-b", nil)
	// Half-open link: only the NOTIFY can tell gw-a that the machine moved.
	e.net.Links(id)[0].Stall(time.Minute)
	a.waitEvent("connected to gw-b", func(ev agent.ConnEvent) bool {
		return ev.Kind == agent.KindConnected && ev.Gateway == "gw-b"
	})
	eventually(t, waitTimeout, "gw-a fences its session", func() bool {
		_, ok := gw.Machine(id)
		return !ok
	})
	waitDone(t, old)
	if _, err := e.pool.Exec(context.Background(), `SELECT pg_notify('sbx_routes', 'r1')`); err != nil {
		t.Fatal(err)
	}
	select {
	case p := <-routes:
		if p != "r1" {
			t.Fatalf("sbx_routes payload %q, want r1", p)
		}
	case <-time.After(waitTimeout):
		t.Fatal("sbx_routes notification not delivered while OnSessionChange is blocked")
	}

	blockOnce.Do(func() { close(block) })
	deadline := time.After(waitTimeout)
	for {
		select {
		case got := <-got:
			if got == id {
				return
			}
		case <-deadline:
			t.Fatalf("OnSessionChange was not called with %s", id)
		}
	}
}

func TestNewRejectsTunnelListenChannels(t *testing.T) {
	e := newEnv(t)
	for _, ch := range []string{wire.NotifyChannel, wire.NotifyInstancesChannel} {
		_, err := New(Config{
			InstanceID:     "gw-x",
			Store:          e.store,
			ListenChannels: map[string]func(string){ch: func(string) {}},
		})
		if err == nil {
			t.Errorf("New accepted ListenChannels[%q]", ch)
		}
	}
}

func TestFenceWhileDrainingMoves(t *testing.T) {
	e := newEnv(t)
	gwA := e.gateway("gw-a", nil)
	gwB := e.gateway("gw-b", nil)
	gwB.routed.Store(false)
	id, bs := e.machine()
	a := e.startAgent(agentConfig(e, id, bs, defaultIdentity()))
	a.waitConnected()
	mc := waitMachine(t, gwA, id)
	ctx := context.Background()

	port := startEcho(t)
	tcp, err := mc.(*MachineConn).DialTCPWith(ctx, port, TCPOptions{DrainDeadline: 400 * time.Millisecond})
	if err != nil {
		t.Fatal(err)
	}
	defer func() { _ = tcp.Close() }()
	echo(t, tcp, "before")

	events := tunnelv1connect.NewEventsClient(&http.Client{Transport: mc}, "http://agent")
	sctx, cancel := context.WithCancel(ctx)
	defer cancel()
	stream, err := events.Subscribe(sctx, connect.NewRequest(&tunnelv1.SubscribeRequest{}))
	if err != nil {
		t.Fatal(err)
	}
	defer func() { _ = stream.Close() }()

	gwA.routed.Store(false)
	gwB.routed.Store(true)
	if err := mc.Drain(ctx, transport.DrainOptions{Reason: "test", TCPDeadline: 10 * time.Second}); err != nil {
		t.Fatalf("Drain: %v", err)
	}
	sDraining, st := gwA.lookup(id)
	if sDraining == nil || st != stateDraining {
		t.Fatalf("state after Drain = %v", st)
	}
	// Only the active session of a machine rotates the token.
	if err := sDraining.rotateToken(ctx); !errors.Is(err, errNotActive) {
		t.Fatalf("rotateToken on a draining session: err = %v, want errNotActive", err)
	}
	a.waitEvent("connected to gw-b", func(ev agent.ConnEvent) bool {
		return ev.Kind == agent.KindConnected && ev.Gateway == "gw-b"
	})
	eventually(t, time.Second, "A moves the session", func() bool {
		_, st := gwA.lookup(id)
		return st == stateMoved
	})
	movedAt := time.Now()
	sA, _ := gwA.lookup(id)
	if _, ok := gwA.Machine(id); ok {
		t.Fatal("Machine must not return a moved session")
	}

	// RPC streams end right away with ErrMachineMoved.
	if stream.Receive() {
		t.Fatal("unexpected message on the aborted stream")
	}
	if err := stream.Err(); !errors.Is(err, ErrMachineMoved) {
		t.Fatalf("stream error = %v, want ErrMachineMoved", err)
	}
	// New calls are refused.
	req, _ := http.NewRequestWithContext(ctx, http.MethodGet, "http://agent/files/x", nil)
	if resp, err := mc.RoundTrip(req); !errors.Is(err, ErrMachineMoved) {
		if err == nil {
			_ = resp.Body.Close()
		}
		t.Fatalf("RoundTrip after move: err = %v, want ErrMachineMoved", err)
	}
	if _, err := mc.DialTCP(ctx, port); !errors.Is(err, ErrMachineMoved) {
		t.Fatalf("DialTCP after move: err = %v, want ErrMachineMoved", err)
	}

	// The TCP stream lives until its own deadline, then the session closes.
	echo(t, tcp, "after")
	buf := make([]byte, 16)
	_, err = tcp.Read(buf)
	elapsed := time.Since(movedAt)
	if err == nil || elapsed < 300*time.Millisecond || elapsed > 3*time.Second {
		t.Fatalf("tcp read ended after %s with %v, want an error ~400ms after the move", elapsed, err)
	}
	if !errors.Is(err, ErrMachineMoved) {
		t.Fatalf("tcp read error = %v, want ErrMachineMoved", err)
	}
	waitDone(t, sA)
	gwA.waitEventsIdle()
	if s, _ := gwA.lookup(id); s != nil {
		t.Fatal("moved session still registered after its streams ended")
	}
	if gwA.sink.hasConnEvent(id, 1, "disconnected") {
		t.Fatal("a fenced session must not send disconnected")
	}
}

// A retire NOTIFY closes a moved session at once, TCP streams included:
// they do not linger until their drain deadline.
func TestRetireClosesMovedSession(t *testing.T) {
	e := newEnv(t)
	gwA := e.gateway("gw-a", nil)
	gwB := e.gateway("gw-b", nil)
	gwB.routed.Store(false)
	id, bs := e.machine()
	a := e.startAgent(agentConfig(e, id, bs, defaultIdentity()))
	a.waitConnected()
	mc := waitMachine(t, gwA, id)
	ctx := context.Background()

	tcp, err := mc.(*MachineConn).DialTCPWith(ctx, startEcho(t), TCPOptions{DrainDeadline: time.Minute})
	if err != nil {
		t.Fatal(err)
	}
	defer func() { _ = tcp.Close() }()
	echo(t, tcp, "before")

	gwA.routed.Store(false)
	gwB.routed.Store(true)
	if err := mc.Drain(ctx, transport.DrainOptions{Reason: "test", TCPDeadline: time.Minute}); err != nil {
		t.Fatalf("Drain: %v", err)
	}
	a.waitEvent("connected to gw-b", func(ev agent.ConnEvent) bool {
		return ev.Kind == agent.KindConnected && ev.Gateway == "gw-b"
	})
	eventually(t, time.Second, "A moves the session", func() bool {
		_, st := gwA.lookup(id)
		return st == stateMoved
	})
	sA, _ := gwA.lookup(id)
	echo(t, tcp, "moved")

	retiredAt := time.Now()
	if err := e.store.Retire(ctx, id); err != nil {
		t.Fatal(err)
	}
	buf := make([]byte, 16)
	if _, err := tcp.Read(buf); err == nil {
		t.Fatal("tcp stream still open after retire")
	}
	if d := time.Since(retiredAt); d > 2*time.Second {
		t.Fatalf("tcp stream closed %s after retire, want at once", d)
	}
	waitDone(t, sA)
}

func TestRunShutdownDisconnects(t *testing.T) {
	e := newEnv(t)
	gw := e.gateway("gw-a", nil)
	id, bs := e.machine()
	e.startAgent(agentConfig(e, id, bs, defaultIdentity())).waitConnected()
	waitMachine(t, gw, id)

	start := time.Now()
	gw.cancel()
	select {
	case err := <-gw.done:
		if err != nil {
			t.Fatalf("Run = %v", err)
		}
		gw.done <- nil // for the cleanup
	case <-time.After(waitTimeout):
		t.Fatal("Run did not return")
	}
	if d := time.Since(start); d > time.Second {
		t.Fatalf("Run took %s to return", d)
	}
	if s := e.session(id); s.State != registry.SessionDisconnected {
		t.Fatalf("session state = %s after shutdown", s.State)
	}
	if _, err := e.store.Instance(context.Background(), "gw-a"); !errors.Is(err, registry.ErrNotFound) {
		t.Fatalf("instance row after shutdown: err = %v", err)
	}
	if !gw.sink.hasConnEvent(id, 1, "disconnected") {
		t.Fatal("no disconnected event after shutdown")
	}
}

func TestHeartbeatReRegistersAfterSweep(t *testing.T) {
	e := newEnv(t)
	// The test drives the heartbeat itself, so the order is fixed: the
	// re-registration happens after the post-sweep session is up.
	gw := e.gateway("gw-a", func(c *Config) { c.Timing.Heartbeat = time.Hour })
	id, bs := e.machine()
	a := e.startAgent(agentConfig(e, id, bs, defaultIdentity()))
	a.waitConnected()
	waitMachine(t, gw, id)

	// Another instance sweeps A as if its heartbeat were stale: A fences the
	// swept session (same epoch and instance, now disconnected).
	swept, err := e.store.SweepStale(context.Background(), "other", 0)
	if err != nil || len(swept) != 1 {
		t.Fatalf("SweepStale = %v, %v", swept, err)
	}
	ev := a.waitEvent("reconnect with a fresh epoch", func(ev agent.ConnEvent) bool {
		return ev.Kind == agent.KindConnected && ev.Epoch == 2
	})
	if ev.Gateway != "gw-a" {
		t.Fatalf("reconnected to %s", ev.Gateway)
	}
	waitMachine(t, gw, id)

	resyncs := gw.resyncs.Load()
	gw.heartbeatOnce(context.Background())
	inst, err := e.store.Instance(context.Background(), "gw-a")
	if err != nil || inst.State != registry.InstanceActive {
		t.Fatalf("instance after re-register = %+v, %v", inst, err)
	}
	eventually(t, waitTimeout, "resync after re-register", func() bool { return gw.resyncs.Load() > resyncs })

	// The post-sweep session survives the resync.
	s, st := gw.lookup(id)
	if s == nil || st != stateActive || s.info.Epoch != 2 {
		t.Fatalf("session after resync = %v %v", s, st)
	}
	if reg := e.session(id); reg.Epoch != 2 || reg.State != registry.SessionConnected {
		t.Fatalf("registry after resync = %+v", reg)
	}
	select {
	case ev := <-a.events:
		t.Fatalf("agent saw %+v after the resync", ev)
	default:
	}
}

func TestSlowSinkDoesNotDelayDisconnectOrShutdown(t *testing.T) {
	e := newEnv(t)
	gw := e.gateway("gw-a", func(c *Config) { c.Sink = hangSink{} })
	id, bs := e.machine()
	a := e.startAgent(agentConfig(e, id, bs, defaultIdentity()))
	a.waitConnected()
	waitMachine(t, gw, id)

	a.stop()
	eventually(t, time.Second, "registry disconnected while the sink hangs", func() bool {
		return e.session(id).State == registry.SessionDisconnected
	})

	start := time.Now()
	gw.cancel()
	select {
	case err := <-gw.done:
		if err != nil {
			t.Fatalf("Run = %v", err)
		}
		gw.done <- nil // for the cleanup
	case <-time.After(waitTimeout):
		t.Fatal("Run did not return")
	}
	if d := time.Since(start); d > 3*time.Second {
		t.Fatalf("Run took %s to return with a hanging sink", d)
	}
}

func TestEventsAckMismatch(t *testing.T) {
	e := newEnv(t)
	gw := e.gateway("gw-a", nil)
	id, bs := e.machine()
	j := journal.New()
	for range 20 {
		j.Append("test.event", nil)
	}
	// First successful call acks beyond the batch (must be retried), the
	// second acks 5 below its end (the rest must be resent).
	gw.sink.setAdjust(100, -5)
	cfg := agentConfig(e, id, bs, defaultIdentity())
	cfg.Journal = j
	e.startAgent(cfg).waitConnected()

	eventually(t, waitTimeout, "journal acked 20", func() bool { return j.AckedSeq() == 20 })
	attempts, _ := gw.sink.snapshot()
	if len(attempts) < 3 {
		t.Fatalf("attempts = %d, want at least 3", len(attempts))
	}
	b0 := attempts[0]
	if attempts[1][0].GetSeq() != b0[0].GetSeq() || len(attempts[1]) != len(b0) {
		t.Fatalf("an ack beyond the batch must retry the same batch: %d then %d", b0[0].GetSeq(), attempts[1][0].GetSeq())
	}
	last := b0[len(b0)-1].GetSeq()
	if got := attempts[2][0].GetSeq(); got != last-5+1 {
		t.Fatalf("after a partial ack of %d the next batch starts at %d, want %d", last-5, got, last-4)
	}
	// Every seq was delivered at least once.
	seen := map[uint64]bool{}
	for _, a := range attempts[1:] {
		for _, ev := range a {
			seen[ev.GetSeq()] = true
		}
	}
	for seq := uint64(1); seq <= 20; seq++ {
		if !seen[seq] {
			t.Fatalf("seq %d never delivered", seq)
		}
	}
}

func TestTCPStreamReleasedWhenBothDirectionsDone(t *testing.T) {
	e := newEnv(t)
	gw := e.gateway("gw-a", func(c *Config) { c.MaxTCPStreamsPerMachine = 1 })
	id, bs := e.machine()
	e.startAgent(agentConfig(e, id, bs, defaultIdentity())).waitConnected()
	mc := waitMachine(t, gw, id)
	ctx := context.Background()
	bye, echoPort := startBye(t), startEcho(t)

	// The agent side ends first: the stream is half-closed and still counts.
	c1, err := mc.DialTCP(ctx, bye)
	if err != nil {
		t.Fatal(err)
	}
	defer func() { _ = c1.Close() }()
	if got, err := io.ReadAll(c1); err != nil || string(got) != "bye" {
		t.Fatalf("read = %q, %v", got, err)
	}
	if _, err := mc.DialTCP(ctx, echoPort); !errors.Is(err, ErrTooManyStreams) {
		t.Fatalf("dial while half-closed: err = %v, want ErrTooManyStreams", err)
	}
	// Closing our side too finishes the stream.
	if err := c1.(interface{ CloseWrite() error }).CloseWrite(); err != nil {
		t.Fatal(err)
	}
	c2, err := mc.DialTCP(ctx, echoPort)
	if err != nil {
		t.Fatalf("dial after both directions finished: %v", err)
	}
	defer func() { _ = c2.Close() }()

	// Our side ends first, then the agent's: released without Close.
	echo(t, c2, "x")
	if err := c2.(interface{ CloseWrite() error }).CloseWrite(); err != nil {
		t.Fatal(err)
	}
	if rest, err := io.ReadAll(c2); err != nil || string(rest) != "|eof" {
		t.Fatalf("after half-close: %q, %v", rest, err)
	}
	c3, err := mc.DialTCP(ctx, echoPort)
	if err != nil {
		t.Fatalf("dial after the second stream finished: %v", err)
	}
	_ = c3.Close()
}

// MachineConn.Epoch is the epoch of the local session, the one the registry
// holds for it, so callers need no registry query for a local machine.
func TestMachineConnEpoch(t *testing.T) {
	e := newEnv(t)
	gwA := e.gateway("gw-a", nil)
	gwB := e.gateway("gw-b", nil)
	gwB.routed.Store(false)
	id, bs := e.machine()
	a := e.startAgent(agentConfig(e, id, bs, defaultIdentity()))
	a.waitConnected()
	mc := waitMachine(t, gwA, id).(*MachineConn)
	if got, want := mc.Epoch(), e.session(id).Epoch; got != want || got == 0 {
		t.Fatalf("Epoch = %d, want %d (registry)", got, want)
	}

	gwA.routed.Store(false)
	gwB.routed.Store(true)
	e.net.Links(id)[0].Stall(time.Minute)
	a.waitEvent("connected to gw-b", func(ev agent.ConnEvent) bool {
		return ev.Kind == agent.KindConnected && ev.Gateway == "gw-b"
	})
	mcB := waitMachine(t, gwB, id).(*MachineConn)
	if got := mcB.Epoch(); got != mc.Epoch()+1 {
		t.Fatalf("Epoch on B = %d, want %d", got, mc.Epoch()+1)
	}
}
