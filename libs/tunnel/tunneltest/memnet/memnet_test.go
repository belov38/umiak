package memnet_test

import (
	"bytes"
	"context"
	"errors"
	"io"
	"math/rand/v2"
	"net"
	"net/http"
	"os"
	"runtime"
	"sync"
	"testing"
	"time"

	"github.com/belov38/umiak/libs/tunnel/h2"
	"github.com/belov38/umiak/libs/tunnel/transport"
	"github.com/belov38/umiak/libs/tunnel/tunneltest/memnet"
)

// testAdmitter admits every connection and hands the gateway end to a channel.
type testAdmitter struct {
	info  transport.ConnInfo
	err   error
	conns chan net.Conn
	// onAdmit, if set, runs inside Admit.
	onAdmit func()
	mu      sync.Mutex
	hello   []transport.Hello
	abort   []error
}

func newAdmitter(instance string) *testAdmitter {
	return &testAdmitter{
		info:  transport.ConnInfo{GatewayInstance: instance, Epoch: 1, ConnID: "c-" + instance},
		conns: make(chan net.Conn, 16),
	}
}

func (a *testAdmitter) Admit(_ context.Context, h transport.Hello) (transport.Admission, error) {
	a.mu.Lock()
	a.hello = append(a.hello, h)
	a.mu.Unlock()
	if a.onAdmit != nil {
		a.onAdmit()
	}
	if a.err != nil {
		return nil, a.err
	}
	return &testAdmission{a: a}, nil
}

type testAdmission struct{ a *testAdmitter }

func (s *testAdmission) Info() transport.ConnInfo { return s.a.info }
func (s *testAdmission) Serve(c net.Conn)         { s.a.conns <- c }
func (s *testAdmission) Abort(err error) {
	s.a.mu.Lock()
	s.a.abort = append(s.a.abort, err)
	s.a.mu.Unlock()
}

func (a *testAdmitter) gatewayConn(t *testing.T) net.Conn {
	t.Helper()
	select {
	case c := <-a.conns:
		return c
	case <-time.After(5 * time.Second):
		t.Fatal("gateway end was not served")
		return nil
	}
}

// pair dials one machine through a single-gateway network.
func pair(t *testing.T, opts memnet.Options) (n *memnet.Network, agent, gw net.Conn, link *memnet.Link) {
	t.Helper()
	n = memnet.New(opts)
	adm := newAdmitter("gw-1")
	n.AddGateway("gw-1", adm, func() bool { return true })
	agent, _, err := n.Dialer().Dial(context.Background(), transport.Hello{MachineID: "m-1"})
	if err != nil {
		t.Fatal(err)
	}
	gw = adm.gatewayConn(t)
	links := n.Links("m-1")
	if len(links) != 1 {
		t.Fatalf("links = %d, want 1", len(links))
	}
	t.Cleanup(func() { _ = agent.Close(); _ = gw.Close() })
	return n, agent, gw, links[0]
}

func isTimeout(err error) bool {
	var ne net.Error
	return errors.As(err, &ne) && ne.Timeout()
}

func TestDialRoutesToReadyGateway(t *testing.T) {
	n := memnet.New(memnet.Options{})
	a1, a2 := newAdmitter("gw-1"), newAdmitter("gw-2")
	n.AddGateway("gw-1", a1, func() bool { return false })
	n.AddGateway("gw-2", a2, func() bool { return true })

	hello := transport.Hello{MachineID: "m-1", BootID: "boot", Secret: []byte("s")}
	conn, info, err := n.Dialer().Dial(context.Background(), hello)
	if err != nil {
		t.Fatal(err)
	}
	defer func() { _ = conn.Close() }()
	if info != a2.info {
		t.Fatalf("info = %+v, want %+v", info, a2.info)
	}
	gw := a2.gatewayConn(t)
	defer func() { _ = gw.Close() }()
	if len(a1.hello) != 0 || len(a2.hello) != 1 {
		t.Fatalf("admit calls: gw-1=%d gw-2=%d", len(a1.hello), len(a2.hello))
	}
	if a2.hello[0].BootID != "boot" {
		t.Fatalf("hello not passed through: %+v", a2.hello[0])
	}
	links := n.Links("m-1")
	if len(links) != 1 || links[0].Gateway != "gw-2" || links[0].MachineID != "m-1" || links[0].Info != a2.info {
		t.Fatalf("links = %+v", links)
	}
	// Both ends are connected.
	go func() { _, _ = conn.Write([]byte("ping")) }()
	buf := make([]byte, 4)
	if _, err := io.ReadFull(gw, buf); err != nil || string(buf) != "ping" {
		t.Fatalf("read = %q, %v", buf, err)
	}
}

