package config

import (
	"crypto/ed25519"
	"crypto/rand"
	"encoding/base64"
	"encoding/pem"
	"net/netip"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"golang.org/x/crypto/ssh"

	"github.com/belov38/umiak/libs/tunnel/gateway"
)

func writeFile(t *testing.T, dir, name, content string) string {
	t.Helper()
	p := filepath.Join(dir, name)
	if err := os.WriteFile(p, []byte(content), 0o600); err != nil {
		t.Fatal(err)
	}
	return p
}

// writeSSHKey writes an OpenSSH private key and returns its path and signer.
func writeSSHKey(t *testing.T, dir, name string) (string, ssh.Signer) {
	t.Helper()
	_, priv, err := ed25519.GenerateKey(rand.Reader)
	if err != nil {
		t.Fatal(err)
	}
	blk, err := ssh.MarshalPrivateKey(priv, "")
	if err != nil {
		t.Fatal(err)
	}
	signer, err := ssh.NewSignerFromKey(priv)
	if err != nil {
		t.Fatal(err)
	}
	return writeFile(t, dir, name, string(pem.EncodeToMemory(blk))), signer
}

func b64key(fill byte) string {
	return base64.StdEncoding.EncodeToString([]byte(strings.Repeat(string([]byte{fill}), 32)))
}

type fixture struct {
	dir string
	env map[string]string
}

func (f *fixture) getenv(k string) string { return f.env[k] }

// newFixture returns a complete valid environment.
func newFixture(t *testing.T) *fixture {
	t.Helper()
	dir := t.TempDir()
	hostKey, _ := writeSSHKey(t, dir, "host_ed25519")
	caKey, _ := writeSSHKey(t, dir, "user_ca")
	_, loginCA := writeSSHKey(t, dir, "login_ca_unused")
	loginCAFile := writeFile(t, dir, "login_ca.pub", "# login CAs\n"+string(ssh.MarshalAuthorizedKey(loginCA.PublicKey())))
	return &fixture{dir: dir, env: map[string]string{
		"UMIAK_GATEWAY_INTERNAL_URL":           "http://gw-0.gateway.svc:7000",
		"UMIAK_GATEWAY_SERVICE_TOKENS_FILE":    writeFile(t, dir, "tokens.json", `{"api":["a1"],"worker":["w1"],"gateway":["g1","g2"]}`),
		"UMIAK_GATEWAY_COOKIE_KEYS_FILE":       writeFile(t, dir, "cookie.keys", "k1:"+b64key('a')+"\n"),
		"UMIAK_GATEWAY_TLS_PREVIEW_CERT_FILE":  "/tls/umiak.crt",
		"UMIAK_GATEWAY_TLS_PREVIEW_KEY_FILE":   "/tls/umiak.key",
		"UMIAK_GATEWAY_TLS_TUNNEL_CERT_FILE":   "/tls/tunnel.crt",
		"UMIAK_GATEWAY_TLS_TUNNEL_KEY_FILE":    "/tls/tunnel.key",
		"UMIAK_GATEWAY_SSH_HOST_KEY_FILES":     hostKey,
		"UMIAK_GATEWAY_SSH_USER_CA_KEY_FILE":   caKey,
		"UMIAK_GATEWAY_SSH_LOGIN_CA_KEYS_FILE": loginCAFile,
		"UMIAK_GATEWAY_API_TOKEN_FILE":         writeFile(t, dir, "api.token", "  api-secret\n"),
		"UMIAK_GATEWAY_API_URL":                "http://api:3000",
		"UMIAK_GATEWAY_PREVIEW_DOMAIN":         "umiak.example.com",
		"UMIAK_GATEWAY_TUNNEL_HOST":            "tunnel.example.com",
		"UMIAK_GATEWAY_SSH_HOST":               "ssh.example.com",
		"UMIAK_GATEWAY_DATABASE_URL":           "postgres://x",
	}}
}

