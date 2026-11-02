package sshgw_test

import (
	"bytes"
	"context"
	"crypto/ed25519"
	"crypto/rand"
	"errors"
	"fmt"
	"io"
	"net"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/prometheus/client_golang/prometheus/testutil"
	"golang.org/x/crypto/ssh"

	"github.com/belov38/umiak/libs/tunnel/tunneltest/pgtest"
	"github.com/belov38/umiak/services/gateway/internal/config"
	"github.com/belov38/umiak/services/gateway/internal/cpapi"
	"github.com/belov38/umiak/services/gateway/internal/testenv"
	"github.com/belov38/umiak/services/gateway/internal/testenv/sshdtest"
)

func TestMain(m *testing.M) { pgtest.Main(m) }

// loginUser is the OS user of every test sandbox.
const loginUser = "umiak"

// fixture is one gateway instance with one machine that runs the sshd
// double on port 22.
type fixture struct {
	env  *testenv.Env
	inst *testenv.Inst
	m    *testenv.Machine
	sshd *sshdtest.Server
	slug string
}

func newFixture(t *testing.T, mod func(*config.Config)) *fixture {
	t.Helper()
	env := testenv.New(t, testenv.Options{})
	inst := env.StartInstance(mod)
	m := env.NewMachine()
	sshd := sshdtest.New(t, env.Keys.UserCA.PublicKey(), loginUser)
	m.ServeSSHD(sshd)
	return &fixture{env: env, inst: inst, m: m, sshd: sshd, slug: "quiet-otter-lamp"}
}

// userAuth is an allowed answer for a user actor on the fixture machine.
func (f *fixture) userAuth(userID string) cpapi.SSHAuthorization {
	return cpapi.SSHAuthorization{
		Allowed:      true,
		Actor:        cpapi.SSHActor{Kind: "user", UserID: userID, Email: userID + "@example.com"},
		UserID:       userID,
		Email:        userID + "@example.com",
		SandboxID:    "sb_x",
		MachineID:    f.m.ID,
		SandboxState: "ready",
		LoginUser:    loginUser,
		TeamID:       "team_1",
	}
}

// allowKey makes the fake allow key for the fixture sandbox as auth.
func (f *fixture) allowKey(key ssh.PublicKey, auth cpapi.SSHAuthorization) {
	line := authorizedKey(key)
	f.env.API.SetSSH(func(r cpapi.SSHAuthorizeRequest) bool {
		return r.Sandbox == f.slug && r.PublicKey == line
	}, auth)
}

func authorizedKey(k ssh.PublicKey) string {
	return strings.TrimSpace(string(ssh.MarshalAuthorizedKey(k)))
}