func TestRoundRobin(t *testing.T) {
	n := memnet.New(memnet.Options{})
	a1, a2, a3 := newAdmitter("gw-1"), newAdmitter("gw-2"), newAdmitter("gw-3")
	n.AddGateway("gw-1", a1, func() bool { return true })
	n.AddGateway("gw-2", a2, func() bool { return true })
	n.AddGateway("gw-3", a3, func() bool { return false })
	var got []string
	for range 4 {
		c, info, err := n.Dialer().Dial(context.Background(), transport.Hello{MachineID: "m-1"})
		if err != nil {
			t.Fatal(err)
		}
		defer func() { _ = c.Close() }()
		got = append(got, info.GatewayInstance)
	}
	want := []string{"gw-1", "gw-2", "gw-1", "gw-2"}
	for i := range want {
		if got[i] != want[i] {
			t.Fatalf("order = %v, want %v", got, want)
		}
	}
	if links := n.Links("m-1"); len(links) != 4 {
		t.Fatalf("links = %d, want 4", len(links))
	}
}

func TestNoReadyGateway503(t *testing.T) {
	n := memnet.New(memnet.Options{})
	_, _, err := n.Dialer().Dial(context.Background(), transport.Hello{MachineID: "m-1"})
	var rej *transport.RejectError
	if !errors.As(err, &rej) || rej.Status != 503 || rej.RetryAfter != time.Second {
		t.Fatalf("no gateways: err = %v", err)
	}
	n.AddGateway("gw-1", newAdmitter("gw-1"), func() bool { return false })
	_, _, err = n.Dialer().Dial(context.Background(), transport.Hello{MachineID: "m-1"})
	if !errors.As(err, &rej) || rej.Status != 503 || rej.RetryAfter != time.Second {
		t.Fatalf("not ready: err = %v", err)
	}
	n.RemoveGateway("gw-1")
	n.AddGateway("gw-2", newAdmitter("gw-2"), nil) // nil ready means always ready
	c, _, err := n.Dialer().Dial(context.Background(), transport.Hello{MachineID: "m-1"})
	if err != nil {
		t.Fatal(err)
	}
	_ = c.Close()
}

func TestDialFault(t *testing.T) {
	n := memnet.New(memnet.Options{})
	adm := newAdmitter("gw-1")
	n.AddGateway("gw-1", adm, func() bool { return true })
	want := &transport.RejectError{Status: 401}
	n.SetDialFault(func(transport.Hello) error { return want })
	_, _, err := n.Dialer().Dial(context.Background(), transport.Hello{MachineID: "m-1"})
	if err != error(want) { //nolint:errorlint // identity check: the error must be returned unchanged
		t.Fatalf("err = %v, want the same *RejectError", err)
	}
	if len(adm.hello) != 0 {
		t.Fatal("admission must not be reached when the dial fault fires")
	}
	n.SetDialFault(func(transport.Hello) error { return nil })
	c, _, err := n.Dialer().Dial(context.Background(), transport.Hello{MachineID: "m-1"})
	if err != nil {
		t.Fatal(err)
	}
	_ = c.Close()
	n.SetDialFault(nil)
	c, _, err = n.Dialer().Dial(context.Background(), transport.Hello{MachineID: "m-1"})
	if err != nil {
		t.Fatal(err)
	}
	_ = c.Close()
}

func TestAdmitErrorUnchanged(t *testing.T) {
	n := memnet.New(memnet.Options{})
	adm := newAdmitter("gw-1")
	adm.err = &transport.RejectError{Status: 403, Reason: "nope"}
	n.AddGateway("gw-1", adm, func() bool { return true })
	_, _, err := n.Dialer().Dial(context.Background(), transport.Hello{MachineID: "m-1"})
	if err != adm.err { //nolint:errorlint // identity check: the error must be returned unchanged
		t.Fatalf("err = %v, want admit error unchanged", err)
	}
	if len(n.Links("m-1")) != 0 {
		t.Fatal("rejected dial must not register a link")
	}
}

func TestDialContextCancelledAfterAdmit(t *testing.T) {
	n := memnet.New(memnet.Options{})
	adm := newAdmitter("gw-1")
	n.AddGateway("gw-1", adm, func() bool { return true })
	ctx, cancel := context.WithCancel(context.Background())
	adm.onAdmit = cancel
	_, _, err := n.Dialer().Dial(ctx, transport.Hello{MachineID: "m-1"})
	if !errors.Is(err, context.Canceled) {
		t.Fatalf("err = %v, want context.Canceled", err)
	}
	if len(adm.conns) != 0 {
		t.Fatal("Serve must not be called for a cancelled dial")
	}
	if len(adm.abort) != 1 || !errors.Is(adm.abort[0], context.Canceled) {
		t.Fatalf("abort = %v, want one context.Canceled", adm.abort)
	}
	if len(n.Links("m-1")) != 0 {
		t.Fatal("cancelled dial must not register a link")
	}
}