func TestFromEnvDefaults(t *testing.T) {
	f := newFixture(t)
	f.env["UMIAK_GATEWAY_DATABASE_URL"] = ""
	f.env["DATABASE_URL"] = "postgres://fallback"
	cfg, err := FromEnv(f.getenv)
	if err != nil {
		t.Fatal(err)
	}

	if !strings.Contains(cfg.InstanceID, "-") || len(cfg.InstanceID) < 9 {
		t.Errorf("InstanceID = %q, want hostname-<8 hex>", cfg.InstanceID)
	}
	if cfg.DatabaseURL != "postgres://fallback" {
		t.Errorf("DatabaseURL = %q", cfg.DatabaseURL)
	}
	checks := []struct {
		name      string
		got, want any
	}{
		{"InternalListen", cfg.InternalListen, ":7000"},
		{"TLSListen", cfg.TLSListen, ":8443"},
		{"SSHListen", cfg.SSHListen, ":2222"},
		{"HTTPListen", cfg.HTTPListen, ""},
		{"MetricsListen", cfg.MetricsListen, ":9090"},
		{"ProxyProtocol", cfg.ProxyProtocol, false},
		{"CookieCrossSite", cfg.CookieCrossSite, false},
		{"StripCookiePrefixes", strings.Join(cfg.StripCookiePrefixes, ","), "_oauth2_proxy,__Host-oauth2_proxy,__Secure-oauth2_proxy"},
		{"ReservedPorts", len(cfg.ReservedPorts), 6},
		{"ReservedPorts[0]", cfg.ReservedPorts[0], 22},
		{"ReservedPorts[5]", cfg.ReservedPorts[5], 48010},
		{"ReservedSuffixes", strings.Join(cfg.ReservedSuffixes, ","), "desktop"},
		{"ReservedSlugs", strings.Join(cfg.ReservedSlugs, ","), "api,app,www,ssh,tunnel,admin,static,umiak"},
		{"HTTPDrainDeadline", cfg.HTTPDrainDeadline, 2 * time.Minute},
		{"SSHDrainDeadline", cfg.SSHDrainDeadline, 15 * time.Minute},
		{"SSHKeepaliveInterval", cfg.SSHKeepaliveInterval, 30 * time.Second},
		{"SSHKeepaliveMax", cfg.SSHKeepaliveMax, 3},
		{"SSHMaxChannels", cfg.SSHMaxChannels, 256},
		{"TLSMaxHandshakesPerIP", cfg.TLSMaxHandshakesPerIP, 64},
		{"ProxyHeaderTimeout", cfg.ProxyHeaderTimeout, 2 * time.Second},
		{"SSHLoginCertMaxValidity", cfg.SSHLoginCertMaxValidity, 24 * time.Hour},
		{"TLSHandshake", cfg.Timeouts.TLSHandshake, 10 * time.Second},
		{"ReadHeader", cfg.Timeouts.ReadHeader, 10 * time.Second},
		{"MaxHeaderBytes", cfg.Timeouts.MaxHeaderBytes, 64 << 10},
		{"ClientIdle", cfg.Timeouts.ClientIdle, 120 * time.Second},
		{"RouteLookup", cfg.Timeouts.RouteLookup, 3 * time.Second},
		{"AgentWait", cfg.Timeouts.AgentWait, 10 * time.Second},
		{"Dial", cfg.Timeouts.Dial, 10 * time.Second},
		{"ResponseHeader", cfg.Timeouts.ResponseHeader, 5 * time.Minute},
		{"StreamIdle", cfg.Timeouts.StreamIdle, 60 * time.Minute},
		{"TunnelReadHeader", cfg.Timeouts.TunnelReadHeader, 5 * time.Second},
		{"TunnelAdmitRate", cfg.TunnelAdmitRate, 200.0},
		{"TunnelAdmitBurst", cfg.TunnelAdmitBurst, 1000},
		{"LogLevel", cfg.LogLevel, "info"},
		{"PeerToken", cfg.PeerToken, "g1"},
		{"APIToken", cfg.APIToken, "api-secret"},
		{"IPRate", cfg.RateLimit.IPRate, 300.0},
		{"IPBurst", cfg.RateLimit.IPBurst, 2000},
		{"LabelRate", cfg.RateLimit.LabelRate, 1000.0},
		{"LabelBurst", cfg.RateLimit.LabelBurst, 3000},
		{"AuthFailPerMin", cfg.RateLimit.AuthFailPerMin, 20},
		{"AuthBlock", cfg.RateLimit.AuthBlock, 5 * time.Minute},
		{"ConnsPerIP", cfg.RateLimit.ConnsPerIP, 512},
		{"TunnelConnsPerIP", cfg.RateLimit.TunnelConnsPerIP, 512},
		{"SSHConnPerMin", cfg.RateLimit.SSHConnPerMin, 10},
		{"SSHConnBurst", cfg.RateLimit.SSHConnBurst, 20},
		{"SSHAuthFailPerMin", cfg.RateLimit.SSHAuthFailPerMin, 10},
		{"SSHSessionsPerUser", cfg.RateLimit.SSHSessionsPerUser, 20},
		{"RateLimitExempt", len(cfg.RateLimit.Exempt), 0},
	}
	for _, c := range checks {
		if c.got != c.want {
			t.Errorf("%s = %v, want %v", c.name, c.got, c.want)
		}
	}
}

