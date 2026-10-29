package sshgw

import (
	"context"
	"crypto/ed25519"
	"crypto/rand"
	"encoding/binary"
	"errors"
	"fmt"
	"net"
	"regexp"
	"sync/atomic"
	"time"

	"golang.org/x/crypto/ssh"

	"github.com/belov38/boat-dev-clone/services/gateway/internal/upstream"
)

const (
	// sshPort is the port of the VM's sshd (127.0.0.1:22 in the VM).
	sshPort = 22
	// backendCertBackdate is how far back the backend certificate's
	// ValidAfter goes, for clock skew between the gateway and the VM.
	backendCertBackdate = 60 * time.Second
	// backendAddr is the address name given to the backend handshake.
	backendAddr = "127.0.0.1:22"
)

// backendExtensions are the permissions of the backend certificate
// (spec 9.3): those OpenSSH grants by default to authorized keys.
var backendExtensions = []string{
	"permit-pty",
	"permit-port-forwarding",
	"permit-agent-forwarding",
	"permit-X11-forwarding",
	"permit-user-rc",
}

// Sandbox states (spec 6.3 with the S7 deviation).
const (
	stateReady    = "ready"
	stateRunning  = "running" // spec 6.3 name of ready
	stateStopped  = "stopped"
	stateStopping = "stopping"
	stateCreating = "creating"
	stateStarting = "starting"
	stateResuming = "resuming" // spec 6.3 name of starting
)

var (
	// idPattern is the form of userId and apiKeyId (public format).
	idPattern = regexp.MustCompile(`^[A-Za-z0-9_]+$`)
	// loginUserPattern is the OS user of the VM: POSIX and Windows names.
	loginUserPattern = regexp.MustCompile(`^[A-Za-z0-9_][A-Za-z0-9_.-]{0,63}$`)
)

// backend is the gateway's SSH connection to the VM's sshd.
type backend struct {
	conn  ssh.Conn
	chans <-chan ssh.NewChannel
	reqs  <-chan *ssh.Request
	// via and owner describe the tunnel stream, for logs.
	via, owner string
	// hostKey is the FingerprintSHA256 of the sshd host key; a re-key may
	// set it again.
	hostKey atomic.Value // string
}

// HostKey returns the fingerprint of the sshd host key.
func (b *backend) HostKey() string {
	s, _ := b.hostKey.Load().(string)
	return s
}

// stateMessage returns the client message for a sandbox that cannot be
// reached in state, or "" when the state allows a dial.
func stateMessage(state, user string) string {
	switch state {
	case stateReady, stateRunning:
		return ""
	case stateStopped, stateStopping:
		return fmt.Sprintf("sbx: sandbox %s is stopped; run: sbx resume %s", user, user)
	case stateCreating, stateStarting, stateResuming:
		return fmt.Sprintf("sbx: sandbox %s is starting; try again in a moment", user)
	}
	return unavailableMessage(user)
}

func unavailableMessage(user string) string {
	return fmt.Sprintf("sbx: sandbox %s is unavailable", user)
}

func unreachableMessage(user string) string {
	return fmt.Sprintf("sbx: cannot reach sshd in sandbox %s", user)
}

// connectBackend dials port 22 of the sandbox and logs in to its sshd. When
// that is not possible it returns the message for the client instead.
func (ss *session) connectBackend(ctx context.Context) (*backend, string) {
	a := ss.id.Auth
	user := ss.conn.User()
	if msg := stateMessage(a.SandboxState, user); msg != "" {
		return nil, msg
	}
	if a.MachineID == "" {
		return nil, unavailableMessage(user)
	}
	if a.LoginUser == "" {
		ss.log.Error("sshgw: ssh/authorize gave no login user")
		return nil, unavailableMessage(user)
	}
	// The ids go into the backend certificate: refuse anything malformed.
	actorID := a.Actor.UserID
	if a.Actor.Kind == actorTeamKey {
		actorID = a.Actor.APIKeyID
	}
	if !idPattern.MatchString(actorID) || !loginUserPattern.MatchString(a.LoginUser) {
		ss.log.Error("sshgw: ssh/authorize gave malformed ids", "actor_id", actorID, "login_user", a.LoginUser)
		return nil, unavailableMessage(user)
	}
	cfg := ss.srv.cfg
	up, err := cfg.Dialer.Dial(ctx, a.MachineID, sshPort, cfg.DrainDeadline)
	if err != nil {
		ss.log.Info("sshgw: backend dial failed", "err", err)
		var ue *upstream.Error
		if errors.As(err, &ue) && ue.Code == upstream.CodeAgentUnavailable {
			return nil, unavailableMessage(user)
		}
		return nil, unreachableMessage(user)
	}
	b, err := ss.handshakeBackend(ctx, up, a.LoginUser)
	if err != nil {
		_ = up.Close()
		ss.log.Warn("sshgw: backend login failed", "err", err)
		return nil, unreachableMessage(user)
	}
	b.via, b.owner = up.Via, up.OwnerInstance
	return b, ""
}

