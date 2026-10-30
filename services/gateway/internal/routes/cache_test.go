package routes_test

import (
	"context"
	"errors"
	"strconv"
	"sync"
	"testing"
	"time"

	"github.com/prometheus/client_golang/prometheus"
	"github.com/prometheus/client_golang/prometheus/testutil"

	"github.com/belov38/boat-dev-clone/services/gateway/internal/cpapi"
	"github.com/belov38/boat-dev-clone/services/gateway/internal/cpapi/cpapitest"
	"github.com/belov38/boat-dev-clone/services/gateway/internal/obs"
	"github.com/belov38/boat-dev-clone/services/gateway/internal/routes"
)

type fakeClock struct {
	mu sync.Mutex
	t  time.Time
}

func newClock() *fakeClock { return &fakeClock{t: time.Unix(1_800_000_000, 0)} }

func (c *fakeClock) Now() time.Time {
	c.mu.Lock()
	defer c.mu.Unlock()
	return c.t
}

func (c *fakeClock) Advance(d time.Duration) {
	c.mu.Lock()
	defer c.mu.Unlock()
	c.t = c.t.Add(d)
}

func label(t *testing.T, raw string) routes.Label {
	t.Helper()
	l, ok := routes.ParseHost(raw+".sbx.example.com", "sbx.example.com", routes.DefaultGrammar())
	if !ok {
		t.Fatalf("label %q does not parse", raw)
	}
	return l
}

func readyRoute(l string, slug string, port uint16) cpapi.Route {
	return cpapi.Route{
		Label: l, SandboxID: "sbx_1", Slug: slug, Port: port, MachineID: "m1",
		SandboxState: "ready", Access: "public", HostRewrite: "preserve", AppProtocol: "http1",
	}
}

func newCache(api cpapi.Client, clk *fakeClock, m *obs.Metrics) *routes.Cache {
	return routes.NewCache(api, routes.CacheConfig{Now: clk.Now}, m)
}

func TestCacheTTLAndSingleflight(t *testing.T) {
	f := cpapitest.NewFake()
	f.SetRoute(readyRoute("quiet-otter-lamp-5173", "quiet-otter-lamp", 5173))
	f.SetLatency(50 * time.Millisecond) // keeps the callers overlapping
	clk := newClock()
	c := newCache(f, clk, nil)
	l := label(t, "quiet-otter-lamp-5173")

	var wg sync.WaitGroup
	errs := make(chan error, 50)
	for range 50 {
		wg.Add(1)
		go func() {
			defer wg.Done()
			r, err := c.Get(context.Background(), l)
			if err == nil && r.SandboxID != "sbx_1" {
				err = errors.New("wrong route")
			}
			errs <- err
		}()
	}
	wg.Wait()
	close(errs)
	for err := range errs {
		if err != nil {
			t.Fatal(err)
		}
	}
	if n := f.Calls("LookupRoute"); n != 1 {
		t.Fatalf("API calls = %d, want 1", n)
	}

	clk.Advance(29 * time.Second)
	if _, err := c.Get(context.Background(), l); err != nil {
		t.Fatal(err)
	}
	if n := f.Calls("LookupRoute"); n != 1 {
		t.Fatalf("API calls before TTL = %d, want 1", n)
	}

	clk.Advance(2 * time.Second) // 31 s since the fetch
	if _, err := c.Get(context.Background(), l); err != nil {
		t.Fatal(err)
	}
	if n := f.Calls("LookupRoute"); n != 2 {
		t.Fatalf("API calls after TTL = %d, want 2", n)
	}
}

func TestCacheNegativeTTL(t *testing.T) {
	f := cpapitest.NewFake()
	clk := newClock()
	c := newCache(f, clk, nil)
	l := label(t, "ghost-sandbox-80")

	for range 3 {
		if _, err := c.Get(context.Background(), l); !errors.Is(err, cpapi.ErrRouteNotFound) {
			t.Fatalf("err = %v, want ErrRouteNotFound", err)
		}
	}
	if n := f.Calls("LookupRoute"); n != 1 {
		t.Fatalf("API calls = %d, want 1", n)
	}

	// The route appears; the negative entry still hides it until 5 s pass.
	f.SetRoute(readyRoute("ghost-sandbox-80", "ghost-sandbox", 80))
	clk.Advance(4 * time.Second)
	if _, err := c.Get(context.Background(), l); !errors.Is(err, cpapi.ErrRouteNotFound) {
		t.Fatalf("err = %v, want cached ErrRouteNotFound", err)
	}
	clk.Advance(2 * time.Second)
	if _, err := c.Get(context.Background(), l); err != nil {
		t.Fatalf("after negative TTL: %v", err)
	}
	if n := f.Calls("LookupRoute"); n != 2 {
		t.Fatalf("API calls = %d, want 2", n)
	}
}

