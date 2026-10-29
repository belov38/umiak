// Package ratelimit holds the in-memory abuse limits of the gateway (spec
// section 11): token buckets per client IP and per label, auth-failure
// blocks, and concurrency limits. The state lives in one pod and is not
// shared, so the effective limit grows with the number of pods.
package ratelimit

import (
	"context"
	"net/netip"
	"sync"
	"time"

	"golang.org/x/time/rate"

	"github.com/belov38/boat-dev-clone/services/gateway/internal/obs"
)

// Limit names, used as the "limit" label of sbx_gateway_ratelimited_total and
// as the second result of AllowRequest.
const (
	LimitIP         = "ip"
	LimitLabel      = "label"
	LimitAuthFail   = "auth_fail"
	LimitConns      = "conns"
	LimitSSHConn    = "ssh_conn"
	LimitSSHAuth    = "ssh_auth_fail"
	LimitSSHSession = "ssh_sessions"
)

const (
	// idleTTL is how long an untouched entry is kept before gc drops it.
	// A bucket idle this long is full again, so dropping it loses nothing.
	idleTTL    = 10 * time.Minute
	gcInterval = time.Minute

	// failWindow is the window in which auth failures are counted.
	failWindow = time.Minute
	// sshAuthBlock is how long an IP stays blocked after too many SSH
	// authentication failures.
	sshAuthBlock = time.Minute
)

// Config holds the limits. Every numeric field must be positive: the config
// package validates the values read from the environment. A zero value
// refuses everything.
type Config struct {
	IPRate     float64 // HTTP requests per second per client IP
	IPBurst    int
	LabelRate  float64 // HTTP requests per second per label
	LabelBurst int

	AuthFailPerMin int           // auth failures per minute per IP before the block
	AuthBlock      time.Duration // block length after AuthFailPerMin failures

	ConnsPerIP int // concurrent connections per IP

	SSHConnPerMin     int // new SSH connections per minute per IP
	SSHConnBurst      int
	SSHAuthFailPerMin int // SSH auth failures per minute per IP; the block lasts one minute

	SSHSessionsPerUser int // concurrent SSH sessions per user

	// Exempt addresses skip every per-IP limit. Label and per-user limits
	// still apply to them.
	Exempt []netip.Prefix

	// Now is the clock; nil means time.Now.
	Now func() time.Time
}

// Key returns the bucket key of an address: IPv4 /32, IPv6 /64. IPv4-mapped
// IPv6 addresses are unmapped first. An invalid address gives the zero Prefix.
func Key(ip netip.Addr) netip.Prefix {
	ip = ip.Unmap().WithZone("")
	if !ip.IsValid() {
		return netip.Prefix{}
	}
	if ip.Is4() {
		return netip.PrefixFrom(ip, 32)
	}
	return netip.PrefixFrom(ip, 64).Masked()
}

// Limits is the set of limiters. It is safe for concurrent use.
type Limits struct {
	cfg     Config
	now     func() time.Time
	metrics *obs.Metrics

	mu       sync.Mutex
	ipReq    buckets[netip.Prefix]
	labelReq buckets[string]
	sshConn  buckets[netip.Prefix]
	authFail failTracker
	sshAuth  failTracker
	conns    map[netip.Prefix]int
	sessions map[string]int
}

// New creates the limiters. m may be nil; then refusals are not counted.
func New(cfg Config, m *obs.Metrics) *Limits {
	now := cfg.Now
	if now == nil {
		now = time.Now
	}
	return &Limits{
		cfg:      cfg,
		now:      now,
		metrics:  m,
		ipReq:    newBuckets[netip.Prefix](rate.Limit(cfg.IPRate), cfg.IPBurst),
		labelReq: newBuckets[string](rate.Limit(cfg.LabelRate), cfg.LabelBurst),
		sshConn:  newBuckets[netip.Prefix](rate.Limit(float64(cfg.SSHConnPerMin)/60), cfg.SSHConnBurst),
		authFail: newFailTracker(cfg.AuthFailPerMin, failWindow, cfg.AuthBlock),
		sshAuth:  newFailTracker(cfg.SSHAuthFailPerMin, failWindow, sshAuthBlock),
		conns:    map[netip.Prefix]int{},
		sessions: map[string]int{},
	}
}

// Run garbage-collects idle entries every minute until ctx is done.
func (l *Limits) Run(ctx context.Context) {
	t := time.NewTicker(gcInterval)
	defer t.Stop()
	for {
		select {
		case <-ctx.Done():
			return
		case <-t.C:
			l.gc(l.now())
		}
	}
}

