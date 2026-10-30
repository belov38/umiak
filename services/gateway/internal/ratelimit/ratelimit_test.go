package ratelimit

import (
	"context"
	"net/netip"
	"sync"
	"testing"
	"time"

	"github.com/prometheus/client_golang/prometheus"
	"github.com/prometheus/client_golang/prometheus/testutil"

	"github.com/belov38/boat-dev-clone/services/gateway/internal/obs"
)

type fakeClock struct {
	mu sync.Mutex
	t  time.Time
}

func (c *fakeClock) Now() time.Time {
	c.mu.Lock()
	defer c.mu.Unlock()
	return c.t
}

func (c *fakeClock) Advance(d time.Duration) {
	c.mu.Lock()
	c.t = c.t.Add(d)
	c.mu.Unlock()
}

func testConfig(clk *fakeClock) Config {
	return Config{
		IPRate: 300, IPBurst: 2000, LabelRate: 1000, LabelBurst: 3000,
		AuthFailPerMin: 20, AuthBlock: 5 * time.Minute, ConnsPerIP: 512, TunnelConnsPerIP: 512,
		SSHConnPerMin: 10, SSHConnBurst: 20, SSHAuthFailPerMin: 10, SSHSessionsPerUser: 20,
		Now: clk.Now,
	}
}

func newTest(t *testing.T, mut func(*Config)) (*Limits, *fakeClock, *obs.Metrics) {
	t.Helper()
	clk := &fakeClock{t: time.Date(2026, 1, 1, 0, 0, 0, 0, time.UTC)}
	cfg := testConfig(clk)
	if mut != nil {
		mut(&cfg)
	}
	m := obs.NewMetrics(prometheus.NewRegistry())
	return New(cfg, m), clk, m
}

func refusals(m *obs.Metrics, limit string) int {
	return int(testutil.ToFloat64(m.RateLimited.WithLabelValues(limit)))
}

func ip(s string) netip.Addr { return netip.MustParseAddr(s) }

func TestKeyV6Slash64(t *testing.T) {
	a := Key(ip("2001:db8:1:2:aaaa::1"))
	b := Key(ip("2001:db8:1:2:bbbb::2"))
	c := Key(ip("2001:db8:1:3::1"))
	if a != b {
		t.Errorf("same /64 gave different keys: %v %v", a, b)
	}
	if a == c {
		t.Errorf("different /64 gave the same key: %v", a)
	}
	if a.String() != "2001:db8:1:2::/64" {
		t.Errorf("key = %v", a)
	}
	if got := Key(ip("::ffff:192.0.2.7")); got != netip.MustParsePrefix("192.0.2.7/32") {
		t.Errorf("v4-mapped key = %v", got)
	}
	if got := Key(ip("192.0.2.7")); got != netip.MustParsePrefix("192.0.2.7/32") {
		t.Errorf("v4 key = %v", got)
	}
	if got := Key(ip("fe80::1%eth0")); got.Addr().Zone() != "" {
		t.Errorf("zone kept: %v", got)
	}

	l, _, _ := newTest(t, func(c *Config) { c.IPBurst = 2; c.IPRate = 0.001 })
	for i, addr := range []string{"2001:db8:1:2::1", "2001:db8:1:2::2"} {
		if ok, _, _ := l.AllowRequest(ip(addr), "l"+addr); !ok {
			t.Fatalf("request %d refused", i)
		}
	}
	if ok, limit, _ := l.AllowRequest(ip("2001:db8:1:2::3"), "x"); ok || limit != LimitIP {
		t.Errorf("third request in the same /64: ok=%v limit=%q", ok, limit)
	}
}

