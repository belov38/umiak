package routes

import (
	"context"
	"errors"
	"fmt"
	"strconv"
	"sync"
	"time"

	"golang.org/x/sync/singleflight"

	"github.com/belov38/umiak/services/gateway/internal/cpapi"
	"github.com/belov38/umiak/services/gateway/internal/obs"
)

// ErrLookupUnavailable means the route is not cached (or too old to serve)
// and api cannot answer. The proxy maps it to 503 route_lookup_unavailable.
var ErrLookupUnavailable = errors.New("routes: route lookup unavailable")

// Cache defaults (spec 6.2).
const (
	DefaultTTL         = 30 * time.Second
	DefaultNegativeTTL = 5 * time.Second
	DefaultStaleFor    = 10 * time.Minute
	DefaultTimeout     = 3 * time.Second
	DefaultMaxEntries  = 50_000

	// retryBackoff is how long an expired entry is served stale without
	// asking api again after a failed refresh. Past it the entry is still
	// served stale at once while a refresh runs in the background, so a
	// slow or hung api adds its timeout only to the request that found the
	// entry expired.
	retryBackoff = time.Second
)

// CacheConfig tunes the cache. Zero fields take the defaults.
type CacheConfig struct {
	TTL         time.Duration // positive entries
	NegativeTTL time.Duration // route_not_found answers
	StaleFor    time.Duration // how long past TTL a positive entry may be served when api fails
	Timeout     time.Duration // one api call, shared by all waiting callers
	MaxEntries  int           // bound on cached labels; labels come from the network
	Now         func() time.Time
}

func (c *CacheConfig) setDefaults() {
	if c.TTL <= 0 {
		c.TTL = DefaultTTL
	}
	if c.NegativeTTL <= 0 {
		c.NegativeTTL = DefaultNegativeTTL
	}
	if c.StaleFor <= 0 {
		c.StaleFor = DefaultStaleFor
	}
	if c.Timeout <= 0 {
		c.Timeout = DefaultTimeout
	}
	if c.MaxEntries <= 0 {
		c.MaxEntries = DefaultMaxEntries
	}
	if c.Now == nil {
		c.Now = time.Now
	}
}

type entry struct {
	slug     string
	route    cpapi.Route
	notFound bool
	fetched  time.Time
	retryAt  time.Time // set after a failed refresh; no new api call before it
}

// Cache is the in-memory route cache of one pod. A nil *obs.Metrics is
// allowed.
type Cache struct {
	api cpapi.Client
	cfg CacheConfig
	m   *obs.Metrics

	sf singleflight.Group

	mu      sync.Mutex
	entries map[string]*entry
	// gen changes on every invalidation. A fetch that started before an
	// invalidation may carry pre-change data, so its result is not stored,
	// and callers arriving later do not join it (gen is part of the flight key).
	gen uint64
}

// NewCache returns a cache in front of api.
func NewCache(api cpapi.Client, cfg CacheConfig, m *obs.Metrics) *Cache {
	cfg.setDefaults()
	return &Cache{api: api, cfg: cfg, m: m, entries: make(map[string]*entry)}
}

// flightResult is what one shared api call produced.
type flightResult struct {
	route cpapi.Route
	err   error
}

// Get returns the route for label. It returns cpapi.ErrRouteNotFound when api
// says there is none and ErrLookupUnavailable when api cannot answer and no
// usable stale entry exists. A stale entry with Blocked=true is returned as
// is, so the caller still refuses it.
func (c *Cache) Get(ctx context.Context, label Label) (cpapi.Route, error) {
	now := c.cfg.Now()
	c.mu.Lock()
	gen := c.gen
	if e, ok := c.entries[label.Raw]; ok {
		switch {
		case e.notFound && now.Sub(e.fetched) < c.cfg.NegativeTTL:
			c.mu.Unlock()
			c.lookup("hit")
			return cpapi.Route{}, cpapi.ErrRouteNotFound
		case !e.notFound && now.Sub(e.fetched) < c.cfg.TTL:
			r := e.route
			c.mu.Unlock()
			c.lookup("hit")
			return r, nil
		case !e.notFound && !e.retryAt.IsZero() && c.staleOK(e, now):
			// A refresh already failed: answer stale and, once the backoff
			// is over, refresh in the background.
			r, due := e.route, !now.Before(e.retryAt)
			c.mu.Unlock()
			if due {
				c.refresh(ctx, label, gen)
			}
			c.lookup("stale")
			return r, nil
		}
	}
	c.mu.Unlock()

	ch := c.sf.DoChan(c.flightKey(label, gen), func() (any, error) {
		return c.fetch(ctx, label, gen), nil
	})
	select {
	case <-ctx.Done():
		return cpapi.Route{}, ctx.Err()
	case res := <-ch:
		return c.finish(label, res.Val.(flightResult))
	}
}

