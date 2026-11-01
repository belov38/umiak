package e2e_test

import (
	"context"
	"io"
	"net/http"
	"strconv"
	"sync"
	"sync/atomic"
	"testing"
	"time"

	"github.com/belov38/umiak/libs/tunnel/transport"
	"github.com/belov38/umiak/services/gateway/internal/cpapi"
	"github.com/belov38/umiak/services/gateway/internal/server"
	"github.com/belov38/umiak/services/gateway/internal/testenv"
)

// notifyWindow is the longest a NOTIFY may take to change answers (spec
// 15.2, 15.3).
const notifyWindow = time.Second

func TestRenameWithin1s(t *testing.T) {
	t.Parallel()
	c := newCluster(t, testenv.Options{}, nil)
	m := c.newMachine(t)
	m.ServeHTTP(3000, echoApp())
	old := c.env.Route(m, 3000, nil)
	oldHost := testenv.Host(old.Label)
	fronts := []*http.Client{c.env.PlainClient(c.A), c.env.PlainClient(c.B)}
	for _, f := range fronts {
		mustGet(t, f, oldHost, "/") // cached on A and B
	}

	// The rename in api: the old label is gone, the new one exists.
	c.env.API.DeleteRoute(old.Label)
	renamed := c.env.Route(m, 3000, func(r *cpapi.Route) {
		r.Slug = "renamed" + old.Slug[1:7]
		r.SandboxID = old.SandboxID
	})
	c.env.NotifyRoutes(old.Slug)
	for i, f := range fronts {
		took := within(t, notifyWindow, "old label 404 on front "+strconv.Itoa(i), func() bool {
			r := get(t, f, oldHost, "/")
			return r.status == http.StatusNotFound && r.umiakError == "route_not_found"
		})
		t.Logf("front %d: old label 404 after %s", i, took)
		mustGet(t, f, testenv.Host(renamed.Label), "/")
	}
}

func TestBlockWithin1s(t *testing.T) {
	t.Parallel()
	c := newCluster(t, testenv.Options{}, nil)
	m := c.newMachine(t)
	m.ServeHTTP(3000, echoApp())
	rt := c.env.Route(m, 3000, nil)
	host := testenv.Host(rt.Label)
	fronts := []*http.Client{c.env.PlainClient(c.A), c.env.PlainClient(c.B)}
	for _, f := range fronts {
		mustGet(t, f, host, "/")
	}

	// The team turned public ports off: api answers blocked.
	rt.Blocked, rt.BlockReason = true, "public_disabled"
	c.env.API.SetRoute(rt)
	c.env.NotifyRoutes("*")
	for i, f := range fronts {
		took := within(t, notifyWindow, "403 route_blocked on front "+strconv.Itoa(i), func() bool {
			r := get(t, f, host, "/")
			return r.status == http.StatusForbidden && r.umiakError == "route_blocked"
		})
		t.Logf("front %d: blocked after %s", i, took)
	}
}

// offsetClock is the wall clock plus an adjustable offset.
type offsetClock struct{ off atomic.Int64 }

func (c *offsetClock) Now() time.Time          { return time.Now().Add(time.Duration(c.off.Load())) }
func (c *offsetClock) Advance(d time.Duration) { c.off.Add(int64(d)) }

