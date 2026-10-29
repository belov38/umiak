package sshgw

import (
	"context"
	"crypto/ed25519"
	"crypto/rand"
	"errors"
	"fmt"
	"log/slog"
	"slices"
	"sort"
	"sync"
	"testing"
	"time"

	"golang.org/x/crypto/ssh"

	"github.com/belov38/boat-dev-clone/libs/tunnel/registry"
	"github.com/belov38/boat-dev-clone/services/gateway/internal/cpapi"
	"github.com/belov38/boat-dev-clone/services/gateway/internal/cpapi/cpapitest"
	"github.com/belov38/boat-dev-clone/services/gateway/internal/upstream"
)

// note is one notify call on a fake target.
type note struct {
	msg             string
	interactiveOnly bool
}

// fakeTarget is a session without conns: it records notices and closes.
type fakeTarget struct {
	name  string
	id    identity
	owner string

	mu     sync.Mutex
	notes  []note
	reason string // close reason, "" while open
	closes int
}

func (f *fakeTarget) ident() identity { return f.id }

func (f *fakeTarget) ownerInstance() string {
	f.mu.Lock()
	defer f.mu.Unlock()
	return f.owner
}

func (f *fakeTarget) notify(msg string, interactiveOnly bool) <-chan struct{} {
	f.mu.Lock()
	f.notes = append(f.notes, note{msg, interactiveOnly})
	f.mu.Unlock()
	done := make(chan struct{})
	close(done)
	return done
}

func (f *fakeTarget) closeWithReason(reason string) {
	f.mu.Lock()
	defer f.mu.Unlock()
	if f.reason == "" {
		f.reason = reason
	}
	f.closes++
}

func (f *fakeTarget) closedWith() string {
	f.mu.Lock()
	defer f.mu.Unlock()
	return f.reason
}

func (f *fakeTarget) messages() []string {
	f.mu.Lock()
	defer f.mu.Unlock()
	var out []string
	for _, n := range f.notes {
		out = append(out, n.msg)
	}
	return out
}

func (f *fakeTarget) allNotes() []note {
	f.mu.Lock()
	defer f.mu.Unlock()
	return slices.Clone(f.notes)
}

// userTarget is a session of user userID on a sandbox of team teamID.
func userTarget(name, userID, teamID string) *fakeTarget {
	return &fakeTarget{name: name, id: identity{
		Request: cpapi.SSHAuthorizeRequest{Sandbox: name},
		Auth: cpapi.SSHAuthorization{
			Allowed: true, Actor: cpapi.SSHActor{Kind: actorUser, UserID: userID},
			UserID: userID, TeamID: teamID, MachineID: "m-" + name,
		},
	}}
}

// keyTarget is a session of team API key keyID on a sandbox of teamID.
func keyTarget(name, keyID, teamID string) *fakeTarget {
	return &fakeTarget{name: name, id: identity{
		Request: cpapi.SSHAuthorizeRequest{Sandbox: name},
		Auth: cpapi.SSHAuthorization{
			Allowed: true, Actor: cpapi.SSHActor{Kind: actorTeamKey, APIKeyID: keyID},
			TeamID: teamID, MachineID: "m-" + name,
		},
	}}
}

// fakeClock is a manual Clock: timers fire in Advance, in time order, on
// the caller's goroutine.
type fakeClock struct {
	mu     sync.Mutex
	now    time.Time
	timers []*fakeTimer
}

type fakeTimer struct {
	c       *fakeClock
	at      time.Time
	f       func()
	stopped bool
	fired   bool
}

func newFakeClock() *fakeClock {
	return &fakeClock{now: time.Date(2026, 10, 30, 12, 0, 0, 0, time.UTC)}
}

func (c *fakeClock) Now() time.Time {
	c.mu.Lock()
	defer c.mu.Unlock()
	return c.now
}

func (c *fakeClock) AfterFunc(d time.Duration, f func()) Timer {
	c.mu.Lock()
	defer c.mu.Unlock()
	t := &fakeTimer{c: c, at: c.now.Add(d), f: f}
	c.timers = append(c.timers, t)
	return t
}

func (t *fakeTimer) Stop() bool {
	t.c.mu.Lock()
	defer t.c.mu.Unlock()
	if t.stopped || t.fired {
		return false
	}
	t.stopped = true
	return true
}