func TestFromEnvOverrides(t *testing.T) {
	f := newFixture(t)
	for k, v := range map[string]string{
		"UMIAK_GATEWAY_INSTANCE_ID":                   "gw-1",
		"UMIAK_GATEWAY_TLS_LISTEN":                    ":443",
		"UMIAK_GATEWAY_HTTP_LISTEN":                   ":8080",
		"UMIAK_GATEWAY_PROXY_PROTOCOL":                "v2",
		"UMIAK_GATEWAY_PROXY_PROTOCOL_CIDRS":          "10.0.0.0/8, fd00::/8",
		"UMIAK_GATEWAY_TRUSTED_PROXY_CIDRS":           "192.168.0.0/16",
		"UMIAK_GATEWAY_RATELIMIT_EXEMPT_CIDRS":        "203.0.113.0/24",
		"UMIAK_GATEWAY_RATELIMIT_IP_RATE":             "5.5",
		"UMIAK_GATEWAY_RATELIMIT_AUTH_BLOCK":          "1m",
		"UMIAK_GATEWAY_RESERVED_PORTS":                "22, 8080",
		"UMIAK_GATEWAY_TIMEOUT_DIAL":                  "3s",
		"UMIAK_GATEWAY_TIMEOUT_STREAM_IDLE":           "30m",
		"UMIAK_GATEWAY_MAX_HEADER_BYTES":              "1024",
		"UMIAK_GATEWAY_COOKIE_CROSS_SITE":             "true",
		"UMIAK_GATEWAY_HTTP_DRAIN_DEADLINE":           "30s",
		"UMIAK_GATEWAY_TUNNEL_ADMIT_RATE":             "50",
		"UMIAK_GATEWAY_TUNNEL_ADMIT_BURST":            "60",
		"UMIAK_GATEWAY_MIN_AGENT_VERSION":             "1.2.3",
		"UMIAK_GATEWAY_LOG_LEVEL":                     "debug",
		"UMIAK_GATEWAY_STRIP_COOKIE_PREFIXES":         "a,b",
		"UMIAK_GATEWAY_AUTH_URL":                      "https://app.example.com/authorize",
		"UMIAK_GATEWAY_RESERVED_SUFFIXES":             "desktop,vnc",
		"UMIAK_GATEWAY_RESERVED_SLUGS":                "api",
		"UMIAK_GATEWAY_TIMEOUT_RESPONSE_HEADER":       "1m",
		"UMIAK_GATEWAY_TLS_MAX_HANDSHAKES_PER_IP":     "16",
		"UMIAK_GATEWAY_SSH_LOGIN_CERT_MAX_VALIDITY":   "1h",
		"UMIAK_GATEWAY_PROXY_HEADER_TIMEOUT":          "500ms",
		"UMIAK_GATEWAY_RATELIMIT_TUNNEL_CONNS_PER_IP": "32",
		"UMIAK_GATEWAY_TIMEOUT_TUNNEL_READ_HEADER":    "3s",
	} {
		f.env[k] = v
	}
	cfg, err := FromEnv(f.getenv)
	if err != nil {
		t.Fatal(err)
	}
	if cfg.InstanceID != "gw-1" || cfg.TLSListen != ":443" || cfg.HTTPListen != ":8080" || !cfg.ProxyProtocol || !cfg.CookieCrossSite {
		t.Errorf("basic overrides not applied: %+v", cfg)
	}
	if len(cfg.ProxyProtocolCIDRs) != 2 || cfg.ProxyProtocolCIDRs[1] != netip.MustParsePrefix("fd00::/8") {
		t.Errorf("ProxyProtocolCIDRs = %v", cfg.ProxyProtocolCIDRs)
	}
	if len(cfg.TrustedProxyCIDRs) != 1 || len(cfg.RateLimit.Exempt) != 1 {
		t.Errorf("cidrs: %v %v", cfg.TrustedProxyCIDRs, cfg.RateLimit.Exempt)
	}
	if cfg.RateLimit.IPRate != 5.5 || cfg.RateLimit.AuthBlock != time.Minute {
		t.Errorf("ratelimit = %+v", cfg.RateLimit)
	}
	if len(cfg.ReservedPorts) != 2 || cfg.ReservedPorts[1] != 8080 {
		t.Errorf("ReservedPorts = %v", cfg.ReservedPorts)
	}
	if cfg.Timeouts.Dial != 3*time.Second || cfg.Timeouts.StreamIdle != 30*time.Minute || cfg.Timeouts.MaxHeaderBytes != 1024 || cfg.Timeouts.ResponseHeader != time.Minute {
		t.Errorf("timeouts = %+v", cfg.Timeouts)
	}
	if cfg.HTTPDrainDeadline != 30*time.Second || cfg.TunnelAdmitRate != 50 || cfg.TunnelAdmitBurst != 60 || cfg.MinAgentVersion != "1.2.3" || cfg.LogLevel != "debug" {
		t.Errorf("misc overrides: %+v", cfg)
	}
	if cfg.TLSMaxHandshakesPerIP != 16 {
		t.Errorf("TLSMaxHandshakesPerIP = %d", cfg.TLSMaxHandshakesPerIP)
	}
	if cfg.ProxyHeaderTimeout != 500*time.Millisecond {
		t.Errorf("ProxyHeaderTimeout = %s", cfg.ProxyHeaderTimeout)
	}
	if cfg.RateLimit.TunnelConnsPerIP != 32 || cfg.Timeouts.TunnelReadHeader != 3*time.Second {
		t.Errorf("TunnelConnsPerIP = %d, TunnelReadHeader = %s", cfg.RateLimit.TunnelConnsPerIP, cfg.Timeouts.TunnelReadHeader)
	}
	if cfg.SSHLoginCertMaxValidity != time.Hour {
		t.Errorf("SSHLoginCertMaxValidity = %s", cfg.SSHLoginCertMaxValidity)
	}
	if strings.Join(cfg.StripCookiePrefixes, "|") != "a|b" || strings.Join(cfg.ReservedSuffixes, "|") != "desktop|vnc" || cfg.AuthURL == "" {
		t.Errorf("lists: %+v", cfg)
	}
}

