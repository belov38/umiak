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

	"github.com/belov38/umiak/services/gateway/internal/config"
	"github.com/belov38/umiak/services/gateway/internal/testenv"
)

// httpDrain is the shrunk HTTP drain deadline of the drain tests (2 min in
// production).
const httpDrain = 5 * time.Second

// slowApp answers /slow after delay with "done" and counts the requests in
// flight; WebSockets are echoed and everything else gets "fast".
type slowApp struct {
	delay    time.Duration
	inFlight atomic.Int64
	ws       wsEchoApp
}

func (a *slowApp) ServeHTTP(w http.ResponseWriter, r *http.Request) {
	switch {
	case r.URL.Path == "/slow":
		a.inFlight.Add(1)
		defer a.inFlight.Add(-1)
		time.Sleep(a.delay)
		_, _ = io.WriteString(w, "done")
	case r.Header.Get("Upgrade") != "":
		a.ws.ServeHTTP(w, r)
	default:
		_, _ = io.WriteString(w, "fast")
	}
}

// slowRequests starts n GET /slow through client and returns a function
// that waits for their results.
func slowRequests(t *testing.T, client *http.Client, host string, n int) func() []result {
	t.Helper()
	results := make([]result, n)
	var wg sync.WaitGroup
	for i := range n {
		wg.Go(func() { results[i] = get(t, client, host, "/slow") })
	}
	return func() []result {
		wg.Wait()
		return results
	}
}

func TestRollingDrainHTTP(t *testing.T) {
	t.Parallel()
	c := newCluster(t, testenv.Options{}, func(cfg *config.Config) { cfg.HTTPDrainDeadline = httpDrain })
	m := c.newMachine(t)
	app := &slowApp{delay: 3 * time.Second}
	m.ServeHTTP(3000, app)
	rt := c.env.Route(m, 3000, nil)
	host := testenv.Host(rt.Label)
	client := c.env.PlainClient(c.A)

	const nWS = 10
	conns := openWebSockets(t, client, nWS, func(int) string { return "ws://" + host + "/ws" })
	wait := slowRequests(t, client, host, 100)
	eventually(t, "100 requests in flight", func() bool { return app.inFlight.Load() == 100 })

	t0 := time.Now()
	closedAt := make([]time.Duration, nWS)
	var wsWG sync.WaitGroup
	for i, ws := range conns {
		wsWG.Go(func() {
			ctx, cancel := context.WithTimeout(context.Background(), reqTimeout)
			defer cancel()
			for {
				if _, _, err := ws.Read(ctx); err != nil {
					closedAt[i] = time.Since(t0)
					return
				}
			}
		})
	}
	drained := make(chan error, 1)
	go func() {
		ctx, cancel := context.WithTimeout(context.Background(), reqTimeout)
		defer cancel()
		drained <- c.A.Drain(ctx)
	}()

	for i, r := range wait() {
		if r.err != nil || r.status != http.StatusOK || r.body != "done" {
			t.Errorf("request %d cut by the drain: %v", i, r)
		}
	}
	wsWG.Wait()
	for i, d := range closedAt {
		if d < httpDrain || d > httpDrain+2*time.Second {
			t.Errorf("WebSocket %d closed %s after the drain started, want [%s, %s]", i, d, httpDrain, httpDrain+2*time.Second)
		}
	}
	select {
	case err := <-drained:
		if err != nil {
			t.Fatalf("Drain = %v", err)
		}
	case <-time.After(reqTimeout):
		t.Fatal("Drain did not return")
	}
	t.Logf("drain of A took %s", time.Since(t0))
}

func TestOwnerDrainKeepsHTTP(t *testing.T) {
	t.Parallel()
	c := newCluster(t, testenv.Options{}, func(cfg *config.Config) { cfg.HTTPDrainDeadline = httpDrain })
	m := c.newMachine(t)
	app := &slowApp{delay: 2 * time.Second}
	m.ServeHTTP(3000, app)
	rt := c.env.Route(m, 3000, nil)
	host := testenv.Host(rt.Label)
	client := loopClient(c, c.A)

	wait := slowRequests(t, client, host, 20)
	eventually(t, "20 requests in flight", func() bool { return app.inFlight.Load() == 20 })

	// Short requests keep coming through A during the whole move.
	var (
		stop  atomic.Bool
		loops sync.WaitGroup
		mu    sync.Mutex
		bad   []result
		count atomic.Int64
	)
	for range 5 {
		loops.Go(func() {
			for !stop.Load() {
				time.Sleep(loopPause)
				r := get(t, client, host, "/")
				count.Add(1)
				if r.err != nil || r.status != http.StatusOK {
					mu.Lock()
					bad = append(bad, r)
					mu.Unlock()
				}
			}
		})
	}

	c.env.RouteOnly(c.B)
	t0 := time.Now()
	drained := make(chan error, 1)
	go func() {
		ctx, cancel := context.WithTimeout(context.Background(), reqTimeout)
		defer cancel()
		drained <- c.C.Drain(ctx)
	}()

	for i, r := range wait() {
		if r.err != nil || r.status != http.StatusOK || r.body != "done" {
			t.Errorf("in-flight request %d through A = %v", i, r)
		}
	}
	eventually(t, "machine on B", func() bool { return m.Owner() == c.B })
	n := 0
	eventually(t, "new requests through A go to B", func() bool {
		n++
		rid := "after-drain-" + strconv.Itoa(n)
		req := newReq(t, http.MethodGet, "http", host, "/", nil)
		req.Header.Set("X-Request-Id", rid)
		if r := send(client, req); r.status != http.StatusOK {
			return false
		}
		return logLine(t, c.A, rid)["ownerInstance"] == c.B.Name
	})
	stop.Store(true)
	loops.Wait()
	for _, r := range bad {
		t.Errorf("request through A during the owner drain = %v", r)
	}
	select {
	case err := <-drained:
		if err != nil {
			t.Fatalf("Drain of C = %v", err)
		}
	case <-time.After(reqTimeout):
		t.Fatal("Drain of C did not return")
	}
	t.Logf("%d short requests during the move; drain of C took %s", count.Load(), time.Since(t0))
}
