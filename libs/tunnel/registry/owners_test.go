package registry_test

import (
	"context"
	"errors"
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
