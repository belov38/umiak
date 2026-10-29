// Package sshdtest is an in-process double of the OpenSSH server inside a
// VM: it accepts only user certificates signed by the gateway's SSH user CA
// for one login user, and serves a small, deterministic set of channels and
// requests for the SSH gateway tests.
//
// Session channels:
//   - "env" requests are recorded and listed by the "env" command;
//   - "exec" runs a tiny script: commands separated by ";", each one of
//     "echo <text>" (text and "\n" to stdout), "stderr <text>" (to stderr),
//     "env" (the session's env as NAME=VALUE lines, sorted), "cat" (copy
//     stdin to stdout until EOF), "closewrite" (send EOF on stdout now),
//     "sleep <duration>", "signal <NAME>" (send exit-signal and stop
//     without an exit-status) and "exit <N>" (stop with status N).
//     Unknown commands are written to stdout followed by "\n". Without
//     "exit" the status is 0. A command containing "stderr" anywhere also
//     writes "err\n" to stderr;
//   - "shell" (with or without a pty) and "subsystem" echo stdin back to
//     stdout until EOF, then exit 0;
//   - "auth-agent-req@openssh.com" is accepted and makes the double open an
//     "auth-agent@openssh.com" channel back to the client, send an agent
//     REQUEST_IDENTITIES message and record the reply (AgentReplies);
//   - every request name is recorded (Requests).
//
// Other channels: "direct-tcpip" dials the target address. Global requests:
// "tcpip-forward" listens on 127.0.0.1 and opens "forwarded-tcpip" channels
// for accepted conns; "cancel-tcpip-forward" stops that listener. Right
// after the handshake the double sends "hostkeys-00@openssh.com"
// (want-reply false), like OpenSSH.
package sshdtest

import (
	"bytes"
	"context"
	"crypto/ed25519"
	"crypto/rand"
	"encoding/binary"
	"errors"
	"fmt"
	"io"
	"maps"
	"net"
	"slices"
	"strconv"
	"strings"
	"sync"
	"testing"
	"time"

	"golang.org/x/crypto/ssh"
)

const (
	extKeyID = "sshdtest-key-id"
	// dialTimeout bounds direct-tcpip dials.
	dialTimeout = 10 * time.Second
)

// Server is the sshd double. Serve it with ServeConn, for example as a
// testenv TCP app on port 22.
type Server struct {
	userCA    []byte
	loginUser string
	config    *ssh.ServerConfig
	hostKey   ssh.Signer

	mu       sync.Mutex
	certs    []*ssh.Certificate
	requests []string
	agent    [][]byte
	globals  []string
}

// New returns a double that trusts userCA for certificates whose single
// accepted principal is loginUser. Its host key is random.
func New(t testing.TB, userCA ssh.PublicKey, loginUser string) *Server {
	t.Helper()
	_, priv, err := ed25519.GenerateKey(rand.Reader)
	if err != nil {
		t.Fatal(err)
	}
	hk, err := ssh.NewSignerFromKey(priv)
	if err != nil {
		t.Fatal(err)
	}
	s := &Server{userCA: userCA.Marshal(), loginUser: loginUser, hostKey: hk}
	s.config = &ssh.ServerConfig{
		PublicKeyCallback: s.authenticate,
		ServerVersion:     "SSH-2.0-OpenSSH_9.9 sshdtest",
	}
	s.config.AddHostKey(hk)
	return s
}

// HostKey returns the double's host key.
func (s *Server) HostKey() ssh.PublicKey { return s.hostKey.PublicKey() }

// authenticate accepts a user certificate signed by the user CA with
// loginUser as principal, like sshd with TrustedUserCAKeys.
func (s *Server) authenticate(meta ssh.ConnMetadata, key ssh.PublicKey) (*ssh.Permissions, error) {
	cert, ok := key.(*ssh.Certificate)
	if !ok {
		return nil, errors.New("sshdtest: only certificates are accepted")
	}
	if meta.User() != s.loginUser {
		return nil, fmt.Errorf("sshdtest: user %q is not %q", meta.User(), s.loginUser)
	}
	checker := &ssh.CertChecker{
		IsUserAuthority: func(auth ssh.PublicKey) bool { return bytes.Equal(auth.Marshal(), s.userCA) },
	}
	perms, err := checker.Authenticate(meta, cert)
	if err != nil {
		return nil, err
	}
	p := *perms
	p.Extensions = map[string]string{extKeyID: string(cert.Marshal())}
	return &p, nil
}