func TestFromEnvDisableListeners(t *testing.T) {
	f := newFixture(t)
	f.env["UMIAK_GATEWAY_TLS_LISTEN"] = "off"
	f.env["UMIAK_GATEWAY_SSH_LISTEN"] = "off"
	for _, k := range []string{
		"UMIAK_GATEWAY_TLS_PREVIEW_CERT_FILE", "UMIAK_GATEWAY_TLS_PREVIEW_KEY_FILE",
		"UMIAK_GATEWAY_TLS_TUNNEL_CERT_FILE", "UMIAK_GATEWAY_TLS_TUNNEL_KEY_FILE",
		"UMIAK_GATEWAY_SSH_HOST_KEY_FILES", "UMIAK_GATEWAY_SSH_USER_CA_KEY_FILE", "UMIAK_GATEWAY_SSH_LOGIN_CA_KEYS_FILE",
	} {
		delete(f.env, k)
	}
	cfg, err := FromEnv(f.getenv)
	if err != nil {
		t.Fatal(err)
	}
	if cfg.TLSListen != "" || cfg.SSHListen != "" || len(cfg.SSHHostKeys) != 0 || cfg.SSHUserCA != nil {
		t.Errorf("listeners not disabled: %+v", cfg)
	}
}

func TestFromEnvFiles(t *testing.T) {
	f := newFixture(t)
	k2 := base64.URLEncoding.EncodeToString([]byte(strings.Repeat("\xfb", 32)))
	f.env["UMIAK_GATEWAY_COOKIE_KEYS_FILE"] = writeFile(t, f.dir, "cookie2.keys",
		"# comment\n\nk1:"+b64key('a')+"\nk2:"+k2+"\n")
	hk2, signer2 := writeSSHKey(t, f.dir, "host2")
	f.env["UMIAK_GATEWAY_SSH_HOST_KEY_FILES"] += "," + hk2
	_, l2 := writeSSHKey(t, f.dir, "l2")
	_, l3 := writeSSHKey(t, f.dir, "l3")
	f.env["UMIAK_GATEWAY_SSH_LOGIN_CA_KEYS_FILE"] = writeFile(t, f.dir, "login2.pub",
		string(ssh.MarshalAuthorizedKey(l2.PublicKey()))+"\n# c\n"+string(ssh.MarshalAuthorizedKey(l3.PublicKey())))

	cfg, err := FromEnv(f.getenv)
	if err != nil {
		t.Fatal(err)
	}
	if got := cfg.ServiceTokens["worker"]; len(got) != 1 || got[0] != "w1" {
		t.Errorf("ServiceTokens = %v", cfg.ServiceTokens)
	}
	if cfg.PeerToken != "g1" {
		t.Errorf("PeerToken = %q", cfg.PeerToken)
	}
	if len(cfg.CookieKeys) != 2 || cfg.CookieKeys[0].ID != "k1" || cfg.CookieKeys[1].ID != "k2" {
		t.Fatalf("CookieKeys = %+v", cfg.CookieKeys)
	}
	if len(cfg.CookieKeys[0].Key) != 32 || cfg.CookieKeys[1].Key[0] != 0xfb {
		t.Errorf("cookie key bytes wrong")
	}
	if len(cfg.SSHHostKeys) != 2 || string(cfg.SSHHostKeys[1].PublicKey().Marshal()) != string(signer2.PublicKey().Marshal()) {
		t.Errorf("SSHHostKeys wrong: %d", len(cfg.SSHHostKeys))
	}
	if cfg.SSHUserCA == nil {
		t.Error("SSHUserCA nil")
	}
	if len(cfg.SSHLoginCAKeys) != 2 || string(cfg.SSHLoginCAKeys[1].Marshal()) != string(l3.PublicKey().Marshal()) {
		t.Errorf("SSHLoginCAKeys = %d", len(cfg.SSHLoginCAKeys))
	}
}

