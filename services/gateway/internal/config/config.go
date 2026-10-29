// Package config reads the gateway configuration from the environment
// (spec section 16.2). Secrets and keys come from files named by *_FILE
// variables.
package config

import (
	"bufio"
	"crypto/rand"
	"encoding/base64"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"net/netip"
	"os"
	"strconv"
	"strings"
	"time"

	"golang.org/x/crypto/ssh"

	"github.com/belov38/boat-dev-clone/libs/tunnel/gateway"
	"github.com/belov38/boat-dev-clone/services/gateway/internal/ratelimit"
)

const envPrefix = "SBX_GATEWAY_"

// CookieKey is one key of the session cookie codec. The first key signs; all
// keys verify.
type CookieKey struct {
	ID  string
	Key []byte
}

// Timeouts are the limits of spec section 7.7.
type Timeouts struct {
	TLSHandshake   time.Duration
	ReadHeader     time.Duration
	MaxHeaderBytes int
	ClientIdle     time.Duration
	RouteLookup    time.Duration
	AgentWait      time.Duration
	Dial           time.Duration
	ResponseHeader time.Duration
	StreamIdle     time.Duration
}

// Config is the validated gateway configuration.
type Config struct {
	// Identity and internal listener.
	InstanceID     string
	DatabaseURL    string
	InternalListen string
	InternalURL    string
	ServiceTokens  gateway.TokenSet
	PeerToken      string // first token of ServiceTokens["gateway"]

	// Listeners. An empty TLSListen or SSHListen disables that listener.
	TLSListen     string
	SSHListen     string
	HTTPListen    string
	MetricsListen string

	// Names.
	SbxDomain  string
	TunnelHost string
	SSHHost    string

	// TLS files (required when TLSListen is set).
	SbxCertFile    string
	SbxKeyFile     string
	TunnelCertFile string
	TunnelKeyFile  string

	// Client IP.
	ProxyProtocol      bool
	ProxyProtocolCIDRs []netip.Prefix
	TrustedProxyCIDRs  []netip.Prefix

	// API.
	APIURL   string
	APIToken string
	AuthURL  string

	// Cookies.
	CookieKeys          []CookieKey
	CookieCrossSite     bool
	StripCookiePrefixes []string

	// SSH keys (required when SSHListen is set; login CA keys may be empty).
	SSHHostKeys    []ssh.Signer
	SSHUserCA      ssh.Signer
	SSHLoginCAKeys []ssh.PublicKey

	// Reserved names.
	ReservedPorts    []int
	ReservedSuffixes []string
	ReservedSlugs    []string

	// Rate limits.
	RateLimit ratelimit.Config

	// Drain.
	HTTPDrainDeadline time.Duration
	SSHDrainDeadline  time.Duration

	Timeouts Timeouts

	// Tunnel.
	TunnelAdmitRate  float64
	TunnelAdmitBurst int
	MinAgentVersion  string

	LogLevel string
}