func TestCacheStaleIfError(t *testing.T) {
	f := cpapitest.NewFake()
	f.SetRoute(readyRoute("quiet-otter-lamp-5173", "quiet-otter-lamp", 5173))
	clk := newClock()
	reg := prometheus.NewRegistry()
	m := obs.NewMetrics(reg)
	c := newCache(f, clk, m)
	l := label(t, "quiet-otter-lamp-5173")

	if _, err := c.Get(context.Background(), l); err != nil {
		t.Fatal(err)
	}
	if v := testutil.ToFloat64(m.DependencyUp.WithLabelValues("api")); v != 1 {
		t.Fatalf("dependency_up{api} = %v, want 1", v)
	}

	f.SetDown(true)
	clk.Advance(31 * time.Second)
	r, err := c.Get(context.Background(), l)
	if err != nil || r.SandboxID != "sbx_1" {
		t.Fatalf("stale get = %+v, %v", r, err)
	}
	if v := testutil.ToFloat64(m.DependencyUp.WithLabelValues("api")); v != 0 {
		t.Fatalf("dependency_up{api} = %v, want 0", v)
	}
	if v := testutil.ToFloat64(m.RouteLookups.WithLabelValues("stale")); v != 1 {
		t.Fatalf("stale lookups = %v, want 1", v)
	}

	// Still inside 10 min after the TTL expired (30 s TTL + 9 min).
	clk.Advance(9 * time.Minute)
	if _, err := c.Get(context.Background(), l); err != nil {
		t.Fatalf("within stale window: %v", err)
	}

	// Past it: 30 s + 10 min + 1 s after the fetch.
	clk.Advance(2 * time.Minute)
	start := time.Now()
	if _, err := c.Get(context.Background(), l); !errors.Is(err, routes.ErrLookupUnavailable) {
		t.Fatalf("err = %v, want ErrLookupUnavailable", err)
	}
	if time.Since(start) > 3*time.Second {
		t.Fatal("lookup took longer than the timeout")
	}
	if v := testutil.ToFloat64(m.RouteLookups.WithLabelValues("error")); v != 1 {
		t.Fatalf("error lookups = %v, want 1", v)
	}

	// The API recovers.
	f.SetDown(false)
	if _, err := c.Get(context.Background(), l); err != nil {
		t.Fatal(err)
	}
	if v := testutil.ToFloat64(m.DependencyUp.WithLabelValues("api")); v != 1 {
		t.Fatalf("dependency_up{api} = %v, want 1", v)
	}
}

func TestCacheMissWithAPIDown(t *testing.T) {
	f := cpapitest.NewFake()
	f.SetDown(true)
	c := newCache(f, newClock(), nil)
	l := label(t, "quiet-otter-lamp-5173")

	start := time.Now()
	_, err := c.Get(context.Background(), l)
	if !errors.Is(err, routes.ErrLookupUnavailable) {
		t.Fatalf("err = %v, want ErrLookupUnavailable", err)
	}
	if errors.Is(err, cpapi.ErrRouteNotFound) {
		t.Fatal("unavailable must not look like not found")
	}
	if time.Since(start) > 3*time.Second {
		t.Fatal("took longer than 3 s")
	}
}

func TestCacheNegativeEntryIsNotServedStale(t *testing.T) {
	f := cpapitest.NewFake()
	clk := newClock()
	c := newCache(f, clk, nil)
	l := label(t, "ghost-sandbox-80")
	if _, err := c.Get(context.Background(), l); !errors.Is(err, cpapi.ErrRouteNotFound) {
		t.Fatal(err)
	}
	f.SetDown(true)
	clk.Advance(6 * time.Second)
	if _, err := c.Get(context.Background(), l); !errors.Is(err, routes.ErrLookupUnavailable) {
		t.Fatalf("err = %v, want ErrLookupUnavailable", err)
	}
}

func TestCacheStaleBlockedStaysBlocked(t *testing.T) {
	f := cpapitest.NewFake()
	r := readyRoute("quiet-otter-lamp-5173", "quiet-otter-lamp", 5173)
	r.Blocked, r.BlockReason = true, "abuse"
	f.SetRoute(r)
	clk := newClock()
	c := newCache(f, clk, nil)
	l := label(t, "quiet-otter-lamp-5173")
	if _, err := c.Get(context.Background(), l); err != nil {
		t.Fatal(err)
	}
	f.SetDown(true)
	clk.Advance(time.Minute)
	got, err := c.Get(context.Background(), l)
	if err != nil {
		t.Fatal(err)
	}
	if ok, e := routes.Decide(got); ok || e.Code != "route_blocked" {
		t.Fatalf("stale blocked route decided ok=%v err=%+v", ok, e)
	}
}