func TestAPIDownStale(t *testing.T) {
	t.Parallel()
	clock := &offsetClock{}
	c := newCluster(t, testenv.Options{Deps: func(d *server.Deps) { d.Now = clock.Now }}, nil)
	m := c.newMachine(t)
	m.ServeHTTP(3000, echoApp())
	ok := c.env.Route(m, 3000, nil)
	blocked := c.env.Route(m, 3000, func(r *cpapi.Route) { r.Blocked, r.BlockReason = true, "operator" })
	fresh := c.env.Route(m, 3000, nil) // never asked for before the outage
	client := c.env.PlainClient(c.A)

	expect := func(host string, status int, code, what string) {
		t.Helper()
		r := get(t, client, host, "/")
		if r.took > 3*time.Second {
			t.Errorf("%s took %s, want <= 3 s", what, r.took)
		}
		if r.err != nil || r.status != status || r.umiakError != code {
			t.Errorf("%s = %v, want %d %s", what, r, status, code)
		}
	}
	expect(testenv.Host(ok.Label), http.StatusOK, "", "ok before the outage")
	expect(testenv.Host(blocked.Label), http.StatusForbidden, "route_blocked", "blocked before the outage")

	c.env.API.SetDown(true)
	expect(testenv.Host(ok.Label), http.StatusOK, "", "cached route, api down")
	expect(testenv.Host(blocked.Label), http.StatusForbidden, "route_blocked", "cached blocked route, api down")
	expect(testenv.Host(fresh.Label), http.StatusServiceUnavailable, "route_lookup_unavailable", "new label, api down")

	// Past the TTL (30 s) the entries are expired but within the 10 min of
	// stale serving.
	clock.Advance(9 * time.Minute)
	expect(testenv.Host(ok.Label), http.StatusOK, "", "expired route at +9 min, api down")
	expect(testenv.Host(blocked.Label), http.StatusForbidden, "route_blocked", "expired blocked route at +9 min, api down")

	// A hung api: every lookup waits for the 1 s lookup timeout at most,
	// and the stale entries keep being served.
	c.env.API.SetDown(false)
	c.env.API.SetLatency(time.Minute)
	clock.Advance(2 * time.Second) // past the retry backoff of the failed refresh
	expect(testenv.Host(ok.Label), http.StatusOK, "", "expired route, api hung")
	expect(testenv.Host(blocked.Label), http.StatusForbidden, "route_blocked", "expired blocked route, api hung")
	expect(testenv.Host(fresh.Label), http.StatusServiceUnavailable, "route_lookup_unavailable", "new label, api hung")

	// Beyond TTL + 10 min nothing is served from the cache.
	c.env.API.SetLatency(0)
	c.env.API.SetDown(true)
	clock.Advance(2 * time.Minute)
	expect(testenv.Host(ok.Label), http.StatusServiceUnavailable, "route_lookup_unavailable", "route older than TTL+10 min, api down")
	expect(testenv.Host(blocked.Label), http.StatusServiceUnavailable, "route_lookup_unavailable", "blocked route older than TTL+10 min, api down")

	c.env.API.SetDown(false)
	expect(testenv.Host(ok.Label), http.StatusOK, "", "api back")
}

func TestMachineMoveMidTraffic(t *testing.T) {
	t.Parallel()
	c := newCluster(t, testenv.Options{}, nil)
	m := c.newMachine(t)
	m.ServeHTTP(3000, http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) { _, _ = io.WriteString(w, "ok") }))
	rt := c.env.Route(m, 3000, nil)
	host := testenv.Host(rt.Label)
	agentWait := c.A.Config.Timeouts.AgentWait

	var (
		mu       sync.Mutex
		results  []result
		stop     atomic.Bool
		wg       sync.WaitGroup
		requests atomic.Int64
	)
	for _, front := range []*testenv.Inst{c.A, c.B} {
		client := loopClient(c, front)
		for range 10 {
			wg.Go(func() {
				for !stop.Load() {
					time.Sleep(loopPause)
					r := get(t, client, host, "/")
					requests.Add(1)
					if r.err != nil || r.status != http.StatusOK {
						mu.Lock()
						results = append(results, r)
						mu.Unlock()
					}
				}
			})
		}
	}
	eventually(t, "traffic", func() bool { return requests.Load() > 200 })

	// The tunnel to C breaks; the agent reconnects, to B only.
	c.env.RouteOnly(c.B)
	links := c.env.Net.Links(m.ID)
	if len(links) != 1 || links[0].Gateway != c.C.Name {
		t.Fatalf("links = %v, want one to C", links)
	}
	cutAt := time.Now()
	links[0].Cut()
	eventually(t, "machine on B", func() bool { return m.Owner() == c.B })
	m.WaitConnected()
	t.Logf("reconnected to B %s after the cut", time.Since(cutAt))
	before := requests.Load()
	eventually(t, "traffic after the move", func() bool { return requests.Load() > before+200 })
	stop.Store(true)
	wg.Wait()

	var first, last time.Time
	for _, r := range results {
		if r.err != nil || r.status != http.StatusServiceUnavailable || r.umiakError != "agent_unavailable" || r.retry == "" {
			t.Errorf("answer during the move: %v (Retry-After %q) after %s", r, r.retry, r.took)
			continue
		}
		if r.took > agentWait+time.Second {
			t.Errorf("503 agent_unavailable took %s, want <= AgentWait %s", r.took, agentWait)
		}
		if first.IsZero() || r.start.Before(first) {
			first = r.start
		}
		if end := r.start.Add(r.took); end.After(last) {
			last = end
		}
	}
	if !first.IsZero() && last.Sub(first) > agentWait+time.Second {
		t.Errorf("503s lasted %s, want <= AgentWait %s", last.Sub(first), agentWait)
	}
	for _, r := range results {
		t.Logf("non-200 at cut%+v took %s: %d %s", r.start.Sub(cutAt), r.took, r.status, r.umiakError)
	}
	t.Logf("%d requests, %d non-200 during the move", requests.Load(), len(results))
}