func TestAllowRequestBurst(t *testing.T) {
	l, clk, m := newTest(t, nil)
	addr := ip("192.0.2.1")
	for i := range 2000 {
		if ok, limit, _ := l.AllowRequest(addr, "a"); !ok {
			t.Fatalf("request %d refused by %q", i+1, limit)
		}
	}
	ok, limit, wait := l.AllowRequest(addr, "a")
	if ok || limit != LimitIP {
		t.Fatalf("request 2001: ok=%v limit=%q", ok, limit)
	}
	if want := time.Second / 300; wait < want-time.Millisecond || wait > want+time.Millisecond {
		t.Errorf("retryAfter = %v, want about %v", wait, want)
	}
	if refusals(m, LimitIP) != 1 {
		t.Errorf("ip refusals = %d", refusals(m, LimitIP))
	}

	// A refused call does not consume tokens: after 1s, 300 pass.
	clk.Advance(time.Second)
	n := 0
	for {
		if ok, _, _ := l.AllowRequest(addr, "a"); !ok {
			break
		}
		n++
	}
	if n != 300 {
		t.Errorf("refilled %d tokens in 1s, want 300", n)
	}

	// Another IP has its own bucket.
	if ok, _, _ := l.AllowRequest(ip("192.0.2.2"), "b"); !ok {
		t.Error("other IP refused")
	}
}

func TestLabelLimit(t *testing.T) {
	l, clk, m := newTest(t, func(c *Config) { c.LabelBurst = 5; c.LabelRate = 1 })
	// Different IPs, same label: only the label bucket limits.
	for i := range 5 {
		addr := netip.AddrFrom4([4]byte{198, 51, 100, byte(i + 1)})
		if ok, limit, _ := l.AllowRequest(addr, "app"); !ok {
			t.Fatalf("request %d refused by %q", i+1, limit)
		}
	}
	ok, limit, wait := l.AllowRequest(ip("198.51.100.9"), "app")
	if ok || limit != LimitLabel || wait != time.Second {
		t.Fatalf("ok=%v limit=%q wait=%v", ok, limit, wait)
	}
	if refusals(m, LimitLabel) != 1 {
		t.Errorf("label refusals = %d", refusals(m, LimitLabel))
	}
	if ok, _, _ := l.AllowRequest(ip("198.51.100.9"), "other"); !ok {
		t.Error("other label refused")
	}
	clk.Advance(time.Second)
	if ok, _, _ := l.AllowRequest(ip("198.51.100.9"), "app"); !ok {
		t.Error("label did not refill")
	}
}

func TestExemptSkipsIP(t *testing.T) {
	l, _, _ := newTest(t, func(c *Config) {
		c.Exempt = []netip.Prefix{netip.MustParsePrefix("10.0.0.0/8")}
		c.IPBurst = 1
		c.IPRate = 0.001
		c.LabelBurst = 3
		c.LabelRate = 0.001
		c.ConnsPerIP = 1
		c.AuthFailPerMin = 1
		c.SSHConnBurst = 1
		c.SSHAuthFailPerMin = 1
	})
	ex := ip("10.1.2.3")
	for i := range 3 {
		if ok, limit, _ := l.AllowRequest(ex, "x"); !ok {
			t.Fatalf("exempt request %d refused by %q", i+1, limit)
		}
	}
	// The label limit still applies.
	if ok, limit, _ := l.AllowRequest(ex, "x"); ok || limit != LimitLabel {
		t.Errorf("4th exempt request: ok=%v limit=%q", ok, limit)
	}
	// A v4-mapped form of an exempt address is exempt too.
	if ok, _, _ := l.AllowRequest(ip("::ffff:10.1.2.3"), "y"); !ok {
		t.Error("v4-mapped exempt address refused")
	}
	// A non-exempt address is limited by IP.
	other := ip("192.0.2.1")
	if ok, _, _ := l.AllowRequest(other, "z"); !ok {
		t.Fatal("first request refused")
	}
	if ok, limit, _ := l.AllowRequest(other, "z"); ok || limit != LimitIP {
		t.Errorf("non-exempt: ok=%v limit=%q", ok, limit)
	}

	// Other per-IP limits are skipped as well.
	for range 3 {
		l.AuthFailure(ex)
		l.SSHAuthFailure(ex)
		if blocked, _ := l.AuthBlocked(ex); blocked {
			t.Fatal("exempt IP blocked")
		}
		if l.SSHAuthBlocked(ex) {
			t.Fatal("exempt IP blocked for SSH")
		}
		if !l.AllowSSHConn(ex) {
			t.Fatal("exempt SSH conn refused")
		}
		if _, ok := l.AcquireConn(ex); !ok {
			t.Fatal("exempt conn refused")
		}
	}
}