// FromEnv reads and validates the configuration. getenv is normally os.Getenv;
// an empty value means "unset". Errors name the offending variable.
func FromEnv(getenv func(string) string) (Config, error) {
	l := &loader{getenv: getenv}
	var c Config

	c.InstanceID = l.str("INSTANCE_ID", "")
	if c.InstanceID == "" {
		c.InstanceID = defaultInstanceID()
	}
	c.DatabaseURL = l.str("DATABASE_URL", getenv("DATABASE_URL"))
	c.InternalListen = l.str("INTERNAL_LISTEN", ":7000")
	c.InternalURL = l.required("INTERNAL_URL")

	c.TLSListen = l.listen("TLS_LISTEN", ":8443")
	c.SSHListen = l.listen("SSH_LISTEN", ":2222")
	c.HTTPListen = l.listen("HTTP_LISTEN", "")
	c.MetricsListen = l.str("METRICS_LISTEN", ":9090")

	c.SbxDomain = l.str("SBX_DOMAIN", "")
	c.TunnelHost = l.str("TUNNEL_HOST", "")
	c.SSHHost = l.str("SSH_HOST", "")

	if c.TLSListen != "" {
		c.SbxCertFile = l.required("TLS_SBX_CERT_FILE")
		c.SbxKeyFile = l.required("TLS_SBX_KEY_FILE")
		c.TunnelCertFile = l.required("TLS_TUNNEL_CERT_FILE")
		c.TunnelKeyFile = l.required("TLS_TUNNEL_KEY_FILE")
	} else {
		c.SbxCertFile = l.str("TLS_SBX_CERT_FILE", "")
		c.SbxKeyFile = l.str("TLS_SBX_KEY_FILE", "")
		c.TunnelCertFile = l.str("TLS_TUNNEL_CERT_FILE", "")
		c.TunnelKeyFile = l.str("TLS_TUNNEL_KEY_FILE", "")
	}

	switch pp := l.str("PROXY_PROTOCOL", "off"); pp {
	case "off":
	case "v2":
		c.ProxyProtocol = true
	default:
		l.fail("PROXY_PROTOCOL", fmt.Errorf("invalid value %q, want off or v2", pp))
	}
	c.ProxyProtocolCIDRs = l.cidrs("PROXY_PROTOCOL_CIDRS")
	c.TrustedProxyCIDRs = l.cidrs("TRUSTED_PROXY_CIDRS")

	c.APIURL = l.str("API_URL", "")
	c.APIToken = l.fileText("API_TOKEN_FILE", false)
	c.AuthURL = l.str("AUTH_URL", "")

	c.ServiceTokens, c.PeerToken = l.serviceTokens("SERVICE_TOKENS_FILE")
	c.CookieKeys = l.cookieKeys("COOKIE_KEYS_FILE")
	c.CookieCrossSite = l.boolean("COOKIE_CROSS_SITE", false)
	c.StripCookiePrefixes = l.list("STRIP_COOKIE_PREFIXES", []string{"_oauth2_proxy", "__Host-oauth2_proxy", "__Secure-oauth2_proxy"})

	if c.SSHListen != "" {
		c.SSHHostKeys = l.hostKeys("SSH_HOST_KEY_FILES")
		c.SSHUserCA = l.privateKey("SSH_USER_CA_KEY_FILE", true)
		c.SSHLoginCAKeys = l.loginCAKeys("SSH_LOGIN_CA_KEYS_FILE")
	}

	c.ReservedPorts = l.ports("RESERVED_PORTS", []int{22, 47800, 47984, 47989, 47990, 48010})
	c.ReservedSuffixes = l.list("RESERVED_SUFFIXES", []string{"desktop"})
	c.ReservedSlugs = l.list("RESERVED_SLUGS", []string{"api", "app", "www", "ssh", "tunnel", "admin", "static", "sbx"})

	c.RateLimit = ratelimit.Config{
		IPRate:             l.float("RATELIMIT_IP_RATE", 300),
		IPBurst:            l.integer("RATELIMIT_IP_BURST", 2000),
		LabelRate:          l.float("RATELIMIT_LABEL_RATE", 1000),
		LabelBurst:         l.integer("RATELIMIT_LABEL_BURST", 3000),
		AuthFailPerMin:     l.integer("RATELIMIT_AUTH_FAIL_PER_MIN", 20),
		AuthBlock:          l.duration("RATELIMIT_AUTH_BLOCK", 5*time.Minute),
		ConnsPerIP:         l.integer("RATELIMIT_CONNS_PER_IP", 512),
		SSHConnPerMin:      l.integer("RATELIMIT_SSH_CONN_PER_MIN", 10),
		SSHConnBurst:       l.integer("RATELIMIT_SSH_CONN_BURST", 20),
		SSHAuthFailPerMin:  l.integer("RATELIMIT_SSH_AUTH_FAIL_PER_MIN", 10),
		SSHSessionsPerUser: l.integer("RATELIMIT_SSH_SESSIONS_PER_USER", 20),
		Exempt:             l.cidrs("RATELIMIT_EXEMPT_CIDRS"),
	}

	c.HTTPDrainDeadline = l.duration("HTTP_DRAIN_DEADLINE", 2*time.Minute)
	c.SSHDrainDeadline = l.duration("SSH_DRAIN_DEADLINE", 15*time.Minute)

	c.Timeouts = Timeouts{
		TLSHandshake:   l.duration("TIMEOUT_TLS_HANDSHAKE", 10*time.Second),
		ReadHeader:     l.duration("TIMEOUT_READ_HEADER", 10*time.Second),
		MaxHeaderBytes: l.integer("MAX_HEADER_BYTES", 64<<10),
		ClientIdle:     l.duration("TIMEOUT_CLIENT_IDLE", 120*time.Second),
		RouteLookup:    l.duration("TIMEOUT_ROUTE_LOOKUP", 3*time.Second),
		AgentWait:      l.duration("TIMEOUT_AGENT_WAIT", 10*time.Second),
		Dial:           l.duration("TIMEOUT_DIAL", 10*time.Second),
		ResponseHeader: l.duration("TIMEOUT_RESPONSE_HEADER", 5*time.Minute),
		StreamIdle:     l.duration("TIMEOUT_STREAM_IDLE", 60*time.Minute),
	}

	c.TunnelAdmitRate = l.float("TUNNEL_ADMIT_RATE", 200)
	c.TunnelAdmitBurst = l.integer("TUNNEL_ADMIT_BURST", 1000)
	c.MinAgentVersion = l.str("MIN_AGENT_VERSION", "")

	c.LogLevel = l.str("LOG_LEVEL", "info")
	switch c.LogLevel {
	case "debug", "info", "warn", "error":
	default:
		l.fail("LOG_LEVEL", fmt.Errorf("invalid value %q, want debug, info, warn or error", c.LogLevel))
	}

	if l.err != nil {
		return Config{}, l.err
	}
	return c, nil
}