func TestFromEnvErrors(t *testing.T) {
	cases := []struct {
		name string
		mut  func(f *fixture)
		want string
	}{
		{"missing internal url", func(f *fixture) { delete(f.env, "UMIAK_GATEWAY_INTERNAL_URL") }, "UMIAK_GATEWAY_INTERNAL_URL"},
		{"cookie key not 32 bytes", func(f *fixture) {
			f.env["UMIAK_GATEWAY_COOKIE_KEYS_FILE"] = writeFile(t, f.dir, "short.keys", "k1:"+base64.StdEncoding.EncodeToString([]byte("short"))+"\n")
		}, "UMIAK_GATEWAY_COOKIE_KEYS_FILE"},
		{"cookie key duplicate kid", func(f *fixture) {
			f.env["UMIAK_GATEWAY_COOKIE_KEYS_FILE"] = writeFile(t, f.dir, "dup.keys", "k1:"+b64key('a')+"\nk1:"+b64key('b')+"\n")
		}, "UMIAK_GATEWAY_COOKIE_KEYS_FILE"},
		{"cookie keys empty", func(f *fixture) {
			f.env["UMIAK_GATEWAY_COOKIE_KEYS_FILE"] = writeFile(t, f.dir, "empty.keys", "# nothing\n")
		}, "UMIAK_GATEWAY_COOKIE_KEYS_FILE"},
		{"cookie key id not cookie-safe", func(f *fixture) {
			f.env["UMIAK_GATEWAY_COOKIE_KEYS_FILE"] = writeFile(t, f.dir, "badkid.keys", "k;1:"+b64key('a')+"\n")
		}, "UMIAK_GATEWAY_COOKIE_KEYS_FILE"},
		{"cookie key id with space", func(f *fixture) {
			f.env["UMIAK_GATEWAY_COOKIE_KEYS_FILE"] = writeFile(t, f.dir, "spacekid.keys", "k 1:"+b64key('a')+"\n")
		}, "UMIAK_GATEWAY_COOKIE_KEYS_FILE"},
		{"cookie keys unset", func(f *fixture) { delete(f.env, "UMIAK_GATEWAY_COOKIE_KEYS_FILE") }, "UMIAK_GATEWAY_COOKIE_KEYS_FILE"},
		{"bad cidr", func(f *fixture) { f.env["UMIAK_GATEWAY_TRUSTED_PROXY_CIDRS"] = "10.0.0.0/8,nonsense" }, "UMIAK_GATEWAY_TRUSTED_PROXY_CIDRS"},
		{"bad exempt cidr", func(f *fixture) { f.env["UMIAK_GATEWAY_RATELIMIT_EXEMPT_CIDRS"] = "1.2.3.4/99" }, "UMIAK_GATEWAY_RATELIMIT_EXEMPT_CIDRS"},
		{"bad proxy protocol", func(f *fixture) { f.env["UMIAK_GATEWAY_PROXY_PROTOCOL"] = "v3" }, "UMIAK_GATEWAY_PROXY_PROTOCOL"},
		{"bad duration", func(f *fixture) { f.env["UMIAK_GATEWAY_TIMEOUT_DIAL"] = "ten" }, "UMIAK_GATEWAY_TIMEOUT_DIAL"},
		{"non-positive duration", func(f *fixture) { f.env["UMIAK_GATEWAY_TIMEOUT_DIAL"] = "-1s" }, "UMIAK_GATEWAY_TIMEOUT_DIAL"},
		{"bad int", func(f *fixture) { f.env["UMIAK_GATEWAY_MAX_HEADER_BYTES"] = "x" }, "UMIAK_GATEWAY_MAX_HEADER_BYTES"},
		{"bad tunnel conns per ip", func(f *fixture) { f.env["UMIAK_GATEWAY_RATELIMIT_TUNNEL_CONNS_PER_IP"] = "0" }, "UMIAK_GATEWAY_RATELIMIT_TUNNEL_CONNS_PER_IP"},
		{"bad handshakes per ip", func(f *fixture) { f.env["UMIAK_GATEWAY_TLS_MAX_HANDSHAKES_PER_IP"] = "0" }, "UMIAK_GATEWAY_TLS_MAX_HANDSHAKES_PER_IP"},
		{"bad port", func(f *fixture) { f.env["UMIAK_GATEWAY_RESERVED_PORTS"] = "22,70000" }, "UMIAK_GATEWAY_RESERVED_PORTS"},
		{"bad bool", func(f *fixture) { f.env["UMIAK_GATEWAY_COOKIE_CROSS_SITE"] = "maybe" }, "UMIAK_GATEWAY_COOKIE_CROSS_SITE"},
		{"bad log level", func(f *fixture) { f.env["UMIAK_GATEWAY_LOG_LEVEL"] = "loud" }, "UMIAK_GATEWAY_LOG_LEVEL"},
		{"tokens without gateway", func(f *fixture) {
			f.env["UMIAK_GATEWAY_SERVICE_TOKENS_FILE"] = writeFile(t, f.dir, "t2.json", `{"api":["a"]}`)
		}, "UMIAK_GATEWAY_SERVICE_TOKENS_FILE"},
		{"tokens bad json", func(f *fixture) {
			f.env["UMIAK_GATEWAY_SERVICE_TOKENS_FILE"] = writeFile(t, f.dir, "t3.json", `{`)
		}, "UMIAK_GATEWAY_SERVICE_TOKENS_FILE"},
		{"tokens file missing", func(f *fixture) { f.env["UMIAK_GATEWAY_SERVICE_TOKENS_FILE"] = "/nonexistent/tokens.json" }, "UMIAK_GATEWAY_SERVICE_TOKENS_FILE"},
		{"tls cert missing with tls listen", func(f *fixture) { delete(f.env, "UMIAK_GATEWAY_TLS_PREVIEW_CERT_FILE") }, "UMIAK_GATEWAY_TLS_PREVIEW_CERT_FILE"},
		{"ssh host key missing with ssh listen", func(f *fixture) { delete(f.env, "UMIAK_GATEWAY_SSH_HOST_KEY_FILES") }, "UMIAK_GATEWAY_SSH_HOST_KEY_FILES"},
		{"ssh user ca missing", func(f *fixture) { delete(f.env, "UMIAK_GATEWAY_SSH_USER_CA_KEY_FILE") }, "UMIAK_GATEWAY_SSH_USER_CA_KEY_FILE"},
		{"ssh host key garbage", func(f *fixture) {
			f.env["UMIAK_GATEWAY_SSH_HOST_KEY_FILES"] = writeFile(t, f.dir, "junk", "not a key")
		}, "UMIAK_GATEWAY_SSH_HOST_KEY_FILES"},
		{"login ca garbage", func(f *fixture) {
			f.env["UMIAK_GATEWAY_SSH_LOGIN_CA_KEYS_FILE"] = writeFile(t, f.dir, "junk.pub", "ssh-ed25519 !!!\n")
		}, "UMIAK_GATEWAY_SSH_LOGIN_CA_KEYS_FILE"},
	}
	for _, c := range cases {
		t.Run(c.name, func(t *testing.T) {
			f := newFixture(t)
			c.mut(f)
			_, err := FromEnv(f.getenv)
			if err == nil {
				t.Fatal("expected error")
			}
			if !strings.Contains(err.Error(), c.want) {
				t.Errorf("error %q does not name %s", err, c.want)
			}
		})
	}
}