// refresh starts the shared api call for label without waiting for it; a
// call already in flight is joined instead. fetch detaches it from ctx.
func (c *Cache) refresh(ctx context.Context, label Label, gen uint64) {
	c.sf.DoChan(c.flightKey(label, gen), func() (any, error) {
		return c.fetch(ctx, label, gen), nil
	})
}

func (c *Cache) flightKey(label Label, gen uint64) string {
	return label.Raw + "\x00" + strconv.FormatUint(gen, 10)
}

// fetch runs the shared api call. It must not depend on the cancellation of
// the caller that happens to start it, so it gets its own timeout.
func (c *Cache) fetch(caller context.Context, label Label, gen uint64) flightResult {
	ctx, cancel := context.WithTimeout(context.WithoutCancel(caller), c.cfg.Timeout)
	defer cancel()
	route, err := c.api.LookupRoute(ctx, label.Raw)
	now := c.cfg.Now()

	notFound := errors.Is(err, cpapi.ErrRouteNotFound)
	c.setAPIUp(err == nil || notFound)

	c.mu.Lock()
	defer c.mu.Unlock()
	if c.gen != gen {
		return flightResult{route: route, err: err}
	}
	switch {
	case err == nil:
		c.store(label.Raw, &entry{slug: label.Slug, route: route, fetched: now})
	case notFound:
		c.store(label.Raw, &entry{slug: label.Slug, notFound: true, fetched: now})
	default:
		if e, ok := c.entries[label.Raw]; ok {
			e.retryAt = now.Add(retryBackoff)
		}
	}
	return flightResult{route: route, err: err}
}

// finish turns a flight result into the answer of one caller.
func (c *Cache) finish(label Label, res flightResult) (cpapi.Route, error) {
	switch {
	case res.err == nil:
		c.lookup("miss")
		return res.route, nil
	case errors.Is(res.err, cpapi.ErrRouteNotFound):
		c.lookup("miss")
		return cpapi.Route{}, cpapi.ErrRouteNotFound
	}

	now := c.cfg.Now()
	c.mu.Lock()
	e, ok := c.entries[label.Raw]
	var stale cpapi.Route
	usable := ok && !e.notFound && c.staleOK(e, now)
	if usable {
		stale = e.route
	}
	c.mu.Unlock()
	if usable {
		c.lookup("stale")
		return stale, nil
	}
	c.lookup("error")
	return cpapi.Route{}, fmt.Errorf("%w: %w", ErrLookupUnavailable, res.err)
}

// staleOK reports whether a positive entry may still be served when api
// fails. The caller holds c.mu.
func (c *Cache) staleOK(e *entry, now time.Time) bool {
	return now.Sub(e.fetched) < c.cfg.TTL+c.cfg.StaleFor
}

// store inserts e, evicting an arbitrary entry when the cache is full. The
// caller holds c.mu.
func (c *Cache) store(key string, e *entry) {
	if _, exists := c.entries[key]; !exists && len(c.entries) >= c.cfg.MaxEntries {
		for k := range c.entries {
			delete(c.entries, k)
			break
		}
	}
	c.entries[key] = e
}

// InvalidateSlug drops every entry of the slug, positive and negative. "*"
// drops everything.
func (c *Cache) InvalidateSlug(slug string) {
	c.mu.Lock()
	c.gen++
	if slug == "*" {
		clear(c.entries)
	} else {
		for k, e := range c.entries {
			if e.slug == slug {
				delete(c.entries, k)
			}
		}
	}
	c.mu.Unlock()
	if c.m != nil {
		c.m.RouteInvalidations.Inc()
	}
}

// Flush drops everything. Call it when a LISTEN connection is lost or
// restored, because notifications may have been missed.
func (c *Cache) Flush() { c.InvalidateSlug("*") }

// Len returns the number of cached labels.
func (c *Cache) Len() int {
	c.mu.Lock()
	defer c.mu.Unlock()
	return len(c.entries)
}

func (c *Cache) lookup(result string) {
	if c.m != nil {
		c.m.RouteLookups.WithLabelValues(result).Inc()
	}
}

func (c *Cache) setAPIUp(up bool) {
	if c.m == nil {
		return
	}
	v := 0.0
	if up {
		v = 1
	}
	c.m.DependencyUp.WithLabelValues("api").Set(v)
}