func TestPipeBackpressure(t *testing.T) {
	const size = 1024
	_, agent, gw, _ := pair(t, memnet.Options{BufferSize: size})

	written := make(chan int, 1)
	go func() {
		n, _ := agent.Write(make([]byte, size*4))
		written <- n
	}()
	select {
	case n := <-written:
		t.Fatalf("write of 4x buffer returned %d without a reader", n)
	case <-time.After(100 * time.Millisecond):
	}
	// Read everything: the writer completes and all bytes arrive.
	got := make([]byte, size*4)
	if _, err := io.ReadFull(gw, got); err != nil {
		t.Fatal(err)
	}
	if n := <-written; n != size*4 {
		t.Fatalf("written = %d", n)
	}

	// Exactly BufferSize bytes fit without a reader; one more blocks.
	if n, err := agent.Write(make([]byte, size)); err != nil || n != size {
		t.Fatalf("write full buffer: %d, %v", n, err)
	}
	extra := make(chan error, 1)
	go func() { _, err := agent.Write([]byte{1}); extra <- err }()
	select {
	case err := <-extra:
		t.Fatalf("write beyond buffer returned %v", err)
	case <-time.After(100 * time.Millisecond):
	}
	buf := make([]byte, 1)
	if _, err := io.ReadFull(gw, buf); err != nil {
		t.Fatal(err)
	}
	if err := <-extra; err != nil {
		t.Fatalf("blocked write: %v", err)
	}
}

func TestCloseSemantics(t *testing.T) {
	_, agent, gw, link := pair(t, memnet.Options{})
	if _, err := agent.Write([]byte("tail")); err != nil {
		t.Fatal(err)
	}
	if err := agent.Close(); err != nil {
		t.Fatal(err)
	}
	// Peer reads the remaining data, then EOF.
	data, err := io.ReadAll(gw)
	if err != nil || string(data) != "tail" {
		t.Fatalf("ReadAll = %q, %v", data, err)
	}
	// Peer writes fail.
	if _, err := gw.Write([]byte("x")); err == nil {
		t.Fatal("write to a closed peer must fail")
	}
	// Local reads and writes fail with net.ErrClosed.
	if _, err := agent.Read(make([]byte, 1)); !errors.Is(err, net.ErrClosed) {
		t.Fatalf("local read after close: %v", err)
	}
	if _, err := agent.Write([]byte("x")); !errors.Is(err, net.ErrClosed) {
		t.Fatalf("local write after close: %v", err)
	}
	// A closed link is dead.
	select {
	case <-link.Closed():
	case <-time.After(time.Second):
		t.Fatal("Closed() did not fire after one end was closed")
	}
	if err := agent.Close(); err != nil {
		t.Fatalf("second close: %v", err)
	}
}

func TestCloseWakesBlockedReader(t *testing.T) {
	_, agent, gw, _ := pair(t, memnet.Options{})
	res := make(chan error, 2)
	go func() { _, err := gw.Read(make([]byte, 1)); res <- err }()
	go func() { _, err := agent.Read(make([]byte, 1)); res <- err }()
	time.Sleep(20 * time.Millisecond)
	_ = agent.Close()
	for range 2 {
		select {
		case err := <-res:
			if err == nil {
				t.Fatal("expected error")
			}
		case <-time.After(2 * time.Second):
			t.Fatal("reader not woken by close")
		}
	}
}

func TestCut(t *testing.T) {
	n, agent, gw, link := pair(t, memnet.Options{})
	if _, err := agent.Write([]byte("buffered")); err != nil {
		t.Fatal(err)
	}
	blocked := make(chan error, 1)
	go func() { _, err := agent.Read(make([]byte, 1)); blocked <- err }()
	time.Sleep(20 * time.Millisecond)

	link.Cut()
	select {
	case <-link.Closed():
	case <-time.After(time.Second):
		t.Fatal("Closed() did not fire")
	}
	if err := <-blocked; !errors.Is(err, net.ErrClosed) {
		t.Fatalf("blocked read: %v", err)
	}
	for name, c := range map[string]net.Conn{"agent": agent, "gateway": gw} {
		if _, err := c.Read(make([]byte, 8)); !errors.Is(err, net.ErrClosed) {
			t.Errorf("%s read: %v", name, err)
		}
		if _, err := c.Write([]byte("x")); !errors.Is(err, net.ErrClosed) {
			t.Errorf("%s write: %v", name, err)
		}
	}
	if got := n.Links("m-1"); len(got) != 0 {
		t.Fatalf("cut link still listed: %d", len(got))
	}
	link.Cut() // idempotent
}