func TestFromEnvDrainKnobs(t *testing.T) {
	f := newFixture(t)
	cfg, err := FromEnv(f.getenv)
	if err != nil {
		t.Fatal(err)
	}
	if cfg.EndpointWait != 0 || cfg.DrainTimeout != 0 {
		t.Fatalf("defaults: EndpointWait=%v DrainTimeout=%v, want 0 (library defaults)", cfg.EndpointWait, cfg.DrainTimeout)
	}
	f.env["UMIAK_GATEWAY_ENDPOINT_WAIT"] = "100ms"
	f.env["UMIAK_GATEWAY_DRAIN_TIMEOUT"] = "3s"
	if cfg, err = FromEnv(f.getenv); err != nil {
		t.Fatal(err)
	}
	if cfg.EndpointWait != 100*time.Millisecond || cfg.DrainTimeout != 3*time.Second {
		t.Fatalf("EndpointWait=%v DrainTimeout=%v", cfg.EndpointWait, cfg.DrainTimeout)
	}
}

func TestValidateServe(t *testing.T) {
	valid := func(t *testing.T) Config {
		t.Helper()
		f := newFixture(t)
		cfg, err := FromEnv(f.getenv)
		if err != nil {
			t.Fatal(err)
		}
		return cfg
	}
	if err := valid(t).ValidateServe(); err != nil {
		t.Fatalf("valid config: %v", err)
	}
	// The largest SSH drain deadline that fits: 5 + 5 + 910 + 10 + 30 = 960 s.
	edge := valid(t)
	edge.SSHDrainDeadline = 15*time.Minute + 10*time.Second
	if err := edge.ValidateServe(); err != nil {
		t.Fatalf("drain budget of exactly the grace period: %v", err)
	}
	// Disjoint exempt and PROXY CIDRs are fine, and an overlap does not
	// matter with PROXY off.
	disjoint := valid(t)
	disjoint.ProxyProtocol = true
	disjoint.ProxyProtocolCIDRs = []netip.Prefix{netip.MustParsePrefix("10.0.0.0/8")}
	disjoint.RateLimit.Exempt = []netip.Prefix{netip.MustParsePrefix("172.16.0.0/12"), netip.MustParsePrefix("fd00::/8")}
	if err := disjoint.ValidateServe(); err != nil {
		t.Fatalf("disjoint exempt and PROXY CIDRs: %v", err)
	}
	off := valid(t)
	off.ProxyProtocolCIDRs = []netip.Prefix{netip.MustParsePrefix("10.0.0.0/8")}
	off.RateLimit.Exempt = []netip.Prefix{netip.MustParsePrefix("10.0.0.0/8")}
	if err := off.ValidateServe(); err != nil {
		t.Fatalf("overlap with PROXY off: %v", err)
	}
	// Equal HTTP and SSH drain deadlines are fine.
	eq := valid(t)
	eq.HTTPDrainDeadline, eq.SSHDrainDeadline = 2*time.Minute, 2*time.Minute
	if err := eq.ValidateServe(); err != nil {
		t.Fatalf("equal drain deadlines: %v", err)
	}
	if got := DrainBudget(valid(t), gateway.Timing{}); got != 920*time.Second {
		t.Fatalf("DrainBudget = %s, want 920s", got)
	}
	none := valid(t)
	none.APIURL, none.APIToken = APIURLNone, ""
	if err := none.ValidateServe(); err != nil {
		t.Fatalf("API_URL=none without a token: %v", err)
	}
	for _, tc := range []struct {
		name   string
		mutate func(*Config)
		want   string
	}{
		{"no domain", func(c *Config) { c.UmiakDomain = "" }, "UMIAK_GATEWAY_PREVIEW_DOMAIN"},
		{"no tunnel host", func(c *Config) { c.TunnelHost = "" }, "UMIAK_GATEWAY_TUNNEL_HOST"},
		{"no database", func(c *Config) { c.DatabaseURL = "" }, "UMIAK_GATEWAY_DATABASE_URL"},
		{"no api url", func(c *Config) { c.APIURL = "" }, "UMIAK_GATEWAY_API_URL"},
		{"bad api url", func(c *Config) { c.APIURL = "api:3000" }, "UMIAK_GATEWAY_API_URL"},
		{"no api token", func(c *Config) { c.APIToken = "" }, "UMIAK_GATEWAY_API_TOKEN_FILE"},
		{"bad internal url", func(c *Config) { c.InternalURL = "gateway:7000" }, "UMIAK_GATEWAY_INTERNAL_URL"},
		{"proxy v2 without cidrs", func(c *Config) { c.ProxyProtocol, c.ProxyProtocolCIDRs = true, nil }, "UMIAK_GATEWAY_PROXY_PROTOCOL_CIDRS"},
		// 5 s + 5 s + 15 min 11 s + 10 s + 30 s = 961 s > 960 s.
		{"drain over the grace period", func(c *Config) { c.SSHDrainDeadline = 15*time.Minute + 11*time.Second }, "UMIAK_GATEWAY_SSH_DRAIN_DEADLINE"},
		{"endpoint wait over the grace period", func(c *Config) {
			c.EndpointWait = 6 * time.Second
			c.SSHDrainDeadline = 15*time.Minute + 10*time.Second
		}, "UMIAK_GATEWAY_SSH_DRAIN_DEADLINE"},
		{"exempt cidr inside the proxy cidrs", func(c *Config) {
			c.ProxyProtocol = true
			c.ProxyProtocolCIDRs = []netip.Prefix{netip.MustParsePrefix("10.0.0.0/8")}
			c.RateLimit.Exempt = []netip.Prefix{netip.MustParsePrefix("192.0.2.0/24"), netip.MustParsePrefix("10.1.0.0/16")}
		}, "UMIAK_GATEWAY_RATELIMIT_EXEMPT_CIDRS"},
		{"exempt cidr containing a proxy cidr", func(c *Config) {
			c.ProxyProtocol = true
			c.ProxyProtocolCIDRs = []netip.Prefix{netip.MustParsePrefix("10.0.0.5/32")}
			c.RateLimit.Exempt = []netip.Prefix{netip.MustParsePrefix("10.0.0.0/24")}
		}, "UMIAK_GATEWAY_RATELIMIT_EXEMPT_CIDRS"},
		{"http drain longer than ssh drain", func(c *Config) { c.HTTPDrainDeadline = 3 * time.Minute; c.SSHDrainDeadline = 2 * time.Minute }, "UMIAK_GATEWAY_HTTP_DRAIN_DEADLINE"},
	} {
		t.Run(tc.name, func(t *testing.T) {
			c := valid(t)
			tc.mutate(&c)
			err := c.ValidateServe()
			if err == nil || !strings.Contains(err.Error(), tc.want) {
				t.Fatalf("err = %v, want one naming %s", err, tc.want)
			}
		})
	}
}

