package e2e_test

import (
	"crypto/ed25519"
	"crypto/rand"
	"encoding/json"
	"net/http"
	"net/url"
	"strings"
	"sync"
	"testing"
	"time"

	"golang.org/x/crypto/ssh"

	"github.com/belov38/boat-dev-clone/services/gateway/internal/config"
	"github.com/belov38/boat-dev-clone/services/gateway/internal/cpapi"
	"github.com/belov38/boat-dev-clone/services/gateway/internal/portauth"
	"github.com/belov38/boat-dev-clone/services/gateway/internal/testenv"
	"github.com/belov38/boat-dev-clone/services/gateway/internal/testenv/sshdtest"
)

// tlsGet sends GET https://host/path to the TLS listener of front over
// HTTP/1.1 with optional headers (a Host header sets req.Host).
func tlsGet(t *testing.T, c *cluster, front *testenv.Inst, host, path string, hdr http.Header) answer {
	t.Helper()
	req := newReq(t, http.MethodGet, "https", host, path, nil)
	for k, v := range hdr {
		if k == "Host" {
			req.Host = v[0]
			continue
		}
		req.Header[k] = v
	}
	return roundTrip(c.env.HTTPClient(front, false).Transport, req)
}

func decodeAnswer(t *testing.T, what string, a answer) echoed {
	t.Helper()
	if a.status != http.StatusOK {
		t.Fatalf("%s = %v", what, a)
	}
	var e echoed
	if err := json.Unmarshal(a.body, &e); err != nil {
		t.Fatalf("%s: echo body %q: %v", what, a.body, err)
	}
	return e
}

// tokenCookie gets the session cookie of a token route the way curl does:
// a request with ?_token= is proxied and the answer sets the cookie.
func tokenCookie(t *testing.T, c *cluster, host, token string) string {
	t.Helper()
	a := tlsGet(t, c, c.A, host, "/?_token="+url.QueryEscape(token), nil)
	if a.status != http.StatusOK {
		t.Fatalf("token request to %s = %v", host, a)
	}
	for _, v := range a.header.Values("Set-Cookie") {
		if ck, err := http.ParseSetCookie(v); err == nil && ck.Name == portauth.AuthCookie {
			return ck.Value
		}
	}
	t.Fatalf("no %s from %s: %q", portauth.AuthCookie, host, a.header.Values("Set-Cookie"))
	return ""
}

func authCookie(v string) http.Header {
	return http.Header{"Cookie": {portauth.AuthCookie + "=" + v}}
}

// withoutID removes the request id from a gateway answer's body.
func withoutID(a answer) string {
	return strings.ReplaceAll(string(a.body), a.header.Get("X-Request-Id"), "<id>")
}

