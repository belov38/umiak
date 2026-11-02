package gateway

import (
	"context"
	"errors"
	"net/http"
	"testing"
	"time"

	"github.com/belov38/umiak/libs/tunnel/agent"
	"github.com/belov38/umiak/libs/tunnel/registry"
	"github.com/belov38/umiak/libs/tunnel/transport"
)

// drainTiming is fastTiming with a visible spread and a short margin.
func drainTiming(c *Config) {
	c.Timing.EndpointWait = 100 * time.Millisecond
	c.Timing.DrainSpread = 300 * time.Millisecond
	c.Timing.DrainMargin = 500 * time.Millisecond
}

// runDoneWithin reports whether Run of gw returned within d.
func runDoneWithin(gw *testGW, d time.Duration) bool {
	select {
	case <-gw.runDone:
		return true
	default:
	}
	select {
	case <-gw.runDone:
		return true
	case <-time.After(d):
		return false
	}
}

func TestDrainMovesSessionsAndStops(t *testing.T) {
	e := newEnv(t)
	gwA := e.gateway("gw-a", drainTiming)
	gwB := e.gateway("gw-b", nil)
	gwB.routed.Store(false)

	const n = 4
	agents := make([]*testAgent, n)
	ids := make([]string, n)
	for i := range agents {
		id, bs := e.machine()
		ids[i] = id
		agents[i] = e.startAgent(agentConfig(e, id, bs, defaultIdentity()))
		waitConnectedTo(agents[i], "gw-a")
	}
	// One machine has a TCP stream with a drain deadline longer than the default.
	port := startEcho(t)
	mc := waitMachine(t, gwA, ids[0])
	tcp, err := mc.(*MachineConn).DialTCPWith(context.Background(), port, TCPOptions{DrainDeadline: 3 * time.Second})
	if err != nil {
		t.Fatal(err)
	}
	defer func() { _ = tcp.Close() }()
	echo(t, tcp, "before")
	gwB.routed.Store(true)

	// Each agent's drain event, stamped when it arrives.
	type stamped struct {
		ev agent.ConnEvent
		at time.Time
	}
	drainEvents := make([]chan stamped, n)
	for i, a := range agents {
		drainEvents[i] = make(chan stamped, 1)
		go func() {
			for ev := range a.events {
				if ev.Kind == agent.KindDrain {
					drainEvents[i] <- stamped{ev: ev, at: time.Now()}
					return
				}
			}
		}()
	}

	started := time.Now()
	drained := make(chan error, 1)
	go func() { drained <- gwA.Drain(context.Background()) }()

	eventually(t, time.Second, "A not ready", func() bool { return !gwA.Ready() })
	if _, err := gwA.Admitter().Admit(context.Background(), transport.Hello{MachineID: ids[1]}); err == nil {
		t.Fatal("admission while draining succeeded")
	} else {
		var rej *transport.RejectError
		if !errors.As(err, &rej) || rej.Status != http.StatusServiceUnavailable {
			t.Fatalf("admission while draining: %v, want 503", err)
		}
	}
	eventually(t, time.Second, "instance state draining", func() bool {
		inst, err := e.store.Instance(context.Background(), "gw-a")
		return err == nil && inst.State == registry.InstanceDraining && inst.DrainStartedAt != nil
	})

	var first, last time.Time
	for i, a := range agents {
		var got stamped
		select {
		case got = <-drainEvents[i]:
		case <-time.After(waitTimeout):
			t.Fatalf("agent %d: no drain event", i)
		}
		ev, at := got.ev, got.at
		want := 2 * time.Second // Timing.TCPDeadline
		if i == 0 {
			want = 3 * time.Second
		}
		if ev.TCPDeadline != want {
			t.Fatalf("agent %d: drain tcp_deadline = %v, want %v", i, ev.TCPDeadline, want)
		}
		if ev.Reason != "gateway_shutdown" {
			t.Fatalf("drain reason = %q", ev.Reason)
		}
		if first.IsZero() || at.Before(first) {
			first = at
		}
		if at.After(last) {
			last = at
		}
		waitConnectedTo(a, "gw-b")
	}
	if since := first.Sub(started); since < 100*time.Millisecond {
		t.Fatalf("first Control/Drain %v after Drain started, want after EndpointWait", since)
	}
	if spread := last.Sub(first); spread < 150*time.Millisecond {
		t.Fatalf("Control/Drain calls spread over %v, want about 3/4 of 300ms", spread)
	}

	// The TCP stream keeps A's session (and Drain) alive until it ends.
	echo(t, tcp, "after move")
	select {
	case err := <-drained:
		t.Fatalf("Drain returned (%v) while a TCP stream was open", err)
	case <-time.After(200 * time.Millisecond):
	}
	_ = tcp.Close()
	select {
	case err := <-drained:
		if err != nil {
			t.Fatalf("Drain = %v", err)
		}
	case <-time.After(waitTimeout):
		t.Fatal("Drain did not return after the last stream ended")
	}
	if !runDoneWithin(gwA, 0) {
		t.Fatal("Run still running after Drain returned")
	}
	if _, err := e.store.Instance(context.Background(), "gw-a"); !errors.Is(err, registry.ErrNotFound) {
		t.Fatalf("instance row after Drain: err = %v, want ErrNotFound", err)
	}
	for _, id := range ids {
		if s := e.session(id); s.InstanceID != "gw-b" || s.State != "connected" {
			t.Fatalf("session %s = %s/%s, want gw-b connected", id, s.InstanceID, s.State)
		}
	}
	// Drain is idempotent.
	if err := gwA.Drain(context.Background()); err != nil {
		t.Fatalf("second Drain = %v", err)
	}
}

