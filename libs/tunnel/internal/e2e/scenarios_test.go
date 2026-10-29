package e2e_test

import (
	"context"
	"crypto/sha256"
	"errors"
	"fmt"
	"io"
	"net"
	"slices"
	"testing"
	"time"

	"connectrpc.com/connect"
	"github.com/google/uuid"

	"github.com/belov38/boat-dev-clone/libs/tunnel/agent"
	"github.com/belov38/boat-dev-clone/libs/tunnel/gateway"
	"github.com/belov38/boat-dev-clone/libs/tunnel/rpcconv"
	"github.com/belov38/boat-dev-clone/libs/tunnel/transport"
	"github.com/belov38/boat-dev-clone/libs/tunnel/tunneltest/process"
	testingv1 "github.com/belov38/boat-dev-clone/libs/tunnel/tunneltest/testpb/sbx/testing/v1"
	"github.com/belov38/boat-dev-clone/libs/tunnel/wire"
)

// maxPause is the scaled pause budget of spec 14.1 (30 s there).
const maxPause = 5 * time.Second

// Fault kinds of TestLongCommandSurvivesFaults.
type fault int

const (
	faultCut fault = iota
	faultStall
	faultAbandon
	faultDrain
	faultRestartAgent
	numFaults
)

func (f fault) String() string {
	return [...]string{"cut", "stall", "abandon+replace", "drain+replace", "restart-agent"}[f]
}

// injectFaults injects one random fault every 50-300 ms until stop is
// closed. It runs on its own goroutine and reports problems as errors.
func (e *env) injectFaults(ctx context.Context, m *machine, stop <-chan struct{}, counts *[numFaults]int, skipped *int) error {
	for {
		wait := 50*time.Millisecond + time.Duration(e.rng.Int64N(int64(250*time.Millisecond)))
		select {
		case <-stop:
			return nil
		case <-time.After(wait):
		}
		f := fault(e.rng.IntN(int(numFaults)))
		switch f {
		case faultCut, faultStall:
			l := m.newestLink()
			if l == nil {
				*skipped++
				continue
			}
			if f == faultCut {
				l.Cut()
			} else {
				l.Stall(2 * deadAfter)
			}
		case faultAbandon, faultDrain:
			owner := m.ownerGateway()
			if owner == nil {
				*skipped++
				continue
			}
			// The replacement comes up first, as in a rolling update.
			if _, err := e.startGateway(nil); err != nil { //nolint:contextcheck // the gateway outlives the injector
				return err
			}
			if f == faultAbandon {
				e.abandon(owner) //nolint:contextcheck // a crash takes no context
			} else if err := e.drain(ctx, owner); err != nil {
				return fmt.Errorf("drain %s: %w", owner.name, err)
			}
		case faultRestartAgent:
			if err := m.restartAgent(); err != nil { //nolint:contextcheck // the new agent outlives the injector
				return err
			}
		case numFaults:
		}
		counts[f]++
	}
}

