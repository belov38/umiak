package agent

import (
	"context"
	"crypto/x509"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"sync"
	"time"

	tunnelagent "github.com/belov38/boat-dev-clone/libs/tunnel/agent"
	"github.com/belov38/boat-dev-clone/libs/tunnel/wstransport"

	"github.com/belov38/boat-dev-clone/services/guest-agent/internal/ports"
	"github.com/belov38/boat-dev-clone/services/guest-agent/internal/update"
)

// startTunnel starts the tunnel client (spec 6 step 2.5, S2): the effective
// tunnel URL over a WebSocket trusting the tunnel CA of this version, the
// agent mux as the handler, the journal for Events, the Info answer, the
// CONNECT dialer and the connection events for status.json and the update
// confirmation. It runs until ctx ends.
func (a *agent) startTunnel(ctx context.Context) {
	url, source := a.identity.tunnelURL()
	a.tunnel.setURL(url, source)
	dialer := a.d.Dialer
	if dialer == nil {
		if url == "" {
			a.log.Error("agent: no tunnel url: set [tunnel] url in agent.toml or the smbios family")
			a.tunnel.setError("no tunnel url configured")
			return
		}
		pool, err := a.tunnelCAs()
		if err != nil {
			// A nil pool trusts nothing: every dial fails with a TLS error
			// that status.json and doctor show.
			a.log.Error("agent: tunnel CA bundle", "err", err)
			a.tunnel.setError(err.Error())
		}
		dialer = wstransport.NewDialer(wstransport.DialerConfig{URL: url, RootCAs: pool})
	}
	c, err := tunnelagent.New(tunnelagent.Config{
		Dialer:      dialer,
		Credentials: credentials{a: a},
		Identity: tunnelagent.Identity{
			BootID:     a.bootID,
			InstanceID: a.instanceID,
			Vmgenid:    "", // not readable on Linux (spec 7.1)
			Version:    a.version,
		},
		Handler:     a.mux,
		Info:        a.tunnelInfo,
		Journal:     a.st.Journal(),
		Dial:        ports.Dialer{Counter: a.tcp, LocalAddrs: a.d.LocalAddrs}.Dial,
		OnConnEvent: a.onConnEvent,
		Logger:      a.log,
	})
	if err != nil {
		a.log.Error("agent: tunnel client", "err", err)
		a.tunnel.setError(err.Error())
		return
	}
	a.log.Info("agent: starting the tunnel", "url", url, "source", source)
	a.goBG(func() { _ = c.Run(ctx) })
}

// tunnelCAs loads <trust>/tunnel-ca.pem: [tunnel] trust_dir from agent.toml,
// otherwise the trust directory of the current version.
func (a *agent) tunnelCAs() (*x509.CertPool, error) {
	path := filepath.Join(a.l.CurrentLink, filepath.FromSlash(update.TunnelCAName))
	if a.cfg.TrustDir != "" {
		path = filepath.Join(a.cfg.TrustDir, filepath.Base(update.TunnelCAName))
	}
	b, err := os.ReadFile(path)
	if err != nil {
		return nil, err
	}
	pool := x509.NewCertPool()
	if !pool.AppendCertsFromPEM(b) {
		return nil, fmt.Errorf("agent: no certificates in %s", path)
	}
	return pool, nil
}

// credentials re-reads the smbios identity for every bootstrap (the library
// calls it at start and after a 401 on the boot secret).
type credentials struct{ a *agent }

// Bootstrap implements tunnelagent.Credentials.
func (c credentials) Bootstrap(ctx context.Context) (string, []byte, error) {
	id, err := c.a.readIdentity(ctx)
	if err != nil {
		return "", nil, err
	}
	if want := c.a.identity.machineID(); !sameMachine(want, id.MachineID) {
		return "", nil, errors.New("agent: the smbios machine id changed while running")
	}
	return id.MachineID, id.BS, nil
}

// onConnEvent records a tunnel connection change for status.json and lets
// the first connection count toward the update confirmation.
func (a *agent) onConnEvent(ev tunnelagent.ConnEvent) {
	a.tunnel.event(ev)
	if ev.Kind == tunnelagent.KindConnected {
		a.confirm.connected()
	}
}

