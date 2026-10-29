package sshgw

import (
	"bytes"
	"context"
	"crypto/ed25519"
	"crypto/rand"
	"errors"
	"log/slog"
	"math"
	"strings"
	"sync"
	"testing"
	"time"

	"golang.org/x/crypto/ssh"

	"github.com/belov38/boat-dev-clone/services/gateway/internal/cpapi"
)

// syncBuffer is a bytes.Buffer safe for concurrent log writes.
type syncBuffer struct {
	mu sync.Mutex
	b  bytes.Buffer
}

func (s *syncBuffer) Write(p []byte) (int, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	return s.b.Write(p)
}

func (s *syncBuffer) String() string {
	s.mu.Lock()
	defer s.mu.Unlock()
	return s.b.String()
}

// fakeMeta is the ssh.ConnMetadata of an authentication attempt.
type fakeMeta struct {
	ssh.ConnMetadata
	user string
}

func (m fakeMeta) User() string { return m.user }

// TestLoginCertMaxValidity: a login certificate valid for longer than
// LoginCertMaxValidity is refused before api is called, with a clear log.
func TestLoginCertMaxValidity(t *testing.T) {
	newKey := func() ssh.Signer {
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
	ca := newKey()
	var logs syncBuffer
	calls := 0
	now := time.Unix(1_800_000_000, 0)
	s := newUnitServer(t, func(c *Config) {
		c.LoginCAKeys = []ssh.PublicKey{ca.PublicKey()}
		c.LoginCertMaxValidity = time.Hour
		c.Now = func() time.Time { return now }
		c.Logger = slog.New(slog.NewTextHandler(&logs, &slog.HandlerOptions{Level: slog.LevelDebug}))
		c.API = apiFunc(func(context.Context, cpapi.SSHAuthorizeRequest) (cpapi.SSHAuthorization, error) {
			calls++
			return cpapi.SSHAuthorization{}, nil
		})
	})
	cert := func(validFor time.Duration) *ssh.Certificate {
		c := &ssh.Certificate{
			Key:             newKey().PublicKey(),
			Serial:          7,
			CertType:        ssh.UserCert,
			KeyId:           "sbx:user:usr_1",
			ValidPrincipals: []string{"sb_x"},
			ValidAfter:      uint64(now.Add(-time.Minute).Unix()),
			ValidBefore:     uint64(now.Add(-time.Minute + validFor).Unix()),
		}
		if err := c.SignCert(rand.Reader, ca); err != nil {
			t.Fatal(err)
		}
		return c
	}
	if err := s.checkLoginCert(cert(time.Hour)); err != nil {
		t.Fatalf("a certificate valid for exactly the cap: %v", err)
	}
	if _, err := s.authenticate(context.Background(), fakeMeta{user: "quiet-otter"}, cert(time.Hour+time.Second)); err == nil {
		t.Fatal("a certificate over the validity cap was accepted")
	}
	// A validity too long for a Duration does not overflow the check.
	huge := cert(time.Hour)
	huge.ValidAfter, huge.ValidBefore = 0, math.MaxInt64
	if err := s.checkLoginCert(huge); !errors.Is(err, errCertTooLong) {
		t.Fatalf("a validity of MaxInt64 s: %v", err)
	}
	if calls != 0 {
		t.Fatalf("api called %d times", calls)
	}
	if l := logs.String(); !strings.Contains(l, "validity 1h0m1s exceeds the maximum 1h0m0s") || !strings.Contains(l, "level=WARN") {
		t.Fatalf("log %q has no clear reason", l)
	}
}
