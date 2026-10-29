package sshgw

import (
	"context"
	"slices"
	"sort"
	"sync"
	"sync/atomic"
	"testing"
	"time"

	"github.com/belov38/boat-dev-clone/services/gateway/internal/cpapi"
)

// revokeTargets are the sessions of the revocation tests.
func revokeTargets() []*fakeTarget {
	return []*fakeTarget{
		userTarget("u1-t1", "usr_1", "team_1"),
		userTarget("u1-t2", "usr_1", "team_2"),
		userTarget("u2-t1", "usr_2", "team_1"),
		keyTarget("k1-t1", "key_1", "team_1"),
		keyTarget("k2-t2", "key_2", "team_2"),
		// A user whose id equals a key id: key revocations must not
		// touch user sessions, and the other way round.
		userTarget("ukey-t3", "key_1", "team_3"),
	}
}

func TestRevokeForms(t *testing.T) {
	cases := []struct {
		payload string
		closed  []string
	}{
		{"user:usr_1", []string{"u1-t1", "u1-t2"}},
		{"user:key_1", []string{"ukey-t3"}},
		{"member:team_1:usr_1", []string{"u1-t1"}},
		{"member:team_2:usr_1", []string{"u1-t2"}},
		{"member:team_1:usr_9", nil},
		{"key:key_1", []string{"k1-t1"}},
		{"key:usr_1", nil},
		{"team:team_1", []string{"k1-t1", "u1-t1", "u2-t1"}},
		{"team:team_2", []string{"k2-t2", "u1-t2"}},
		// Unknown and malformed forms are ignored.
		{"bogus", nil},
		{"user", nil},
		{"user:", nil},
		{"user:usr_1:x", nil},
		{"member:team_1", nil},
		{"member::usr_1", nil},
		{"member:team_1:usr_1:x", nil},
		{"key:", nil},
		{"team:team_1:x", nil},
		{"group:team_1", nil},
		{":usr_1", nil},
	}
	for _, tc := range cases {
		t.Run(tc.payload, func(t *testing.T) {
			s := newUnitServer(t, nil)
			ts := revokeTargets()
			for _, ft := range ts {
				s.register(ft)
			}
			s.Revoke(tc.payload)
			flushJobs(t, s)
			var closed []string
			for _, ft := range ts {
				switch r := ft.closedWith(); r {
				case "":
					if n := ft.allNotes(); len(n) != 0 {
						t.Errorf("%s: notes %v without a close", ft.name, n)
					}
				case reasonRevoked:
					closed = append(closed, ft.name)
					// Every session channel, interactive or not.
					if n := ft.allNotes(); !slices.Equal(n, []note{{revokedMessage, false}}) {
						t.Errorf("%s: notes %v", ft.name, n)
					}
				default:
					t.Errorf("%s: close reason %q", ft.name, r)
				}
			}
			sort.Strings(closed)
			if !slices.Equal(closed, tc.closed) {
				t.Fatalf("closed %q, want %q", closed, tc.closed)
			}
		})
	}
}

// Revoke runs on the LISTEN goroutine: it must return while the queue is
// busy.
func TestRevokeDoesNotBlock(t *testing.T) {
	s := newUnitServer(t, nil)
	ft := userTarget("u1", "usr_1", "team_1")
	s.register(ft)
	release := make(chan struct{})
	s.enqueue(s.revokes, "busy", func(context.Context) { <-release })
	done := make(chan struct{})
	go func() {
		for range 1000 {
			s.Revoke("user:usr_1")
		}
		close(done)
	}()
	select {
	case <-done:
	case <-time.After(5 * time.Second):
		t.Fatal("Revoke blocked")
	}
	if ft.closedWith() != "" {
		t.Fatal("closed while the queue was busy")
	}
	close(release)
	flushJobs(t, s)
	if ft.closedWith() != reasonRevoked {
		t.Fatalf("close reason %q", ft.closedWith())
	}
	// The 1000 identical revocations were coalesced while waiting.
	if n := ft.allNotes(); len(n) != 1 {
		t.Fatalf("%d notices, want 1", len(n))
	}
}

// Revocations have their own worker: a slow registry read (owner drain
// lookups) does not hold them up.
func TestRevokeNotBehindRegistryReads(t *testing.T) {
	s := newUnitServer(t, nil)
	ft := userTarget("u1", "usr_1", "team_1")
	s.register(ft)
	release := make(chan struct{})
	defer close(release)
	s.enqueue(s.jobs, "slow-read", func(context.Context) { <-release })
	s.Revoke("user:usr_1")
	deadline := time.Now().Add(5 * time.Second)
	for ft.closedWith() != reasonRevoked {
		if time.Now().After(deadline) {
			t.Fatal("the revocation waited for the registry read")
		}
		time.Sleep(2 * time.Millisecond)
	}
}

func TestRecheck(t *testing.T) {
	var inFlight, maxInFlight atomic.Int64
	var mu sync.Mutex
	var seen []string
	api := apiFunc(func(_ context.Context, req cpapi.SSHAuthorizeRequest) (cpapi.SSHAuthorization, error) {
		n := inFlight.Add(1)
		defer inFlight.Add(-1)
		for {
			m := maxInFlight.Load()
			if n <= m || maxInFlight.CompareAndSwap(m, n) {
				break
			}
		}
		time.Sleep(10 * time.Millisecond)
		mu.Lock()
		seen = append(seen, req.Sandbox)
		mu.Unlock()
		switch req.Sandbox[0] {
		case 'a':
			return cpapi.SSHAuthorization{Allowed: true}, nil
		case 'e':
			return cpapi.SSHAuthorization{}, cpapi.ErrUnavailable
		}
		return cpapi.SSHAuthorization{Allowed: false}, nil
	})
	s := newUnitServer(t, func(c *Config) { c.API = api })
	var all []*fakeTarget
	for _, prefix := range []string{"a", "e", "d"} {
		for i := range 10 {
			ft := userTarget(prefix+string(rune('0'+i)), "usr_1", "team_1")
			all = append(all, ft)
			s.register(ft)
		}
	}
	s.Recheck(context.Background())
	for _, ft := range all {
		want := ""
		if ft.name[0] == 'd' {
			want = reasonRevoked
		}
		if got := ft.closedWith(); got != want {
			t.Errorf("%s: close reason %q, want %q", ft.name, got, want)
		}
	}
	if len(seen) != len(all) {
		t.Fatalf("%d checks, want %d", len(seen), len(all))
	}
	if m := maxInFlight.Load(); m > recheckParallel || m < 2 {
		t.Fatalf("max concurrent checks %d, want 2..%d", m, recheckParallel)
	}

	// Revoke("") (a LISTEN reconnect) schedules a recheck on its own
	// queue.
	ft := userTarget("d-late", "usr_1", "team_1")
	s.register(ft)
	s.Revoke("")
	deadline := time.Now().Add(10 * time.Second)
	for ft.closedWith() == "" {
		if time.Now().After(deadline) {
			t.Fatal("no recheck after Revoke(\"\")")
		}
		time.Sleep(5 * time.Millisecond)
	}
}

func TestQueueAfterClose(t *testing.T) {
	s := newUnitServer(t, nil)
	ft := userTarget("u1", "usr_1", "team_1")
	s.register(ft)
	_ = s.Close()
	s.Revoke("user:usr_1")
	s.NotifyInstance("")
	s.NotifyMachine("")
	time.Sleep(20 * time.Millisecond)
	if ft.closedWith() != "" {
		t.Fatal("a revocation ran after Close")
	}
}