// TestFromEnvMappedCIDRs: an IPv4-mapped prefix of /96 or longer becomes the
// IPv4 prefix (client addresses are unmapped before matching); a shorter one
// is refused, naming its variable.
func TestFromEnvMappedCIDRs(t *testing.T) {
	vars := []string{"UMIAK_GATEWAY_RATELIMIT_EXEMPT_CIDRS", "UMIAK_GATEWAY_PROXY_PROTOCOL_CIDRS", "UMIAK_GATEWAY_TRUSTED_PROXY_CIDRS"}
	got := func(c Config, name string) []netip.Prefix {
		switch name {
		case "UMIAK_GATEWAY_RATELIMIT_EXEMPT_CIDRS":
			return c.RateLimit.Exempt
		case "UMIAK_GATEWAY_PROXY_PROTOCOL_CIDRS":
			return c.ProxyProtocolCIDRs
		default:
			return c.TrustedProxyCIDRs
		}
	}
	for _, name := range vars {
		f := newFixture(t)
		f.env[name] = "::ffff:10.1.2.0/120, ::ffff:192.0.2.7, ::ffff:0:0/96, 2001:db8::/32"
		cfg, err := FromEnv(f.getenv)
		if err != nil {
			t.Fatalf("%s: %v", name, err)
		}
		want := []netip.Prefix{
			netip.MustParsePrefix("10.1.2.0/24"),
			netip.MustParsePrefix("192.0.2.7/32"),
			netip.MustParsePrefix("0.0.0.0/0"),
			netip.MustParsePrefix("2001:db8::/32"),
		}
		p := got(cfg, name)
		if len(p) != len(want) {
			t.Fatalf("%s = %v, want %v", name, p, want)
		}
		for i := range want {
			if p[i] != want[i] {
				t.Errorf("%s[%d] = %s, want %s", name, i, p[i], want[i])
			}
		}
		if !p[0].Contains(netip.MustParseAddr("::ffff:10.1.2.3").Unmap()) {
			t.Errorf("%s: %s does not match the unmapped client 10.1.2.3", name, p[0])
		}

		f = newFixture(t)
		f.env[name] = "::ffff:10.0.0.0/95"
		if _, err := FromEnv(f.getenv); err == nil || !strings.Contains(err.Error(), name) {
			t.Errorf("%s=::ffff:10.0.0.0/95: err = %v, want one naming %s", name, err, name)
		}
	}
}