func TestCrossTenant(t *testing.T) {
	t.Parallel()
	c := newCluster(t, testenv.Options{}, nil)
	mA, mB := c.newMachine(t), c.newMachine(t)
	appA, appB := &countingApp{}, &countingApp{}
	mA.ServeHTTP(80, appA)
	mA.ServeHTTP(81, appA)
	mB.ServeHTTP(80, appB)
	mB.ServeHTTP(81, appB)
	a := c.env.Route(mA, 80, nil)
	b := c.env.Route(mB, 80, nil)
	ta := c.env.Route(mA, 81, func(r *cpapi.Route) { r.Access = "token"; r.TokenHash = tokenHash("tok-a") })
	tb := c.env.Route(mB, 81, func(r *cpapi.Route) { r.Access = "token"; r.TokenHash = tokenHash("tok-b") })
	hostA, hostB := testenv.Host(a.Label), testenv.Host(b.Label)

	// counts runs fn and returns how many requests each app got.
	counts := func(fn func()) (na, nb int64) {
		a0, b0 := appA.Count(), appB.Count()
		fn()
		return appA.Count() - a0, appB.Count() - b0
	}

	t.Run("X-Forwarded-Host does not route", func(t *testing.T) {
		var e echoed
		na, nb := counts(func() {
			e = decodeAnswer(t, "answer", tlsGet(t, c, c.A, hostA, "/", http.Header{"X-Forwarded-Host": {hostB}}))
		})
		if na != 1 || nb != 0 || e.Host != hostA || e.Header.Get("X-Forwarded-Host") != hostA {
			t.Fatalf("a got %d, b got %d; app saw Host %q, X-Forwarded-Host %q", na, nb, e.Host, e.Header.Get("X-Forwarded-Host"))
		}
	})

	t.Run("absolute-form URI", func(t *testing.T) {
		// Go's server takes r.Host from an absolute-form request target
		// and ignores the Host header: the label in the URI decides. The
		// safe property pinned here is that one label decides both the
		// route and the access check, so a's cookie never opens b.
		r := dialRawH1(t, c, c.A, hostA)
		var resp answer
		na, nb := counts(func() {
			resp = r.do(t, "GET https://"+hostB+"/abs HTTP/1.1\r\nHost: "+hostA+"\r\n\r\n")
		})
		e := decodeAnswer(t, "public b by URI", resp)
		if na != 0 || nb != 1 || e.Host != hostB || e.Path != "/abs" {
			t.Fatalf("a got %d, b got %d; app saw Host %q path %q", na, nb, e.Host, e.Path)
		}

		hostTA, hostTB := testenv.Host(ta.Label), testenv.Host(tb.Label)
		cookieA := tokenCookie(t, c, hostTA, "tok-a")
		raw := func(target, host, extra string) string {
			return "GET " + target + " HTTP/1.1\r\nHost: " + host + "\r\n" + extra + "\r\n"
		}
		na, nb = counts(func() {
			// a's cookie with b in the URI and a in Host: b's route, b's
			// check, refused.
			expectGatewayError(t, "a's cookie, b in the URI", r.do(t, raw("https://"+hostTB+"/", hostTA, "Cookie: "+portauth.AuthCookie+"="+cookieA+"\r\n")),
				http.StatusUnauthorized, "auth_required")
			// a's token for b: refused too.
			expectGatewayError(t, "a's token, b in the URI", r.do(t, raw("https://"+hostTB+"/", hostTA, "Sbx-Port-Token: tok-a\r\n")),
				http.StatusUnauthorized, "token_invalid")
		})
		if na != 0 || nb != 0 {
			t.Fatalf("a got %d, b got %d requests; want none", na, nb)
		}
		// b's own token for b in the URI works and reaches b only.
		na, nb = counts(func() {
			decodeAnswer(t, "b's token, b in the URI", r.do(t, raw("https://"+hostTB+"/", hostTA, "Sbx-Port-Token: tok-b\r\n")))
			// And a's cookie still opens a (origin form): the cookie was valid.
			decodeAnswer(t, "a's cookie on a", r.do(t, raw("/", hostTA, "Cookie: "+portauth.AuthCookie+"="+cookieA+"\r\n")))
		})
		if na != 1 || nb != 1 {
			t.Fatalf("a got %d, b got %d requests; want 1 and 1", na, nb)
		}
	})

	t.Run("host spellings", func(t *testing.T) {
		// Spec 4.2: the host is lower-cased, so the upper-case spelling is
		// the same label and the same route, never another one.
		na, nb := counts(func() {
			decodeAnswer(t, "upper case", tlsGet(t, c, c.A, hostA, "/", http.Header{"Host": {strings.ToUpper(hostA)}}))
		})
		if na != 1 || nb != 0 {
			t.Fatalf("upper case: a got %d, b got %d", na, nb)
		}
		na, nb = counts(func() {
			for _, h := range []string{hostA + ".", hostA + ":8443", strings.ToUpper(hostA) + "."} {
				expectGatewayError(t, "Host "+h, tlsGet(t, c, c.A, hostA, "/", http.Header{"Host": {h}}), http.StatusNotFound, "route_not_found")
			}
		})
		if na != 0 || nb != 0 {
			t.Fatalf("a got %d, b got %d requests; want none", na, nb)
		}
	})

	t.Run("reserved slug", func(t *testing.T) {
		// Even if api had such a route, the grammar refuses the label
		// before any lookup.
		c.env.Route(mA, 3000, func(r *cpapi.Route) { r.Slug = "api" })
		before := c.env.API.Calls("LookupRoute")
		expectGatewayError(t, "api-3000", tlsGet(t, c, c.A, testenv.Host("api-3000"), "/", nil), http.StatusNotFound, "route_not_found")
		if n := c.env.API.Calls("LookupRoute") - before; n != 0 {
			t.Fatalf("%d route lookups for a reserved slug", n)
		}
	})

	t.Run("identical 404s", func(t *testing.T) {
		deleted := c.env.Route(mA, 82, func(r *cpapi.Route) { r.SandboxState = "deleted" })
		hosts := map[string]string{
			"deleted sandbox":  testenv.Host(deleted.Label),
			"unpublished port": testenv.Host(a.Slug + "-4000"),
			"unknown label":    testenv.Host("nosuch-slug-80"),
		}
		for _, accept := range []string{"application/json", "text/html"} {
			bodies := map[string]string{}
			for what, host := range hosts {
				r := tlsGet(t, c, c.A, host, "/", http.Header{"Accept": {accept}})
				expectGatewayError(t, what, r, http.StatusNotFound, "route_not_found")
				if !strings.Contains(string(r.body), r.header.Get("X-Request-Id")) {
					t.Fatalf("%s: body has no request id: %s", what, r.body)
				}
				bodies[what] = withoutID(r)
			}
			if bodies["deleted sandbox"] != bodies["unpublished port"] || bodies["deleted sandbox"] != bodies["unknown label"] {
				t.Fatalf("%s 404 bodies differ:\n%v", accept, bodies)
			}
		}
	})
}