func TestCutAll(t *testing.T) {
	n := memnet.New(memnet.Options{})
	adm := newAdmitter("gw-1")
	n.AddGateway("gw-1", adm, func() bool { return true })
	var links []*memnet.Link
	for _, m := range []string{"m-1", "m-2", "m-1"} {
		c, _, err := n.Dialer().Dial(context.Background(), transport.Hello{MachineID: m})
		if err != nil {
			t.Fatal(err)
		}
		defer func() { _ = c.Close() }()
		defer func() { _ = adm.gatewayConn(t).Close() }()
		links = append(links, n.Links(m)[len(n.Links(m))-1])
	}
	if got := n.Links("m-1"); len(got) != 2 || got[0] != links[0] || got[1] != links[2] {
		t.Fatalf("links not oldest first: %+v", got)
	}
	n.CutAll()
	for i, l := range links {
		select {
		case <-l.Closed():
		default:
			t.Fatalf("link %d not closed", i)
		}
	}
	if len(n.Links("m-1"))+len(n.Links("m-2")) != 0 {
		t.Fatal("links remain after CutAll")
	}
}

func TestStallShort(t *testing.T) {
	_, agent, gw, link := pair(t, memnet.Options{DeadAfter: 5 * time.Second})
	payload := bytes.Repeat([]byte("0123456789"), 100)

	link.Stall(150 * time.Millisecond)
	start := time.Now()
	if _, err := agent.Write(payload); err != nil { // fits in the buffer, must not block
		t.Fatal(err)
	}
	got := make([]byte, len(payload))
	if _, err := io.ReadFull(gw, got); err != nil {
		t.Fatal(err)
	}
	if el := time.Since(start); el < 140*time.Millisecond {
		t.Fatalf("data delivered after %s, stall not honoured", el)
	}
	if !bytes.Equal(got, payload) {
		t.Fatal("payload corrupted by stall")
	}
	// Delivery works normally afterwards, in both directions.
	go func() { _, _ = gw.Write([]byte("back")) }()
	buf := make([]byte, 4)
	if _, err := io.ReadFull(agent, buf); err != nil || string(buf) != "back" {
		t.Fatalf("after stall: %q, %v", buf, err)
	}
}

func TestStallBlocksWritersWhenBufferFull(t *testing.T) {
	_, agent, gw, link := pair(t, memnet.Options{BufferSize: 64, DeadAfter: 5 * time.Second})
	link.Stall(200 * time.Millisecond)
	done := make(chan struct{})
	go func() {
		_, _ = agent.Write(make([]byte, 256))
		close(done)
	}()
	select {
	case <-done:
		t.Fatal("writer must block while stalled with a full buffer")
	case <-time.After(100 * time.Millisecond):
	}
	if _, err := io.ReadFull(gw, make([]byte, 256)); err != nil {
		t.Fatal(err)
	}
	<-done
}

func TestStallExtendedByLongerStall(t *testing.T) {
	_, agent, gw, link := pair(t, memnet.Options{DeadAfter: 5 * time.Second})
	link.Stall(100 * time.Millisecond)
	link.Stall(250 * time.Millisecond)
	link.Stall(10 * time.Millisecond) // must not shorten the stall
	start := time.Now()
	_, _ = agent.Write([]byte("x"))
	if _, err := io.ReadFull(gw, make([]byte, 1)); err != nil {
		t.Fatal(err)
	}
	if el := time.Since(start); el < 230*time.Millisecond {
		t.Fatalf("delivered after %s", el)
	}
}

func TestStallConcurrent(t *testing.T) {
	_, agent, gw, link := pair(t, memnet.Options{DeadAfter: 5 * time.Second})
	var wg sync.WaitGroup
	for i := range 16 {
		wg.Add(1)
		go func() {
			defer wg.Done()
			for range 20 {
				link.Stall(time.Duration(i+1) * time.Millisecond)
			}
		}()
	}
	wg.Wait()
	go func() { _, _ = agent.Write([]byte("ok")) }()
	buf := make([]byte, 2)
	_ = gw.SetReadDeadline(time.Now().Add(5 * time.Second))
	if _, err := io.ReadFull(gw, buf); err != nil {
		t.Fatal(err)
	}
}

func TestStallLongClosesAgentEnd(t *testing.T) {
	const stall = 400 * time.Millisecond
	_, agent, gw, link := pair(t, memnet.Options{DeadAfter: 50 * time.Millisecond})
	start := time.Now()
	link.Stall(stall)

	res := make(chan error, 1)
	go func() { _, err := agent.Read(make([]byte, 1)); res <- err }()
	select {
	case err := <-res:
		if !errors.Is(err, net.ErrClosed) {
			t.Fatalf("agent read: %v", err)
		}
		if el := time.Since(start); el < 40*time.Millisecond || el > 300*time.Millisecond {
			t.Fatalf("agent end closed after %s, want about 50ms", el)
		}
	case <-time.After(2 * time.Second):
		t.Fatal("agent end not closed")
	}
	if _, err := agent.Write([]byte("x")); !errors.Is(err, net.ErrClosed) {
		t.Fatalf("agent write: %v", err)
	}
	select {
	case <-link.Closed():
	case <-time.After(time.Second):
		t.Fatal("Closed() did not fire")
	}

	// The gateway end stays blackholed while the stall lasts: no EOF, no
	// error on write (it buffers).
	_ = gw.SetReadDeadline(time.Now().Add(50 * time.Millisecond))
	if _, err := gw.Read(make([]byte, 1)); !isTimeout(err) {
		t.Fatalf("gateway read during stall: %v, want timeout", err)
	}
	if n, err := gw.Write([]byte("lost")); err != nil || n != 4 {
		t.Fatalf("gateway write during stall: %d, %v", n, err)
	}

	// After the stall the gateway sees the peer closed.
	time.Sleep(time.Until(start.Add(stall + 50*time.Millisecond)))
	_ = gw.SetReadDeadline(time.Now().Add(time.Second))
	if _, err := gw.Read(make([]byte, 1)); !errors.Is(err, io.EOF) {
		t.Fatalf("gateway read after stall: %v, want EOF", err)
	}
	if _, err := gw.Write([]byte("x")); err == nil {
		t.Fatal("gateway write after stall must fail")
	}
}