func (l *Limits) gc(now time.Time) {
	l.mu.Lock()
	defer l.mu.Unlock()
	l.ipReq.gc(now)
	l.labelReq.gc(now)
	l.sshConn.gc(now)
	l.authFail.gc(now)
	l.sshAuth.gc(now)
}

func (l *Limits) refused(limit string) {
	if l.metrics != nil {
		l.metrics.RateLimited.WithLabelValues(limit).Inc()
	}
}

func (l *Limits) exempt(ip netip.Addr) bool {
	ip = ip.Unmap().WithZone("")
	for _, p := range l.cfg.Exempt {
		if p.Contains(ip) {
			return true
		}
	}
	return false
}

// AllowRequest takes one HTTP request from the IP bucket (unless the address
// is exempt) and from the label bucket. On refusal it returns the limit name
// (LimitIP or LimitLabel) and how long the client should wait. A request
// refused by the label bucket has already used one IP token.
//
// An empty label skips the label bucket. Labels come from the network, so the
// proxy checks the IP alone first and calls AllowLabel only once a route for
// the label exists; otherwise every random host would create a bucket.
func (l *Limits) AllowRequest(ip netip.Addr, label string) (ok bool, limit string, retryAfter time.Duration) {
	now := l.now()
	l.mu.Lock()
	if !l.exempt(ip) {
		if allowed, wait := l.ipReq.take(Key(ip), now); !allowed {
			l.mu.Unlock()
			l.refused(LimitIP)
			return false, LimitIP, wait
		}
	}
	if label == "" {
		l.mu.Unlock()
		return true, "", 0
	}
	allowed, wait := l.labelReq.take(label, now)
	l.mu.Unlock()
	if !allowed {
		l.refused(LimitLabel)
		return false, LimitLabel, wait
	}
	return true, "", 0
}

// AllowLabel takes one HTTP request from the label bucket only. On refusal
// it returns how long the client should wait.
func (l *Limits) AllowLabel(label string) (ok bool, retryAfter time.Duration) {
	now := l.now()
	l.mu.Lock()
	allowed, wait := l.labelReq.take(label, now)
	l.mu.Unlock()
	if !allowed {
		l.refused(LimitLabel)
		return false, wait
	}
	return true, 0
}

// AuthFailure records one authorization failure (token_invalid, bad
// callback) of the IP. The AuthFailPerMin-th failure within a minute blocks
// the IP for AuthBlock.
func (l *Limits) AuthFailure(ip netip.Addr) {
	if l.exempt(ip) {
		return
	}
	now := l.now()
	l.mu.Lock()
	l.authFail.fail(Key(ip), now)
	l.mu.Unlock()
}

// AuthBlocked reports whether the IP is blocked and for how much longer.
// A true answer counts as a refusal.
func (l *Limits) AuthBlocked(ip netip.Addr) (bool, time.Duration) {
	if l.exempt(ip) {
		return false, 0
	}
	now := l.now()
	l.mu.Lock()
	blocked, left := l.authFail.blocked(Key(ip), now)
	l.mu.Unlock()
	if blocked {
		l.refused(LimitAuthFail)
	}
	return blocked, left
}

// AcquireConn counts one open connection of the IP. The caller must call
// release when the connection closes; release is idempotent. When ok is
// false, release is nil.
func (l *Limits) AcquireConn(ip netip.Addr) (release func(), ok bool) {
	if l.exempt(ip) {
		return func() {}, true
	}
	k := Key(ip)
	l.mu.Lock()
	if l.conns[k] >= l.cfg.ConnsPerIP {
		l.mu.Unlock()
		l.refused(LimitConns)
		return nil, false
	}
	l.conns[k]++
	l.mu.Unlock()
	return l.releaser(func() { dec(l.conns, k) }), true
}

// AllowSSHConn takes one new SSH connection from the IP bucket.
func (l *Limits) AllowSSHConn(ip netip.Addr) bool {
	if l.exempt(ip) {
		return true
	}
	now := l.now()
	l.mu.Lock()
	ok, _ := l.sshConn.take(Key(ip), now)
	l.mu.Unlock()
	if !ok {
		l.refused(LimitSSHConn)
	}
	return ok
}