func TestCookieScope(t *testing.T) {
	t.Parallel()
	c := newCluster(t, testenv.Options{}, nil)
	m := c.newMachine(t)
	app := &countingApp{}
	for _, port := range []uint16{80, 3000, 3001} {
		m.ServeHTTP(port, app)
	}
	tokenRoute := func(r *cpapi.Route) { r.Access = "token"; r.TokenHash = tokenHash("tok") }
	a80 := c.env.Route(m, 80, tokenRoute)
	a3000 := c.env.Route(m, 3000, func(r *cpapi.Route) { tokenRoute(r); r.Slug = a80.Slug })
	b80 := c.env.Route(m, 80, tokenRoute)
	sso := c.env.Route(m, 3001, func(r *cpapi.Route) { r.Access = "sso" })
	sso2 := c.env.Route(m, 3001, func(r *cpapi.Route) { r.Access = "sso" })
	host := func(r cpapi.Route) string { return testenv.Host(r.Label) }
	codec := portauth.NewCodec([]config.CookieKey{c.env.Keys.Cookie}, time.Now)
	fetch := func(r cpapi.Route, cookie string) answer {
		return tlsGet(t, c, c.A, host(r), "/", authCookie(cookie))
	}

	t.Run("label scope", func(t *testing.T) {
		ck := tokenCookie(t, c, host(a80), "tok")
		decodeAnswer(t, "a-80 with its cookie", fetch(a80, ck))
		for _, r := range []cpapi.Route{a3000, b80} {
			expectGatewayError(t, r.Label+" with a-80's cookie", fetch(r, ck), http.StatusUnauthorized, "auth_required")
		}
	})

	ssoSession := func(mod func(*portauth.Session)) portauth.Session {
		s := portauth.Session{Label: sso.Label, Mode: portauth.ModeSSO, Epoch: sso.AuthEpoch,
			UserID: "usr_1", Email: "u@example.com", Expiry: time.Now().Add(time.Hour)}
		if mod != nil {
			mod(&s)
		}
		return s
	}
	t.Run("forged cookies", func(t *testing.T) {
		// The minted cookie works as is: the refusals below are about the
		// one field each changes.
		decodeAnswer(t, "valid sso cookie", fetch(sso, codec.SealSession(ssoSession(nil))))
		otherKey := make([]byte, 32)
		if _, err := rand.Read(otherKey); err != nil {
			t.Fatal(err)
		}
		// A key that was removed from the config: signed right, unknown kid.
		removedKid := portauth.NewCodec([]config.CookieKey{{ID: "k0", Key: otherKey}}, time.Now)
		sameKidOtherKey := portauth.NewCodec([]config.CookieKey{{ID: c.env.Keys.Cookie.ID, Key: otherKey}}, time.Now)
		cases := map[string]string{
			"mode t on an sso route": codec.SealSession(ssoSession(func(s *portauth.Session) { s.Mode = portauth.ModeToken })),
			"expired":                codec.SealSession(ssoSession(func(s *portauth.Session) { s.Expiry = time.Now().Add(-time.Second) })),
			"old epoch":              codec.SealSession(ssoSession(func(s *portauth.Session) { s.Epoch-- })),
			"removed kid":            removedKid.SealSession(ssoSession(nil)),
			"kid with another key":   sameKidOtherKey.SealSession(ssoSession(nil)),
			"another sso label":      codec.SealSession(ssoSession(func(s *portauth.Session) { s.Label = sso2.Label })),
		}
		n0 := app.Count()
		for name, v := range cases {
			expectGatewayError(t, name, fetch(sso, v), http.StatusUnauthorized, "auth_required")
		}
		if n := app.Count() - n0; n != 0 {
			t.Fatalf("the app got %d requests", n)
		}
	})

	callback := func(cl *http.Client, r cpapi.Route, code, state string, hdr http.Header) page {
		t.Helper()
		return navigate(t, cl, "https://"+host(r)+"/__sbx/auth/callback?code="+url.QueryEscape(code)+"&state="+url.QueryEscape(state), hdr)
	}
	grant := func(r cpapi.Route) cpapi.PortAuthGrant {
		return cpapi.PortAuthGrant{UserID: "usr_1", Email: "u@example.com", AuthEpoch: r.AuthEpoch}
	}

	t.Run("code issued for another label", func(t *testing.T) {
		br := browser(t, c, c.A, "", false)
		state := startLogin(t, br, "https://"+host(sso), "/x")
		codeY := c.env.API.IssueCode(sso2.Label, grant(sso2))
		if p := callback(br, sso, codeY, state, nil); p.status != http.StatusUnauthorized || p.sbxError != "auth_required" {
			t.Fatalf("callback on X with Y's code = %v", p.result)
		}
		for _, ck := range jarCookies(br, host(sso)) {
			if ck.Name == portauth.AuthCookie {
				t.Fatal("a session cookie was set")
			}
		}
		// Y's code is not burned by the refusal: Y's own login still works.
		brY := browser(t, c, c.A, "", false)
		stateY := startLogin(t, brY, "https://"+host(sso2), "/y")
		if p := callback(brY, sso2, codeY, stateY, nil); p.status != http.StatusFound || p.header.Get("Location") != "/y" {
			t.Fatalf("Y's callback with its code = %v, Location %q", p.result, p.header.Get("Location"))
		}
	})

	t.Run("state cookie of another label", func(t *testing.T) {
		brY := browser(t, c, c.A, "", false)
		stateY := startLogin(t, brY, "https://"+host(sso2), "/y")
		var stateCookie *http.Cookie
		for _, ck := range jarCookies(brY, host(sso2)) {
			if strings.HasPrefix(ck.Name, portauth.StateCookiePrefix) {
				stateCookie = ck
			}
		}
		if stateCookie == nil {
			t.Fatal("no state cookie from Y's login")
		}
		// The cookie and state of Y's login replayed on X's callback, with
		// a valid code for X: refused before the code is exchanged.
		codeX := c.env.API.IssueCode(sso.Label, grant(sso))
		before := c.env.API.Calls("ExchangePortAuthCode")
		plain := browser(t, c, c.A, "", false)
		plain.Jar = nil
		p := callback(plain, sso, codeX, stateY, http.Header{"Cookie": {stateCookie.Name + "=" + stateCookie.Value}})
		if p.status != http.StatusUnauthorized || p.sbxError != "auth_required" {
			t.Fatalf("callback on X with Y's state cookie = %v", p.result)
		}
		if n := c.env.API.Calls("ExchangePortAuthCode") - before; n != 0 {
			t.Fatalf("%d code exchanges for a refused state", n)
		}
	})
}