// KeyIDs returns the KeyId of every certificate that logged in, in order.
func (s *Server) KeyIDs() []string {
	s.mu.Lock()
	defer s.mu.Unlock()
	ids := make([]string, len(s.certs))
	for i, c := range s.certs {
		ids[i] = c.KeyId
	}
	return ids
}

// Certs returns every certificate that logged in, in order.
func (s *Server) Certs() []*ssh.Certificate {
	s.mu.Lock()
	defer s.mu.Unlock()
	return slices.Clone(s.certs)
}

// Requests returns the names of all session channel requests received, in
// order.
func (s *Server) Requests() []string {
	s.mu.Lock()
	defer s.mu.Unlock()
	return slices.Clone(s.requests)
}

// GlobalRequests returns the names of all global requests received.
func (s *Server) GlobalRequests() []string {
	s.mu.Lock()
	defer s.mu.Unlock()
	return slices.Clone(s.globals)
}

// AgentReplies returns the agent messages (without the length prefix)
// received on the auth-agent channels the double opened.
func (s *Server) AgentReplies() [][]byte {
	s.mu.Lock()
	defer s.mu.Unlock()
	return slices.Clone(s.agent)
}

func (s *Server) record(dst *[]string, v string) {
	s.mu.Lock()
	defer s.mu.Unlock()
	*dst = append(*dst, v)
}

// ServeConn serves one SSH conn and returns when it ended. Everything it
// started is stopped before it returns.
func (s *Server) ServeConn(c net.Conn) {
	sconn, chans, reqs, err := ssh.NewServerConn(c, s.config)
	if err != nil {
		return
	}
	if raw, ok := sconn.Permissions.Extensions[extKeyID]; ok {
		if k, err := ssh.ParsePublicKey([]byte(raw)); err == nil {
			if cert, ok := k.(*ssh.Certificate); ok {
				s.mu.Lock()
				s.certs = append(s.certs, cert)
				s.mu.Unlock()
			}
		}
	}
	cs := &conn{srv: s, sconn: sconn, forwards: map[string]net.Listener{}}
	defer func() {
		cs.closeAll()
		_ = sconn.Close()
		cs.wg.Wait()
	}()

	_, _, _ = sconn.SendRequest("hostkeys-00@openssh.com", false, ssh.Marshal(struct{ Key string }{string(s.hostKey.PublicKey().Marshal())}))

	cs.wg.Go(func() { cs.globalRequests(reqs) })
	for nc := range chans {
		switch nc.ChannelType() {
		case "session":
			ch, creqs, err := nc.Accept()
			if err != nil {
				continue
			}
			cs.wg.Go(func() { cs.session(ch, creqs) })
		case "direct-tcpip":
			cs.wg.Go(func() { cs.directTCPIP(nc) })
		default:
			_ = nc.Reject(ssh.UnknownChannelType, "sshdtest: unsupported channel type")
		}
	}
}

// conn is the state of one served conn.
type conn struct {
	srv   *Server
	sconn *ssh.ServerConn
	wg    sync.WaitGroup

	mu       sync.Mutex
	closed   bool
	forwards map[string]net.Listener
	tcp      []net.Conn
}

// track registers a TCP conn to close with the SSH conn; false means the
// SSH conn already ended.
func (c *conn) track(tc net.Conn) bool {
	c.mu.Lock()
	defer c.mu.Unlock()
	if c.closed {
		return false
	}
	c.tcp = append(c.tcp, tc)
	return true
}

func (c *conn) closeAll() {
	c.mu.Lock()
	defer c.mu.Unlock()
	c.closed = true
	for _, ln := range c.forwards {
		_ = ln.Close()
	}
	for _, tc := range c.tcp {
		_ = tc.Close()
	}
}

type forwardReq struct {
	Addr string
	Port uint32
}