func TestCacheCallerCancelDoesNotCancelSharedCall(t *testing.T) {
	f := cpapitest.NewFake()
	f.SetRoute(readyRoute("quiet-otter-lamp-5173", "quiet-otter-lamp", 5173))
	f.SetLatency(150 * time.Millisecond)
	c := newCache(f, newClock(), nil)
	l := label(t, "quiet-otter-lamp-5173")

	ctx1, cancel1 := context.WithCancel(context.Background())
	first := make(chan error, 1)
	go func() {
		_, err := c.Get(ctx1, l)
		first <- err
	}()
	time.Sleep(30 * time.Millisecond)

	second := make(chan error, 1)
	go func() {
		_, err := c.Get(context.Background(), l)
		second <- err
	}()
	time.Sleep(30 * time.Millisecond)
	cancel1()

	if err := <-first; !errors.Is(err, context.Canceled) {
		t.Fatalf("first err = %v, want context.Canceled", err)
	}
	if err := <-second; err != nil {
		t.Fatalf("second caller failed after the first one left: %v", err)
	}
	if n := f.Calls("LookupRoute"); n != 1 {
		t.Fatalf("API calls = %d, want 1", n)
	}
}

func TestCacheTimeout(t *testing.T) {
	f := cpapitest.NewFake()
	f.SetRoute(readyRoute("quiet-otter-lamp-5173", "quiet-otter-lamp", 5173))
	f.SetLatency(5 * time.Second)
	c := routes.NewCache(f, routes.CacheConfig{Timeout: 100 * time.Millisecond}, nil)
	l := label(t, "quiet-otter-lamp-5173")

	start := time.Now()
	_, err := c.Get(context.Background(), l)
	if !errors.Is(err, routes.ErrLookupUnavailable) {
		t.Fatalf("err = %v, want ErrLookupUnavailable", err)
	}
	if d := time.Since(start); d > 2*time.Second {
		t.Fatalf("took %v with a 100ms timeout", d)
	}
}

func TestInvalidateSlug(t *testing.T) {
	f := cpapitest.NewFake()
	f.SetRoute(readyRoute("foo-80", "foo", 80))
	f.SetRoute(readyRoute("foo-3000", "foo", 3000))
	f.SetRoute(readyRoute("foobar-80", "foobar", 80))
	clk := newClock()
	reg := prometheus.NewRegistry()
	m := obs.NewMetrics(reg)
	c := newCache(f, clk, m)

	get := func(raw string) {
		t.Helper()
		_, err := c.Get(context.Background(), label(t, raw))
		if err != nil && !errors.Is(err, cpapi.ErrRouteNotFound) {
			t.Fatal(err)
		}
	}
	fill := func() {
		get("foo-80")
		get("foo-3000")
		get("foobar-80")
		get("foo-9999") // negative entry of the same slug
	}

	fill()
	if n := f.Calls("LookupRoute"); n != 4 {
		t.Fatalf("calls = %d, want 4", n)
	}
	c.InvalidateSlug("foo")
	fill()
	if n := f.Calls("LookupRoute"); n != 7 { // foo-80, foo-3000, foo-9999 again; foobar-80 cached
		t.Fatalf("calls after InvalidateSlug = %d, want 7", n)
	}

	c.InvalidateSlug("*")
	fill()
	if n := f.Calls("LookupRoute"); n != 11 {
		t.Fatalf("calls after wildcard = %d, want 11", n)
	}

	c.Flush()
	fill()
	if n := f.Calls("LookupRoute"); n != 15 {
		t.Fatalf("calls after Flush = %d, want 15", n)
	}
	if v := testutil.ToFloat64(m.RouteInvalidations); v != 3 {
		t.Fatalf("invalidations = %v, want 3", v)
	}

	c.InvalidateSlug("nothing-here") // must not panic or drop others
	fill()
	if n := f.Calls("LookupRoute"); n != 15 {
		t.Fatalf("calls after unrelated invalidation = %d, want 15", n)
	}
}

func TestInvalidateDuringFetchIsNotCached(t *testing.T) {
	f := cpapitest.NewFake()
	f.SetRoute(readyRoute("foo-80", "foo", 80))
	f.SetLatency(100 * time.Millisecond)
	c := newCache(f, newClock(), nil)
	l := label(t, "foo-80")

	done := make(chan struct{})
	go func() {
		defer close(done)
		_, _ = c.Get(context.Background(), l)
	}()
	time.Sleep(30 * time.Millisecond)
	c.InvalidateSlug("foo") // the fetch in flight may carry pre-change data
	<-done

	f.SetLatency(0)
	if _, err := c.Get(context.Background(), l); err != nil {
		t.Fatal(err)
	}
	if n := f.Calls("LookupRoute"); n != 2 {
		t.Fatalf("API calls = %d, want 2 (result fetched before the invalidation must not be cached)", n)
	}
}

