package testenv

import (
	"errors"
	"io"
	"net"
	"net/http"
	"sync"
	"time"

	"github.com/belov38/boat-dev-clone/services/gateway/internal/testenv/sshdtest"
)

// appReadHeaderTimeout bounds request headers on the test apps.
const appReadHeaderTimeout = 10 * time.Second

// ServeHTTP runs an HTTP/1.1 app behind port of the machine. A later Serve*
// on the same port replaces it for new dials.
func (m *Machine) ServeHTTP(port uint16, h http.Handler) {
	m.e.T.Helper()
	var p http.Protocols
	p.SetHTTP1(true)
	m.serveHTTP(port, h, &p)
}

// ServeH2C runs a cleartext HTTP/2 (prior knowledge) app behind port. It
// does not speak HTTP/1.
func (m *Machine) ServeH2C(port uint16, h http.Handler) {
	m.e.T.Helper()
	var p http.Protocols
	p.SetUnencryptedHTTP2(true)
	m.serveHTTP(port, h, &p)
}

func (m *Machine) serveHTTP(port uint16, h http.Handler, p *http.Protocols) {
	m.e.T.Helper()
	ln := m.e.listen()
	srv := &http.Server{Handler: h, ReadHeaderTimeout: appReadHeaderTimeout, Protocols: p}
	done := make(chan struct{})
	go func() {
		defer close(done)
		_ = srv.Serve(ln)
	}()
	m.e.T.Cleanup(func() {
		_ = srv.Close()
		<-done
	})
	m.setApp(port, ln.Addr().String())
}

// ServeTCP runs a TCP app behind port: fn is called for every accepted conn
// on its own goroutine, and the conn is closed when fn returns.
func (m *Machine) ServeTCP(port uint16, fn func(net.Conn)) {
	m.e.T.Helper()
	ln := m.e.listen()
	var (
		wg    sync.WaitGroup
		mu    sync.Mutex
		conns = map[net.Conn]struct{}{}
	)
	wg.Go(func() {
		for {
			c, err := ln.Accept()
			if err != nil {
				if !errors.Is(err, net.ErrClosed) {
					m.e.T.Logf("testenv: tcp app on %d: accept: %v", port, err)
				}
				return
			}
			mu.Lock()
			conns[c] = struct{}{}
			mu.Unlock()
			wg.Go(func() {
				defer func() {
					mu.Lock()
					delete(conns, c)
					mu.Unlock()
					_ = c.Close()
				}()
				fn(c)
			})
		}
	})
	m.e.T.Cleanup(func() {
		_ = ln.Close()
		mu.Lock()
		for c := range conns {
			_ = c.Close()
		}
		mu.Unlock()
		wg.Wait()
	})
	m.setApp(port, ln.Addr().String())
}

// ServeSSHD runs the sshd double behind port 22 of the machine.
func (m *Machine) ServeSSHD(srv *sshdtest.Server) {
	m.e.T.Helper()
	m.ServeTCP(22, srv.ServeConn)
}

// Echo is a ServeTCP function that copies everything back.
func Echo(c net.Conn) { _, _ = io.Copy(c, c) }
