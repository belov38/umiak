package sshgw_test

import (
	"context"
	"errors"
	"fmt"
	"net"
	"net/netip"
	"regexp"
	"slices"
	"strings"
	"testing"
	"time"

	proxyproto "github.com/pires/go-proxyproto"
	"golang.org/x/crypto/ssh"

	"github.com/belov38/boat-dev-clone/services/gateway/internal/config"
	"github.com/belov38/boat-dev-clone/services/gateway/internal/cpapi"
	"github.com/belov38/boat-dev-clone/services/gateway/internal/ratelimit"
	"github.com/belov38/boat-dev-clone/services/gateway/internal/testenv"
)

var sessionKeyID = regexp.MustCompile(`^sbx:(user|key):([A-Za-z0-9_]+):([0-9a-f]{16})$`)

func TestSSHUserKey(t *testing.T) {
	f := newFixture(t, nil)
	key := newSigner(t)
	f.allowKey(key.PublicKey(), f.userAuth("usr_1"))

	c := f.mustDial(t, f.slug, ssh.PublicKeys(key))
	if string(c.ServerVersion()) != "SSH-2.0-sbx-gateway" {
		t.Fatalf("server version %q", c.ServerVersion())
	}
	eventually(t, "one active session", func() bool { return f.inst.SSH().Sessions() == 1 })
	r := run(t, c, "echo hi")
	if r.err != nil || r.stdout != "hi\n" || r.exit != 0 {
		t.Fatalf("exec: %v", r)
	}
	if got := f.authMetric("ok"); got != 1 {
		t.Fatalf("ssh_auth_total{ok} = %v", got)
	}

	ids := f.sshd.KeyIDs()
	if len(ids) != 1 {
		t.Fatalf("sshd key ids %q", ids)
	}
	m := sessionKeyID.FindStringSubmatch(ids[0])
	if m == nil || m[1] != "user" || m[2] != "usr_1" {
		t.Fatalf("backend key id %q", ids[0])
	}

	// The backend certificate (spec 9.3).
	cert := f.sshd.Certs()[0]
	if !slices.Equal(cert.ValidPrincipals, []string{loginUser}) {
		t.Fatalf("principals %q", cert.ValidPrincipals)
	}
	now := time.Now().Unix()
	if va := int64(cert.ValidAfter); va > now-55 || va < now-70 {
		t.Fatalf("ValidAfter %d, now %d", va, now)
	}
	if vb := int64(cert.ValidBefore); vb < now+290 || vb > now+305 {
		t.Fatalf("ValidBefore %d, now %d", vb, now)
	}
	var exts []string
	for k := range cert.Extensions {
		exts = append(exts, k)
	}
	slices.Sort(exts)
	want := []string{"permit-X11-forwarding", "permit-agent-forwarding", "permit-port-forwarding", "permit-pty", "permit-user-rc"}
	if !slices.Equal(exts, want) {
		t.Fatalf("extensions %q", exts)
	}
	if len(cert.CriticalOptions) != 0 {
		t.Fatalf("critical options %v", cert.CriticalOptions)
	}

	// A second session on the same connection reuses the backend.
	if r := run(t, c, "echo again; exit 3"); r.stdout != "again\n" || r.exit != 3 {
		t.Fatalf("second exec: %v", r)
	}
	_ = c.Close()
	eventually(t, "the session to end", func() bool { return f.inst.SSH().Sessions() == 0 })
	if log := f.inst.AccessLog.String(); !strings.Contains(log, `"sessionId":"`+m[3]+`"`) || !strings.Contains(log, `"userId":"usr_1"`) {
		t.Fatalf("access log %s", log)
	}
}