// Advance moves the clock by d, firing every timer due on the way.
func (c *fakeClock) Advance(d time.Duration) {
	c.mu.Lock()
	end := c.now.Add(d)
	c.mu.Unlock()
	for {
		c.mu.Lock()
		var next *fakeTimer
		for _, t := range c.timers {
			if !t.stopped && !t.fired && !t.at.After(end) && (next == nil || t.at.Before(next.at)) {
				next = t
			}
		}
		if next == nil {
			c.now = end
			c.mu.Unlock()
			return
		}
		next.fired = true
		c.now = next.at
		c.mu.Unlock()
		next.f()
	}
}

// pending returns the number of timers that have not fired or stopped.
func (c *fakeClock) pending() int {
	c.mu.Lock()
	defer c.mu.Unlock()
	n := 0
	for _, t := range c.timers {
		if !t.stopped && !t.fired {
			n++
		}
	}
	return n
}

// fakeInstances is an InstanceSource with fixed rows.
type fakeInstances struct {
	mu    sync.Mutex
	rows  map[string]registry.Instance
	reads []string
}

func (f *fakeInstances) set(id string, drainStart *time.Time) {
	f.mu.Lock()
	defer f.mu.Unlock()
	if f.rows == nil {
		f.rows = map[string]registry.Instance{}
	}
	f.rows[id] = registry.Instance{ID: id, State: "draining", DrainStartedAt: drainStart}
}

func (f *fakeInstances) Instance(_ context.Context, id string) (registry.Instance, error) {
	f.mu.Lock()
	defer f.mu.Unlock()
	f.reads = append(f.reads, id)
	r, ok := f.rows[id]
	if !ok {
		return registry.Instance{}, registry.ErrNotFound
	}
	return r, nil
}

func (f *fakeInstances) readIDs() []string {
	f.mu.Lock()
	defer f.mu.Unlock()
	out := slices.Clone(f.reads)
	sort.Strings(out)
	return out
}

// fakeOwners is an OwnerSource with fixed owners.
type fakeOwners map[string]string // machine -> instance

func (f fakeOwners) Lookup(_ context.Context, machineID string) (registry.Owner, bool, error) {
	id, ok := f[machineID]
	if !ok {
		return registry.Owner{}, false, nil
	}
	if id == "error" {
		return registry.Owner{}, false, errors.New("lookup failed")
	}
	return registry.Owner{InstanceID: id}, true, nil
}

// apiFunc is a cpapi.Client whose AuthorizeSSH is a function.
type apiFunc func(ctx context.Context, req cpapi.SSHAuthorizeRequest) (cpapi.SSHAuthorization, error)

func (f apiFunc) LookupRoute(context.Context, string) (cpapi.Route, error) {
	return cpapi.Route{}, cpapi.ErrUnavailable
}

func (f apiFunc) ExchangePortAuthCode(context.Context, string, string) (cpapi.PortAuthGrant, error) {
	return cpapi.PortAuthGrant{}, cpapi.ErrUnavailable
}

func (f apiFunc) AuthorizeSSH(ctx context.Context, req cpapi.SSHAuthorizeRequest) (cpapi.SSHAuthorization, error) {
	return f(ctx, req)
}

// newUnitServer returns a server that never listens, for tests on fake
// targets; mod may change its config.
func newUnitServer(t *testing.T, mod func(*Config)) *Server {
	t.Helper()
	signer := func() ssh.Signer {
		_, priv, err := ed25519.GenerateKey(rand.Reader)
		if err != nil {
			t.Fatal(err)
		}
		s, err := ssh.NewSignerFromKey(priv)
		if err != nil {
			t.Fatal(err)
		}
		return s
	}
	cfg := Config{
		HostSigners: []ssh.Signer{signer()},
		UserCA:      signer(),
		API:         cpapitest.NewFake(),
		Dialer:      upstream.New(upstream.Config{}),
		Logger:      slog.New(slog.DiscardHandler),
	}
	if mod != nil {
		mod(&cfg)
	}
	s, err := New(cfg)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = s.Close() })
	return s
}

var flushSeq struct {
	sync.Mutex
	n int
}

// flushJobs waits until every job queued on s.jobs and s.revokes before
// it has run.
func flushJobs(t *testing.T, s *Server) {
	t.Helper()
	flushQueue(t, s, s.jobs)
	flushQueue(t, s, s.revokes)
}

// flushQueue waits until every job queued on q before it has run.
func flushQueue(t *testing.T, s *Server, q *jobQueue) {
	t.Helper()
	flushSeq.Lock()
	flushSeq.n++
	key := fmt.Sprintf("flush-%d", flushSeq.n)
	flushSeq.Unlock()
	done := make(chan struct{})
	s.enqueue(q, key, func(context.Context) { close(done) })
	select {
	case <-done:
	case <-time.After(10 * time.Second):
		t.Fatal("queue did not run")
	}
}