func TestLongCommandSurvivesFaults(t *testing.T) {
	e := newEnv(t)
	e.mustGateway(nil)
	e.mustGateway(nil)
	m := e.newMachine(process.Options{}, nil)
	m.waitEvent(t, "connected", func(ev connEv) bool { return ev.Kind == agent.KindConnected })

	sp := spec(4000, 1024, time.Millisecond, 42)
	wantOut, wantErr := process.Expected(sp)
	ctx, cancel := context.WithTimeout(context.Background(), 2*waitTimeout)
	defer cancel()
	if err := e.startCommand(ctx, m.id, "long-1", sp); err != nil {
		t.Fatal(err)
	}
	readers := []*reader{newReader(e, m.id, "long-1"), newReader(e, m.id, "long-1")}
	results := make([]<-chan error, len(readers))
	for i, r := range readers {
		results[i] = r.goRun(ctx)
	}

	var (
		counts  [numFaults]int
		skipped int
	)
	stop := make(chan struct{})
	injErr := make(chan error, 1)
	go func() { injErr <- e.injectFaults(ctx, m, stop, &counts, &skipped) }()
	for i, ch := range results {
		waitErr(t, ch, fmt.Sprintf("reader %d", i))
	}
	close(stop)
	if err := <-injErr; err != nil {
		t.Fatalf("injector: %v", err)
	}

	total := 0
	for f := range numFaults {
		total += counts[f]
		t.Logf("fault %-16s x%d", f, counts[f])
	}
	t.Logf("faults injected: %d (skipped %d without a live link)", total, skipped)
	for i, r := range readers {
		t.Logf("reader %d: %d attaches, errors %v, %d overlaps, max pause %v", i, r.attaches.Load(), r.codes(), r.overlaps, r.maxPause)
		r.check(t, fmt.Sprintf("reader %d", i), wantOut, wantErr, 42)
		if r.maxPause > maxPause {
			t.Errorf("reader %d: pause of %v, budget %v", i, r.maxPause, maxPause)
		}
	}
	if total < 5 {
		t.Errorf("only %d faults injected", total)
	}
	if n := m.procs.Starts("long-1"); n != 1 {
		t.Errorf("Starts = %d, want 1", n)
	}
}

func TestDrainMovesAllAgents(t *testing.T) {
	e := newEnv(t)
	gA, gB, gC := e.mustGateway(nil), e.mustGateway(nil), e.mustGateway(nil)
	const perGateway = 20
	byGW := map[*gw][]*machine{}
	for _, g := range []*gw{gA, gB, gC} {
		e.routeOnly(g)
		for range perGateway {
			byGW[g] = append(byGW[g], e.newMachine(process.Options{}, nil))
		}
		for _, m := range byGW[g] {
			m.waitConnectedTo(t, g)
		}
	}
	e.routeAll()

	sp := spec(300, 1024, 5*time.Millisecond, 7)
	wantOut, wantErr := process.Expected(sp)
	ctx, cancel := context.WithTimeout(context.Background(), 2*waitTimeout)
	defer cancel()
	type job struct {
		m   *machine
		r   *reader
		res <-chan error
	}
	var jobs []job
	for _, g := range []*gw{gA, gB, gC} {
		for _, m := range byGW[g] {
			if err := e.startCommand(ctx, m.id, "cmd", sp); err != nil {
				t.Fatal(err)
			}
			r := newReader(e, m.id, "cmd")
			jobs = append(jobs, job{m: m, r: r, res: r.goRun(ctx)})
		}
	}
	for _, j := range jobs {
		j.r.waitBytes(t, 1)
	}
	errsBefore := make([]int64, len(jobs))
	for i, j := range jobs {
		errsBefore[i] = j.r.errCount.Load()
	}

	timing := fastTiming()
	budget := timing.EndpointWait + timing.DrainSpread + timing.TCPDeadline + timing.DrainMargin
	start := time.Now()
	if err := gA.Drain(ctx); err != nil {
		t.Fatalf("Drain: %v", err)
	}
	took := time.Since(start)
	t.Logf("Drain of %s with %d agents took %v (deadline %v)", gA.name, perGateway, took, budget)
	if took >= budget {
		t.Errorf("Drain took %v, deadline %v", took, budget)
	}
	for _, m := range byGW[gA] {
		ev := m.waitEvent(t, m.id+" moved", func(ev connEv) bool {
			return ev.Kind == agent.KindConnected && ev.Gateway != gA.name
		})
		if ev.Gateway != gB.name && ev.Gateway != gC.name {
			t.Errorf("%s moved to %s", m.id, ev.Gateway)
		}
		s, err := e.store.Session(ctx, m.id)
		if err != nil || s.State != "connected" || (s.InstanceID != gB.name && s.InstanceID != gC.name) {
			t.Errorf("%s: session %+v, %v", m.id, s, err)
		}
	}

	// A unary call sent to A after the move gets 421 and succeeds on the
	// first retry to the URL it names; the agent runs it once.
	target := byGW[gA][0]
	reqID := uuid.NewString()
	setLabel := func(url string) (*connect.Response[testingv1.SetLabelResponse], error) {
		req := connect.NewRequest(&testingv1.SetLabelRequest{CommandId: "cmd", Label: "moved"})
		req.Header().Set(wire.HeaderRequestID, reqID)
		return e.client(url, target.id).SetLabel(ctx, req)
	}
	_, err := setLabel(gA.url)
	var ce *connect.Error
	if !errors.As(err, &ce) || ce.Meta().Get(wire.HeaderErrorCode) != wire.CodeMachineMoved {
		t.Fatalf("SetLabel to A after the move: %v, want 421 machine_moved", err)
	}
	if d, ok := rpcconv.Detail(err); !ok || !d.GetRetryable() || d.GetInstanceUrl() != movedURL(err) {
		t.Fatalf("421 detail = %v, header url %q", d, movedURL(err))
	}
	to := movedURL(err)
	if to != gB.url && to != gC.url {
		t.Fatalf("421 points to %q, want B or C", to)
	}
	resp, err := setLabel(to)
	if err != nil {
		t.Fatalf("SetLabel retry to %s: %v", to, err)
	}
	if resp.Msg.GetCalls() != 1 || target.procs.LabelCalls("cmd") != 1 {
		t.Fatalf("calls = %d (store %d), want 1", resp.Msg.GetCalls(), target.procs.LabelCalls("cmd"))
	}
	gA.stopWith(true)

	for _, j := range jobs {
		waitErr(t, j.res, "reader of "+j.m.id)
		j.r.check(t, j.m.id, wantOut, wantErr, 7)
		if n := j.m.procs.Starts("cmd"); n != 1 {
			t.Errorf("%s: Starts = %d, want 1", j.m.id, n)
		}
	}
	onA := map[*machine]bool{}
	for _, m := range byGW[gA] {
		onA[m] = true
	}
	resumedA, disturbed := 0, 0
	for i, j := range jobs {
		if j.r.errCount.Load() == errsBefore[i] {
			continue
		}
		if onA[j.m] {
			resumedA++
		} else {
			disturbed++
		}
	}
	t.Logf("readers resumed after the drain: %d of %d on A; readers on B and C disturbed: %d", resumedA, perGateway, disturbed)
	if disturbed != 0 {
		t.Errorf("%d readers of machines on B or C saw errors during A's drain", disturbed)
	}
}