// jarCookies returns the cookies of cl's jar for https://host/.
func jarCookies(cl *http.Client, host string) []*http.Cookie {
	u := &url.URL{Scheme: "https", Host: host, Path: "/"}
	return cl.Jar.Cookies(u)
}

func TestPlatformCredentialsStripped(t *testing.T) {
	t.Parallel()
	c := newCluster(t, testenv.Options{}, nil)
	m := c.newMachine(t)
	m.ServeHTTP(3000, echoApp())
	m.ServeHTTP(3001, echoApp())
	public := c.env.Route(m, 3000, nil)
	token := c.env.Route(m, 3001, func(r *cpapi.Route) { r.Access = "token"; r.TokenHash = tokenHash("tok") })

	hdr := http.Header{
		"Cookie": {"__Host-oauth2_proxy=idp; _oauth2_proxy_csrf=csrf; __Secure-oauth2_proxy_1=part; keep=1; " +
			portauth.AuthCookie + "=x"},
		"X-Auth-Request-Email": {"admin@example.com"},
		"X-Forwarded-User":     {"admin"},
		"Sbx-Port-Token":       {"tok"},
	}
	for _, r := range []cpapi.Route{public, token} {
		for _, front := range []*testenv.Inst{c.A, c.C} {
			e := decodeAnswer(t, r.Access+" via "+front.Name, tlsGet(t, c, front, testenv.Host(r.Label), "/", hdr))
			if got := e.Header.Values("Cookie"); len(got) != 1 || got[0] != "keep=1" {
				t.Errorf("%s via %s: app saw Cookie %q", r.Access, front.Name, got)
			}
			for _, k := range []string{"X-Auth-Request-Email", "X-Forwarded-User", "Sbx-Port-Token"} {
				if v := e.Header.Values(k); len(v) != 0 {
					t.Errorf("%s via %s: app saw %s %q", r.Access, front.Name, k, v)
				}
			}
		}
	}
}