func newSigner(t *testing.T) ssh.Signer {
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

// dial connects an x/crypto client to the SSH listener of the fixture
// instance as user.
func (f *fixture) dial(user string, auth ...ssh.AuthMethod) (*ssh.Client, error) {
	return f.dialConfig(&ssh.ClientConfig{User: user, Auth: auth})
}

func (f *fixture) dialConfig(cfg *ssh.ClientConfig) (*ssh.Client, error) {
	cfg.HostKeyCallback = ssh.FixedHostKey(f.env.Keys.SSHHost.PublicKey())
	cfg.Timeout = testenv.WaitTimeout
	c, err := ssh.Dial("tcp", f.inst.SSHAddr, cfg)
	if err != nil {
		return nil, err
	}
	f.env.T.Cleanup(func() { _ = c.Close() })
	return c, nil
}

func (f *fixture) mustDial(t *testing.T, user string, auth ...ssh.AuthMethod) *ssh.Client {
	t.Helper()
	c, err := f.dial(user, auth...)
	if err != nil {
		t.Fatalf("ssh dial: %v", err)
	}
	return c
}

// result is the outcome of one exec.
type result struct {
	stdout, stderr string
	exit           int
	err            error
}

func (r result) String() string {
	return fmt.Sprintf("stdout %q stderr %q exit %d err %v", r.stdout, r.stderr, r.exit, r.err)
}

// run executes cmd on a new session channel. A missing exit status is
// reported as exit -1 with the error.
func run(t *testing.T, c *ssh.Client, cmd string) result {
	t.Helper()
	s, err := c.NewSession()
	if err != nil {
		t.Fatalf("new session: %v", err)
	}
	defer func() { _ = s.Close() }()
	var out, errb bytes.Buffer
	s.Stdout, s.Stderr = &out, &errb
	err = s.Run(cmd)
	r := result{stdout: out.String(), stderr: errb.String(), err: err}
	var ee *ssh.ExitError
	switch {
	case err == nil:
	case errors.As(err, &ee):
		r.exit = ee.ExitStatus()
		r.err = nil
	default:
		r.exit = -1
	}
	return r
}

// loginCert issues a user certificate for key signed by ca. mod may change
// it before signing.
func loginCert(t *testing.T, ca, key ssh.Signer, mod func(*ssh.Certificate)) ssh.Signer {
	t.Helper()
	now := time.Now()
	cert := &ssh.Certificate{
		Key:             key.PublicKey(),
		Serial:          12345,
		CertType:        ssh.UserCert,
		KeyId:           "umiak:key:key_1",
		ValidPrincipals: []string{"sb_x"},
		ValidAfter:      uint64(now.Add(-time.Minute).Unix()),
		ValidBefore:     uint64(now.Add(10 * time.Minute).Unix()),
	}
	if mod != nil {
		mod(cert)
	}
	if err := cert.SignCert(rand.Reader, ca); err != nil {
		t.Fatal(err)
	}
	s, err := ssh.NewCertSigner(cert, key)
	if err != nil {
		t.Fatal(err)
	}
	return s
}

// failingSigner offers a key but cannot sign: the client only sends the
// query for it.
type failingSigner struct{ ssh.Signer }

func (failingSigner) Sign(io.Reader, []byte) (*ssh.Signature, error) {
	return nil, errors.New("test: signing disabled")
}

// recorder keeps the SSH authorization requests the fake saw.
type recorder struct {
	mu   sync.Mutex
	reqs []cpapi.SSHAuthorizeRequest
}

func (r *recorder) add(req cpapi.SSHAuthorizeRequest) {
	r.mu.Lock()
	defer r.mu.Unlock()
	r.reqs = append(r.reqs, req)
}

func (r *recorder) all() []cpapi.SSHAuthorizeRequest {
	r.mu.Lock()
	defer r.mu.Unlock()
	return append([]cpapi.SSHAuthorizeRequest(nil), r.reqs...)
}

func eventually(t *testing.T, what string, cond func() bool) {
	t.Helper()
	deadline := time.Now().Add(testenv.WaitTimeout)
	for !cond() {
		if time.Now().After(deadline) {
			t.Fatalf("timed out waiting for %s", what)
		}
		time.Sleep(5 * time.Millisecond)
	}
}

func (f *fixture) authMetric(result string) float64 {
	return testutil.ToFloat64(f.inst.Metrics().SSHAuth.WithLabelValues(result))
}

func (f *fixture) limitedMetric(limit string) float64 {
	return testutil.ToFloat64(f.inst.Metrics().RateLimited.WithLabelValues(limit))
}

// rawVersion dials the SSH listener and reads the server version line; it
// fails when the server closes the conn before the handshake.
func (f *fixture) rawVersion() (string, error) {
	ctx, cancel := context.WithTimeout(context.Background(), testenv.WaitTimeout)
	defer cancel()
	c, err := (&net.Dialer{}).DialContext(ctx, "tcp", f.inst.SSHAddr)
	if err != nil {
		return "", err
	}
	defer func() { _ = c.Close() }()
	_ = c.SetDeadline(time.Now().Add(testenv.WaitTimeout))
	buf := make([]byte, 64)
	n, err := c.Read(buf)
	if n > 0 {
		return string(buf[:n]), nil
	}
	return "", err
}