func TestSSHCertLogin(t *testing.T) {
	f := newFixture(t, nil)
	var rec recorder
	auth := f.userAuth("")
	auth.Actor = cpapi.SSHActor{Kind: "team_key", APIKeyID: "key_1"}
	auth.UserID, auth.Email = "", ""
	f.env.API.SetSSH(func(r cpapi.SSHAuthorizeRequest) bool {
		rec.add(r)
		return r.Sandbox == f.slug && r.Certificate != nil && r.Certificate.Principal == "sb_x"
	}, auth)

	key := newSigner(t)
	validBefore := time.Now().Add(10 * time.Minute).Truncate(time.Second)
	signer := loginCert(t, f.env.Keys.LoginCA, key, func(c *ssh.Certificate) {
		c.ValidBefore = uint64(validBefore.Unix())
	})
	c := f.mustDial(t, f.slug, ssh.PublicKeys(signer))
	if r := run(t, c, "echo cert"); r.stdout != "cert\n" || r.exit != 0 {
		t.Fatalf("exec: %v", r)
	}

	reqs := rec.all()
	if len(reqs) == 0 {
		t.Fatal("api not called")
	}
	r := reqs[len(reqs)-1]
	if r.PublicKey != "" || r.Fingerprint != "" || r.Certificate == nil {
		t.Fatalf("request %v", r)
	}
	ci := *r.Certificate
	if ci.KeyID != "sbx:key:key_1" || ci.Serial != "12345" || ci.Principal != "sb_x" || !ci.ValidBefore.Equal(validBefore) {
		t.Fatalf("certificate fields %+v", ci)
	}
	ids := f.sshd.KeyIDs()
	if len(ids) != 1 {
		t.Fatalf("key ids %q", ids)
	}
	if m := sessionKeyID.FindStringSubmatch(ids[0]); m == nil || m[1] != "key" || m[2] != "key_1" {
		t.Fatalf("backend key id %q", ids[0])
	}
}

func TestSSHCertSkew(t *testing.T) {
	f := newFixture(t, nil)
	f.env.API.SetSSH(func(r cpapi.SSHAuthorizeRequest) bool { return r.Certificate != nil }, f.userAuth("usr_1"))
	now := time.Now()
	cases := map[string]struct {
		after, before time.Time
		ok            bool
	}{
		"not yet valid within skew":    {after: now.Add(30 * time.Second), before: now.Add(5 * time.Minute), ok: true},
		"expired within skew":          {after: now.Add(-5 * time.Minute), before: now.Add(-30 * time.Second), ok: true},
		"not yet valid beyond skew":    {after: now.Add(2 * time.Minute), before: now.Add(5 * time.Minute)},
		"expired beyond skew":          {after: now.Add(-5 * time.Minute), before: now.Add(-2 * time.Minute)},
		"valid before not after after": {after: now.Add(-time.Minute), before: now.Add(-time.Minute)},
		"validity of exactly 24 h":     {after: now.Add(-time.Minute), before: now.Add(24*time.Hour - time.Minute), ok: true},
	}
	for name, tc := range cases {
		t.Run(name, func(t *testing.T) {
			s := loginCert(t, f.env.Keys.LoginCA, newSigner(t), func(c *ssh.Certificate) {
				c.ValidAfter, c.ValidBefore = uint64(tc.after.Unix()), uint64(tc.before.Unix())
			})
			_, err := f.dial(f.slug, ssh.PublicKeys(s))
			if (err == nil) != tc.ok {
				t.Fatalf("dial err = %v, want ok=%v", err, tc.ok)
			}
		})
	}
}

func TestSSHCertRejects(t *testing.T) {
	// High per-IP SSH limits: a blocked IP would refuse every later case
	// before api, whatever its certificate.
	f := newFixture(t, func(c *config.Config) {
		c.RateLimit.SSHAuthFailPerMin = 1000
		c.RateLimit.SSHConnPerMin, c.RateLimit.SSHConnBurst = 1000, 1000
	})
	f.env.API.SetSSH(func(r cpapi.SSHAuthorizeRequest) bool {
		return r.Certificate != nil && r.Certificate.Principal == "sb_x"
	}, f.userAuth("usr_1"))
	foreign := newSigner(t)
	cases := []struct {
		name    string
		ca      ssh.Signer
		mod     func(*ssh.Certificate)
		apiCall bool
	}{
		{name: "foreign CA", ca: foreign},
		{name: "expired", mod: func(c *ssh.Certificate) {
			c.ValidAfter = uint64(time.Now().Add(-time.Hour).Unix())
			c.ValidBefore = uint64(time.Now().Add(-61 * time.Second).Unix())
		}},
		{name: "two principals", mod: func(c *ssh.Certificate) { c.ValidPrincipals = []string{"sb_x", "sb_y"} }},
		{name: "no principal", mod: func(c *ssh.Certificate) { c.ValidPrincipals = nil }},
		{name: "other sandbox", mod: func(c *ssh.Certificate) { c.ValidPrincipals = []string{"sb_other"} }, apiCall: true},
		{name: "bad key id", mod: func(c *ssh.Certificate) { c.KeyId = "sbx:admin:x" }},
		{name: "key id with session suffix", mod: func(c *ssh.Certificate) { c.KeyId = "sbx:user:usr_1:abc" }},
		{name: "host cert", mod: func(c *ssh.Certificate) { c.CertType = ssh.HostCert }},
		{name: "critical option", mod: func(c *ssh.Certificate) {
			c.CriticalOptions = map[string]string{"force-command": "/bin/true"}
		}},
		{name: "infinite validity", mod: func(c *ssh.Certificate) { c.ValidBefore = ssh.CertTimeInfinity }},
		{name: "validity over 24 h", mod: func(c *ssh.Certificate) {
			c.ValidAfter = uint64(time.Now().Add(-time.Minute).Unix())
			c.ValidBefore = uint64(time.Now().Add(24 * time.Hour).Unix())
		}},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			ca := tc.ca
			if ca == nil {
				ca = f.env.Keys.LoginCA
			}
			before := f.env.API.Calls("AuthorizeSSH")
			s := loginCert(t, ca, newSigner(t), tc.mod)
			if _, err := f.dial(f.slug, ssh.PublicKeys(s)); err == nil {
				t.Fatal("login allowed")
			}
			called := f.env.API.Calls("AuthorizeSSH") > before
			if called != tc.apiCall {
				t.Fatalf("api called = %v, want %v", called, tc.apiCall)
			}
		})
	}
}

