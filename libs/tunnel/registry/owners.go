package registry

import (
	"context"
	"sync"
	"time"
)

// defaultOwnerTTL bounds how long a positive owner entry is served without
// asking the registry again. It guards against an owner that crashed and was
// not swept yet; regular changes arrive through Invalidate.
const defaultOwnerTTL = 5 * time.Second

// OwnerCache caches Store.Owner answers per machine. Positive answers are
// kept up to ttl or until Invalidate; "no owner" answers and errors are never
// cached. The caller wires Invalidate to the session notifications
// (ListenHandlers.Session, gateway.Config.OnSessionChange). It is safe for
// concurrent use.
type OwnerCache struct {
	store      *Store
	staleAfter time.Duration
	ttl        time.Duration

	mu        sync.Mutex
	entries   map[string]ownerEntry
	lastPrune time.Time
	// inflight tracks running registry lookups so that an Invalidate during
	// a lookup keeps its (possibly outdated) answer out of the cache.
	inflight map[string]*ownerFlight
	allGen   uint64 // bumped by Invalidate("")
	// waiters holds the wake channel of each machine some Wait blocks on;
	// Invalidate closes it.
	waiters map[string]*ownerWaiters
}

type ownerEntry struct {
	owner   Owner
	expires time.Time
}

type ownerFlight struct {
	n   int
	gen uint64 // bumped by Invalidate(machineID)
}

type ownerWaiters struct {
	n  int
	ch chan struct{}
}

// NewOwnerCache returns a cache over s.Owner(ctx, machineID, staleAfter).
// ttl <= 0 means 5 s.
func NewOwnerCache(s *Store, staleAfter, ttl time.Duration) *OwnerCache {
	if ttl <= 0 {
		ttl = defaultOwnerTTL
	}
	return &OwnerCache{
		store:      s,
		staleAfter: staleAfter,
		ttl:        ttl,
		entries:    map[string]ownerEntry{},
		inflight:   map[string]*ownerFlight{},
		waiters:    map[string]*ownerWaiters{},
	}
}

// Lookup returns the owner of a machine, from the cache when a positive
// entry younger than ttl exists, else from the registry. Errors are returned
// and not cached.
func (c *OwnerCache) Lookup(ctx context.Context, machineID string) (Owner, bool, error) {
	c.mu.Lock()
	if e, ok := c.entries[machineID]; ok {
		if time.Now().Before(e.expires) {
			c.mu.Unlock()
			return e.owner, true, nil
		}
		delete(c.entries, machineID)
	}
	c.mu.Unlock()
	return c.fetch(ctx, machineID)
}

// fetch asks the registry and caches a positive answer unless the machine
// was invalidated meanwhile.
func (c *OwnerCache) fetch(ctx context.Context, machineID string) (Owner, bool, error) {
	c.mu.Lock()
	f := c.inflight[machineID]
	if f == nil {
		f = &ownerFlight{}
		c.inflight[machineID] = f
	}
	f.n++
	gen, allGen := f.gen, c.allGen
	c.mu.Unlock()

	o, ok, err := c.store.Owner(ctx, machineID, c.staleAfter)

	c.mu.Lock()
	defer c.mu.Unlock()
	if err == nil && ok && f.gen == gen && c.allGen == allGen {
		now := time.Now()
		c.entries[machineID] = ownerEntry{owner: o, expires: now.Add(c.ttl)}
		c.pruneLocked(now)
	}
	if f.n--; f.n == 0 {
		delete(c.inflight, machineID)
	}
	return o, ok, err
}

// pruneLocked drops expired entries, at most once per ttl.
func (c *OwnerCache) pruneLocked(now time.Time) {
	if now.Sub(c.lastPrune) < c.ttl {
		return
	}
	c.lastPrune = now
	for id, e := range c.entries {
		if !now.Before(e.expires) {
			delete(c.entries, id)
		}
	}
}

// Invalidate drops the cached owner of a machine and wakes its waiters.
// "" drops every entry and wakes every waiter.
func (c *OwnerCache) Invalidate(machineID string) {
	c.mu.Lock()
	defer c.mu.Unlock()
	if machineID == "" {
		clear(c.entries)
		c.allGen++
		for id, w := range c.waiters {
			close(w.ch)
			delete(c.waiters, id)
		}
		return
	}
	delete(c.entries, machineID)
	if f := c.inflight[machineID]; f != nil {
		f.gen++
	}
	if w := c.waiters[machineID]; w != nil {
		close(w.ch)
		delete(c.waiters, machineID)
	}
}

// Wait returns the owner of a machine. When there is none it blocks until
// Invalidate(machineID) or Invalidate("") and asks the registry again,
// until timeout. It returns false, nil when the timeout expires without an
// owner, and ctx.Err() when ctx is done first.
func (c *OwnerCache) Wait(ctx context.Context, machineID string, timeout time.Duration) (Owner, bool, error) {
	t := time.NewTimer(timeout)
	defer t.Stop()
	first := true
	for {
		// Subscribe before looking up, so an Invalidate between the lookup
		// and the wait is not missed.
		ch, release := c.subscribe(machineID)
		var (
			o   Owner
			ok  bool
			err error
		)
		if first {
			o, ok, err = c.Lookup(ctx, machineID)
		} else {
			o, ok, err = c.fetch(ctx, machineID)
		}
		first = false
		if err != nil || ok {
			release()
			return o, ok, err
		}
		select {
		case <-ch:
			release()
		case <-t.C:
			release()
			return Owner{}, false, nil
		case <-ctx.Done():
			release()
			return Owner{}, false, ctx.Err()
		}
	}
}

// subscribe returns the wake channel of a machine and a func to drop the
// subscription.
func (c *OwnerCache) subscribe(machineID string) (<-chan struct{}, func()) {
	c.mu.Lock()
	defer c.mu.Unlock()
	w := c.waiters[machineID]
	if w == nil {
		w = &ownerWaiters{ch: make(chan struct{})}
		c.waiters[machineID] = w
	}
	w.n++
	return w.ch, func() {
		c.mu.Lock()
		defer c.mu.Unlock()
		// After an Invalidate the entry is gone or replaced; only the
		// subscription's own entry is counted down.
		if w.n--; w.n == 0 && c.waiters[machineID] == w {
			delete(c.waiters, machineID)
		}
	}
}