// The agent closes during a stall: the gateway gets the data and EOF when
// the stall ends, not never.
func TestStallThenAgentCloseDelivers(t *testing.T) {
	_, agent, gw, link := pair(t, memnet.Options{DeadAfter: 5 * time.Second})
	link.Stall(100 * time.Millisecond)
	start := time.Now()
	if _, err := agent.Write([]byte("tail")); err != nil {
		t.Fatal(err)
	}
	_ = agent.Close()
	_ = gw.SetReadDeadline(time.Now().Add(2 * time.Second))
	data, err := io.ReadAll(gw)
	if err != nil || string(data) != "tail" {
		t.Fatalf("ReadAll = %q, %v", data, err)
	}
	if el := time.Since(start); el < 90*time.Millisecond || el > time.Second {
		t.Fatalf("delivered after %s, want about 100ms", el)
	}
}

// The gateway closes during a stall: the agent still wakes when the stall
// ends.
func TestStallThenGatewayCloseWakesAgent(t *testing.T) {
	_, agent, gw, link := pair(t, memnet.Options{DeadAfter: 5 * time.Second})
	link.Stall(100 * time.Millisecond)
	start := time.Now()
	res := make(chan error, 1)
	_ = agent.SetReadDeadline(time.Now().Add(2 * time.Second))
	go func() { _, err := agent.Read(make([]byte, 1)); res <- err }()
	time.Sleep(10 * time.Millisecond)
	_ = gw.Close()
	if err := <-res; !errors.Is(err, io.EOF) {
		t.Fatalf("agent read = %v, want EOF", err)
	}
	if el := time.Since(start); el < 90*time.Millisecond || el > time.Second {
		t.Fatalf("EOF after %s, want about 100ms", el)
	}
}

// DeadAfter still closes the agent end when the gateway closed first.
func TestStallDeadAfterSurvivesGatewayClose(t *testing.T) {
	_, agent, gw, link := pair(t, memnet.Options{DeadAfter: 50 * time.Millisecond})
	link.Stall(5 * time.Second)
	_ = gw.Close()
	start := time.Now()
	_ = agent.SetReadDeadline(time.Now().Add(2 * time.Second))
	_, err := agent.Read(make([]byte, 1))
	if !errors.Is(err, net.ErrClosed) {
		t.Fatalf("agent read = %v, want net.ErrClosed", err)
	}
	if el := time.Since(start); el > time.Second {
		t.Fatalf("agent end closed after %s", el)
	}
}

// Writes to a peer that closed behave like a blackhole while stalled.
func TestStallHidesPeerClose(t *testing.T) {
	_, agent, gw, link := pair(t, memnet.Options{BufferSize: 8, DeadAfter: 5 * time.Second})
	link.Stall(150 * time.Millisecond)
	_ = agent.Close()
	if n, err := gw.Write([]byte("abc")); err != nil || n != 3 {
		t.Fatalf("write during stall: %d, %v", n, err)
	}
	// A write larger than the buffer blocks, then fails once the stall ends.
	start := time.Now()
	_, err := gw.Write(make([]byte, 64))
	if err == nil || !errors.Is(err, io.ErrClosedPipe) {
		t.Fatalf("write = %v, want io.ErrClosedPipe", err)
	}
	if el := time.Since(start); el < 100*time.Millisecond {
		t.Fatalf("write failed after %s, stall not honoured", el)
	}
}