// SSHAuthFailure records one failed SSH connection (no successful
// authentication before the handshake ended). The SSHAuthFailPerMin-th
// failure within a minute blocks the IP for one minute.
func (l *Limits) SSHAuthFailure(ip netip.Addr) {
	if l.exempt(ip) {
		return
	}
	now := l.now()
	l.mu.Lock()
	l.sshAuth.fail(Key(ip), now)
	l.mu.Unlock()
}

// SSHAuthBlocked reports whether the IP is blocked for SSH. A true answer
// counts as a refusal.
func (l *Limits) SSHAuthBlocked(ip netip.Addr) bool {
	if l.exempt(ip) {
		return false
	}
	now := l.now()
	l.mu.Lock()
	blocked, _ := l.sshAuth.blocked(Key(ip), now)
	l.mu.Unlock()
	if blocked {
		l.refused(LimitSSHAuth)
	}
	return blocked
}

// AcquireSSHSession counts one open SSH session of the user. The release
// function is idempotent. When ok is false, release is nil.
func (l *Limits) AcquireSSHSession(user string) (release func(), ok bool) {
	l.mu.Lock()
	if l.sessions[user] >= l.cfg.SSHSessionsPerUser {
		l.mu.Unlock()
		l.refused(LimitSSHSession)
		return nil, false
	}
	l.sessions[user]++
	l.mu.Unlock()
	return l.releaser(func() { dec(l.sessions, user) }), true
}

// releaser wraps a decrement so that it runs exactly once, under the lock.
func (l *Limits) releaser(f func()) func() {
	var once sync.Once
	return func() {
		once.Do(func() {
			l.mu.Lock()
			f()
			l.mu.Unlock()
		})
	}
}

// dec decrements a counter and deletes the entry at zero.
func dec[K comparable](m map[K]int, k K) {
	if m[k] <= 1 {
		delete(m, k)
		return
	}
	m[k]--
}

// buckets is a set of token buckets with one rate and burst.
type buckets[K comparable] struct {
	limit rate.Limit
	burst int
	m     map[K]*bucket
}

type bucket struct {
	lim  *rate.Limiter
	last time.Time
}

func newBuckets[K comparable](limit rate.Limit, burst int) buckets[K] {
	return buckets[K]{limit: limit, burst: burst, m: map[K]*bucket{}}
}

// take removes one token. When the bucket is empty it returns how long to
// wait for the next token and leaves the bucket unchanged.
func (b *buckets[K]) take(k K, now time.Time) (bool, time.Duration) {
	bk := b.m[k]
	if bk == nil {
		bk = &bucket{lim: rate.NewLimiter(b.limit, b.burst)}
		b.m[k] = bk
	}
	bk.last = now
	r := bk.lim.ReserveN(now, 1)
	if !r.OK() {
		// Zero rate or burst: nothing will ever pass.
		return false, 0
	}
	if wait := r.DelayFrom(now); wait > 0 {
		r.CancelAt(now)
		return false, wait
	}
	return true, 0
}

func (b *buckets[K]) gc(now time.Time) {
	for k, bk := range b.m {
		if now.Sub(bk.last) >= idleTTL {
			delete(b.m, k)
		}
	}
}

// failTracker counts failures per IP in fixed windows and blocks an IP when
// the count reaches the limit.
type failTracker struct {
	limit  int
	window time.Duration
	block  time.Duration
	m      map[netip.Prefix]*failEntry
}

type failEntry struct {
	start time.Time // start of the current window
	n     int       // failures in the current window
	until time.Time // end of the block, if any
	last  time.Time // last failure
}

func newFailTracker(limit int, window, block time.Duration) failTracker {
	return failTracker{limit: limit, window: window, block: block, m: map[netip.Prefix]*failEntry{}}
}

func (t *failTracker) fail(k netip.Prefix, now time.Time) {
	e := t.m[k]
	if e == nil {
		e = &failEntry{}
		t.m[k] = e
	}
	e.last = now
	if now.Before(e.until) {
		return // already blocked; do not extend
	}
	if e.n == 0 || now.Sub(e.start) >= t.window {
		e.start, e.n = now, 0
	}
	e.n++
	if e.n >= t.limit {
		e.until = now.Add(t.block)
		e.n = 0
	}
}

func (t *failTracker) blocked(k netip.Prefix, now time.Time) (bool, time.Duration) {
	e := t.m[k]
	if e == nil || !now.Before(e.until) {
		return false, 0
	}
	return true, e.until.Sub(now)
}

func (t *failTracker) gc(now time.Time) {
	for k, e := range t.m {
		if !now.Before(e.until) && now.Sub(e.last) >= idleTTL {
			delete(t.m, k)
		}
	}
}
