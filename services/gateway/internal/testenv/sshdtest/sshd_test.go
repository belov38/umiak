package sshdtest_test

import (
	"crypto/ed25519"
	"crypto/rand"
	"net"
	"testing"
	"time"

	"golang.org/x/crypto/ssh"

	"github.com/belov38/umiak/services/gateway/internal/testenv/sshdtest"
)

func signer(t *testing.T) ssh.Signer {
	t.Helper()
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

// login tries a certificate with principals against a fresh double.
func login(t *testing.T, principals []string) error {
	t.Helper()
	ca, key := signer(t), signer(t)
	srv := sshdtest.New(t, ca.PublicKey(), "umiak")
	now := time.Now()
	cert := &ssh.Certificate{
		Key:             key.PublicKey(),
		CertType:        ssh.UserCert,
		KeyId:           "test",
		ValidPrincipals: principals,
		ValidAfter:      uint64(now.Add(-time.Minute).Unix()),
		ValidBefore:     uint64(now.Add(time.Minute).Unix()),
	}
	if err := cert.SignCert(rand.Reader, ca); err != nil {
		t.Fatal(err)
	}
	cs, err := ssh.NewCertSigner(cert, key)
	if err != nil {
		t.Fatal(err)
	}
	// net.Pipe is unbuffered and both sides send their version first, so
	// a loopback TCP pair is used.
	ln, err := (&net.ListenConfig{}).Listen(t.Context(), "tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatal(err)
	}
	defer func() { _ = ln.Close() }()
	done := make(chan struct{})
	go func() {
		defer close(done)
		b, err := ln.Accept()
		if err != nil {
			return
		}
		defer func() { _ = b.Close() }()
		srv.ServeConn(b)
	}()
	a, err := (&net.Dialer{Timeout: 5 * time.Second}).DialContext(t.Context(), "tcp", ln.Addr().String())
	if err != nil {
		t.Fatal(err)
	}
	defer func() {
		_ = a.Close()
		<-done
	}()
	c, _, _, err := ssh.NewClientConn(a, "sshd", &ssh.ClientConfig{
		User:            "umiak",
		Auth:            []ssh.AuthMethod{ssh.PublicKeys(cs)},
		HostKeyCallback: ssh.FixedHostKey(srv.HostKey()),
	})
	if err == nil {
		_ = c.Close()
	}
	return err
}

func TestCertPrincipals(t *testing.T) {
	if err := login(t, []string{"umiak"}); err != nil {
		t.Fatalf("valid certificate refused: %v", err)
	}
	if err := login(t, nil); err == nil {
		t.Fatal("certificate without principals accepted")
	}
	if err := login(t, []string{"other"}); err == nil {
		t.Fatal("certificate for another user accepted")
	}
}