func TestDeadlines(t *testing.T) {
	const size = 16
	_, agent, gw, _ := pair(t, memnet.Options{BufferSize: size})

	// Read deadline in the future expires.
	_ = gw.SetReadDeadline(time.Now().Add(50 * time.Millisecond))
	start := time.Now()
	_, err := gw.Read(make([]byte, 1))
	if !isTimeout(err) || !errors.Is(err, os.ErrDeadlineExceeded) {
		t.Fatalf("read err = %v", err)
	}
	if el := time.Since(start); el < 40*time.Millisecond {
		t.Fatalf("deadline fired after %s", el)
	}
	// A past deadline fails immediately, even with data available.
	_, _ = agent.Write([]byte("abc"))
	_ = gw.SetReadDeadline(time.Now().Add(-time.Second))
	if _, err := gw.Read(make([]byte, 1)); !isTimeout(err) {
		t.Fatalf("expired deadline read err = %v", err)
	}
	// Clearing the deadline makes the data readable again.
	_ = gw.SetReadDeadline(time.Time{})
	buf := make([]byte, 3)
	if _, err := io.ReadFull(gw, buf); err != nil || string(buf) != "abc" {
		t.Fatalf("read after clearing deadline: %q, %v", buf, err)
	}
	// Extending a deadline of a blocked reader wakes it up on the new deadline.
	_ = gw.SetReadDeadline(time.Now().Add(20 * time.Millisecond))
	res := make(chan error, 1)
	go func() { _, err := gw.Read(make([]byte, 1)); res <- err }()
	time.Sleep(5 * time.Millisecond)
	_ = gw.SetReadDeadline(time.Now().Add(150 * time.Millisecond))
	start = time.Now()
	if err := <-res; !isTimeout(err) {
		t.Fatalf("blocked read err = %v", err)
	}
	if el := time.Since(start); el < 100*time.Millisecond {
		t.Fatalf("extended deadline fired after %s", el)
	}
	// Setting a past deadline wakes a blocked reader at once.
	_ = gw.SetReadDeadline(time.Time{})
	go func() { _, err := gw.Read(make([]byte, 1)); res <- err }()
	time.Sleep(20 * time.Millisecond)
	_ = gw.SetReadDeadline(time.Unix(1, 0))
	select {
	case err := <-res:
		if !isTimeout(err) {
			t.Fatalf("err = %v", err)
		}
	case <-time.After(time.Second):
		t.Fatal("blocked reader not woken by past deadline")
	}

	// Write deadline: full buffer, partial progress is reported.
	_ = agent.SetWriteDeadline(time.Now().Add(50 * time.Millisecond))
	n, err := agent.Write(make([]byte, size*2))
	if !isTimeout(err) || n != size {
		t.Fatalf("write: n=%d err=%v, want n=%d timeout", n, err, size)
	}
	// SetDeadline sets both.
	_ = agent.SetDeadline(time.Now().Add(-time.Second))
	if _, err := agent.Write([]byte("x")); !isTimeout(err) {
		t.Fatalf("write err = %v", err)
	}
	if _, err := agent.Read(make([]byte, 1)); !isTimeout(err) {
		t.Fatalf("read err = %v", err)
	}
}

func TestAddrs(t *testing.T) {
	_, agent, gw, _ := pair(t, memnet.Options{})
	if agent.LocalAddr() == nil || agent.RemoteAddr() == nil || gw.LocalAddr() == nil || gw.RemoteAddr() == nil {
		t.Fatal("nil addr")
	}
	if agent.LocalAddr().Network() != "memnet" || agent.LocalAddr().String() == agent.RemoteAddr().String() {
		t.Fatalf("addrs: %v %v", agent.LocalAddr(), agent.RemoteAddr())
	}
}

func TestRemoveGatewayKeepsLinks(t *testing.T) {
	n, agent, gw, link := pair(t, memnet.Options{})
	n.RemoveGateway("gw-1")
	select {
	case <-link.Closed():
		t.Fatal("RemoveGateway must not touch existing links")
	default:
	}
	go func() { _, _ = agent.Write([]byte("hi")) }()
	if _, err := io.ReadFull(gw, make([]byte, 2)); err != nil {
		t.Fatal(err)
	}
	_, _, err := n.Dialer().Dial(context.Background(), transport.Hello{MachineID: "m-1"})
	var rej *transport.RejectError
	if !errors.As(err, &rej) || rej.Status != 503 {
		t.Fatalf("dial after removal: %v", err)
	}
}

func TestCutGateway(t *testing.T) {
	n := memnet.New(memnet.Options{})
	a1, a2 := newAdmitter("gw-1"), newAdmitter("gw-2")
	n.AddGateway("gw-1", a1, nil)
	n.AddGateway("gw-2", a2, nil)
	c1, _, _ := n.Dialer().Dial(context.Background(), transport.Hello{MachineID: "m-1"})
	c2, _, _ := n.Dialer().Dial(context.Background(), transport.Hello{MachineID: "m-1"})
	defer func() { _ = c1.Close(); _ = c2.Close() }()
	n.CutGateway("gw-1")
	links := n.Links("m-1")
	if len(links) != 1 || links[0].Gateway != "gw-2" {
		t.Fatalf("links after CutGateway: %+v", links)
	}
}