func TestAuthBlock(t *testing.T) {
	l, clk, m := newTest(t, nil)
	addr := ip("192.0.2.1")
	for range 19 {
		l.AuthFailure(addr)
	}
	if blocked, _ := l.AuthBlocked(addr); blocked {
		t.Fatal("blocked after 19 failures")
	}
	l.AuthFailure(addr)
	blocked, left := l.AuthBlocked(addr)
	if !blocked || left != 5*time.Minute {
		t.Fatalf("blocked=%v left=%v", blocked, left)
	}
	if refusals(m, LimitAuthFail) != 1 {
		t.Errorf("auth_fail refusals = %d", refusals(m, LimitAuthFail))
	}

	clk.Advance(4 * time.Minute)
	blocked, left = l.AuthBlocked(addr)
	if !blocked || left != time.Minute {
		t.Fatalf("after 4m: blocked=%v left=%v", blocked, left)
	}
	// Failures during the block do not extend it.
	l.AuthFailure(addr)
	clk.Advance(time.Minute)
	if blocked, _ := l.AuthBlocked(addr); blocked {
		t.Fatal("still blocked after 5m")
	}
	// The count starts over after the block.
	for range 19 {
		l.AuthFailure(addr)
	}
	if blocked, _ := l.AuthBlocked(addr); blocked {
		t.Fatal("blocked after 19 fresh failures")
	}

	// Failures spread over more than a minute do not add up.
	other := ip("192.0.2.2")
	for range 19 {
		l.AuthFailure(other)
	}
	clk.Advance(61 * time.Second)
	l.AuthFailure(other)
	if blocked, _ := l.AuthBlocked(other); blocked {
		t.Fatal("blocked by failures from two windows")
	}
}

func TestConnsPerIP(t *testing.T) {
	l, _, m := newTest(t, nil)
	addr := ip("192.0.2.1")
	var releases []func()
	for i := range 512 {
		rel, ok := l.AcquireConn(addr)
		if !ok {
			t.Fatalf("acquire %d refused", i+1)
		}
		releases = append(releases, rel)
	}
	if rel, ok := l.AcquireConn(addr); ok || rel != nil {
		t.Fatal("acquire 513 passed")
	}
	if refusals(m, LimitConns) != 1 {
		t.Errorf("conns refusals = %d", refusals(m, LimitConns))
	}
	if _, ok := l.AcquireConn(ip("192.0.2.2")); !ok {
		t.Error("other IP refused")
	}

	releases[0]()
	releases[0]() // idempotent: must not free a second slot
	rel, ok := l.AcquireConn(addr)
	if !ok {
		t.Fatal("acquire after release refused")
	}
	if _, ok := l.AcquireConn(addr); ok {
		t.Fatal("double release freed two slots")
	}
	rel()

	for _, r := range releases[1:] {
		r()
	}
	l.mu.Lock()
	n := len(l.conns)
	l.mu.Unlock()
	if n != 1 { // only 192.0.2.2 remains
		t.Errorf("conns entries = %d, want 1", n)
	}
}

