package testenv

import (
	"context"
	"fmt"
	"net"
	"net/http"
	"sync"
	"time"

	"github.com/google/uuid"

	"github.com/belov38/umiak/libs/tunnel/agent"
	"github.com/belov38/umiak/libs/tunnel/registry"
	"github.com/belov38/umiak/libs/tunnel/wire"
)

// MachineOptions configure NewMachine.
type MachineOptions struct {
	// Handler serves the agent's non-CONNECT requests (umiak.agent.v1, test
	// services such as the tunneltest/process double); nil answers 404.
	Handler http.Handler
}

// Machine is one VM: credentials, the local apps behind its ports and the
// current agent client.
type Machine struct {
	ID string

	e       *Env
	bs      []byte
	handler http.Handler
	// raw is the hostile agent's handler (NewRawAgent); nil for a real agent.
	raw http.Handler

	appMu     sync.Mutex
	apps      map[uint16]string // port -> 127.0.0.1 address of the app
	blackhole map[uint16]bool

	mu  sync.Mutex
	cur *agentRun
}

type agentRun struct {
	instanceID string
	cancel     context.CancelFunc
	done       chan error
}

type staticCreds struct {
	id string
	bs []byte
}

func (c staticCreds) Bootstrap(context.Context) (string, []byte, error) { return c.id, c.bs, nil }

// NewMachine puts fresh credentials in the registry, starts an agent over
// Env.Net and waits until a running instance serves its tunnel.
func (e *Env) NewMachine(opts ...MachineOptions) *Machine {
	e.T.Helper()
	var o MachineOptions
	if len(opts) > 0 {
		o = opts[0]
	}
	bs, err := wire.NewSecret()
	if err != nil {
		e.T.Fatal(err)
	}
	m := &Machine{
		ID:        uuid.NewString(),
		e:         e,
		bs:        bs,
		handler:   o.Handler,
		apps:      map[uint16]string{},
		blackhole: map[uint16]bool{},
	}
	if err := e.Store.PutCredentials(context.Background(), m.ID, wire.HashSecret(bs)); err != nil {
		e.T.Fatalf("testenv: PutCredentials: %v", err)
	}
	e.T.Cleanup(m.Stop)
	m.Start()
	return m
}

// Start starts an agent client (a new agent process: new instance id, no
// machine token, so it connects with the bootstrap secret) and waits until
// it is connected. A running client is stopped first. A raw agent
// (NewRawAgent) connects again as a raw agent.
func (m *Machine) Start() {
	m.e.T.Helper()
	m.mu.Lock()
	defer m.mu.Unlock()
	if err := m.stopLocked(); err != nil {
		m.e.T.Fatal(err)
	}
	if m.raw != nil {
		m.startRawLocked()
		return
	}
	inst := "agent-" + randHex(8)
	c, err := agent.New(agent.Config{
		Dialer:      m.e.Net.Dialer(),
		Credentials: staticCreds{id: m.ID, bs: m.bs},
		Identity:    agent.Identity{BootID: "boot-" + m.ID, InstanceID: inst, Vmgenid: "gen-1", Version: "1.0.0"},
		Dial:        m.dial,
		Handler:     m.handler,
		Backoff:     agent.Backoff{First: 5 * time.Millisecond, Base: 10 * time.Millisecond, Max: 100 * time.Millisecond, ResetAfter: time.Minute},
		RejectDelays: agent.RejectDelays{
			BadBootstrap: 50 * time.Millisecond, Retired: 50 * time.Millisecond,
			Outdated: 50 * time.Millisecond, MaxRetryAfter: 200 * time.Millisecond,
		},
		DrainJitter:     20 * time.Millisecond,
		DrainCloseExtra: 2 * time.Second,
		Logger:          Logger("agent", inst, "machine", m.ID),
	})
	if err != nil {
		m.e.T.Fatalf("testenv: agent.New: %v", err)
	}
	ctx, cancel := context.WithCancel(context.Background())
	run := &agentRun{instanceID: inst, cancel: cancel, done: make(chan error, 1)}
	go func() { run.done <- c.Run(ctx) }()
	m.cur = run
	m.waitConnectedLocked()
}

