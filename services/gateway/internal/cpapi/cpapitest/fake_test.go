package cpapitest_test

import (
	"context"
	"errors"
	"sync"
	"testing"
	"time"

	"github.com/belov38/umiak/services/gateway/internal/cpapi"
	"github.com/belov38/umiak/services/gateway/internal/cpapi/cpapitest"
)

func TestFakeRoutes(t *testing.T) {
	f := cpapitest.NewFake()
	ctx := context.Background()
	if _, err := f.LookupRoute(ctx, "foo-80"); !errors.Is(err, cpapi.ErrRouteNotFound) {
		t.Fatalf("err = %v", err)
	}
	f.SetRoute(cpapi.Route{Label: "foo-80", SandboxID: "umiak_1"})
	r, err := f.LookupRoute(ctx, "foo-80")
	if err != nil || r.SandboxID != "umiak_1" || r.Kind != "port" {
		t.Fatalf("route = %+v, %v", r, err)
	}
	f.DeleteRoute("foo-80")
	if _, err := f.LookupRoute(ctx, "foo-80"); !errors.Is(err, cpapi.ErrRouteNotFound) {
		t.Fatalf("after delete: %v", err)
	}
	if n := f.Calls("LookupRoute"); n != 3 {
		t.Fatalf("calls = %d", n)
	}
	if n := f.Calls("Nonexistent"); n != 0 {
		t.Fatalf("calls = %d", n)
	}
}

func TestFakeDown(t *testing.T) {
	f := cpapitest.NewFake()
	f.SetRoute(cpapi.Route{Label: "foo-80"})
	f.SetDown(true)
	ctx := context.Background()
	if _, err := f.LookupRoute(ctx, "foo-80"); !errors.Is(err, cpapi.ErrUnavailable) {
		t.Fatalf("lookup: %v", err)
	}
	if _, err := f.ExchangePortAuthCode(ctx, "c", "foo-80"); !errors.Is(err, cpapi.ErrUnavailable) {
		t.Fatalf("exchange: %v", err)
	}
	if _, err := f.AuthorizeSSH(ctx, cpapi.SSHAuthorizeRequest{}); !errors.Is(err, cpapi.ErrUnavailable) {
		t.Fatalf("ssh: %v", err)
	}
	f.SetDown(false)
	if _, err := f.LookupRoute(ctx, "foo-80"); err != nil {
		t.Fatal(err)
	}
}

func TestFakeCodeLifecycle(t *testing.T) {
	f := cpapitest.NewFake()
	var mu sync.Mutex
	now := time.Unix(1_800_000_000, 0)
	f.SetClock(func() time.Time { mu.Lock(); defer mu.Unlock(); return now })
	advance := func(d time.Duration) { mu.Lock(); now = now.Add(d); mu.Unlock() }
	ctx := context.Background()

	code := f.IssueCode("foo-80", cpapi.PortAuthGrant{UserID: "u"})
	// A label mismatch consumes nothing.
	if _, err := f.ExchangePortAuthCode(ctx, code, "bar-80"); !errors.Is(err, cpapi.ErrInvalidCode) {
		t.Fatalf("mismatch: %v", err)
	}
	if g, err := f.ExchangePortAuthCode(ctx, code, "foo-80"); err != nil || g.UserID != "u" || g.Label != "foo-80" {
		t.Fatalf("exchange: %+v, %v", g, err)
	}
	if _, err := f.ExchangePortAuthCode(ctx, code, "foo-80"); !errors.Is(err, cpapi.ErrInvalidCode) {
		t.Fatalf("reuse: %v", err)
	}

	code = f.IssueCode("foo-80", cpapi.PortAuthGrant{UserID: "u"})
	advance(59 * time.Second)
	if _, err := f.ExchangePortAuthCode(ctx, code, "foo-80"); err != nil {
		t.Fatalf("at 59 s: %v", err)
	}
	code = f.IssueCode("foo-80", cpapi.PortAuthGrant{UserID: "u"})
	advance(61 * time.Second)
	if _, err := f.ExchangePortAuthCode(ctx, code, "foo-80"); !errors.Is(err, cpapi.ErrInvalidCode) {
		t.Fatalf("expired: %v", err)
	}
}

func TestFakeConcurrentExchangeIsSingleUse(t *testing.T) {
	f := cpapitest.NewFake()
	code := f.IssueCode("foo-80", cpapi.PortAuthGrant{UserID: "u"})
	var wg sync.WaitGroup
	var mu sync.Mutex
	okCount := 0
	for range 20 {
		wg.Add(1)
		go func() {
			defer wg.Done()
			if _, err := f.ExchangePortAuthCode(context.Background(), code, "foo-80"); err == nil {
				mu.Lock()
				okCount++
				mu.Unlock()
			}
		}()
	}
	wg.Wait()
	if okCount != 1 {
		t.Fatalf("%d exchanges succeeded, want 1", okCount)
	}
}

func TestFakeSSHFirstMatchWins(t *testing.T) {
	f := cpapitest.NewFake()
	f.SetSSH(func(r cpapi.SSHAuthorizeRequest) bool { return r.Sandbox == "a" }, cpapi.SSHAuthorization{Allowed: true, LoginUser: "first"})
	f.SetSSH(func(cpapi.SSHAuthorizeRequest) bool { return true }, cpapi.SSHAuthorization{Allowed: true, LoginUser: "second"})
	ctx := context.Background()
	if got, _ := f.AuthorizeSSH(ctx, cpapi.SSHAuthorizeRequest{Sandbox: "a"}); got.LoginUser != "first" {
		t.Fatalf("got %+v", got)
	}
	if got, _ := f.AuthorizeSSH(ctx, cpapi.SSHAuthorizeRequest{Sandbox: "b"}); got.LoginUser != "second" {
		t.Fatalf("got %+v", got)
	}
	empty := cpapitest.NewFake()
	if got, err := empty.AuthorizeSSH(ctx, cpapi.SSHAuthorizeRequest{}); err != nil || got.Allowed {
		t.Fatalf("no rules: %+v, %v", got, err)
	}
}

func TestFakeLatencyHonoursContext(t *testing.T) {
	f := cpapitest.NewFake()
	f.SetRoute(cpapi.Route{Label: "foo-80"})
	f.SetLatency(5 * time.Second)
	ctx, cancel := context.WithTimeout(context.Background(), 50*time.Millisecond)
	defer cancel()
	start := time.Now()
	_, err := f.LookupRoute(ctx, "foo-80")
	if !errors.Is(err, cpapi.ErrUnavailable) || time.Since(start) > time.Second {
		t.Fatalf("err = %v after %v", err, time.Since(start))
	}
}