// sshRecorder keeps the ssh/authorize requests of the fake api.
type sshRecorder struct {
	mu   sync.Mutex
	reqs []cpapi.SSHAuthorizeRequest
}

func (r *sshRecorder) add(req cpapi.SSHAuthorizeRequest) {
	r.mu.Lock()
	defer r.mu.Unlock()
	r.reqs = append(r.reqs, req)
}

func (r *sshRecorder) last() (cpapi.SSHAuthorizeRequest, int) {
	r.mu.Lock()
	defer r.mu.Unlock()
	if len(r.reqs) == 0 {
		return cpapi.SSHAuthorizeRequest{}, 0
	}
	return r.reqs[len(r.reqs)-1], len(r.reqs)
}

func newSSHKey(t *testing.T) ssh.Signer {
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

// loginCert issues a login certificate for principal signed by the login CA.
func loginCert(t *testing.T, c *cluster, principal, keyID string) ssh.Signer {
	t.Helper()
	key := newSSHKey(t)
	now := time.Now()
	cert := &ssh.Certificate{
		Key: key.PublicKey(), Serial: 7, CertType: ssh.UserCert, KeyId: keyID,
		ValidPrincipals: []string{principal},
		ValidAfter:      uint64(now.Add(-time.Minute).Unix()),
		ValidBefore:     uint64(now.Add(10 * time.Minute).Unix()),
	}
	if err := cert.SignCert(rand.Reader, c.env.Keys.LoginCA); err != nil {
		t.Fatal(err)
	}
	s, err := ssh.NewCertSigner(cert, key)
	if err != nil {
		t.Fatal(err)
	}
	return s
}

func TestSSHPrincipalsAcrossInstances(t *testing.T) {
	t.Parallel()
	c := newCluster(t, testenv.Options{}, nil)
	m := c.newMachine(t)
	const loginUser = "sbx"
	sshd := sshdtest.New(t, c.env.Keys.UserCA.PublicKey(), loginUser)
	m.ServeSSHD(sshd)

	// Sandboxes X and Y run on the same machine; Z is a sandbox whose api
	// answer is careless and allows any certificate.
	const slugX, slugY, slugZ = "quiet-otter-lamp", "brave-fox-tree", "lazy-dog-hill"
	auth := func(sandboxID string) cpapi.SSHAuthorization {
		return cpapi.SSHAuthorization{
			Allowed: true, Actor: cpapi.SSHActor{Kind: "user", UserID: "usr_1"}, UserID: "usr_1",
			SandboxID: sandboxID, MachineID: m.ID, SandboxState: "ready", LoginUser: loginUser, TeamID: "team_1",
		}
	}
	var rec sshRecorder
	// api's rule (S7 12.1): a certificate's principal must be the ID of
	// the sandbox named by the user.
	c.env.API.SetSSH(func(r cpapi.SSHAuthorizeRequest) bool {
		rec.add(r)
		return r.Sandbox == slugX && r.Certificate != nil && r.Certificate.Principal == "sb_X"
	}, auth("sb_X"))
	c.env.API.SetSSH(func(r cpapi.SSHAuthorizeRequest) bool {
		return r.Sandbox == slugY && r.Certificate != nil && r.Certificate.Principal == "sb_Y"
	}, auth("sb_Y"))
	c.env.API.SetSSH(func(r cpapi.SSHAuthorizeRequest) bool { return r.Sandbox == slugZ }, auth("sb_Z"))

	dial := func(front *testenv.Inst, user string, s ssh.Signer) (*ssh.Client, error) {
		return ssh.Dial("tcp", front.SSHAddr, &ssh.ClientConfig{
			User:            user,
			Auth:            []ssh.AuthMethod{ssh.PublicKeys(s)},
			HostKeyCallback: ssh.FixedHostKey(c.env.Keys.SSHHost.PublicKey()),
			Timeout:         testenv.WaitTimeout,
		})
	}
	certX := loginCert(t, c, "sb_X", "sbx:user:usr_1")

	t.Run("cert for X used for Y", func(t *testing.T) {
		for _, front := range []*testenv.Inst{c.A, c.B} {
			before := c.env.API.Calls("AuthorizeSSH")
			_, nrec := rec.last()
			if cl, err := dial(front, slugY, certX); err == nil {
				_ = cl.Close()
				t.Fatalf("via %s: login to Y with X's certificate allowed", front.Name)
			}
			// This front asked api itself: a fresh call, not the other
			// front's earlier one.
			if n := c.env.API.Calls("AuthorizeSSH") - before; n < 1 {
				t.Fatalf("via %s: api not called", front.Name)
			}
			r, n := rec.last()
			if n == nrec {
				t.Fatalf("via %s: no new request recorded", front.Name)
			}
			if r.Sandbox != slugY || r.Certificate == nil || r.Certificate.Principal != "sb_X" || r.Certificate.KeyID != "sbx:user:usr_1" {
				t.Fatalf("via %s: api got %+v (certificate %+v)", front.Name, r, r.Certificate)
			}
		}
	})

	t.Run("careless api answer for another sandbox", func(t *testing.T) {
		// api allows Z for X's certificate; the gateway still refuses: the
		// answer is for sb_Z, the certificate names sb_X.
		if cl, err := dial(c.A, slugZ, certX); err == nil {
			_ = cl.Close()
			t.Fatal("login to Z with X's certificate allowed")
		}
	})

	t.Run("backend sees loginUser only", func(t *testing.T) {
		for _, front := range []*testenv.Inst{c.A, c.B} {
			cl, err := dial(front, slugX, certX)
			if err != nil {
				t.Fatalf("via %s: %v", front.Name, err)
			}
			s, err := cl.NewSession()
			if err != nil {
				t.Fatal(err)
			}
			out, err := s.Output("echo ok")
			_ = cl.Close()
			if err != nil || string(out) != "ok\n" {
				t.Fatalf("via %s: exec = %q, %v", front.Name, out, err)
			}
		}
		certs := sshd.Certs()
		if len(certs) != 2 {
			t.Fatalf("backend saw %d logins, want 2", len(certs))
		}
		for _, bc := range certs {
			if len(bc.ValidPrincipals) != 1 || bc.ValidPrincipals[0] != loginUser {
				t.Fatalf("backend certificate principals %q, want only %q", bc.ValidPrincipals, loginUser)
			}
			if !strings.HasPrefix(bc.KeyId, "sbx:user:usr_1:") {
				t.Fatalf("backend certificate KeyId %q", bc.KeyId)
			}
		}
	})

	t.Run("bad KeyId refused before api", func(t *testing.T) {
		for _, keyID := range []string{"sbx:user:usr_1\nsbx:key:key_1", "sbx:user:usr_1\n", "sbx:user:", "sbx:key:"} {
			before := c.env.API.Calls("AuthorizeSSH")
			if cl, err := dial(c.A, slugX, loginCert(t, c, "sb_X", keyID)); err == nil {
				_ = cl.Close()
				t.Fatalf("KeyId %q allowed", keyID)
			}
			if n := c.env.API.Calls("AuthorizeSSH") - before; n != 0 {
				t.Fatalf("KeyId %q: api called %d times", keyID, n)
			}
		}
	})
}