func TestSSHLimits(t *testing.T) {
	l, clk, m := newTest(t, nil)
	addr := ip("192.0.2.1")

	// Connection rate: burst 20, then 10 per minute.
	for i := range 20 {
		if !l.AllowSSHConn(addr) {
			t.Fatalf("ssh conn %d refused", i+1)
		}
	}
	if l.AllowSSHConn(addr) {
		t.Fatal("ssh conn 21 passed")
	}
	if refusals(m, LimitSSHConn) != 1 {
		t.Errorf("ssh_conn refusals = %d", refusals(m, LimitSSHConn))
	}
	clk.Advance(6 * time.Second)
	if !l.AllowSSHConn(addr) {
		t.Fatal("no refill after 6s")
	}
	if l.AllowSSHConn(addr) {
		t.Fatal("more than one token in 6s")
	}
	clk.Advance(time.Minute)
	n := 0
	for l.AllowSSHConn(addr) {
		n++
	}
	if n != 10 {
		t.Errorf("refilled %d in 1m, want 10", n)
	}

	// Auth failures: 10 per minute, block for one minute.
	for range 9 {
		l.SSHAuthFailure(addr)
	}
	if l.SSHAuthBlocked(addr) {
		t.Fatal("blocked after 9 failures")
	}
	l.SSHAuthFailure(addr)
	if !l.SSHAuthBlocked(addr) {
		t.Fatal("not blocked after 10 failures")
	}
	if refusals(m, LimitSSHAuth) != 1 {
		t.Errorf("ssh_auth_fail refusals = %d", refusals(m, LimitSSHAuth))
	}
	clk.Advance(time.Minute)
	if l.SSHAuthBlocked(addr) {
		t.Fatal("still blocked after 1m")
	}

	// Sessions per user.
	var releases []func()
	for i := range 20 {
		rel, ok := l.AcquireSSHSession("user-1")
		if !ok {
			t.Fatalf("session %d refused", i+1)
		}
		releases = append(releases, rel)
	}
	if rel, ok := l.AcquireSSHSession("user-1"); ok || rel != nil {
		t.Fatal("session 21 passed")
	}
	if refusals(m, LimitSSHSession) != 1 {
		t.Errorf("ssh_sessions refusals = %d", refusals(m, LimitSSHSession))
	}
	if _, ok := l.AcquireSSHSession("user-2"); !ok {
		t.Error("other user refused")
	}
	releases[0]()
	releases[0]()
	rel, ok := l.AcquireSSHSession("user-1")
	if !ok {
		t.Fatal("session after release refused")
	}
	if _, ok := l.AcquireSSHSession("user-1"); ok {
		t.Fatal("double release freed two slots")
	}
	rel()
	for _, r := range releases[1:] {
		r()
	}
	l.mu.Lock()
	left := len(l.sessions)
	l.mu.Unlock()
	if left != 1 { // user-2
		t.Errorf("session entries = %d, want 1", left)
	}
}

func TestGC(t *testing.T) {
	l, clk, _ := newTest(t, nil)
	addr := ip("192.0.2.1")
	l.AllowRequest(addr, "app")
	l.AllowSSHConn(addr)
	l.AuthFailure(addr)
	l.SSHAuthFailure(addr)
	size := func() int {
		l.mu.Lock()
		defer l.mu.Unlock()
		return len(l.ipReq.m) + len(l.labelReq.m) + len(l.sshConn.m) + len(l.authFail.m) + len(l.sshAuth.m)
	}
	if size() != 5 {
		t.Fatalf("size = %d, want 5", size())
	}

	clk.Advance(9 * time.Minute)
	l.gc(clk.Now())
	if size() != 5 {
		t.Fatalf("size after 9m = %d, want 5", size())
	}
	// Touching one bucket keeps it alive.
	l.AllowRequest(addr, "app")
	clk.Advance(time.Minute)
	l.gc(clk.Now())
	if size() != 2 {
		t.Fatalf("size after 10m = %d, want 2 (touched buckets)", size())
	}
	clk.Advance(10 * time.Minute)
	l.gc(clk.Now())
	if size() != 0 {
		t.Fatalf("size after 20m = %d, want 0", size())
	}

	// A block outlives the idle time when AuthBlock is long.
	l2, clk2, _ := newTest(t, func(c *Config) { c.AuthBlock = time.Hour; c.AuthFailPerMin = 1 })
	l2.AuthFailure(addr)
	clk2.Advance(30 * time.Minute)
	l2.gc(clk2.Now())
	if blocked, _ := l2.AuthBlocked(addr); !blocked {
		t.Error("active block dropped by gc")
	}
}

func TestRun(t *testing.T) {
	l, _, _ := newTest(t, nil)
	ctx, cancel := context.WithCancel(context.Background())
	done := make(chan struct{})
	go func() {
		l.Run(ctx)
		close(done)
	}()
	cancel()
	select {
	case <-done:
	case <-time.After(5 * time.Second):
		t.Fatal("Run did not stop")
	}
}

