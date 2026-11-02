package harness_test

import (
	"context"
	"errors"
	"io"
	"net"
	"net/http"
	"strconv"
	"testing"

	"github.com/belov38/umiak/libs/tunnel/gateway"
	"github.com/belov38/umiak/libs/tunnel/transport"
	"github.com/belov38/umiak/libs/tunnel/wire"
)

// closedPort returns a local TCP port nobody listens on.
func closedPort(t *testing.T) uint16 {
	t.Helper()
	ln, err := (&net.ListenConfig{}).Listen(t.Context(), "tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatal(err)
	}
	port := ln.Addr().(*net.TCPAddr).Port
	_ = ln.Close()
	return uint16(port) //nolint:gosec // a TCP port fits uint16
}

func TestHarnessConnectRefusedHeader(t *testing.T) {
	e := newEnv(t)
	port := closedPort(t)
	mc, ok := e.gw.Machine(e.machineID)
	if !ok {
		t.Fatal("no session")
	}

	// Through the gateway API: a refused dial is a 502 DialError.
	_, err := mc.DialTCP(ctx(t), port)
	var de *transport.DialError
	if !errors.As(err, &de) || de.Status != http.StatusBadGateway {
		t.Fatalf("DialTCP to a closed port = %v, want DialError 502", err)
	}

	// Through the internal listener (the peer path) the same 502.
	_, err = gateway.DialRemoteTCP(ctx(t), e.peer, e.url, serviceToken, e.machineID, port, gateway.TCPOptions{})
	if !errors.As(err, &de) || de.Status != http.StatusBadGateway {
		t.Fatalf("DialRemoteTCP to a closed port = %v, want DialError 502", err)
	}

	// The agent's own answer, read with a raw CONNECT over the tunnel,
	// names the reason.
	pr, pw := io.Pipe()
	defer func() { _ = pw.Close() }()
	cctx, cancel := context.WithCancel(ctx(t))
	defer cancel()
	req, err := http.NewRequestWithContext(cctx, http.MethodConnect, "", pr)
	if err != nil {
		t.Fatal(err)
	}
	authority := net.JoinHostPort("localhost", strconv.Itoa(int(port)))
	req.Host, req.URL.Host = authority, authority
	res, err := mc.RoundTrip(req)
	if err != nil {
		t.Fatalf("CONNECT: %v", err)
	}
	_ = res.Body.Close()
	if res.StatusCode != http.StatusBadGateway || res.Header.Get(wire.HeaderDialError) != "refused" {
		t.Fatalf("CONNECT = %d, %s %q; want 502 refused", res.StatusCode, wire.HeaderDialError, res.Header.Get(wire.HeaderDialError))
	}
}

func TestHarnessConnectEcho(t *testing.T) {
	e := newEnv(t)
	ln, err := (&net.ListenConfig{}).Listen(t.Context(), "tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatal(err)
	}
	defer func() { _ = ln.Close() }()
	go func() {
		c, err := ln.Accept()
		if err != nil {
			return
		}
		defer func() { _ = c.Close() }()
		_, _ = io.Copy(c, c)
	}()
	port := uint16(ln.Addr().(*net.TCPAddr).Port) //nolint:gosec // a TCP port fits uint16

	c, err := gateway.DialRemoteTCP(ctx(t), e.peer, e.url, serviceToken, e.machineID, port, gateway.TCPOptions{})
	if err != nil {
		t.Fatalf("DialRemoteTCP: %v", err)
	}
	defer func() { _ = c.Close() }()
	if _, err := c.Write([]byte("ping")); err != nil {
		t.Fatal(err)
	}
	buf := make([]byte, 4)
	if _, err := io.ReadFull(c, buf); err != nil || string(buf) != "ping" {
		t.Fatalf("echo %q, %v", buf, err)
	}
}