// startEcho listens on 127.0.0.1 and echoes until the peer goes away.
func startEcho(t *testing.T) uint16 {
	t.Helper()
	ln, err := (&net.ListenConfig{}).Listen(context.Background(), "tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = ln.Close() })
	go func() {
		for {
			c, err := ln.Accept()
			if err != nil {
				return
			}
			go func() {
				defer func() { _ = c.Close() }()
				_, _ = io.Copy(c, c)
			}()
		}
	}()
	return uint16(ln.Addr().(*net.TCPAddr).Port) //nolint:gosec // a TCP port fits in uint16
}

func echo(t *testing.T, c net.Conn, msg string) {
	t.Helper()
	if _, err := io.WriteString(c, msg); err != nil {
		t.Fatalf("write %q: %v", msg, err)
	}
	buf := make([]byte, len(msg))
	if _, err := io.ReadFull(c, buf); err != nil {
		t.Fatalf("read echo of %q: %v", msg, err)
	}
	if string(buf) != msg {
		t.Fatalf("echo = %q, want %q", buf, msg)
	}
}

// closedAt reads c until it fails and sends the time.
func closedAt(c net.Conn) <-chan time.Time {
	ch := make(chan time.Time, 1)
	go func() {
		_, _ = io.Copy(io.Discard, c)
		ch <- time.Now()
	}()
	return ch
}

func TestDrainKeepsTCPUntilDeadline(t *testing.T) {
	e := newEnv(t)
	gA, gB := e.mustGateway(nil), e.mustGateway(nil)
	e.routeOnly(gA)
	m := e.newMachine(process.Options{}, nil)
	m.waitConnectedTo(t, gA)
	ctx, cancel := context.WithTimeout(context.Background(), 2*waitTimeout)
	defer cancel()

	port := startEcho(t)
	const longDeadline = 900 * time.Millisecond
	short, err := gateway.DialRemoteTCP(ctx, e.peer, gA.url, serviceToken, m.id, port, gateway.TCPOptions{})
	if err != nil {
		t.Fatal(err)
	}
	defer func() { _ = short.Close() }()
	long, err := gateway.DialRemoteTCP(ctx, e.peer, gA.url, serviceToken, m.id, port, gateway.TCPOptions{DrainDeadline: longDeadline})
	if err != nil {
		t.Fatal(err)
	}
	defer func() { _ = long.Close() }()
	echo(t, short, "short before")
	echo(t, long, "long before")

	// An RPC stream on A: Attach to a slow command.
	if err := e.startCommand(ctx, m.id, "slow", spec(100000, 64, 50*time.Millisecond, 0)); err != nil {
		t.Fatal(err)
	}
	stream, err := e.client(gA.url, m.id).Attach(ctx, connect.NewRequest(&testingv1.AttachRequest{CommandId: "slow"}))
	if err != nil {
		t.Fatal(err)
	}
	defer func() { _ = stream.Close() }()
	if !stream.Receive() {
		t.Fatalf("attach on A: %v", stream.Err())
	}
	type streamEnd struct {
		at  time.Time
		err error
	}
	rpcEnd := make(chan streamEnd, 1)
	go func() {
		for stream.Receive() { //nolint:revive // read until the stream ends
		}
		rpcEnd <- streamEnd{at: time.Now(), err: stream.Err()}
	}()

	e.routeAll()
	drained := make(chan error, 1)
	drainStart := time.Now()
	go func() { drained <- gA.Drain(ctx) }()
	ev := m.waitEvent(t, "drain", func(ev connEv) bool { return ev.Kind == agent.KindDrain })
	if ev.TCPDeadline != longDeadline {
		t.Fatalf("agent got tcp_deadline %v, want %v (the longest open stream)", ev.TCPDeadline, longDeadline)
	}
	movedAt := m.waitConnectedTo(t, gB).at

	echo(t, short, "short after move")
	shortClosed := closedAt(short)
	time.Sleep(time.Until(movedAt.Add(longDeadline / 2)))
	echo(t, long, "long after move")
	longClosed := closedAt(long)

	const early, late = 50 * time.Millisecond, 500 * time.Millisecond
	checkClose := func(name string, ch <-chan time.Time, deadline time.Duration) {
		t.Helper()
		select {
		case at := <-ch:
			d := at.Sub(movedAt)
			t.Logf("%s stream closed %v after the move (deadline %v)", name, d, deadline)
			if d < deadline-early || d > deadline+late {
				t.Errorf("%s stream closed %v after the move, want %v (-%v/+%v)", name, d, deadline, early, late)
			}
		case <-time.After(waitTimeout):
			t.Fatalf("%s stream never closed", name)
		}
	}
	checkClose("default", shortClosed, fastTiming().TCPDeadline)
	checkClose("long", longClosed, longDeadline)

	select {
	case end := <-rpcEnd:
		d := end.at.Sub(movedAt)
		detail, _ := rpcconv.Detail(end.err)
		t.Logf("RPC stream on A ended %v after the move: %v", d, end.err)
		if connect.CodeOf(end.err) != connect.CodeUnavailable || detail.GetCode() != wire.CodeMachineMoved {
			t.Errorf("RPC stream on A ended with %v, want unavailable machine_moved", end.err)
		}
		if d > fastTiming().TCPDeadline {
			t.Errorf("RPC stream on A ended %v after the move, want right away", d)
		}
	case <-time.After(waitTimeout):
		t.Fatal("RPC stream on A did not end")
	}

	select {
	case err := <-drained:
		if err != nil {
			t.Fatalf("Drain = %v", err)
		}
		timing := fastTiming()
		if took, budget := time.Since(drainStart), timing.EndpointWait+timing.DrainSpread+longDeadline+timing.DrainMargin; took > budget {
			t.Errorf("Drain took %v, deadline %v", took, budget)
		}
	case <-time.After(waitTimeout):
		t.Fatal("Drain did not return")
	}
}

func TestAgentRestartKeepsCommands(t *testing.T) {
	e := newEnv(t)
	e.mustGateway(nil)
	e.mustGateway(nil)
	m := e.newMachine(process.Options{}, nil)
	m.waitEvent(t, "connected", func(ev connEv) bool { return ev.Kind == agent.KindConnected })
	ctx, cancel := context.WithTimeout(context.Background(), 2*waitTimeout)
	defer cancel()

	sp := spec(3000, 1024, time.Millisecond, 42)
	wantOut, wantErr := process.Expected(sp)
	if err := e.startCommand(ctx, m.id, "build", sp); err != nil {
		t.Fatal(err)
	}
	r := newReader(e, m.id, "build")
	res := r.goRun(ctx)
	r.waitBytes(t, 200<<10)

	if err := m.restartAgent(); err != nil {
		t.Fatal(err)
	}
	gen := m.generation()
	ev := m.waitEvent(t, "new client connected", func(ev connEv) bool {
		return ev.gen == gen && ev.Kind == agent.KindConnected
	})
	if ev.Auth != transport.AuthBootstrap {
		t.Fatalf("restarted agent connected with %v, want the bootstrap secret (MT was in memory)", ev.Auth)
	}
	eventually(t, waitTimeout, "agent_restarted event", func() bool { return e.sink.has(m.id, "agent_restarted") })

	waitErr(t, res, "reader")
	t.Logf("reader: %d attaches, errors %v, max pause %v", r.attaches.Load(), r.codes(), r.maxPause)
	r.check(t, "reader", wantOut, wantErr, 42)
	if n := m.procs.Starts("build"); n != 1 {
		t.Errorf("Starts = %d, want 1", n)
	}
}

func TestCutMidEnvelope(t *testing.T) {
	e := newEnv(t)
	e.mustGateway(nil)
	m := e.newMachine(process.Options{}, nil)
	m.waitEvent(t, "connected", func(ev connEv) bool { return ev.Kind == agent.KindConnected })
	ctx, cancel := context.WithTimeout(context.Background(), 2*waitTimeout)
	defer cancel()

	// 64 KiB lines: every data event is one large envelope. The reader is
	// slow, so the pipeline is full and the agent is blocked inside an
	// envelope when the tunnel is cut.
	sp := spec(256, 64<<10, 0, 3) // 16 MiB
	wantOut, wantErr := process.Expected(sp)
	if err := e.startCommand(ctx, m.id, "big", sp); err != nil {
		t.Fatal(err)
	}
	r := newReader(e, m.id, "big")
	r.slow = 5 * time.Millisecond
	res := r.goRun(ctx)
	const cuts = 3
	var lastAttach int64
	for k := range cuts {
		// Cut a new Attach call once it has carried 1 MiB, so every cut
		// hits a live stream and leaves several MiB unsent.
		eventually(t, waitTimeout, fmt.Sprintf("a new attach reading before cut %d", k+1), func() bool {
			return r.attaches.Load() > lastAttach && r.attachBytes.Load() >= 1<<20
		})
		lastAttach = r.attaches.Load()
		l := m.newestLink()
		if l == nil {
			t.Fatalf("cut %d: no live link", k+1)
		}
		l.Cut()
	}
	waitErr(t, res, "reader")
	t.Logf("%d cuts; reader: %d attaches, errors %v", cuts, r.attaches.Load(), r.codes())
	for _, err := range r.errs {
		t.Logf("  attach error: %v", err)
	}
	r.check(t, "reader", wantOut, wantErr, 3)
	if len(r.errs) < cuts {
		t.Fatalf("reader saw %d errors for %d cuts", len(r.errs), cuts)
	}
	// At least one cut reset a stream inside an envelope (connect-go reports
	// the RST_STREAM as internal); the others may end at a boundary with
	// unavailable. Both are retryable and nothing truncated was parsed: the
	// output above is exact.
	if r.codes()[connect.CodeInternal.String()] == 0 {
		t.Errorf("no cut landed inside an envelope (errors %v)", r.codes())
	}
}

func TestSlowConsumerBounded(t *testing.T) {
	e := newEnv(t)
	g := e.mustGateway(nil)
	m := e.newMachine(process.Options{}, nil)
	m.waitConnectedTo(t, g)
	ctx, cancel := context.WithTimeout(context.Background(), 2*waitTimeout)
	defer cancel()

	sp := spec(1024, 64<<10, 0, 0) // 64 MiB
	if err := e.startCommand(ctx, m.id, "flood", sp); err != nil {
		t.Fatal(err)
	}
	stream, err := e.client(g.url, m.id).Attach(ctx, connect.NewRequest(&testingv1.AttachRequest{CommandId: "flood"}))
	if err != nil {
		t.Fatal(err)
	}
	defer func() { _ = stream.Close() }()

	hashes := [2]io.Writer{sha256.New(), sha256.New()}
	var consumed uint64
	var exit *testingv1.ExitEvent
	read := func(until uint64) {
		t.Helper()
		for consumed < until && exit == nil {
			if !stream.Receive() {
				t.Fatalf("attach ended: %v", stream.Err())
			}
			switch ev := stream.Msg().GetEvent().(type) {
			case *testingv1.AttachResponse_Data:
				_, _ = hashes[streamIndex(ev.Data.GetStream())].Write(ev.Data.GetData())
				consumed += uint64(len(ev.Data.GetData()))
			case *testingv1.AttachResponse_Exit:
				exit = ev.Exit
			}
		}
	}
	read(4 << 20)

	// Stop reading for 1 s.
	const bound = 4 << 20
	var maxInFlight uint64
	pauseEnd := time.Now().Add(time.Second)
	for time.Now().Before(pauseEnd) {
		maxInFlight = max(maxInFlight, m.procs.SentBytes("flood")-consumed)
		time.Sleep(20 * time.Millisecond)
	}
	maxInFlight = max(maxInFlight, m.procs.SentBytes("flood")-consumed)
	po, pe := m.procs.Produced("flood")
	t.Logf("after a 1 s pause: consumed %d, handed to Send %d (in flight %d), produced %d",
		consumed, m.procs.SentBytes("flood"), maxInFlight, po+pe)
	if maxInFlight >= bound {
		t.Errorf("%d bytes in flight while the client did not read, want < %d", maxInFlight, bound)
	}
	if po+pe < consumed+maxInFlight+16<<20 {
		t.Errorf("the command produced only %d bytes: the bound was not exercised", po+pe)
	}

	read(1 << 62) // to the exit event
	wantOut, wantErr := process.Expected(sp)
	for i, want := range [][]byte{wantOut, wantErr} {
		sum := sha256.Sum256(want)
		if got := hashes[i].(interface{ Sum([]byte) []byte }).Sum(nil); !slices.Equal(got, sum[:]) {
			t.Errorf("stream %d: sha256 differs", i)
		}
	}
	if exit.GetStdoutEnd() != uint64(len(wantOut)) || exit.GetStderrEnd() != uint64(len(wantErr)) {
		t.Errorf("exit = %v", exit)
	}
}