func TestCacheMetricsHitMiss(t *testing.T) {
	f := cpapitest.NewFake()
	f.SetRoute(readyRoute("foo-80", "foo", 80))
	reg := prometheus.NewRegistry()
	m := obs.NewMetrics(reg)
	c := newCache(f, newClock(), m)
	l := label(t, "foo-80")
	for range 3 {
		if _, err := c.Get(context.Background(), l); err != nil {
			t.Fatal(err)
		}
	}
	if v := testutil.ToFloat64(m.RouteLookups.WithLabelValues("miss")); v != 1 {
		t.Fatalf("miss = %v, want 1", v)
	}
	if v := testutil.ToFloat64(m.RouteLookups.WithLabelValues("hit")); v != 2 {
		t.Fatalf("hit = %v, want 2", v)
	}
	if v := testutil.ToFloat64(m.DependencyUp.WithLabelValues("api")); v != 1 {
		t.Fatalf("dependency_up = %v, want 1", v)
	}
}

func TestCacheNotFoundCountsAsAPIUp(t *testing.T) {
	f := cpapitest.NewFake()
	reg := prometheus.NewRegistry()
	m := obs.NewMetrics(reg)
	c := newCache(f, newClock(), m)
	m.DependencyUp.WithLabelValues("api").Set(0)
	if _, err := c.Get(context.Background(), label(t, "foo-80")); !errors.Is(err, cpapi.ErrRouteNotFound) {
		t.Fatal(err)
	}
	if v := testutil.ToFloat64(m.DependencyUp.WithLabelValues("api")); v != 1 {
		t.Fatalf("dependency_up = %v, want 1", v)
	}
}

func TestCacheBounded(t *testing.T) {
	f := cpapitest.NewFake()
	c := routes.NewCache(f, routes.CacheConfig{MaxEntries: 100}, nil)
	for i := range 1000 {
		l := routes.Label{Raw: "x-" + strconv.Itoa(i), Slug: "x", Port: uint16(i%60000 + 1), Kind: "port"}
		if _, err := c.Get(context.Background(), l); !errors.Is(err, cpapi.ErrRouteNotFound) {
			t.Fatal(err)
		}
	}
	if n := c.Len(); n > 100 {
		t.Fatalf("cache holds %d entries, limit 100", n)
	}
}

// With a hung api, only the request that finds the route expired waits for
// the api timeout; after that the stale route is answered at once and the
// refresh runs in the background, at most once per backoff.
func TestCacheStaleRefreshInBackground(t *testing.T) {
	f := cpapitest.NewFake()
	rt := readyRoute("quiet-otter-lamp-5173", "quiet-otter-lamp", 5173)
	f.SetRoute(rt)
	clk := newClock()
	timeout := 300 * time.Millisecond
	c := routes.NewCache(f, routes.CacheConfig{Now: clk.Now, Timeout: timeout}, nil)
	l := label(t, "quiet-otter-lamp-5173")
	if _, err := c.Get(context.Background(), l); err != nil {
		t.Fatal(err)
	}

	f.SetLatency(time.Hour)
	clk.Advance(31 * time.Second)
	if r, err := c.Get(context.Background(), l); err != nil || r.SandboxID != "sbx_1" {
		t.Fatalf("first stale get = %+v, %v", r, err)
	}
	for i := range 5 {
		// Past the retry backoff each time: a refresh is due.
		clk.Advance(2 * time.Second)
		start := time.Now()
		r, err := c.Get(context.Background(), l)
		if err != nil || r.SandboxID != "sbx_1" {
			t.Fatalf("stale get %d = %+v, %v", i, r, err)
		}
		if el := time.Since(start); el > timeout/2 {
			t.Fatalf("stale get %d waited %s for the hung api", i, el)
		}
	}
	// Let the background refreshes time out before api recovers.
	time.Sleep(timeout + 100*time.Millisecond)

	// Once api answers, a background refresh stores the fresh route.
	f.SetLatency(0)
	rt.SandboxState = "stopped"
	f.SetRoute(rt)
	clk.Advance(2 * time.Second)
	deadline := time.Now().Add(5 * time.Second)
	for {
		r, err := c.Get(context.Background(), l)
		if err != nil {
			t.Fatal(err)
		}
		if r.SandboxState == "stopped" {
			break
		}
		if time.Now().After(deadline) {
			t.Fatal("the background refresh never stored the fresh route")
		}
		time.Sleep(10 * time.Millisecond)
	}
}