// TestMoveUsesNewEpoch is Review Focus 5: after a move a keep-alive conn of
// the old tunnel epoch is never reused, even while the old tunnel still
// carries it.
func TestMoveUsesNewEpoch(t *testing.T) {
	t.Parallel()
	c := newCluster(t, testenv.Options{}, nil)
	m := c.newMachine(t)
	m.ServeHTTP(3000, echoApp())
	rt := c.env.Route(m, 3000, nil)
	host := testenv.Host(rt.Label)
	client := c.env.PlainClient(c.A)

	first := decodeEcho(t, get(t, client, host, "/")).RemoteAddr
	if again := decodeEcho(t, get(t, client, host, "/")).RemoteAddr; again != first {
		t.Fatalf("keep-alive not reused before the move: %s then %s", first, again)
	}
	ctx, cancel := context.WithTimeout(context.Background(), reqTimeout)
	defer cancel()
	oldOwner, _, err := c.A.Owners().Lookup(ctx, m.ID)
	if err != nil {
		t.Fatal(err)
	}

	// A graceful move: the old tunnel keeps its streams (and A's pooled
	// conn) for the drain deadline while the agent connects to B.
	c.env.RouteOnly(c.B)
	mc, ok := c.C.Tunnel().Machine(m.ID)
	if !ok {
		t.Fatal("machine not on C")
	}
	if err := mc.Drain(ctx, transport.DrainOptions{Reason: "test", TCPDeadline: time.Minute}); err != nil {
		t.Fatalf("Drain: %v", err)
	}
	eventually(t, "A sees the new owner", func() bool {
		o, ok, err := c.A.Owners().Lookup(ctx, m.ID)
		return err == nil && ok && o.InstanceID == c.B.Name
	})
	newOwner, _, _ := c.A.Owners().Lookup(ctx, m.ID)
	if newOwner.Epoch == oldOwner.Epoch {
		t.Fatalf("epoch unchanged after the move: %d", newOwner.Epoch)
	}

	req := newReq(t, http.MethodGet, "http", host, "/", nil)
	req.Header.Set("X-Request-Id", "after-move")
	e := decodeEcho(t, send(client, req))
	if e.RemoteAddr == first {
		t.Fatalf("request after the move reused the keep-alive conn of epoch %d (%s)", oldOwner.Epoch, first)
	}
	if l := logLine(t, c.A, "after-move"); l["ownerInstance"] != c.B.Name {
		t.Errorf("ownerInstance = %v, want %s", l["ownerInstance"], c.B.Name)
	}
}