func TestLinksRemovedWhenBothEndsClosed(t *testing.T) {
	n, agent, gw, link := pair(t, memnet.Options{})
	_ = gw.Close()
	_ = agent.Close()
	<-link.Closed()
	if len(n.Links("m-1")) != 0 {
		t.Fatal("closed link still listed")
	}
}

func TestIntegrityUnderFaultsRace(t *testing.T) {
	// Concurrent writer and reader in each direction with random short
	// stalls: every byte arrives in order. Run under -race.
	_, agent, gw, link := pair(t, memnet.Options{BufferSize: 4096, DeadAfter: time.Minute})
	const total = 1 << 20
	rng := rand.New(rand.NewPCG(1, 2))
	src := make([]byte, total)
	for i := range src {
		src[i] = byte(rng.Uint32())
	}

	stop := make(chan struct{})
	var stallWG sync.WaitGroup
	stallWG.Add(1)
	go func() {
		defer stallWG.Done()
		for {
			select {
			case <-stop:
				return
			case <-time.After(2 * time.Millisecond):
				link.Stall(time.Duration(rand.IntN(3)) * time.Millisecond)
			}
		}
	}()

	var wg sync.WaitGroup
	send := func(c net.Conn) {
		defer wg.Done()
		for off := 0; off < total; {
			end := min(off+1+rand.IntN(3000), total)
			n, err := c.Write(src[off:end])
			if err != nil {
				t.Errorf("write: %v", err)
				return
			}
			off += n
		}
	}
	recv := func(c net.Conn) {
		defer wg.Done()
		got := make([]byte, total)
		for off := 0; off < total; {
			n, err := c.Read(got[off:min(off+1+rand.IntN(5000), total)])
			off += n
			if err != nil {
				t.Errorf("read at %d: %v", off, err)
				return
			}
		}
		if !bytes.Equal(got, src) {
			t.Error("payload corrupted")
		}
	}
	wg.Add(4)
	go send(agent)
	go send(gw)
	go recv(gw)
	go recv(agent)
	wg.Wait()
	close(stop)
	stallWG.Wait()
}

func TestConcurrentCutAndTraffic(t *testing.T) {
	// Cut while readers and writers are active: nobody hangs.
	for range 20 {
		_, agent, gw, link := pair(t, memnet.Options{BufferSize: 128})
		var wg sync.WaitGroup
		for _, c := range []net.Conn{agent, gw} {
			wg.Add(2)
			go func() {
				defer wg.Done()
				for {
					if _, err := c.Write(make([]byte, 100)); err != nil {
						return
					}
				}
			}()
			go func() {
				defer wg.Done()
				buf := make([]byte, 64)
				for {
					if _, err := c.Read(buf); err != nil {
						return
					}
				}
			}()
		}
		time.Sleep(time.Millisecond)
		link.Cut()
		done := make(chan struct{})
		go func() { wg.Wait(); close(done) }()
		select {
		case <-done:
		case <-time.After(5 * time.Second):
			t.Fatal("goroutines stuck after Cut")
		}
	}
}

func TestNoGoroutineLeak(t *testing.T) {
	before := runtime.NumGoroutine()
	for range 50 {
		n := memnet.New(memnet.Options{DeadAfter: time.Hour})
		adm := newAdmitter("gw-1")
		n.AddGateway("gw-1", adm, nil)
		agent, _, err := n.Dialer().Dial(context.Background(), transport.Hello{MachineID: "m-1"})
		if err != nil {
			t.Fatal(err)
		}
		gw := adm.gatewayConn(t)
		l := n.Links("m-1")[0]
		l.Stall(time.Hour)
		_ = agent.SetReadDeadline(time.Now().Add(time.Hour))
		_ = gw.SetWriteDeadline(time.Now().Add(time.Hour))
		_ = agent.Close()
		_ = gw.Close()
	}
	deadline := time.Now().Add(2 * time.Second)
	for runtime.NumGoroutine() > before && time.Now().Before(deadline) {
		time.Sleep(10 * time.Millisecond)
	}
	if after := runtime.NumGoroutine(); after > before {
		t.Fatalf("goroutines: before=%d after=%d", before, after)
	}
}