// TestValidateServeDrainTimeout: UMIAK_GATEWAY_DRAIN_TIMEOUT may not exceed the
// grace period minus 10 s (950 s, the default process bound).
func TestValidateServeDrainTimeout(t *testing.T) {
	f := newFixture(t)
	f.env["UMIAK_GATEWAY_DRAIN_TIMEOUT"] = "950s"
	cfg, err := FromEnv(f.getenv)
	if err != nil {
		t.Fatal(err)
	}
	if err := cfg.ValidateServe(); err != nil {
		t.Fatalf("DRAIN_TIMEOUT=950s: %v", err)
	}
	cfg.DrainTimeout = 951 * time.Second
	err = cfg.ValidateServe()
	if err == nil || !strings.Contains(err.Error(), "UMIAK_GATEWAY_DRAIN_TIMEOUT") {
		t.Fatalf("DRAIN_TIMEOUT=951s: err = %v, want one naming UMIAK_GATEWAY_DRAIN_TIMEOUT", err)
	}
}

// TestValidateServeDrainBudgetCause: the drain budget error names the
// variables set above their defaults.
func TestValidateServeDrainBudgetCause(t *testing.T) {
	const (
		endpoint = "UMIAK_GATEWAY_ENDPOINT_WAIT"
		ssh      = "UMIAK_GATEWAY_SSH_DRAIN_DEADLINE"
		http     = "UMIAK_GATEWAY_HTTP_DRAIN_DEADLINE"
	)
	for _, tc := range []struct {
		name    string
		mutate  func(*Config)
		want    []string
		notWant []string
	}{
		// 5 s + 5 s + 15 min 11 s + 10 s + 30 s = 961 s.
		{"ssh drain deadline", func(c *Config) { c.SSHDrainDeadline = 15*time.Minute + 11*time.Second }, []string{ssh}, []string{endpoint, http}},
		// 16 s + 5 s + 15 min + 10 s + 30 s = 961 s.
		{"endpoint wait", func(c *Config) { c.EndpointWait = 16 * time.Second }, []string{endpoint}, []string{ssh, http}},
		{"both", func(c *Config) {
			c.EndpointWait = 6 * time.Second
			c.SSHDrainDeadline = 15*time.Minute + 10*time.Second
		}, []string{endpoint, ssh}, []string{http}},
		// The HTTP deadline enters the budget when it is the longest; the
		// separate HTTP > SSH check names it too.
		{"http drain deadline", func(c *Config) { c.HTTPDrainDeadline = 16 * time.Minute }, []string{http}, []string{endpoint, ssh}},
	} {
		t.Run(tc.name, func(t *testing.T) {
			f := newFixture(t)
			cfg, err := FromEnv(f.getenv)
			if err != nil {
				t.Fatal(err)
			}
			tc.mutate(&cfg)
			err = cfg.ValidateServe()
			if err == nil {
				t.Fatal("ValidateServe passed")
			}
			var budget string
			for line := range strings.SplitSeq(err.Error(), "\n") {
				if strings.Contains(line, "drain budget") {
					budget = line
				}
			}
			if budget == "" {
				t.Fatalf("no drain budget error in %q", err)
			}
			for _, w := range tc.want {
				if !strings.Contains(budget, w) {
					t.Errorf("%q does not name %s", budget, w)
				}
			}
			for _, w := range tc.notWant {
				if strings.Contains(budget, w) {
					t.Errorf("%q names %s", budget, w)
				}
			}
		})
	}
}

// TestProcessDrainTimeout: the process's drain timeout is DrainTimeout when
// set, else the drain budget plus the process margin, capped at
// MaxDrainTimeout.
func TestProcessDrainTimeout(t *testing.T) {
	f := newFixture(t)
	cfg, err := FromEnv(f.getenv)
	if err != nil {
		t.Fatal(err)
	}
	if got := ProcessDrainTimeout(cfg, gateway.Timing{}); got != 950*time.Second {
		t.Errorf("defaults: %s, want 950s", got)
	}
	// 5 + 5 + 910 + 10 + 30 = 960 s, valid for ValidateServe, but the
	// process bound stays 10 s below the grace period.
	cfg.SSHDrainDeadline = 15*time.Minute + 10*time.Second
	if err := cfg.ValidateServe(); err != nil {
		t.Fatal(err)
	}
	if got := ProcessDrainTimeout(cfg, gateway.Timing{}); got != MaxDrainTimeout {
		t.Errorf("SSH drain 15m10s: %s, want %s", got, MaxDrainTimeout)
	}
	cfg.SSHDrainDeadline, cfg.HTTPDrainDeadline = 2*time.Second, time.Second
	if got := ProcessDrainTimeout(cfg, gateway.Timing{EndpointWait: 100 * time.Millisecond, DrainSpread: 100 * time.Millisecond, DrainMargin: time.Second}); got != 15*time.Minute+31200*time.Millisecond {
		// The TCP drain deadline default (15 min) is the longest.
		t.Errorf("short deadlines: %s", got)
	}
	cfg.DrainTimeout = 3 * time.Second
	if got := ProcessDrainTimeout(cfg, gateway.Timing{}); got != 3*time.Second {
		t.Errorf("explicit: %s, want 3s", got)
	}
}
