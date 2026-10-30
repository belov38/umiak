package registry_test

import (
	"context"
	"errors"
	"sync"
	"sync/atomic"
	"testing"
	"time"

	"github.com/belov38/boat-dev-clone/libs/tunnel/registry"
	"github.com/belov38/boat-dev-clone/libs/tunnel/transport"
)

// Wait on a machine without an owner returns as soon as a session is
// admitted and Invalidate(id) is called; without Invalidate it times out.
func TestOwnerCacheWait(t *testing.T) {
	s, _ := setup(t)
	ctx := context.Background()
	if err := s.RegisterInstance(ctx, "gw-1", "http://10.0.0.1:8080"); err != nil {
		t.Fatal(err)
	}
	c := registry.NewOwnerCache(s, 15*time.Second, 0)
	id, bs := machine(t, s)

	if _, ok, err := c.Lookup(ctx, id); err != nil || ok {
		t.Fatalf("Lookup before admission: ok=%v err=%v", ok, err)
	}

	admitted := make(chan error, 1)
	invalidated := make(chan time.Time, 1)
	go func() {
		time.Sleep(300 * time.Millisecond)
		_, err := s.Admit(ctx, params(id, "gw-1", transport.AuthBootstrap, bs))
		invalidated <- time.Now()
		c.Invalidate(id)
		admitted <- err
	}()
	o, ok, err := c.Wait(ctx, id, 20*time.Second)
	returned := time.Now()
	if err != nil || !ok {
		t.Fatalf("Wait = %+v, %v, %v", o, ok, err)
	}
	if err := <-admitted; err != nil {
		t.Fatal(err)
	}
	if d := returned.Sub(<-invalidated); d > time.Second {
		t.Fatalf("Wait returned %s after Invalidate, want under 1 s", d)
	}
	if o.InstanceID != "gw-1" || o.InternalURL != "http://10.0.0.1:8080" || o.Epoch != 1 {
		t.Fatalf("owner = %+v", o)
	}

	// Invalidate("") wakes waiters too.
	id2, bs2 := machine(t, s)
	go func() {
		time.Sleep(300 * time.Millisecond)
		_, err := s.Admit(ctx, params(id2, "gw-1", transport.AuthBootstrap, bs2))
		c.Invalidate("")
		admitted <- err
	}()
	if o, ok, err := c.Wait(ctx, id2, 20*time.Second); err != nil || !ok || o.InstanceID != "gw-1" {
		t.Fatalf("Wait after Invalidate(\"\") = %+v, %v, %v", o, ok, err)
	}
	if err := <-admitted; err != nil {
		t.Fatal(err)
	}

	// An invalidation of another machine wakes nothing useful: the timeout wins.
	id3, _ := machine(t, s)
	go func() {
		time.Sleep(100 * time.Millisecond)
		c.Invalidate(id)
	}()
	start := time.Now()
	if _, ok, err := c.Wait(ctx, id3, 500*time.Millisecond); err != nil || ok {
		t.Fatalf("Wait without owner: ok=%v err=%v; want false, nil", ok, err)
	}
	if d := time.Since(start); d < 500*time.Millisecond {
		t.Fatalf("Wait returned after %s, before its timeout", d)
	}

	// A cancelled context ends Wait with its error.
	cctx, cancel := context.WithCancel(ctx)
	go func() {
		time.Sleep(100 * time.Millisecond)
		cancel()
	}()
	if _, _, err := c.Wait(cctx, id3, 20*time.Second); !errors.Is(err, context.Canceled) {
		t.Fatalf("Wait with cancelled ctx: err = %v, want context.Canceled", err)
	}
}