func TestSSHUnknownKey(t *testing.T) {
	f := newFixture(t, func(c *config.Config) { c.RateLimit.SSHAuthFailPerMin = 2 })
	key := newSigner(t)
	for i := range 2 {
		if _, err := f.dial(f.slug, ssh.PublicKeys(key)); err == nil {
			t.Fatalf("dial %d: unknown key allowed", i)
		}
		eventually(t, "the failure metric", func() bool { return f.authMetric("fail") == float64(i+1) })
	}
	if got := f.authMetric("ok"); got != 0 {
		t.Fatalf("ssh_auth_total{ok} = %v", got)
	}
	// The IP is now blocked: closed before the version exchange.
	if v, err := f.rawVersion(); err == nil {
		t.Fatalf("blocked IP got %q", v)
	}
	if got := f.limitedMetric(ratelimit.LimitSSHAuth); got != 1 {
		t.Fatalf("ratelimited_total{ssh_auth_fail} = %v", got)
	}
}

func TestSSHAPIDown(t *testing.T) {
	f := newFixture(t, nil)
	key := newSigner(t)
	f.allowKey(key.PublicKey(), f.userAuth("usr_1"))
	f.env.API.SetDown(true)
	if _, err := f.dial(f.slug, ssh.PublicKeys(key)); err == nil {
		t.Fatal("login allowed with the api down")
	}
}

func TestSSHPasswordRefused(t *testing.T) {
	f := newFixture(t, nil)
	f.env.API.SetSSH(func(cpapi.SSHAuthorizeRequest) bool { return true }, f.userAuth("usr_1"))
	_, err := f.dial(f.slug, ssh.Password("secret"), ssh.KeyboardInteractive(
		func(string, string, []string, []bool) ([]string, error) { return nil, nil }))
	if err == nil {
		t.Fatal("password login allowed")
	}
	// The server offers publickey only, so the client has nothing to try.
	if !strings.Contains(err.Error(), "no supported methods remain") {
		t.Fatalf("err = %v", err)
	}
	if got := f.authMetric("fail"); got != 0 {
		t.Fatalf("a conn without an auth attempt counted as a failure: %v", got)
	}

	// A client that insists on password and keyboard-interactive is
	// refused, and the conn counts as an authentication failure.
	methods := []ssh.AuthMethod{
		ssh.Password("secret"),
		ssh.KeyboardInteractive(func(string, string, []string, []bool) ([]string, error) { return nil, nil }),
	}
	_, err = f.dialConfig(&ssh.ClientConfig{
		User: f.slug,
		AuthCallback: func(*ssh.ClientAuthContext) (ssh.AuthMethod, error) {
			if len(methods) == 0 {
				return nil, errors.New("no more methods")
			}
			m := methods[0]
			methods = methods[1:]
			return m, nil
		},
	})
	if err == nil {
		t.Fatal("forced password login allowed")
	}
	eventually(t, "the failure metric", func() bool { return f.authMetric("fail") == 1 })
	if n := f.env.API.Calls("AuthorizeSSH"); n != 0 {
		t.Fatalf("api called %d times", n)
	}
}

func TestSSHPlusUser(t *testing.T) {
	f := newFixture(t, nil)
	key := newSigner(t)
	f.env.API.SetSSH(func(cpapi.SSHAuthorizeRequest) bool { return true }, f.userAuth("usr_1"))
	if _, err := f.dial(f.slug+"+root", ssh.PublicKeys(key)); err == nil {
		t.Fatal("user with + allowed")
	}
	if n := f.env.API.Calls("AuthorizeSSH"); n != 0 {
		t.Fatalf("api called %d times", n)
	}
}

