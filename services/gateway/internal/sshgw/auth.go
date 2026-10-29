package sshgw

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"math"
	"regexp"
	"strconv"
	"strings"
	"time"

	"golang.org/x/crypto/ssh"

	"github.com/belov38/boat-dev-clone/services/gateway/internal/cpapi"
)

// extAuth is the Permissions extension that carries the identity of an
// authenticated connection. It is only ever read from the Permissions of
// the ServerConn, which x/crypto takes from the key that passed the
// signature check (CVE-2024-45337).
const extAuth = "sbx-auth"

// Authentication methods recorded in an identity.
const (
	MethodKey  = "key"
	MethodCert = "cert"
)

// Actor kinds of ssh/authorize.
const (
	actorUser    = "user"
	actorTeamKey = "team_key"
)

// maxUserLen bounds the SSH user name (a sandbox slug or id).
const maxUserLen = 128

// loginKeyID is the KeyId form of login certificates (spec 9.2).
var loginKeyID = regexp.MustCompile(`^sbx:(user|key):[A-Za-z0-9_]+$`)

var (
	errRefused     = errors.New("sshgw: access denied")
	errUnavailable = errors.New("sshgw: authorization unavailable")
)

// identity is the result of a successful authentication.
type identity struct {
	// Method is MethodKey or MethodCert.
	Method      string `json:"method"`
	Fingerprint string `json:"fingerprint,omitempty"`
	CertSerial  uint64 `json:"certSerial,omitempty"`
	// Request is the ssh/authorize request, kept for rechecks.
	Request cpapi.SSHAuthorizeRequest `json:"request"`
	Auth    cpapi.SSHAuthorization    `json:"auth"`
}

// actorKeyID returns the actor part of the backend certificate KeyId:
// "user:<userId>" or "key:<apiKeyId>".
func (id identity) actorKeyID() string {
	if id.Auth.Actor.Kind == actorTeamKey {
		return "key:" + id.Auth.Actor.APIKeyID
	}
	return "user:" + id.Auth.Actor.UserID
}

func identityFrom(p *ssh.Permissions) (identity, error) {
	var id identity
	if p == nil {
		return id, errors.New("sshgw: no permissions")
	}
	raw, ok := p.Extensions[extAuth]
	if !ok {
		return id, errors.New("sshgw: no identity extension")
	}
	if err := json.Unmarshal([]byte(raw), &id); err != nil {
		return id, fmt.Errorf("sshgw: identity: %w", err)
	}
	return id, nil
}

// authenticate is the PublicKeyCallback. It is called for key queries too;
// the identity it returns is only used once x/crypto verified the
// signature of that same key.
func (s *Server) authenticate(ctx context.Context, meta ssh.ConnMetadata, key ssh.PublicKey) (*ssh.Permissions, error) {
	user := meta.User()
	// <sandbox>+<osuser> is reserved (spec 9.2).
	if user == "" || len(user) > maxUserLen || strings.ContainsAny(user, "+") {
		return nil, errRefused
	}
	id := identity{Request: cpapi.SSHAuthorizeRequest{Sandbox: user}}
	if cert, ok := key.(*ssh.Certificate); ok {
		if err := s.checkLoginCert(cert); err != nil {
			s.log.Debug("sshgw: login certificate refused", "user", user, "key_id", cert.KeyId, "serial", cert.Serial, "err", err)
			return nil, errRefused
		}
		id.Method = MethodCert
		id.CertSerial = cert.Serial
		id.Request.Certificate = &cpapi.SSHCertInfo{
			KeyID:       cert.KeyId,
			Serial:      strconv.FormatUint(cert.Serial, 10),
			Principal:   cert.ValidPrincipals[0],
			ValidBefore: time.Unix(int64(cert.ValidBefore), 0).UTC(),
		}
	} else {
		id.Method = MethodKey
		id.Fingerprint = ssh.FingerprintSHA256(key)
		id.Request.PublicKey = strings.TrimSpace(string(ssh.MarshalAuthorizedKey(key)))
		id.Request.Fingerprint = id.Fingerprint
	}

	actx, cancel := context.WithTimeout(ctx, s.cfg.AuthTimeout)
	defer cancel()
	auth, err := s.cfg.API.AuthorizeSSH(actx, id.Request)
	if err != nil {
		s.log.Warn("sshgw: ssh/authorize failed", "user", user, "err", err)
		return nil, errUnavailable
	}
	if !auth.Allowed {
		return nil, errRefused
	}
	switch {
	case auth.Actor.Kind == actorUser && auth.Actor.UserID != "":
	case auth.Actor.Kind == actorTeamKey && auth.Actor.APIKeyID != "":
	default:
		s.log.Error("sshgw: ssh/authorize allowed without a valid actor", "user", user, "actor_kind", auth.Actor.Kind)
		return nil, errUnavailable
	}
	id.Auth = auth
	b, err := json.Marshal(id)
	if err != nil {
		return nil, err
	}
	return &ssh.Permissions{Extensions: map[string]string{extAuth: string(b)}}, nil
}

// checkLoginCert verifies a client certificate (spec 9.2): a user cert
// from a login CA, exactly one principal, valid now within the clock skew
// on both bounds, a supported KeyId and no critical options.
func (s *Server) checkLoginCert(cert *ssh.Certificate) error {
	if cert.CertType != ssh.UserCert {
		return fmt.Errorf("certificate type %d", cert.CertType)
	}
	if !s.isLoginCA(cert.SignatureKey) {
		return errors.New("unknown certificate authority")
	}
	if len(cert.ValidPrincipals) != 1 {
		return fmt.Errorf("%d principals", len(cert.ValidPrincipals))
	}
	if !loginKeyID.MatchString(cert.KeyId) {
		return errors.New("unsupported key id")
	}
	// Login certificates live minutes; an unbounded one is not ours.
	if cert.ValidBefore > math.MaxInt64 || cert.ValidAfter > math.MaxInt64 {
		return errors.New("unbounded validity")
	}
	after, before := int64(cert.ValidAfter), int64(cert.ValidBefore)
	if after >= before {
		return errors.New("empty validity")
	}
	now := s.cfg.Now().Unix()
	skew := int64(s.cfg.ClockSkew / time.Second)
	if now+skew < after {
		return errors.New("certificate is not yet valid")
	}
	if now-skew >= before {
		return errors.New("certificate has expired")
	}
	// CheckCert verifies the signature, the principal and the critical
	// options (none are supported). Its time check runs at an instant
	// inside the validity, so the skew above is what applies.
	at := min(max(now, after), before-1)
	checker := &ssh.CertChecker{Clock: func() time.Time { return time.Unix(at, 0) }}
	return checker.CheckCert(cert.ValidPrincipals[0], cert)
}

func (s *Server) isLoginCA(k ssh.PublicKey) bool {
	b := k.Marshal()
	for _, ca := range s.loginCAs {
		if bytes.Equal(ca, b) {
			return true
		}
	}
	return false
}