// A cached owner is served until the ttl expires; after that a stale owner
// instance is no longer returned. Invalidate drops the entry at once.
func TestOwnerCacheTTL(t *testing.T) {
	s, pool := setup(t)
	ctx := context.Background()
	if err := s.RegisterInstance(ctx, "gw-1", "http://10.0.0.1:8080"); err != nil {
		t.Fatal(err)
	}
	ttl := 300 * time.Millisecond
	c := registry.NewOwnerCache(s, 15*time.Second, ttl)
	id, bs := machine(t, s)
	if _, err := s.Admit(ctx, params(id, "gw-1", transport.AuthBootstrap, bs)); err != nil {
		t.Fatal(err)
	}
	if _, ok, err := c.Lookup(ctx, id); err != nil || !ok {
		t.Fatalf("Lookup: ok=%v err=%v", ok, err)
	}
	stale := func() {
		t.Helper()
		if _, err := pool.Exec(ctx, `UPDATE tunnel.gateway_instances SET heartbeat_at = now() - interval '20 seconds'`); err != nil {
			t.Fatal(err)
		}
	}
	stale()
	// Within the ttl the cached entry is served.
	start := time.Now()
	_, ok, err := c.Lookup(ctx, id)
	if time.Since(start) < ttl && (err != nil || !ok) {
		t.Fatalf("Lookup within ttl: ok=%v err=%v; want the cached owner", ok, err)
	}
	time.Sleep(ttl + 50*time.Millisecond)
	if _, ok, err := c.Lookup(ctx, id); err != nil || ok {
		t.Fatalf("Lookup after ttl: ok=%v err=%v; want no owner", ok, err)
	}

	// Negatives are not cached: a fresh heartbeat is seen at once.
	if err := s.Heartbeat(ctx, "gw-1"); err != nil {
		t.Fatal(err)
	}
	if _, ok, err := c.Lookup(ctx, id); err != nil || !ok {
		t.Fatalf("Lookup after heartbeat: ok=%v err=%v; want the owner", ok, err)
	}
	// Invalidate drops a positive entry before its ttl.
	stale()
	c.Invalidate(id)
	if _, ok, err := c.Lookup(ctx, id); err != nil || ok {
		t.Fatalf("Lookup after Invalidate: ok=%v err=%v; want no owner", ok, err)
	}

	// Lookup errors are returned, not cached.
	cctx, cancel := context.WithCancel(ctx)
	cancel()
	if _, _, err := c.Lookup(cctx, id); err == nil {
		t.Fatal("Lookup with a cancelled context: want an error")
	}
}

// Concurrent misses of one machine share a single registry query.
func TestOwnerCacheCollapsesMisses(t *testing.T) {
	s, _ := setup(t)
	ctx := context.Background()
	if err := s.RegisterInstance(ctx, "gw-1", "http://10.0.0.1:8080"); err != nil {
		t.Fatal(err)
	}
	id, bs := machine(t, s)
	if _, err := s.Admit(ctx, params(id, "gw-1", transport.AuthBootstrap, bs)); err != nil {
		t.Fatal(err)
	}
	var queries atomic.Int32
	release := make(chan struct{})
	c := registry.NewOwnerCacheFunc(func(ctx context.Context, machineID string) (registry.Owner, bool, error) {
		queries.Add(1)
		<-release
		return s.Owner(ctx, machineID, 15*time.Second)
	}, 0)
	c.Invalidate(id)

	const n = 50
	var wg sync.WaitGroup
	errs := make(chan error, n)
	for range n {
		wg.Go(func() {
			o, ok, err := c.Lookup(ctx, id)
			switch {
			case err != nil:
				errs <- err
			case !ok || o.InstanceID != "gw-1":
				errs <- errors.New("no owner")
			}
		})
	}
	// Let every caller join the flight before it completes.
	time.Sleep(200 * time.Millisecond)
	close(release)
	wg.Wait()
	close(errs)
	for err := range errs {
		t.Fatal(err)
	}
	if q := queries.Load(); q != 1 {
		t.Fatalf("registry queries = %d, want 1", q)
	}

	// A caller that gives up does not end the shared query of the others.
	queries.Store(0)
	c.Invalidate(id)
	hold := make(chan struct{})
	c2 := registry.NewOwnerCacheFunc(func(ctx context.Context, machineID string) (registry.Owner, bool, error) {
		queries.Add(1)
		<-hold
		return s.Owner(ctx, machineID, 15*time.Second)
	}, 0)
	cctx, cancel := context.WithCancel(ctx)
	first := make(chan error, 1)
	go func() {
		_, _, err := c2.Lookup(cctx, id)
		first <- err
	}()
	time.Sleep(50 * time.Millisecond)
	second := make(chan error, 1)
	go func() {
		_, ok, err := c2.Lookup(ctx, id)
		if err == nil && !ok {
			err = errors.New("no owner")
		}
		second <- err
	}()
	time.Sleep(50 * time.Millisecond)
	cancel()
	if err := <-first; !errors.Is(err, context.Canceled) {
		t.Fatalf("first = %v, want context.Canceled", err)
	}
	close(hold)
	if err := <-second; err != nil {
		t.Fatalf("second = %v", err)
	}
	if q := queries.Load(); q != 1 {
		t.Fatalf("registry queries = %d, want 1", q)
	}

	// An Invalidate during a query: later callers do not join it.
	queries.Store(0)
	gate := make(chan struct{})
	c3 := registry.NewOwnerCacheFunc(func(ctx context.Context, machineID string) (registry.Owner, bool, error) {
		if queries.Add(1) == 1 {
			<-gate
		}
		return s.Owner(ctx, machineID, 15*time.Second)
	}, 0)
	go func() { _, _, _ = c3.Lookup(ctx, id) }()
	time.Sleep(50 * time.Millisecond)
	c3.Invalidate(id)
	if _, ok, err := c3.Lookup(ctx, id); err != nil || !ok {
		t.Fatalf("Lookup after Invalidate: ok=%v err=%v", ok, err)
	}
	close(gate)
	if q := queries.Load(); q != 2 {
		t.Fatalf("registry queries = %d, want 2", q)
	}
}
