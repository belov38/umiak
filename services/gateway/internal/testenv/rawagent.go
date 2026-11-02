package testenv

import (
	"context"
	"errors"
	"net/http"
	"time"

	"github.com/google/uuid"

	"github.com/belov38/umiak/libs/tunnel/h2"
	"github.com/belov38/umiak/libs/tunnel/transport"
	"github.com/belov38/umiak/libs/tunnel/wire"
)

// eventsSubscribePath is the agent's Events/Subscribe procedure. The raw
// agent holds it open, so the gateway does not resubscribe in a loop.
const eventsSubscribePath = "/umiak.tunnel.v1.Events/Subscribe"

// NewRawAgent puts fresh credentials in the registry and connects a hostile
// agent over Env.Net: it is admitted with the valid bootstrap secret, then h
// serves the tunnel conn directly as the agent's HTTP/2 server. CONNECT
// answers (status, headers, body), Control and every other agent call are
// h's. Only Events/Subscribe is held open until the stream ends. It returns
// once a running instance serves the session; Stop closes the tunnel.
//
// The gateway tolerates a failing Control/Info and Control/SetToken (it
// logs and retries), so h may answer them with 404.
func (e *Env) NewRawAgent(h http.Handler) *Machine {
	e.T.Helper()
	bs, err := wire.NewSecret()
	if err != nil {
		e.T.Fatal(err)
	}
	m := &Machine{
		ID:        uuid.NewString(),
		e:         e,
		bs:        bs,
		raw:       h,
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

// rawHandler holds Events/Subscribe open and passes everything else to h.
func rawHandler(h http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.Method == http.MethodPost && r.URL.Path == eventsSubscribePath {
			<-r.Context().Done()
			return
		}
		h.ServeHTTP(w, r)
	})
}

// startRawLocked dials one tunnel conn with the bootstrap secret and serves
// it with the raw handler until the run is cancelled. m.mu is held.
func (m *Machine) startRawLocked() {
	m.e.T.Helper()
	inst := "raw-" + randHex(8)
	hello := transport.Hello{
		MachineID:       m.ID,
		BootID:          "boot-" + m.ID,
		AgentInstanceID: inst,
		Vmgenid:         "gen-1",
		AgentVersion:    "1.0.0",
		Scheme:          transport.AuthBootstrap,
		Secret:          m.bs,
	}
	dctx, dcancel := context.WithTimeout(context.Background(), WaitTimeout)
	conn, _, err := m.e.Net.Dialer().Dial(dctx, hello)
	dcancel()
	if err != nil {
		m.e.T.Fatalf("testenv: raw agent %s: dial: %v", m.ID, err)
	}
	ln := h2.New()
	srv := h2.NewServer(rawHandler(m.raw), h2.DefaultServerConfig())
	served := make(chan struct{})
	go func() {
		defer close(served)
		_ = srv.Serve(ln)
	}()
	if err := ln.Push(conn); err != nil {
		_ = conn.Close()
		m.e.T.Fatalf("testenv: raw agent %s: %v", m.ID, err)
	}

	ctx, cancel := context.WithCancel(context.Background())
	run := &agentRun{instanceID: inst, cancel: cancel, done: make(chan error, 1)}
	go func() {
		<-ctx.Done()
		// Close ends the conn and every handler's context.
		_ = srv.Close()
		_ = ln.Close()
		_ = conn.Close()
		select {
		case <-served:
			run.done <- nil
		case <-time.After(WaitTimeout):
			run.done <- errors.New("testenv: raw agent server did not stop")
		}
	}()
	m.cur = run
	m.waitConnectedLocked()
}