func defaultInstanceID() string {
	host, err := os.Hostname()
	if err != nil || host == "" {
		host = "gateway"
	}
	var b [4]byte
	_, _ = rand.Read(b[:])
	return host + "-" + hex.EncodeToString(b[:])
}

// loader reads variables and keeps the first error.
type loader struct {
	getenv func(string) string
	err    error
}

func (l *loader) fail(name string, err error) {
	if l.err == nil {
		l.err = fmt.Errorf("%s%s: %w", envPrefix, name, err)
	}
}

func (l *loader) raw(name string) string {
	return strings.TrimSpace(l.getenv(envPrefix + name))
}

func (l *loader) str(name, def string) string {
	if v := l.raw(name); v != "" {
		return v
	}
	return def
}

func (l *loader) required(name string) string {
	v := l.raw(name)
	if v == "" {
		l.fail(name, errors.New("is required"))
	}
	return v
}

// listen reads a listen address. "off" disables the listener, since an empty
// value means "use the default".
func (l *loader) listen(name, def string) string {
	v := l.str(name, def)
	if v == "off" {
		return ""
	}
	return v
}

func (l *loader) boolean(name string, def bool) bool {
	v := l.raw(name)
	if v == "" {
		return def
	}
	b, err := strconv.ParseBool(v)
	if err != nil {
		l.fail(name, fmt.Errorf("invalid boolean %q", v))
		return def
	}
	return b
}

func (l *loader) integer(name string, def int) int {
	v := l.raw(name)
	if v == "" {
		return def
	}
	n, err := strconv.Atoi(v)
	if err != nil || n <= 0 {
		l.fail(name, fmt.Errorf("invalid value %q, want a positive integer", v))
		return def
	}
	return n
}

func (l *loader) float(name string, def float64) float64 {
	v := l.raw(name)
	if v == "" {
		return def
	}
	f, err := strconv.ParseFloat(v, 64)
	if err != nil || f <= 0 {
		l.fail(name, fmt.Errorf("invalid value %q, want a positive number", v))
		return def
	}
	return f
}

func (l *loader) duration(name string, def time.Duration) time.Duration {
	v := l.raw(name)
	if v == "" {
		return def
	}
	d, err := time.ParseDuration(v)
	if err != nil || d <= 0 {
		l.fail(name, fmt.Errorf("invalid value %q, want a positive duration like 10s", v))
		return def
	}
	return d
}

// list reads a comma-separated list; empty items are dropped.
func (l *loader) list(name string, def []string) []string {
	v := l.raw(name)
	if v == "" {
		return def
	}
	var out []string
	for _, p := range strings.Split(v, ",") {
		if p = strings.TrimSpace(p); p != "" {
			out = append(out, p)
		}
	}
	return out
}

func (l *loader) ports(name string, def []int) []int {
	items := l.list(name, nil)
	if items == nil {
		return def
	}
	out := make([]int, 0, len(items))
	for _, it := range items {
		n, err := strconv.Atoi(it)
		if err != nil || n < 1 || n > 65535 {
			l.fail(name, fmt.Errorf("invalid port %q", it))
			return def
		}
		out = append(out, n)
	}
	return out
}

// cidrs reads a comma-separated list of prefixes. A bare address is a
// single-host prefix.
func (l *loader) cidrs(name string) []netip.Prefix {
	var out []netip.Prefix
	for _, it := range l.list(name, nil) {
		if p, err := netip.ParsePrefix(it); err == nil {
			out = append(out, p.Masked())
			continue
		}
		a, err := netip.ParseAddr(it)
		if err != nil {
			l.fail(name, fmt.Errorf("invalid CIDR %q", it))
			return nil
		}
		out = append(out, netip.PrefixFrom(a, a.BitLen()))
	}
	return out
}

// fileText reads the file named by the variable and trims it. A missing
// variable is an error only when required.
func (l *loader) fileText(name string, required bool) string {
	path := l.raw(name)
	if path == "" {
		if required {
			l.fail(name, errors.New("is required"))
		}
		return ""
	}
	b, err := os.ReadFile(path)
	if err != nil {
		l.fail(name, err)
		return ""
	}
	return strings.TrimSpace(string(b))
}