func (c *conn) globalRequests(reqs <-chan *ssh.Request) {
	for r := range reqs {
		c.srv.record(&c.srv.globals, r.Type)
		switch r.Type {
		case "tcpip-forward":
			c.tcpipForward(r)
		case "cancel-tcpip-forward":
			var fr forwardReq
			ok := ssh.Unmarshal(r.Payload, &fr) == nil
			if ok {
				key := net.JoinHostPort(fr.Addr, strconv.Itoa(int(fr.Port)))
				c.mu.Lock()
				ln, found := c.forwards[key]
				delete(c.forwards, key)
				c.mu.Unlock()
				ok = found
				if found {
					_ = ln.Close()
				}
			}
			_ = r.Reply(ok, nil)
		default:
			if r.WantReply {
				_ = r.Reply(false, nil)
			}
		}
	}
}

// tcpipForward listens on 127.0.0.1 (whatever address was asked) and
// answers with the bound port when port 0 was asked.
func (c *conn) tcpipForward(r *ssh.Request) {
	var fr forwardReq
	if err := ssh.Unmarshal(r.Payload, &fr); err != nil {
		_ = r.Reply(false, nil)
		return
	}
	ln, err := (&net.ListenConfig{}).Listen(context.Background(), "tcp", net.JoinHostPort("127.0.0.1", strconv.Itoa(int(fr.Port))))
	if err != nil {
		_ = r.Reply(false, nil)
		return
	}
	port := uint32(ln.Addr().(*net.TCPAddr).Port)
	key := net.JoinHostPort(fr.Addr, strconv.Itoa(int(port)))
	c.mu.Lock()
	if c.closed {
		c.mu.Unlock()
		_ = ln.Close()
		_ = r.Reply(false, nil)
		return
	}
	c.forwards[key] = ln
	if fr.Port != 0 {
		c.forwards[net.JoinHostPort(fr.Addr, strconv.Itoa(int(fr.Port)))] = ln
	}
	c.mu.Unlock()
	var reply []byte
	if fr.Port == 0 {
		reply = ssh.Marshal(struct{ Port uint32 }{port})
	}
	_ = r.Reply(true, reply)
	c.wg.Go(func() {
		for {
			tc, err := ln.Accept()
			if err != nil {
				return
			}
			if !c.track(tc) {
				_ = tc.Close()
				return
			}
			c.wg.Go(func() {
				defer func() { _ = tc.Close() }()
				ra := tc.RemoteAddr().(*net.TCPAddr)
				payload := ssh.Marshal(struct {
					Addr       string
					Port       uint32
					OriginAddr string
					OriginPort uint32
				}{fr.Addr, port, ra.IP.String(), uint32(ra.Port)})
				ch, reqs, err := c.sconn.OpenChannel("forwarded-tcpip", payload)
				if err != nil {
					return
				}
				go ssh.DiscardRequests(reqs)
				pipe(ch, tc)
			})
		}
	})
}

func (c *conn) directTCPIP(nc ssh.NewChannel) {
	var d struct {
		Host     string
		Port     uint32
		OrigHost string
		OrigPort uint32
	}
	if err := ssh.Unmarshal(nc.ExtraData(), &d); err != nil {
		_ = nc.Reject(ssh.ConnectionFailed, "sshdtest: bad direct-tcpip payload")
		return
	}
	ctx, cancel := context.WithTimeout(context.Background(), dialTimeout)
	defer cancel()
	tc, err := (&net.Dialer{}).DialContext(ctx, "tcp", net.JoinHostPort(d.Host, strconv.Itoa(int(d.Port))))
	if err != nil {
		_ = nc.Reject(ssh.ConnectionFailed, err.Error())
		return
	}
	defer func() { _ = tc.Close() }()
	if !c.track(tc) {
		_ = nc.Reject(ssh.ConnectionFailed, "sshdtest: closing")
		return
	}
	ch, reqs, err := nc.Accept()
	if err != nil {
		return
	}
	go ssh.DiscardRequests(reqs)
	pipe(ch, tc)
}

// pipe copies both ways between a channel and a TCP conn and closes both.
func pipe(ch ssh.Channel, tc net.Conn) {
	var wg sync.WaitGroup
	wg.Go(func() {
		_, _ = io.Copy(tc, ch)
		if cw, ok := tc.(interface{ CloseWrite() error }); ok {
			_ = cw.CloseWrite()
		}
	})
	wg.Go(func() {
		_, _ = io.Copy(ch, tc)
		_ = ch.CloseWrite()
	})
	wg.Wait()
	_ = ch.Close()
	_ = tc.Close()
}