// Restart replaces the agent client with a new process and waits until it
// is connected again.
func (m *Machine) Restart() {
	m.e.T.Helper()
	m.Start()
}

// Stop stops the agent client. The tunnel closes; the registry marks the
// session disconnected. Repeated calls do nothing.
func (m *Machine) Stop() {
	m.mu.Lock()
	defer m.mu.Unlock()
	if err := m.stopLocked(); err != nil {
		m.e.T.Error(err)
	}
}

func (m *Machine) stopLocked() error {
	r := m.cur
	if r == nil {
		return nil
	}
	m.cur = nil
	r.cancel()
	select {
	case err := <-r.done:
		return err
	case <-time.After(WaitTimeout):
		return fmt.Errorf("testenv: agent of %s did not stop", m.ID)
	}
}

// WaitConnected waits until the current agent client is connected and a
// running instance serves its tunnel.
func (m *Machine) WaitConnected() {
	m.e.T.Helper()
	m.mu.Lock()
	defer m.mu.Unlock()
	m.waitConnectedLocked()
}

func (m *Machine) waitConnectedLocked() {
	m.e.T.Helper()
	if m.cur == nil {
		m.e.T.Fatalf("testenv: %s has no agent running", m.ID)
	}
	want := m.cur.instanceID
	deadline := time.Now().Add(WaitTimeout)
	for !m.servedBy(want) {
		if time.Now().After(deadline) {
			m.e.T.Fatalf("testenv: %s (agent %s) not connected after %s", m.ID, want, WaitTimeout)
		}
		time.Sleep(5 * time.Millisecond)
	}
}

// servedBy reports whether the agent process agentInstanceID holds the
// connected session and its instance serves it.
func (m *Machine) servedBy(agentInstanceID string) bool {
	s, err := m.e.Store.Session(context.Background(), m.ID)
	if err != nil || s.State != registry.SessionConnected || s.AgentInstanceID != agentInstanceID {
		return false
	}
	i := m.e.byName(s.InstanceID)
	if i == nil {
		return false
	}
	_, ok := i.Tunnel().Machine(m.ID)
	return ok
}

// Owner returns the running instance that serves the machine's tunnel, or
// nil.
func (m *Machine) Owner() *Inst {
	s, err := m.e.Store.Session(context.Background(), m.ID)
	if err != nil || s.State != registry.SessionConnected {
		return nil
	}
	return m.e.byName(s.InstanceID)
}

// Blackhole makes dials of port hang until the CONNECT stream ends, so the
// gateway's dial times out; the agent's own answer would be a timeout.
func (m *Machine) Blackhole(port uint16) {
	m.appMu.Lock()
	defer m.appMu.Unlock()
	m.blackhole[port] = true
}

func (m *Machine) setApp(port uint16, addr string) {
	m.appMu.Lock()
	defer m.appMu.Unlock()
	m.apps[port] = addr
	delete(m.blackhole, port)
}

// dial is the agent's CONNECT dial: the app registered on port, a
// blackhole, or a closed port (ECONNREFUSED). The host is ignored.
func (m *Machine) dial(ctx context.Context, _ string, port int) (net.Conn, error) {
	m.appMu.Lock()
	addr, ok := m.apps[uint16(port)]
	hole := m.blackhole[uint16(port)]
	m.appMu.Unlock()
	if hole {
		<-ctx.Done()
		return nil, &timeoutError{err: ctx.Err()}
	}
	if !ok {
		addr = refusedAddr
	}
	return (&net.Dialer{}).DialContext(ctx, "tcp", addr)
}

// timeoutError is a net.Error with Timeout() true, like a real dial timeout.
type timeoutError struct{ err error }

func (e *timeoutError) Error() string   { return "dial timeout: " + e.err.Error() }
func (e *timeoutError) Unwrap() error   { return e.err }
func (e *timeoutError) Timeout() bool   { return true }
func (e *timeoutError) Temporary() bool { return true }

var _ net.Error = (*timeoutError)(nil)