func (l *loader) serviceTokens(name string) (gateway.TokenSet, string) {
	path := l.raw(name)
	if path == "" {
		l.fail(name, errors.New("is required"))
		return nil, ""
	}
	b, err := os.ReadFile(path)
	if err != nil {
		l.fail(name, err)
		return nil, ""
	}
	var ts gateway.TokenSet
	if err := json.Unmarshal(b, &ts); err != nil {
		l.fail(name, fmt.Errorf("invalid JSON: %w", err))
		return nil, ""
	}
	g := ts["gateway"]
	if len(g) == 0 || g[0] == "" {
		l.fail(name, errors.New(`has no "gateway" token`))
		return nil, ""
	}
	return ts, g[0]
}

// cookieKeys reads lines "kid:base64(32 bytes)". Blank and # lines are
// skipped. Standard and URL-safe base64, padded or not, are accepted.
func (l *loader) cookieKeys(name string) []CookieKey {
	path := l.raw(name)
	if path == "" {
		l.fail(name, errors.New("is required"))
		return nil
	}
	f, err := os.Open(path)
	if err != nil {
		l.fail(name, err)
		return nil
	}
	defer func() { _ = f.Close() }()

	var keys []CookieKey
	seen := map[string]bool{}
	sc := bufio.NewScanner(f)
	for n := 1; sc.Scan(); n++ {
		line := strings.TrimSpace(sc.Text())
		if line == "" || strings.HasPrefix(line, "#") {
			continue
		}
		id, enc, ok := strings.Cut(line, ":")
		id, enc = strings.TrimSpace(id), strings.TrimSpace(enc)
		if !ok || id == "" || enc == "" {
			l.fail(name, fmt.Errorf("line %d: want kid:base64", n))
			return nil
		}
		key, err := decodeBase64(enc)
		if err != nil {
			l.fail(name, fmt.Errorf("line %d: key %q is not base64", n, id))
			return nil
		}
		if len(key) != 32 {
			l.fail(name, fmt.Errorf("line %d: key %q is %d bytes, want 32", n, id, len(key)))
			return nil
		}
		if seen[id] {
			l.fail(name, fmt.Errorf("line %d: duplicate key id %q", n, id))
			return nil
		}
		seen[id] = true
		keys = append(keys, CookieKey{ID: id, Key: key})
	}
	if err := sc.Err(); err != nil {
		l.fail(name, err)
		return nil
	}
	if len(keys) == 0 {
		l.fail(name, errors.New("contains no keys"))
	}
	return keys
}

func decodeBase64(s string) ([]byte, error) {
	for _, enc := range []*base64.Encoding{base64.StdEncoding, base64.URLEncoding, base64.RawStdEncoding, base64.RawURLEncoding} {
		if b, err := enc.DecodeString(s); err == nil {
			return b, nil
		}
	}
	return nil, errors.New("invalid base64")
}

func (l *loader) hostKeys(name string) []ssh.Signer {
	paths := l.list(name, nil)
	if len(paths) == 0 {
		l.fail(name, errors.New("is required"))
		return nil
	}
	var out []ssh.Signer
	for _, p := range paths {
		s, err := parsePrivateKeyFile(p)
		if err != nil {
			l.fail(name, err)
			return nil
		}
		out = append(out, s)
	}
	return out
}

func (l *loader) privateKey(name string, required bool) ssh.Signer {
	path := l.raw(name)
	if path == "" {
		if required {
			l.fail(name, errors.New("is required"))
		}
		return nil
	}
	s, err := parsePrivateKeyFile(path)
	if err != nil {
		l.fail(name, err)
		return nil
	}
	return s
}

func parsePrivateKeyFile(path string) (ssh.Signer, error) {
	b, err := os.ReadFile(path)
	if err != nil {
		return nil, err
	}
	s, err := ssh.ParsePrivateKey(b)
	if err != nil {
		return nil, fmt.Errorf("%s: %w", path, err)
	}
	return s, nil
}

// loginCAKeys reads public keys in authorized_keys format, one per line.
// The variable is optional: without it, no certificate can log in.
func (l *loader) loginCAKeys(name string) []ssh.PublicKey {
	path := l.raw(name)
	if path == "" {
		return nil
	}
	b, err := os.ReadFile(path)
	if err != nil {
		l.fail(name, err)
		return nil
	}
	var out []ssh.PublicKey
	for n, line := range strings.Split(string(b), "\n") {
		line = strings.TrimSpace(line)
		if line == "" || strings.HasPrefix(line, "#") {
			continue
		}
		pk, _, _, _, err := ssh.ParseAuthorizedKey([]byte(line))
		if err != nil {
			l.fail(name, fmt.Errorf("line %d: %w", n+1, err))
			return nil
		}
		out = append(out, pk)
	}
	return out
}
