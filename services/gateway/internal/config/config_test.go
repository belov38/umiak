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
		"SBX_GATEWAY_INTERNAL_URL":           "http://gw-0.gateway.svc:7000",
		"SBX_GATEWAY_SERVICE_TOKENS_FILE":    writeFile(t, dir, "tokens.json", `{"api":["a1"],"worker":["w1"],"gateway":["g1","g2"]}`),
		"SBX_GATEWAY_COOKIE_KEYS_FILE":       writeFile(t, dir, "cookie.keys", "k1:"+b64key('a')+"\n"),
		"SBX_GATEWAY_TLS_SBX_CERT_FILE":      "/tls/sbx.crt",
		"SBX_GATEWAY_TLS_SBX_KEY_FILE":       "/tls/sbx.key",
		"SBX_GATEWAY_TLS_TUNNEL_CERT_FILE":   "/tls/tunnel.crt",
		"SBX_GATEWAY_TLS_TUNNEL_KEY_FILE":    "/tls/tunnel.key",
		"SBX_GATEWAY_SSH_HOST_KEY_FILES":     hostKey,
		"SBX_GATEWAY_SSH_USER_CA_KEY_FILE":   caKey,
		"SBX_GATEWAY_SSH_LOGIN_CA_KEYS_FILE": loginCAFile,
		"SBX_GATEWAY_API_TOKEN_FILE":         writeFile(t, dir, "api.token", "  api-secret\n"),
		"SBX_GATEWAY_API_URL":                "http://api:3000",
		"SBX_GATEWAY_SBX_DOMAIN":             "sbx.example.com",
		"SBX_GATEWAY_TUNNEL_HOST":            "tunnel.example.com",
		"SBX_GATEWAY_SSH_HOST":               "ssh.example.com",
		"SBX_GATEWAY_DATABASE_URL":           "postgres://x",
	}}
}

func TestFromEnvDefaults(t *testing.T) {
	f := newFixture(t)
	f.env["SBX_GATEWAY_DATABASE_URL"] = ""
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
		{"ReservedSlugs", strings.Join(cfg.ReservedSlugs, ","), "api,app,www,ssh,tunnel,admin,static,sbx"},
		{"HTTPDrainDeadline", cfg.HTTPDrainDeadline, 2 * time.Minute},
		{"SSHDrainDeadline", cfg.SSHDrainDeadline, 15 * time.Minute},
		{"SSHKeepaliveInterval", cfg.SSHKeepaliveInterval, 30 * time.Second},
		{"SSHKeepaliveMax", cfg.SSHKeepaliveMax, 3},
		{"SSHMaxChannels", cfg.SSHMaxChannels, 256},
		{"TLSMaxHandshakesPerIP", cfg.TLSMaxHandshakesPerIP, 64},
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
		"SBX_GATEWAY_INSTANCE_ID":                 "gw-1",
		"SBX_GATEWAY_TLS_LISTEN":                  ":443",
		"SBX_GATEWAY_HTTP_LISTEN":                 ":8080",
		"SBX_GATEWAY_PROXY_PROTOCOL":              "v2",
		"SBX_GATEWAY_PROXY_PROTOCOL_CIDRS":        "10.0.0.0/8, fd00::/8",
		"SBX_GATEWAY_TRUSTED_PROXY_CIDRS":         "192.168.0.0/16",
		"SBX_GATEWAY_RATELIMIT_EXEMPT_CIDRS":      "203.0.113.0/24",
		"SBX_GATEWAY_RATELIMIT_IP_RATE":           "5.5",
		"SBX_GATEWAY_RATELIMIT_AUTH_BLOCK":        "1m",
		"SBX_GATEWAY_RESERVED_PORTS":              "22, 8080",
		"SBX_GATEWAY_TIMEOUT_DIAL":                "3s",
		"SBX_GATEWAY_TIMEOUT_STREAM_IDLE":         "30m",
		"SBX_GATEWAY_MAX_HEADER_BYTES":            "1024",
		"SBX_GATEWAY_COOKIE_CROSS_SITE":           "true",
		"SBX_GATEWAY_HTTP_DRAIN_DEADLINE":         "30s",
		"SBX_GATEWAY_TUNNEL_ADMIT_RATE":           "50",
		"SBX_GATEWAY_TUNNEL_ADMIT_BURST":          "60",
		"SBX_GATEWAY_MIN_AGENT_VERSION":           "1.2.3",
		"SBX_GATEWAY_LOG_LEVEL":                   "debug",
		"SBX_GATEWAY_STRIP_COOKIE_PREFIXES":       "a,b",
		"SBX_GATEWAY_AUTH_URL":                    "https://app.example.com/authorize",
		"SBX_GATEWAY_RESERVED_SUFFIXES":           "desktop,vnc",
		"SBX_GATEWAY_RESERVED_SLUGS":              "api",
		"SBX_GATEWAY_TIMEOUT_RESPONSE_HEADER":     "1m",
		"SBX_GATEWAY_TLS_MAX_HANDSHAKES_PER_IP":   "16",
		"SBX_GATEWAY_SSH_LOGIN_CERT_MAX_VALIDITY": "1h",
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
	if cfg.SSHLoginCertMaxValidity != time.Hour {
		t.Errorf("SSHLoginCertMaxValidity = %s", cfg.SSHLoginCertMaxValidity)
	}
	if strings.Join(cfg.StripCookiePrefixes, "|") != "a|b" || strings.Join(cfg.ReservedSuffixes, "|") != "desktop|vnc" || cfg.AuthURL == "" {
		t.Errorf("lists: %+v", cfg)
	}
}

