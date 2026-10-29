// Package cpapitest is an in-memory fake of the control plane for tests, plus
// an HTTP server that exposes it on the real wire paths.
package cpapitest

import (
	"context"
	"crypto/rand"
	"encoding/hex"
	"fmt"
	"sync"
	"time"

	"github.com/belov38/boat-dev-clone/services/gateway/internal/cpapi"
)

// CodeTTL is how long an issued port-auth code stays valid.
const CodeTTL = 60 * time.Second

type issuedCode struct {
	label   string
	grant   cpapi.PortAuthGrant
	expires time.Time
}

type sshRule struct {
	match func(cpapi.SSHAuthorizeRequest) bool
	auth  cpapi.SSHAuthorization
}

// Fake implements cpapi.Client. It is safe for concurrent use.
type Fake struct {
	mu      sync.Mutex
	now     func() time.Time
	routes  map[string]cpapi.Route
	codes   map[string]issuedCode
	ssh     []sshRule
	calls   map[string]int
	down    bool
	latency time.Duration
	lastSSH []byte
}

var _ cpapi.Client = (*Fake)(nil)

// NewFake returns an empty fake that uses time.Now.
func NewFake() *Fake {
	return &Fake{
		now:    time.Now,
		routes: make(map[string]cpapi.Route),
		codes:  make(map[string]issuedCode),
		calls:  make(map[string]int),
	}
}

// SetClock replaces the clock used for code expiry.
func (f *Fake) SetClock(now func() time.Time) {
	f.mu.Lock()
	defer f.mu.Unlock()
	f.now = now
}

// SetRoute stores r under r.Label. An empty Kind becomes "port", like the
// real client does.
func (f *Fake) SetRoute(r cpapi.Route) {
	if r.Kind == "" {
		r.Kind = cpapi.KindPort
	}
	f.mu.Lock()
	defer f.mu.Unlock()
	f.routes[r.Label] = r
}

// DeleteRoute removes a route; later lookups return ErrRouteNotFound.
func (f *Fake) DeleteRoute(label string) {
	f.mu.Lock()
	defer f.mu.Unlock()
	delete(f.routes, label)
}

// SetDown makes every method return ErrUnavailable.
func (f *Fake) SetDown(down bool) {
	f.mu.Lock()
	defer f.mu.Unlock()
	f.down = down
}

// SetLatency delays every call. The delay ends early with ErrUnavailable
// when the call's context is done.
func (f *Fake) SetLatency(d time.Duration) {
	f.mu.Lock()
	defer f.mu.Unlock()
	f.latency = d
}

// IssueCode creates a single-use code for label that lives for CodeTTL. The
// grant's Label is set to label.
func (f *Fake) IssueCode(label string, g cpapi.PortAuthGrant) string {
	var b [16]byte
	if _, err := rand.Read(b[:]); err != nil {
		panic(err)
	}
	code := hex.EncodeToString(b[:])
	g.Label = label
	f.mu.Lock()
	defer f.mu.Unlock()
	f.codes[code] = issuedCode{label: label, grant: g, expires: f.now().Add(CodeTTL)}
	return code
}

// SetSSH appends a rule. AuthorizeSSH uses the first rule whose match
// function accepts the request; without a match the answer is Allowed=false.
func (f *Fake) SetSSH(match func(cpapi.SSHAuthorizeRequest) bool, a cpapi.SSHAuthorization) {
	f.mu.Lock()
	defer f.mu.Unlock()
	f.ssh = append(f.ssh, sshRule{match: match, auth: a})
}

// Calls returns how many times a method was called: "LookupRoute",
// "ExchangePortAuthCode" or "AuthorizeSSH". Calls that failed because the
// fake is down count too.
func (f *Fake) Calls(method string) int {
	f.mu.Lock()
	defer f.mu.Unlock()
	return f.calls[method]
}

// LastSSHBody returns the body of the last POST /ssh/authorize that
// NewServer received, or nil.
func (f *Fake) LastSSHBody() []byte {
	f.mu.Lock()
	defer f.mu.Unlock()
	return append([]byte(nil), f.lastSSH...)
}

func (f *Fake) recordSSHBody(b []byte) {
	f.mu.Lock()
	defer f.mu.Unlock()
	f.lastSSH = append(f.lastSSH[:0], b...)
}

// enter counts the call, waits out the configured latency and reports
// whether the fake is down.
func (f *Fake) enter(ctx context.Context, method string) error {
	f.mu.Lock()
	f.calls[method]++
	down, latency := f.down, f.latency
	f.mu.Unlock()

	if latency > 0 {
		t := time.NewTimer(latency)
		defer t.Stop()
		select {
		case <-t.C:
		case <-ctx.Done():
			return fmt.Errorf("%w: %w", cpapi.ErrUnavailable, ctx.Err())
		}
	}
	if down {
		return fmt.Errorf("%w: fake is down", cpapi.ErrUnavailable)
	}
	return nil
}

// LookupRoute implements cpapi.Client.
func (f *Fake) LookupRoute(ctx context.Context, label string) (cpapi.Route, error) {
	if err := f.enter(ctx, "LookupRoute"); err != nil {
		return cpapi.Route{}, err
	}
	f.mu.Lock()
	defer f.mu.Unlock()
	r, ok := f.routes[label]
	if !ok {
		return cpapi.Route{}, cpapi.ErrRouteNotFound
	}
	return r, nil
}

// ExchangePortAuthCode implements cpapi.Client. A code is consumed by the
// first successful exchange. An exchange with another label fails with
// ErrInvalidCode and consumes nothing, so a wrong request cannot burn the
// legitimate user's code. An expired code is removed.
func (f *Fake) ExchangePortAuthCode(ctx context.Context, code, label string) (cpapi.PortAuthGrant, error) {
	if err := f.enter(ctx, "ExchangePortAuthCode"); err != nil {
		return cpapi.PortAuthGrant{}, err
	}
	f.mu.Lock()
	defer f.mu.Unlock()
	c, ok := f.codes[code]
	if !ok {
		return cpapi.PortAuthGrant{}, cpapi.ErrInvalidCode
	}
	if !f.now().Before(c.expires) {
		delete(f.codes, code)
		return cpapi.PortAuthGrant{}, cpapi.ErrInvalidCode
	}
	if c.label != label {
		return cpapi.PortAuthGrant{}, cpapi.ErrInvalidCode
	}
	delete(f.codes, code)
	return c.grant, nil
}

// AuthorizeSSH implements cpapi.Client.
func (f *Fake) AuthorizeSSH(ctx context.Context, req cpapi.SSHAuthorizeRequest) (cpapi.SSHAuthorization, error) {
	if err := f.enter(ctx, "AuthorizeSSH"); err != nil {
		return cpapi.SSHAuthorization{}, err
	}
	f.mu.Lock()
	rules := append([]sshRule(nil), f.ssh...)
	f.mu.Unlock()
	for _, r := range rules {
		if r.match(req) {
			return r.auth, nil
		}
	}
	return cpapi.SSHAuthorization{Allowed: false}, nil
}