// TestTunnelConnsPerIP: the tunnel conns of one IP have their own count,
// separate from the sbx conns; exempt IPs skip it.
func TestTunnelConnsPerIP(t *testing.T) {
	l, _, m := newTest(t, func(c *Config) {
		c.ConnsPerIP = 1
		c.TunnelConnsPerIP = 3
		c.Exempt = []netip.Prefix{netip.MustParsePrefix("10.0.0.0/8")}
	})
	addr := ip("192.0.2.1")
	if _, ok := l.AcquireConn(addr); !ok {
		t.Fatal("sbx conn refused")
	}
	var releases []func()
	for i := range 3 {
		rel, ok := l.AcquireTunnelConn(addr)
		if !ok {
			t.Fatalf("tunnel conn %d refused", i+1)
		}
		releases = append(releases, rel)
	}
	if rel, ok := l.AcquireTunnelConn(addr); ok || rel != nil {
		t.Fatal("tunnel conn 4 passed")
	}
	if got := refusals(m, LimitTunnelConns); got != 1 {
		t.Errorf("tunnel_conns refusals = %d, want 1", got)
	}
	if got := refusals(m, LimitConns); got != 0 {
		t.Errorf("conns refusals = %d, want 0", got)
	}
	// The /64 of an IPv6 client shares one count.
	v6 := ip("2001:db8::1")
	for range 3 {
		if _, ok := l.AcquireTunnelConn(v6); !ok {
			t.Fatal("v6 tunnel conn refused")
		}
	}
	if _, ok := l.AcquireTunnelConn(ip("2001:db8::ffff")); ok {
		t.Fatal("another address of the same /64 passed")
	}
	for range 10 {
		rel, ok := l.AcquireTunnelConn(ip("10.1.2.3"))
		if !ok {
			t.Fatal("exempt tunnel conn refused")
		}
		rel()
	}
	releases[0]()
	releases[0]() // idempotent
	if _, ok := l.AcquireTunnelConn(addr); !ok {
		t.Fatal("tunnel conn after release refused")
	}
	if _, ok := l.AcquireTunnelConn(addr); ok {
		t.Fatal("double release freed two slots")
	}
}

func TestNilMetricsAndDefaultClock(t *testing.T) {
	cfg := testConfig(&fakeClock{})
	cfg.Now = nil
	cfg.ConnsPerIP = 1
	l := New(cfg, nil)
	addr := ip("192.0.2.1")
	if _, ok := l.AcquireConn(addr); !ok {
		t.Fatal("first conn refused")
	}
	if _, ok := l.AcquireConn(addr); ok {
		t.Fatal("second conn passed")
	}
}

func TestConcurrent(t *testing.T) {
	l, _, _ := newTest(t, nil)
	var wg sync.WaitGroup
	for i := range 8 {
		wg.Add(1)
		go func() {
			defer wg.Done()
			addr := netip.AddrFrom4([4]byte{192, 0, 2, byte(i)})
			for range 200 {
				l.AllowRequest(addr, "app")
				l.AuthFailure(addr)
				l.AuthBlocked(addr)
				if rel, ok := l.AcquireConn(addr); ok {
					rel()
				}
				if rel, ok := l.AcquireSSHSession("u"); ok {
					rel()
				}
				l.gc(l.now())
			}
		}()
	}
	wg.Wait()
}

// TestEmptyLabelAndAllowLabel: AllowRequest with "" takes only the IP token,
// so no bucket exists for labels without a route; AllowLabel takes only the
// label token.
func TestEmptyLabelAndAllowLabel(t *testing.T) {
	l, _, m := newTest(t, func(c *Config) { c.LabelRate = 1; c.LabelBurst = 2 })
	addr := ip("192.0.2.7")
	for i := range 10 {
		if ok, _, _ := l.AllowRequest(addr, ""); !ok {
			t.Fatalf("AllowRequest(ip, \"\") #%d refused", i)
		}
	}
	l.mu.Lock()
	n := len(l.labelReq.m)
	l.mu.Unlock()
	if n != 0 {
		t.Fatalf("label buckets = %d, want 0", n)
	}
	for i := range 2 {
		if ok, _ := l.AllowLabel("app"); !ok {
			t.Fatalf("AllowLabel #%d refused", i)
		}
	}
	ok, wait := l.AllowLabel("app")
	if ok || wait <= 0 {
		t.Fatalf("AllowLabel over burst = %v, %v; want refused with a wait", ok, wait)
	}
	if got := refusals(m, LimitLabel); got != 1 {
		t.Fatalf("label refusals = %d, want 1", got)
	}
	if ok, _ := l.AllowLabel("other"); !ok {
		t.Fatal("another label refused")
	}
}