// session serves one session channel.
func (c *conn) session(ch ssh.Channel, reqs <-chan *ssh.Request) {
	defer func() { _ = ch.Close() }()
	env := map[string]string{}
	started := false
	done := make(chan struct{})
	for r := range reqs {
		c.srv.record(&c.srv.requests, r.Type)
		ok := true
		switch r.Type {
		case "env":
			var kv struct{ Name, Value string }
			if ok = ssh.Unmarshal(r.Payload, &kv) == nil; ok {
				env[kv.Name] = kv.Value
			}
		case "pty-req", "window-change":
		case "auth-agent-req@openssh.com":
			c.wg.Go(c.agentChannel)
		case "exec", "shell", "subsystem":
			if started {
				ok = false
				break
			}
			started = true
			var cmd string
			if r.Type == "exec" {
				var p struct{ Command string }
				if ok = ssh.Unmarshal(r.Payload, &p) == nil; !ok {
					break
				}
				cmd = p.Command
			}
			envCopy := maps.Clone(env)
			if r.WantReply {
				_ = r.Reply(true, nil)
			}
			go func() {
				defer close(done)
				if r.Type == "exec" {
					runScript(ch, cmd, envCopy)
				} else {
					_, _ = io.Copy(ch, ch)
					sendExit(ch, 0)
				}
				_ = ch.CloseWrite()
				_ = ch.Close()
			}()
			continue
		default:
			ok = false
		}
		if r.WantReply {
			_ = r.Reply(ok, nil)
		}
	}
	if started {
		<-done
	}
}

func sendExit(ch ssh.Channel, status uint32) {
	_, _ = ch.SendRequest("exit-status", false, ssh.Marshal(struct{ Status uint32 }{status}))
}

// runScript runs an exec command (see the package doc).
func runScript(ch ssh.Channel, cmd string, env map[string]string) {
	if strings.Contains(cmd, "stderr") {
		_, _ = io.WriteString(ch.Stderr(), "err\n")
	}
	for part := range strings.SplitSeq(cmd, ";") {
		part = strings.TrimSpace(part)
		name, arg, _ := strings.Cut(part, " ")
		switch name {
		case "":
		case "echo":
			_, _ = io.WriteString(ch, arg+"\n")
		case "stderr":
			_, _ = io.WriteString(ch.Stderr(), arg+"\n")
		case "env":
			keys := make([]string, 0, len(env))
			for k := range env {
				keys = append(keys, k)
			}
			slices.Sort(keys)
			for _, k := range keys {
				_, _ = io.WriteString(ch, k+"="+env[k]+"\n")
			}
		case "cat":
			_, _ = io.Copy(ch, ch)
		case "closewrite":
			_ = ch.CloseWrite()
		case "sleep":
			if d, err := time.ParseDuration(arg); err == nil {
				time.Sleep(d)
			}
		case "signal":
			_, _ = ch.SendRequest("exit-signal", false, ssh.Marshal(struct {
				Signal     string
				CoreDumped bool
				Error      string
				Lang       string
			}{arg, false, "killed", ""}))
			return
		case "exit":
			n, _ := strconv.ParseUint(arg, 10, 32)
			sendExit(ch, uint32(n))
			return
		default:
			_, _ = io.WriteString(ch, part+"\n")
		}
	}
	sendExit(ch, 0)
}

// agentChannel opens auth-agent@openssh.com back to the client, asks for
// the identities and records the reply.
func (c *conn) agentChannel() {
	ch, reqs, err := c.sconn.OpenChannel("auth-agent@openssh.com", nil)
	if err != nil {
		return
	}
	defer func() { _ = ch.Close() }()
	go ssh.DiscardRequests(reqs)
	const agentcRequestIdentities = 11
	if _, err := ch.Write([]byte{0, 0, 0, 1, agentcRequestIdentities}); err != nil {
		return
	}
	var hdr [4]byte
	if _, err := io.ReadFull(ch, hdr[:]); err != nil {
		return
	}
	n := binary.BigEndian.Uint32(hdr[:])
	if n > 1<<20 {
		return
	}
	msg := make([]byte, n)
	if _, err := io.ReadFull(ch, msg); err != nil {
		return
	}
	c.srv.mu.Lock()
	c.srv.agent = append(c.srv.agent, msg)
	c.srv.mu.Unlock()
}