func TestFromEnvDisableListeners(t *testing.T) {
	f := newFixture(t)
	f.env["SBX_GATEWAY_TLS_LISTEN"] = "off"
	f.env["SBX_GATEWAY_SSH_LISTEN"] = "off"
	for _, k := range []string{
		"SBX_GATEWAY_TLS_SBX_CERT_FILE", "SBX_GATEWAY_TLS_SBX_KEY_FILE",
		"SBX_GATEWAY_TLS_TUNNEL_CERT_FILE", "SBX_GATEWAY_TLS_TUNNEL_KEY_FILE",
		"SBX_GATEWAY_SSH_HOST_KEY_FILES", "SBX_GATEWAY_SSH_USER_CA_KEY_FILE", "SBX_GATEWAY_SSH_LOGIN_CA_KEYS_FILE",
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
	f.env["SBX_GATEWAY_COOKIE_KEYS_FILE"] = writeFile(t, f.dir, "cookie2.keys",
		"# comment\n\nk1:"+b64key('a')+"\nk2:"+k2+"\n")
	hk2, signer2 := writeSSHKey(t, f.dir, "host2")
	f.env["SBX_GATEWAY_SSH_HOST_KEY_FILES"] += "," + hk2
	_, l2 := writeSSHKey(t, f.dir, "l2")
	_, l3 := writeSSHKey(t, f.dir, "l3")
	f.env["SBX_GATEWAY_SSH_LOGIN_CA_KEYS_FILE"] = writeFile(t, f.dir, "login2.pub",
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
		{"missing internal url", func(f *fixture) { delete(f.env, "SBX_GATEWAY_INTERNAL_URL") }, "SBX_GATEWAY_INTERNAL_URL"},
		{"cookie key not 32 bytes", func(f *fixture) {
			f.env["SBX_GATEWAY_COOKIE_KEYS_FILE"] = writeFile(t, f.dir, "short.keys", "k1:"+base64.StdEncoding.EncodeToString([]byte("short"))+"\n")
		}, "SBX_GATEWAY_COOKIE_KEYS_FILE"},
		{"cookie key duplicate kid", func(f *fixture) {
			f.env["SBX_GATEWAY_COOKIE_KEYS_FILE"] = writeFile(t, f.dir, "dup.keys", "k1:"+b64key('a')+"\nk1:"+b64key('b')+"\n")
		}, "SBX_GATEWAY_COOKIE_KEYS_FILE"},
		{"cookie keys empty", func(f *fixture) {
			f.env["SBX_GATEWAY_COOKIE_KEYS_FILE"] = writeFile(t, f.dir, "empty.keys", "# nothing\n")
		}, "SBX_GATEWAY_COOKIE_KEYS_FILE"},
		{"cookie key id not cookie-safe", func(f *fixture) {
			f.env["SBX_GATEWAY_COOKIE_KEYS_FILE"] = writeFile(t, f.dir, "badkid.keys", "k;1:"+b64key('a')+"\n")
		}, "SBX_GATEWAY_COOKIE_KEYS_FILE"},
		{"cookie key id with space", func(f *fixture) {
			f.env["SBX_GATEWAY_COOKIE_KEYS_FILE"] = writeFile(t, f.dir, "spacekid.keys", "k 1:"+b64key('a')+"\n")
		}, "SBX_GATEWAY_COOKIE_KEYS_FILE"},
		{"cookie keys unset", func(f *fixture) { delete(f.env, "SBX_GATEWAY_COOKIE_KEYS_FILE") }, "SBX_GATEWAY_COOKIE_KEYS_FILE"},
		{"bad cidr", func(f *fixture) { f.env["SBX_GATEWAY_TRUSTED_PROXY_CIDRS"] = "10.0.0.0/8,nonsense" }, "SBX_GATEWAY_TRUSTED_PROXY_CIDRS"},
		{"bad exempt cidr", func(f *fixture) { f.env["SBX_GATEWAY_RATELIMIT_EXEMPT_CIDRS"] = "1.2.3.4/99" }, "SBX_GATEWAY_RATELIMIT_EXEMPT_CIDRS"},
		{"bad proxy protocol", func(f *fixture) { f.env["SBX_GATEWAY_PROXY_PROTOCOL"] = "v3" }, "SBX_GATEWAY_PROXY_PROTOCOL"},
		{"bad duration", func(f *fixture) { f.env["SBX_GATEWAY_TIMEOUT_DIAL"] = "ten" }, "SBX_GATEWAY_TIMEOUT_DIAL"},
		{"non-positive duration", func(f *fixture) { f.env["SBX_GATEWAY_TIMEOUT_DIAL"] = "-1s" }, "SBX_GATEWAY_TIMEOUT_DIAL"},
		{"bad int", func(f *fixture) { f.env["SBX_GATEWAY_MAX_HEADER_BYTES"] = "x" }, "SBX_GATEWAY_MAX_HEADER_BYTES"},
		{"bad handshakes per ip", func(f *fixture) { f.env["SBX_GATEWAY_TLS_MAX_HANDSHAKES_PER_IP"] = "0" }, "SBX_GATEWAY_TLS_MAX_HANDSHAKES_PER_IP"},
		{"bad port", func(f *fixture) { f.env["SBX_GATEWAY_RESERVED_PORTS"] = "22,70000" }, "SBX_GATEWAY_RESERVED_PORTS"},
		{"bad bool", func(f *fixture) { f.env["SBX_GATEWAY_COOKIE_CROSS_SITE"] = "maybe" }, "SBX_GATEWAY_COOKIE_CROSS_SITE"},
		{"bad log level", func(f *fixture) { f.env["SBX_GATEWAY_LOG_LEVEL"] = "loud" }, "SBX_GATEWAY_LOG_LEVEL"},
		{"tokens without gateway", func(f *fixture) {
			f.env["SBX_GATEWAY_SERVICE_TOKENS_FILE"] = writeFile(t, f.dir, "t2.json", `{"api":["a"]}`)
		}, "SBX_GATEWAY_SERVICE_TOKENS_FILE"},
		{"tokens bad json", func(f *fixture) {
			f.env["SBX_GATEWAY_SERVICE_TOKENS_FILE"] = writeFile(t, f.dir, "t3.json", `{`)
		}, "SBX_GATEWAY_SERVICE_TOKENS_FILE"},
		{"tokens file missing", func(f *fixture) { f.env["SBX_GATEWAY_SERVICE_TOKENS_FILE"] = "/nonexistent/tokens.json" }, "SBX_GATEWAY_SERVICE_TOKENS_FILE"},
		{"tls cert missing with tls listen", func(f *fixture) { delete(f.env, "SBX_GATEWAY_TLS_SBX_CERT_FILE") }, "SBX_GATEWAY_TLS_SBX_CERT_FILE"},
		{"ssh host key missing with ssh listen", func(f *fixture) { delete(f.env, "SBX_GATEWAY_SSH_HOST_KEY_FILES") }, "SBX_GATEWAY_SSH_HOST_KEY_FILES"},
		{"ssh user ca missing", func(f *fixture) { delete(f.env, "SBX_GATEWAY_SSH_USER_CA_KEY_FILE") }, "SBX_GATEWAY_SSH_USER_CA_KEY_FILE"},
		{"ssh host key garbage", func(f *fixture) {
			f.env["SBX_GATEWAY_SSH_HOST_KEY_FILES"] = writeFile(t, f.dir, "junk", "not a key")
		}, "SBX_GATEWAY_SSH_HOST_KEY_FILES"},
		{"login ca garbage", func(f *fixture) {
			f.env["SBX_GATEWAY_SSH_LOGIN_CA_KEYS_FILE"] = writeFile(t, f.dir, "junk.pub", "ssh-ed25519 !!!\n")
		}, "SBX_GATEWAY_SSH_LOGIN_CA_KEYS_FILE"},
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
	f.env["SBX_GATEWAY_ENDPOINT_WAIT"] = "100ms"
	f.env["SBX_GATEWAY_DRAIN_TIMEOUT"] = "3s"
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
		{"no domain", func(c *Config) { c.SbxDomain = "" }, "SBX_GATEWAY_SBX_DOMAIN"},
		{"no tunnel host", func(c *Config) { c.TunnelHost = "" }, "SBX_GATEWAY_TUNNEL_HOST"},
		{"no database", func(c *Config) { c.DatabaseURL = "" }, "SBX_GATEWAY_DATABASE_URL"},
		{"no api url", func(c *Config) { c.APIURL = "" }, "SBX_GATEWAY_API_URL"},
		{"bad api url", func(c *Config) { c.APIURL = "api:3000" }, "SBX_GATEWAY_API_URL"},
		{"no api token", func(c *Config) { c.APIToken = "" }, "SBX_GATEWAY_API_TOKEN_FILE"},
		{"bad internal url", func(c *Config) { c.InternalURL = "gateway:7000" }, "SBX_GATEWAY_INTERNAL_URL"},
		{"proxy v2 without cidrs", func(c *Config) { c.ProxyProtocol, c.ProxyProtocolCIDRs = true, nil }, "SBX_GATEWAY_PROXY_PROTOCOL_CIDRS"},
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