// handshakeBackend runs the client handshake on the tunnel stream. The
// stream has no deadlines, so a timer and ctx close it instead.
func (ss *session) handshakeBackend(ctx context.Context, c net.Conn, loginUser string) (*backend, error) {
	signer, err := ss.srv.backendSigner(ss.id.actorKeyID()+":"+ss.sid, loginUser)
	if err != nil {
		return nil, err
	}
	b := &backend{}
	timer := time.AfterFunc(ss.srv.cfg.AuthTimeout, func() { _ = c.Close() })
	stop := context.AfterFunc(ctx, func() { _ = c.Close() })
	conn, chans, reqs, err := ssh.NewClientConn(c, backendAddr, &ssh.ClientConfig{
		User: loginUser,
		Auth: []ssh.AuthMethod{ssh.PublicKeys(signer)},
		// The stream is authenticated as this machine by the tunnel and the
		// VM host key changes on fork, so it is logged, not checked
		// (spec 9.3).
		HostKeyCallback: func(_ string, _ net.Addr, key ssh.PublicKey) error {
			b.hostKey.Store(ssh.FingerprintSHA256(key))
			return nil
		},
		ClientVersion: ServerVersion,
	})
	timedOut := !timer.Stop()
	cancelled := !stop()
	if err != nil {
		if timedOut {
			return nil, fmt.Errorf("backend handshake timed out: %w", err)
		}
		return nil, err
	}
	if timedOut || cancelled {
		_ = conn.Close()
		return nil, errors.New("backend handshake aborted")
	}
	ss.log.Info("sshgw: backend connected", "host_key", b.HostKey())
	b.conn, b.chans, b.reqs = conn, chans, reqs
	return b, nil
}

// backendSigner returns an ephemeral ed25519 key with a user certificate
// from the user CA for loginUser (spec 9.3). keyID is
// "user:<userId>:<sessionId>" or "key:<apiKeyId>:<sessionId>".
func (s *Server) backendSigner(keyID, loginUser string) (ssh.Signer, error) {
	_, priv, err := ed25519.GenerateKey(rand.Reader)
	if err != nil {
		return nil, err
	}
	key, err := ssh.NewSignerFromKey(priv)
	if err != nil {
		return nil, err
	}
	var serial [8]byte
	if _, err := rand.Read(serial[:]); err != nil {
		return nil, err
	}
	exts := make(map[string]string, len(backendExtensions))
	for _, e := range backendExtensions {
		exts[e] = ""
	}
	now := s.cfg.Now()
	cert := &ssh.Certificate{
		Key:             key.PublicKey(),
		Serial:          binary.BigEndian.Uint64(serial[:]),
		CertType:        ssh.UserCert,
		KeyId:           "sbx:" + keyID,
		ValidPrincipals: []string{loginUser},
		ValidAfter:      uint64(now.Add(-backendCertBackdate).Unix()),
		ValidBefore:     uint64(now.Add(s.cfg.BackendCertTTL).Unix()),
		Permissions:     ssh.Permissions{Extensions: exts},
	}
	if err := cert.SignCert(rand.Reader, s.cfg.UserCA); err != nil {
		return nil, fmt.Errorf("sshgw: sign backend certificate: %w", err)
	}
	return ssh.NewCertSigner(cert, key)
}