// confirmer confirms a pending update (spec 17.4 step 6) once a tunnel
// connection came up and the gateway's Control/Info was answered. A
// Control/Info on the debug socket is a separate signal: it counts only with
// debugConfirm, and then confirms alone, without a connection.
//
// The signals only set flags and wake run, which calls Confirm on its own
// goroutine: never on the tunnel library's callback goroutines, and only after
// the Info response was built. Confirm is called on every qualifying wake-up:
// it does nothing without a pending update and retries a failed confirmation.
type confirmer struct {
	debugConfirm bool
	confirm      func()
	wake         chan struct{}

	mu        sync.Mutex
	wasUp     bool // a tunnel connection came up
	tunnelInf bool // Control/Info was answered over the tunnel
	debugInf  bool // Control/Info was answered on the debug socket
}

func newConfirmer(debugConfirm bool, confirm func()) *confirmer {
	return &confirmer{debugConfirm: debugConfirm, confirm: confirm, wake: make(chan struct{}, 1)}
}

// connected records a tunnel connection.
func (c *confirmer) connected() { c.set(func() { c.wasUp = true }) }

// tunnelInfo records an answered Control/Info over the tunnel.
func (c *confirmer) tunnelInfo() { c.set(func() { c.tunnelInf = true }) }

// debugInfo records an answered Control/Info on the debug socket.
func (c *confirmer) debugInfo() { c.set(func() { c.debugInf = true }) }

func (c *confirmer) set(f func()) {
	c.mu.Lock()
	f()
	c.mu.Unlock()
	select {
	case c.wake <- struct{}{}:
	default:
	}
}

// ready reports whether the confirmation condition holds.
func (c *confirmer) ready() bool {
	c.mu.Lock()
	defer c.mu.Unlock()
	return (c.wasUp && c.tunnelInf) || (c.debugConfirm && c.debugInf)
}

// run calls Confirm after every wake-up that finds the condition true,
// until ctx ends.
func (c *confirmer) run(ctx context.Context) {
	for {
		select {
		case <-ctx.Done():
			return
		case <-c.wake:
		}
		if c.ready() {
			c.confirm()
		}
	}
}

// tunnelState is the tunnel part of status.json.
type tunnelState struct {
	now func() time.Time

	mu        sync.Mutex
	url       string
	urlSource string
	connected bool
	gateway   string
	connID    string
	epoch     uint64
	lastError string
	since     time.Time
}

func newTunnelState(now func() time.Time) *tunnelState {
	return &tunnelState{now: now, since: now()}
}

func (t *tunnelState) setURL(url, source string) {
	t.mu.Lock()
	defer t.mu.Unlock()
	t.url, t.urlSource = url, source
}

func (t *tunnelState) setError(msg string) {
	t.mu.Lock()
	defer t.mu.Unlock()
	t.lastError = msg
}

// event applies a connection event. A disconnect of a connection other than
// the current one (the old one after a drain) changes nothing.
func (t *tunnelState) event(ev tunnelagent.ConnEvent) {
	t.mu.Lock()
	defer t.mu.Unlock()
	switch ev.Kind {
	case tunnelagent.KindConnected:
		t.connected, t.gateway, t.connID, t.epoch, t.since = true, ev.Gateway, ev.ConnID, ev.Epoch, t.now()
	case tunnelagent.KindDisconnected:
		if t.connected && ev.ConnID == t.connID {
			t.connected, t.since = false, t.now()
			t.lastError = "disconnected: " + ev.Reason
		}
	case tunnelagent.KindRejected:
		msg := ev.Reason
		if ev.Status != 0 {
			msg = fmt.Sprintf("rejected with %d: %s", ev.Status, ev.Reason)
		}
		t.lastError = msg
	}
}

// disconnected marks the tunnel down (agent shutdown).
func (t *tunnelState) disconnected(reason string) {
	t.mu.Lock()
	defer t.mu.Unlock()
	if t.connected {
		t.connected, t.since, t.lastError = false, t.now(), reason
	}
}

// snapshot returns the tunnel part of status.json.
func (t *tunnelState) snapshot() TunnelStatus {
	t.mu.Lock()
	defer t.mu.Unlock()
	return TunnelStatus{
		Connected: t.connected,
		Gateway:   t.gateway,
		ConnID:    t.connID,
		Epoch:     t.epoch,
		LastError: t.lastError,
		Since:     t.since.UTC(),
		URL:       t.url,
		URLSource: t.urlSource,
	}
}