func TestSSHStopped(t *testing.T) {
	f := newFixture(t, nil)
	stopped := "sbx: sandbox " + f.slug + " is stopped; run: sbx resume " + f.slug + "\r\n"
	starting := "sbx: sandbox " + f.slug + " is starting; try again in a moment\r\n"
	unavailable := "sbx: sandbox " + f.slug + " is unavailable\r\n"
	unreachable := "sbx: cannot reach sshd in sandbox " + f.slug + "\r\n"
	noSSHD := f.env.NewMachine() // nothing listens on 22
	cases := []struct {
		name string
		mod  func(*cpapi.SSHAuthorization)
		want string
	}{
		{"stopped", func(a *cpapi.SSHAuthorization) { a.SandboxState = "stopped"; a.MachineID = "" }, stopped},
		{"stopping", func(a *cpapi.SSHAuthorization) { a.SandboxState = "stopping" }, stopped},
		{"starting", func(a *cpapi.SSHAuthorization) { a.SandboxState = "starting"; a.MachineID = "" }, starting},
		{"resuming", func(a *cpapi.SSHAuthorization) { a.SandboxState = "resuming" }, starting},
		{"deleted", func(a *cpapi.SSHAuthorization) { a.SandboxState = "deleted" }, unavailable},
		{"ready without machine", func(a *cpapi.SSHAuthorization) { a.MachineID = "" }, unavailable},
		{"agent unavailable", func(a *cpapi.SSHAuthorization) { a.MachineID = "00000000-0000-0000-0000-000000000000" }, unavailable},
		{"no sshd", func(a *cpapi.SSHAuthorization) { a.MachineID = noSSHD.ID }, unreachable},
		// Malformed ids from api never reach a backend certificate.
		{"bad login user", func(a *cpapi.SSHAuthorization) { a.LoginUser = "sbx,root" }, unavailable},
		{"bad user id", func(a *cpapi.SSHAuthorization) { a.Actor.UserID = "usr_1:x" }, unavailable},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			key := newSigner(t)
			auth := f.userAuth("usr_1")
			tc.mod(&auth)
			f.allowKey(key.PublicKey(), auth)
			c := f.mustDial(t, f.slug, ssh.PublicKeys(key))

			// Other channel types are refused.
			if _, _, err := c.OpenChannel("direct-tcpip", ssh.Marshal(struct {
				Host     string
				Port     uint32
				OrigHost string
				OrigPort uint32
			}{"127.0.0.1", 80, "127.0.0.1", 1})); err == nil {
				t.Fatal("direct-tcpip accepted in stopped mode")
			}

			s, err := c.NewSession()
			if err != nil {
				t.Fatal(err)
			}
			if err := s.RequestPty("xterm", 24, 80, ssh.TerminalModes{}); err != nil {
				t.Fatalf("pty-req: %v", err)
			}
			var out, errb strings.Builder
			s.Stdout, s.Stderr = &out, &errb
			err = s.Run("echo hi")
			var ee *ssh.ExitError
			if !errors.As(err, &ee) || ee.ExitStatus() != 255 {
				t.Fatalf("run: %v", err)
			}
			if errb.String() != tc.want || out.String() != "" {
				t.Fatalf("stderr %q stdout %q, want %q", errb.String(), out.String(), tc.want)
			}
			// The gateway closes the connection after the first session.
			done := make(chan error, 1)
			go func() { done <- c.Wait() }()
			select {
			case err := <-done:
				t.Logf("conn closed: %v", err)
			case <-time.After(testenv.WaitTimeout):
				t.Fatal("connection not closed")
			}
		})
	}
	if n := len(f.sshd.KeyIDs()); n != 0 {
		t.Fatalf("sshd saw %d logins", n)
	}
}