// TestHTTP2OverMemnet runs the real h2 server (agent side) and client conn
// (gateway side) over a memnet link, including a streaming response and a cut.
func TestHTTP2OverMemnet(t *testing.T) {
	n := memnet.New(memnet.Options{})
	ln := h2.New()
	srv := h2.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		_, _ = io.Copy(io.Discard, r.Body)
		for range 3 {
			_, _ = io.WriteString(w, "chunk\n")
			w.(http.Flusher).Flush()
		}
	}), h2.DefaultServerConfig())
	go func() { _ = srv.Serve(ln) }()
	t.Cleanup(func() { _ = srv.Close() })

	clients := make(chan *http.ClientConn, 1)
	adm := &h2Admitter{clients: clients}
	n.AddGateway("gw-1", adm, func() bool { return true })

	agentEnd, info, err := n.Dialer().Dial(context.Background(), transport.Hello{MachineID: "m-1"})
	if err != nil {
		t.Fatal(err)
	}
	if info.GatewayInstance != "gw-1" {
		t.Fatalf("info = %+v", info)
	}
	if err := ln.Push(agentEnd); err != nil {
		t.Fatal(err)
	}
	var cc *http.ClientConn
	select {
	case cc = <-clients:
	case <-time.After(5 * time.Second):
		t.Fatal("no client conn")
	}
	t.Cleanup(func() { _ = cc.Close() })

	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()
	for range 3 {
		req, _ := http.NewRequestWithContext(ctx, http.MethodGet, "http://agent:80/x", nil)
		resp, err := cc.RoundTrip(req)
		if err != nil {
			t.Fatal(err)
		}
		body, err := io.ReadAll(resp.Body)
		_ = resp.Body.Close()
		if err != nil || string(body) != "chunk\nchunk\nchunk\n" {
			t.Fatalf("body = %q, %v", body, err)
		}
	}

	// A cut fails further requests.
	n.CutAll()
	req, _ := http.NewRequestWithContext(ctx, http.MethodGet, "http://agent:80/x", nil)
	if resp, err := cc.RoundTrip(req); err == nil {
		_ = resp.Body.Close()
		t.Fatal("request over a cut link must fail")
	}
}

type h2Admitter struct {
	clients chan *http.ClientConn
	cfg     h2.ClientConfig // zero means the defaults
}

func (a *h2Admitter) Admit(context.Context, transport.Hello) (transport.Admission, error) {
	return &h2Admission{a: a}, nil
}

type h2Admission struct{ a *h2Admitter }

func (s *h2Admission) Info() transport.ConnInfo { return transport.ConnInfo{GatewayInstance: "gw-1"} }
func (s *h2Admission) Abort(error)              {}
func (s *h2Admission) Serve(c net.Conn) {
	// The handshake needs the agent side to be served, which happens after Dial returns.
	go func() {
		cfg := s.a.cfg
		if cfg == (h2.ClientConfig{}) {
			cfg = h2.DefaultClientConfig()
		}
		cc, err := h2.NewClientConn(context.Background(), c, cfg)
		if err != nil {
			_ = c.Close()
			return
		}
		s.a.clients <- cc
	}()
}

type closeSpy struct {
	net.Conn
	once   sync.Once
	closed chan struct{}
}

func (c *closeSpy) Close() error {
	c.once.Do(func() { close(c.closed) })
	return c.Conn.Close()
}

// A long stall over HTTP/2: the agent side notices at DeadAfter, the gateway
// side only through its own h2 ping.
func TestHTTP2LongStall(t *testing.T) {
	n := memnet.New(memnet.Options{DeadAfter: 100 * time.Millisecond})
	ln := h2.New()
	srv := h2.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		_, _ = io.WriteString(w, "ok")
	}), h2.DefaultServerConfig())
	go func() { _ = srv.Serve(ln) }()
	t.Cleanup(func() { _ = srv.Close() })

	clients := make(chan *http.ClientConn, 1)
	adm := &h2Admitter{clients: clients, cfg: h2.ClientConfig{
		StreamWindow: 1 << 20, ConnWindow: 16 << 20, MaxFrame: 16 << 10,
		PingIdle: 50 * time.Millisecond, PingTimeout: 50 * time.Millisecond,
	}}
	n.AddGateway("gw-1", adm, nil)
	agentEnd, _, err := n.Dialer().Dial(context.Background(), transport.Hello{MachineID: "m-1"})
	if err != nil {
		t.Fatal(err)
	}
	spy := &closeSpy{Conn: agentEnd, closed: make(chan struct{})}
	if err := ln.Push(spy); err != nil {
		t.Fatal(err)
	}
	cc := <-clients
	t.Cleanup(func() { _ = cc.Close() })

	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()
	req, _ := http.NewRequestWithContext(ctx, http.MethodGet, "http://agent:80/x", nil)
	resp, err := cc.RoundTrip(req)
	if err != nil {
		t.Fatal(err)
	}
	_, _ = io.Copy(io.Discard, resp.Body)
	_ = resp.Body.Close()

	start := time.Now()
	n.Links("m-1")[0].Stall(10 * time.Second)

	select {
	case <-spy.closed:
		if el := time.Since(start); el < 90*time.Millisecond || el > time.Second {
			t.Fatalf("agent side closed after %s, want about 100ms", el)
		}
	case <-time.After(3 * time.Second):
		t.Fatal("agent side did not notice the dead link")
	}
	for cc.Err() == nil {
		if time.Since(start) > time.Second {
			t.Fatal("gateway h2 conn did not fail via ping")
		}
		time.Sleep(5 * time.Millisecond)
	}
}
