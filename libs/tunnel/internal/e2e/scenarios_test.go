package e2e_test

import (
	"context"
	"crypto/sha256"
	"errors"
	"fmt"
	"io"
	"log/slog"
	"net"
	"slices"
	"strings"
	"sync"
	"testing"
	"time"

	"connectrpc.com/connect"
	"github.com/google/uuid"

	"github.com/belov38/umiak/libs/tunnel/agent"
	"github.com/belov38/umiak/libs/tunnel/gateway"
	"github.com/belov38/umiak/libs/tunnel/h2"
	"github.com/belov38/umiak/libs/tunnel/rpcconv"
	"github.com/belov38/umiak/libs/tunnel/transport"
	"github.com/belov38/umiak/libs/tunnel/tunneltest/process"
	testingv1 "github.com/belov38/umiak/libs/tunnel/tunneltest/testpb/umiak/testing/v1"
	"github.com/belov38/umiak/libs/tunnel/wire"
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
// closed. Kinds come from a shuffled bag, so every kind is injected once per
// round; a kind that could not be injected (no live link or owner) goes back
// into the bag. It runs on its own goroutine and reports problems as errors.
func (e *env) injectFaults(ctx context.Context, m *machine, stop <-chan struct{}, counts *[numFaults]int, skipped *int) error {
	var bag []fault
	for {
		wait := 50*time.Millisecond + time.Duration(e.rng.Int64N(int64(250*time.Millisecond)))
		select {
		case <-stop:
			return nil
		case <-time.After(wait):
		}
		if len(bag) == 0 {
			for f := range numFaults {
				bag = append(bag, f)
			}
			e.rng.Shuffle(len(bag), func(i, j int) { bag[i], bag[j] = bag[j], bag[i] })
		}
		f := bag[len(bag)-1]
		bag = bag[:len(bag)-1]
		retry := func() { bag = append([]fault{f}, bag...) }
		switch f {
		case faultCut, faultStall:
			l := m.newestLink()
			if l == nil {
				*skipped++
				retry()
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
				retry()
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
	for f := range numFaults {
		if counts[f] == 0 {
			t.Errorf("fault %s was never injected", f)
		}
	}
	if n := m.procs.Starts("long-1"); n != 1 {
		t.Errorf("Starts = %d, want 1", n)
	}
	if n := m.procs.Invocations("long-1"); n < 1 {
		t.Errorf("Invocations = %d, want >= 1", n)
	}
}

func TestDrainMovesAllAgents(t *testing.T) {
	e := newEnv(t)
	// The drain is a CPU burst (20 agents reconnect at once, more under
	// -race): the harness's 200 ms ping budget could close a session of B or
	// C and disturb its reader. Under load a heartbeat write can also lag
	// past the harness's 500 ms StaleAfter, and the other gateways sweep the
	// instance's sessions; this test does not exercise sweeps, so its
	// gateways allow 3 s. Gateway-side session moves (when a moved
	// session aborts its RPC streams) and closes are recorded: the moves
	// time the expected stream errors of A's readers, both feed the diagnosis.
	closes := &closeLog{}
	mod := func(c *gateway.Config) {
		c.HTTP2 = h2.ClientConfig{PingIdle: time.Second, PingTimeout: time.Second}
		c.Timing.StaleAfter = 3 * time.Second
		c.Logger = slog.New(&closeHandler{log: closes, next: c.Logger.Handler()})
	}
	gA, gB, gC := e.mustGateway(mod), e.mustGateway(mod), e.mustGateway(mod)
	// The commands exit only after A stopped, so every reader on A has an
	// open attach when its session moves, however slowly the commands were
	// started and the drain ran (under load the output may well be complete
	// by then).
	hold := make(chan struct{})
	release := sync.OnceFunc(func() { close(hold) })
	defer release()
	const perGateway = 20
	byGW := map[*gw][]*machine{}
	for _, g := range []*gw{gA, gB, gC} {
		e.routeOnly(g)
		for range perGateway {
			byGW[g] = append(byGW[g], e.newMachine(process.Options{Hold: hold}, nil))
		}
		for _, m := range byGW[g] {
			m.waitConnectedTo(t, g)
		}
	}
	e.routeAll()

	sp := spec(400, 1024, 5*time.Millisecond, 7)
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
	// The setup must still stand when the drain starts: every agent is on
	// its first connection. Under heavy load a starved heartbeat can get a
	// session swept and its agent reconnected elsewhere; then the drain has
	// nothing to move and the readers' errors would be misattributed.
	for _, g := range []*gw{gA, gB, gC} {
		for _, m := range byGW[g] {
			if ev, ok := m.findEvent(func(ev connEv) bool {
				return ev.Kind != agent.KindConnected || ev.Gateway != g.name
			}); ok {
				var gwCloses []string
				for _, c := range closes.of(m.id) {
					gwCloses = append(gwCloses, fmt.Sprintf("%s %v ago: %q", c.gw, time.Since(c.at).Round(time.Millisecond), c.reason))
				}
				t.Fatalf("setup disturbed before the drain: agent of %s (on %s) had event %s gw=%s reason=%q %v ago; gateway session closes: %v",
					m.id, g.name, ev.Kind, ev.Gateway, ev.Reason, time.Since(ev.at).Round(time.Millisecond), gwCloses)
			}
		}
	}
	atStart := make([]int64, len(jobs))
	for i, j := range jobs {
		atStart[i] = j.r.bytes.Load()
	}

	timing := fastTiming()
	budget := timing.EndpointWait + timing.DrainSpread + timing.TCPDeadline + timing.DrainMargin
	start := time.Now()
	if err := gA.Drain(ctx); err != nil {
		t.Fatalf("Drain: %v", err)
	}
	took := time.Since(start)
	phases := []drainPhase{{"drain returned", took}}
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

	phases = append(phases, drainPhase{"agents of A moved", time.Since(start)})

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
	phases = append(phases, drainPhase{"SetLabel retried", time.Since(start)})
	gA.stopWith(true)
	stopped := time.Now()
	phases = append(phases, drainPhase{"A stopped", stopped.Sub(start)})
	release()

	for _, j := range jobs {
		waitErr(t, j.res, "reader of "+j.m.id)
		j.r.check(t, j.m.id, wantOut, wantErr, 7)
		if n := j.m.procs.Starts("cmd"); n != 1 {
			t.Errorf("%s: Starts = %d, want 1", j.m.id, n)
		}
		if n := j.m.procs.Invocations("cmd"); n < 1 {
			t.Errorf("%s: Invocations = %d, want >= 1", j.m.id, n)
		}
	}
	onA := map[*machine]bool{}
	for _, m := range byGW[gA] {
		onA[m] = true
	}
	// Each reader on A had an open attach when its session moved (the exit
	// was held), so each lost its stream to the move and resumed elsewhere.
	// Readers on B and C see no error from the drain start until A stopped.
	var classes [drainMissed + 1]int
	disturbed := 0
	for _, j := range jobs {
		if onA[j.m] {
			moved, _ := closes.movedAt(j.m.id, gA.name)
			classes[classify(j.r, moved, stopped)]++
		} else if j.r.errorsBetween(start, stopped) != 0 {
			disturbed++
		}
	}
	t.Logf("readers on A: %d resumed, %d exited before the move, %d missed the move; readers on B and C with errors between the drain start and A stopped: %d",
		classes[drainResumed], classes[drainExitedEarly], classes[drainMissed], disturbed)
	if classes[drainResumed] != perGateway {
		t.Errorf("%d of %d readers on A resumed after their session moved, want all", classes[drainResumed], perGateway)
	}
	if disturbed != 0 {
		t.Errorf("%d readers of machines on B or C saw errors between A's drain start and A stopped", disturbed)
	}
	if t.Failed() {
		phases = append(phases, drainPhase{"readers done", time.Since(start)})
		gwOf := map[*machine]string{}
		for g, ms := range byGW {
			for _, m := range ms {
				gwOf[m] = g.name
			}
		}
		diag := make([]drainDiag, len(jobs))
		for i, j := range jobs {
			diag[i] = drainDiag{m: j.m, gw: gwOf[j.m], r: j.r, atStart: atStart[i]}
		}
		logDrainDiag(t, e, gA.name, start, stopped, phases, diag, closes)
	}
}

// drainPhase is a step of TestDrainMovesAllAgents and when it ended,
// relative to the start of the drain.
type drainPhase struct {
	name string
	at   time.Duration
}

// drainDiag is one reader of TestDrainMovesAllAgents and its machine.
type drainDiag struct {
	m       *machine
	gw      string // the gateway the agent was on before the drain
	r       *reader
	atStart int64 // bytes the reader had accepted when the drain started
}

// drainClass is what happened to a reader of the drained gateway.
type drainClass int

const (
	// drainResumed: streaming when its session moved, the stream failed
	// between the move and A stopped and the reader resumed.
	drainResumed drainClass = iota
	// drainExitedEarly: the exit arrived before the session moved, so the
	// move had no stream to abort.
	drainExitedEarly
	// drainMissed: streaming when the session moved (or no move was seen),
	// but no error between the move and A stopped.
	drainMissed
)

func (c drainClass) String() string {
	return [...]string{"resumed", "exited before the move", "missed the move"}[c]
}

// classify classifies a reader of the drained gateway after it returned;
// movedAt is when its session there moved (zero if never).
func classify(r *reader, movedAt, stopped time.Time) drainClass {
	switch {
	case movedAt.IsZero():
		return drainMissed
	case !r.exitAt.IsZero() && r.exitAt.Before(movedAt):
		return drainExitedEarly
	case r.errorsBetween(movedAt, stopped) > 0:
		return drainResumed
	default:
		return drainMissed
	}
}

// logDrainDiag logs what a failed TestDrainMovesAllAgents needs for a
// diagnosis: the phase timings, a line per reader of the drained gateway
// (bytes at the drain start, move, errors and exit times, classification),
// and in detail every reader of the drained gateway that did not resume and
// every other reader that saw an error between the drain start and stopped:
// its errors, the agent's connection events, the gateway-side session moves
// and closes and the registry owner and session. Times are relative to the
// drain start.
func logDrainDiag(t *testing.T, e *env, drained string, start, stopped time.Time, phases []drainPhase, jobs []drainDiag, closes *closeLog) {
	t.Helper()
	ctx, cancel := context.WithTimeout(context.Background(), waitTimeout)
	defer cancel()
	rel := func(at time.Time) string {
		if at.IsZero() {
			return "never"
		}
		return "+" + at.Sub(start).Round(time.Millisecond).String()
	}
	for _, p := range phases {
		t.Logf("phase %q at +%v", p.name, p.at.Round(time.Millisecond))
	}
	errList := func(r *reader) []string {
		var errs []string
		for k := range r.errs {
			mark := "outside"
			if at := r.errAt[k]; !at.Before(start) && !at.After(stopped) {
				mark = "inside"
			}
			errs = append(errs, fmt.Sprintf("[%s %s %s %s] %v", mark, rel(r.errAt[k]), r.errURL[k], connect.CodeOf(r.errs[k]), r.errs[k]))
		}
		return errs
	}
	for _, j := range jobs {
		if j.gw != drained {
			continue
		}
		moved, _ := closes.movedAt(j.m.id, drained)
		var errs []string
		for k := range j.r.errs {
			errs = append(errs, fmt.Sprintf("%s %s", rel(j.r.errAt[k]), connect.CodeOf(j.r.errs[k])))
		}
		t.Logf("reader of %s on %s: %s; %d bytes at the drain start, moved %s, errors [%s], exit %s",
			j.m.id, drained, classify(j.r, moved, stopped), j.atStart, rel(moved), strings.Join(errs, ", "), rel(j.r.exitAt))
	}
	for _, j := range jobs {
		r := j.r
		if j.gw == drained {
			moved, _ := closes.movedAt(j.m.id, drained)
			if classify(r, moved, stopped) == drainResumed {
				continue
			}
		} else if r.errorsBetween(start, stopped) == 0 {
			continue
		}
		j.m.evMu.Lock()
		var evs []string
		for _, ev := range j.m.events {
			evs = append(evs, fmt.Sprintf("%s gen%d %s gw=%s conn=%s epoch=%d status=%d reason=%q",
				rel(ev.at), ev.gen, ev.Kind, ev.Gateway, ev.ConnID, ev.Epoch, ev.Status, ev.Reason))
		}
		j.m.evMu.Unlock()
		o, ok, oerr := e.store.Owner(ctx, j.m.id, staleAfter)
		sess, serr := e.store.Session(ctx, j.m.id)
		var gwCloses []string
		for _, c := range closes.of(j.m.id) {
			what := "closed"
			if c.moved {
				what = "moved (aborted rpc streams " + c.aborted + ")"
			}
			gwCloses = append(gwCloses, fmt.Sprintf("%s %s %s conn=%s epoch=%s reason=%q", rel(c.at), c.gw, what, c.conn, c.epoch, c.reason))
		}
		t.Logf("machine %s (was on %s): %d attaches, %d bytes at the drain start, %d/%d bytes, exit %v at %s\n  errors:\n    %s\n  conn events:\n    %s\n  gateway session moves and closes:\n    %s\n  owner %+v ok=%v err=%v\n  session %+v err=%v",
			j.m.id, j.gw, r.attaches.Load(), j.atStart, len(r.out[0]), len(r.out[1]), r.exit, rel(r.exitAt),
			strings.Join(errList(r), "\n    "), strings.Join(evs, "\n    "), strings.Join(gwCloses, "\n    "), o, ok, oerr, sess, serr)
	}
}

// closeRec is a gateway-side session close ("gateway: session closed") or,
// with moved set, a draining session fenced to moved ("gateway: session
// moved while draining", when its RPC streams are aborted).
type closeRec struct {
	at                               time.Time
	moved                            bool
	gw, machine, conn, epoch, reason string
	aborted                          string // aborted_rpc_streams of a move
}

// closeLog records the session closes and moves of gateways logging through
// closeHandler.
type closeLog struct {
	mu   sync.Mutex
	recs []closeRec
}

// movedAt returns when the session of machineID on gateway gw moved.
func (l *closeLog) movedAt(machineID, gw string) (time.Time, bool) {
	l.mu.Lock()
	defer l.mu.Unlock()
	for _, r := range l.recs {
		if r.moved && r.machine == machineID && r.gw == gw {
			return r.at, true
		}
	}
	return time.Time{}, false
}

// of returns the closes and moves of a machine's sessions.
func (l *closeLog) of(machineID string) []closeRec {
	l.mu.Lock()
	defer l.mu.Unlock()
	var out []closeRec
	for _, r := range l.recs {
		if r.machine == machineID {
			out = append(out, r)
		}
	}
	return out
}

// closeHandler records "gateway: session closed" and "gateway: session
// moved while draining" records in log and passes every record on to next.
type closeHandler struct {
	log   *closeLog
	next  slog.Handler
	attrs []slog.Attr
}

func (h *closeHandler) Enabled(ctx context.Context, l slog.Level) bool {
	return l >= slog.LevelInfo || h.next.Enabled(ctx, l)
}

func (h *closeHandler) Handle(ctx context.Context, r slog.Record) error {
	if r.Message == "gateway: session closed" || r.Message == "gateway: session moved while draining" {
		rec := closeRec{at: r.Time, moved: r.Message != "gateway: session closed"}
		set := func(a slog.Attr) bool {
			v := a.Value.String()
			switch a.Key {
			case "instance_id":
				rec.gw = v
			case "machine_id":
				rec.machine = v
			case "conn_id":
				rec.conn = v
			case "epoch":
				rec.epoch = v
			case "reason":
				rec.reason = v
			case "aborted_rpc_streams":
				rec.aborted = v
			}
			return true
		}
		for _, a := range h.attrs {
			set(a)
		}
		r.Attrs(set)
		h.log.mu.Lock()
		h.log.recs = append(h.log.recs, rec)
		h.log.mu.Unlock()
	}
	if h.next.Enabled(ctx, r.Level) {
		return h.next.Handle(ctx, r)
	}
	return nil
}

func (h *closeHandler) WithAttrs(as []slog.Attr) slog.Handler {
	return &closeHandler{log: h.log, next: h.next.WithAttrs(as), attrs: append(slices.Clone(h.attrs), as...)}
}

func (h *closeHandler) WithGroup(name string) slog.Handler {
	return &closeHandler{log: h.log, next: h.next.WithGroup(name), attrs: h.attrs}
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
	if n := m.procs.Invocations("build"); n < 1 {
		t.Errorf("Invocations = %d, want >= 1", n)
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