func TestSSHIdentityFromVerifiedKey(t *testing.T) {
	f := newFixture(t, nil)
	keyA, keyB := newSigner(t), newSigner(t)
	f.allowKey(keyA.PublicKey(), f.userAuth("usr_a"))
	f.allowKey(keyB.PublicKey(), f.userAuth("usr_b"))

	// Key A is only queried: its signer fails, so no signed request for
	// A is ever sent. AuthCallback runs before Auth, so it offers both.
	methods := []ssh.AuthMethod{ssh.PublicKeys(failingSigner{keyA}), ssh.PublicKeys(keyB)}
	c, err := f.dialConfig(&ssh.ClientConfig{
		User: f.slug,
		AuthCallback: func(*ssh.ClientAuthContext) (ssh.AuthMethod, error) {
			if len(methods) == 0 {
				return nil, nil
			}
			m := methods[0]
			methods = methods[1:]
			return m, nil
		},
	})
	if err != nil {
		t.Fatalf("dial: %v", err)
	}
	if n := f.env.API.Calls("AuthorizeSSH"); n < 2 {
		t.Fatalf("api called %d times; key A was not queried", n)
	}
	if r := run(t, c, "echo b"); r.stdout != "b\n" {
		t.Fatalf("exec: %v", r)
	}
	ids := f.sshd.KeyIDs()
	if len(ids) != 1 {
		t.Fatalf("key ids %q", ids)
	}
	if m := sessionKeyID.FindStringSubmatch(ids[0]); m == nil || m[2] != "usr_b" {
		t.Fatalf("backend key id %q, want usr_b", ids[0])
	}
}

func TestSSHConnRateLimit(t *testing.T) {
	f := newFixture(t, func(c *config.Config) {
		c.RateLimit.SSHConnPerMin = 1
		c.RateLimit.SSHConnBurst = 2
	})
	for i := range 2 {
		v, err := f.rawVersion()
		if err != nil || !strings.HasPrefix(v, "SSH-2.0-sbx-gateway") {
			t.Fatalf("conn %d: %q %v", i, v, err)
		}
	}
	if v, err := f.rawVersion(); err == nil {
		t.Fatalf("third conn got %q", v)
	}
	if got := f.limitedMetric(ratelimit.LimitSSHConn); got != 1 {
		t.Fatalf("ratelimited_total{ssh_conn} = %v", got)
	}
}

// TestSSHManyExecs runs back-to-back short sessions: the backend answers
// exec, sends the exit status and closes at once, and the client must still
// get the exec reply before the close.
func TestSSHManyExecs(t *testing.T) {
	f := newFixture(t, nil)
	key := newSigner(t)
	f.allowKey(key.PublicKey(), f.userAuth("usr_1"))
	c := f.mustDial(t, f.slug, ssh.PublicKeys(key))
	for i := range 100 {
		want := fmt.Sprintf("n%d\n", i)
		if r := run(t, c, fmt.Sprintf("echo n%d; stderr e; exit %d", i, i%7)); r.stdout != want || r.stderr != "err\ne\n" || r.exit != i%7 {
			t.Fatalf("exec %d: %v", i, r)
		}
	}
}

// TestSSHProxyProtocol: behind the L4 balancer the client IP comes from the
// PROXY v2 header (rate limits and the SSH log use it).
func TestSSHProxyProtocol(t *testing.T) {
	f := newFixture(t, func(c *config.Config) {
		c.ProxyProtocol = true
		c.ProxyProtocolCIDRs = []netip.Prefix{netip.MustParsePrefix("127.0.0.1/32")}
	})
	key := newSigner(t)
	f.allowKey(key.PublicKey(), f.userAuth("usr_1"))

	ctx, cancel := context.WithTimeout(context.Background(), testenv.WaitTimeout)
	defer cancel()
	raw, err := (&net.Dialer{}).DialContext(ctx, "tcp", f.inst.SSHAddr)
	if err != nil {
		t.Fatal(err)
	}
	defer func() { _ = raw.Close() }()
	h := proxyproto.HeaderProxyFromAddrs(2,
		&net.TCPAddr{IP: net.ParseIP("203.0.113.7"), Port: 40000},
		&net.TCPAddr{IP: net.ParseIP("10.0.0.1"), Port: 2222})
	if _, err := h.WriteTo(raw); err != nil {
		t.Fatal(err)
	}
	sc, chans, reqs, err := ssh.NewClientConn(raw, f.inst.SSHAddr, &ssh.ClientConfig{
		User:            f.slug,
		Auth:            []ssh.AuthMethod{ssh.PublicKeys(key)},
		HostKeyCallback: ssh.FixedHostKey(f.env.Keys.SSHHost.PublicKey()),
	})
	if err != nil {
		t.Fatal(err)
	}
	c := ssh.NewClient(sc, chans, reqs)
	if r := run(t, c, "echo pp"); r.stdout != "pp\n" {
		t.Fatalf("exec: %v", r)
	}
	_ = c.Close()
	eventually(t, "the SSH log line", func() bool {
		return strings.Contains(f.inst.AccessLog.String(), `"clientIp":"203.0.113.7"`)
	})
}