func TestDrainCancelClosesRemaining(t *testing.T) {
	e := newEnv(t)
	gwA := e.gateway("gw-a", drainTiming)
	gwB := e.gateway("gw-b", nil)
	gwB.routed.Store(false)
	id, bs := e.machine()
	a := e.startAgent(agentConfig(e, id, bs, defaultIdentity()))
	waitConnectedTo(a, "gw-a")
	mc := waitMachine(t, gwA, id)
	tcp, err := mc.(*MachineConn).DialTCPWith(context.Background(), startEcho(t), TCPOptions{DrainDeadline: 15 * time.Minute})
	if err != nil {
		t.Fatal(err)
	}
	defer func() { _ = tcp.Close() }()
	gwB.routed.Store(true)

	ctx, cancel := context.WithCancel(context.Background())
	first := make(chan error, 1)
	go func() { first <- gwA.Drain(ctx) }()
	ev := a.waitEvent("drain", func(ev agent.ConnEvent) bool { return ev.Kind == agent.KindDrain })
	if ev.TCPDeadline != 15*time.Minute {
		t.Fatalf("drain tcp_deadline = %v, want 15m", ev.TCPDeadline)
	}
	waitConnectedTo(a, "gw-b")
	// A second call waits for the first.
	second := make(chan error, 1)
	go func() { second <- gwA.Drain(context.Background()) }()
	select {
	case err := <-second:
		t.Fatalf("second Drain returned early: %v", err)
	case <-time.After(100 * time.Millisecond):
	}

	cancel()
	for name, ch := range map[string]chan error{"first": first, "second": second} {
		select {
		case err := <-ch:
			if !errors.Is(err, context.Canceled) {
				t.Fatalf("%s Drain = %v, want context.Canceled", name, err)
			}
		case <-time.After(waitTimeout):
			t.Fatalf("%s Drain did not return after cancel", name)
		}
	}
	// The lingering stream was closed with the session.
	if _, err := tcp.Read(make([]byte, 1)); err == nil {
		t.Fatal("tcp stream still open after the cancelled drain")
	}
	if !runDoneWithin(gwA, 0) {
		t.Fatal("Run still running after Drain returned")
	}
	if _, err := e.store.Instance(context.Background(), "gw-a"); !errors.Is(err, registry.ErrNotFound) {
		t.Fatalf("instance row: err = %v, want ErrNotFound", err)
	}
}

func TestDrainBeforeRun(t *testing.T) {
	e := newEnv(t)
	g, err := New(Config{InstanceID: "idle", Store: e.store, Logger: testLogger()})
	if err != nil {
		t.Fatal(err)
	}
	if err := g.Drain(context.Background()); err == nil {
		t.Fatal("Drain before Run succeeded")
	}
}
