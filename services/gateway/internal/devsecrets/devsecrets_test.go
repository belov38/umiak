package devsecrets_test

import (
	"bytes"
	"crypto/tls"
	"crypto/x509"
	"encoding/json"
	"encoding/pem"
	"errors"
	"io/fs"
	"os"
	"path/filepath"
	"slices"
	"strings"
	"testing"

	"github.com/belov38/boat-dev-clone/services/gateway/internal/config"
	"github.com/belov38/boat-dev-clone/services/gateway/internal/devsecrets"
)

func generate(t *testing.T, dir string) []string {
	t.Helper()
	created, err := devsecrets.Generate(devsecrets.Options{Dir: dir})
	if err != nil {
		t.Fatal(err)
	}
	return created
}

// snapshot returns the content and mode of every file in dir.
func snapshot(t *testing.T, dir string) map[string]string {
	t.Helper()
	out := map[string]string{}
	entries, err := os.ReadDir(dir)
	if err != nil {
		t.Fatal(err)
	}
	for _, e := range entries {
		p := filepath.Join(dir, e.Name())
		st, err := os.Stat(p)
		if err != nil {
			t.Fatal(err)
		}
		b, err := os.ReadFile(p)
		if err != nil {
			t.Fatal(err)
		}
		out[e.Name()] = st.Mode().Perm().String() + "\n" + string(b)
	}
	return out
}

// envFor is the gateway environment that uses the files of dir.
func envFor(dir string) map[string]string {
	f := func(name string) string { return filepath.Join(dir, name) }
	return map[string]string{
		"SBX_GATEWAY_INTERNAL_URL":           "http://gateway:7000",
		"SBX_GATEWAY_DATABASE_URL":           "postgres://sbx:sbx@postgres:5432/sbx",
		"SBX_GATEWAY_SBX_DOMAIN":             "sbx.localhost",
		"SBX_GATEWAY_TUNNEL_HOST":            "tunnel.localhost",
		"SBX_GATEWAY_SSH_HOST":               "ssh.localhost",
		"SBX_GATEWAY_API_URL":                "http://api:8082",
		"SBX_GATEWAY_API_TOKEN_FILE":         f("api-token"),
		"SBX_GATEWAY_SERVICE_TOKENS_FILE":    f("service-tokens.json"),
		"SBX_GATEWAY_COOKIE_KEYS_FILE":       f("cookie-keys"),
		"SBX_GATEWAY_TLS_SBX_CERT_FILE":      f("sbx.pem"),
		"SBX_GATEWAY_TLS_SBX_KEY_FILE":       f("sbx.key"),
		"SBX_GATEWAY_TLS_TUNNEL_CERT_FILE":   f("tunnel.pem"),
		"SBX_GATEWAY_TLS_TUNNEL_KEY_FILE":    f("tunnel.key"),
		"SBX_GATEWAY_SSH_HOST_KEY_FILES":     f("ssh_host_ed25519_key") + "," + f("ssh_host_ecdsa_key"),
		"SBX_GATEWAY_SSH_USER_CA_KEY_FILE":   f("ssh_user_ca"),
		"SBX_GATEWAY_SSH_LOGIN_CA_KEYS_FILE": f("login-ca-keys"),
	}
}

func verifyLeaf(t *testing.T, dir, name, host string) {
	t.Helper()
	pair, err := tls.LoadX509KeyPair(filepath.Join(dir, name+".pem"), filepath.Join(dir, name+".key"))
	if err != nil {
		t.Fatalf("%s pair: %v", name, err)
	}
	caPEM, err := os.ReadFile(filepath.Join(dir, "ca.pem"))
	if err != nil {
		t.Fatal(err)
	}
	roots := x509.NewCertPool()
	if !roots.AppendCertsFromPEM(caPEM) {
		t.Fatal("ca.pem holds no certificate")
	}
	if _, err := pair.Leaf.Verify(x509.VerifyOptions{DNSName: host, Roots: roots}); err != nil {
		t.Fatalf("%s for %s: %v", name, host, err)
	}
}

func TestDevSecretsIdempotent(t *testing.T) {
	dir := t.TempDir()
	created := generate(t, dir)
	want := []string{
		"api-token", "ca.key", "ca.pem", "cookie-keys", "login-ca-keys",
		"sbx.key", "sbx.pem", "service-tokens.json",
		"ssh_host_ecdsa_key", "ssh_host_ecdsa_key.pub", "ssh_host_ed25519_key", "ssh_host_ed25519_key.pub",
		"ssh_login_ca", "ssh_login_ca.pub", "ssh_user_ca", "ssh_user_ca.pub",
		"tunnel.key", "tunnel.pem", "worker-gateway-token",
	}
	slices.Sort(created)
	if !slices.Equal(created, want) {
		t.Fatalf("created %v\nwant %v", created, want)
	}

	before := snapshot(t, dir)
	if again := generate(t, dir); len(again) != 0 {
		t.Fatalf("second run created %v", again)
	}
	after := snapshot(t, dir)
	for name, v := range before {
		if after[name] != v {
			t.Errorf("%s changed on the second run", name)
		}
	}

	// Modes: secrets 0600, public files 0644.
	for _, name := range want {
		st, err := os.Stat(filepath.Join(dir, name))
		if err != nil {
			t.Fatal(err)
		}
		public := strings.HasSuffix(name, ".pub") || strings.HasSuffix(name, ".pem") || name == "login-ca-keys"
		wantMode := fs.FileMode(0o600)
		if public {
			wantMode = 0o644
		}
		if st.Mode().Perm() != wantMode {
			t.Errorf("%s mode %v, want %v", name, st.Mode().Perm(), wantMode)
		}
	}

	// The files load as a serving configuration.
	env := envFor(dir)
	cfg, err := config.FromEnv(func(k string) string { return env[k] })
	if err != nil {
		t.Fatal(err)
	}
	if err := cfg.ValidateServe(); err != nil {
		t.Fatal(err)
	}
	if len(cfg.SSHHostKeys) != 2 || cfg.SSHUserCA == nil || len(cfg.SSHLoginCAKeys) != 1 || len(cfg.CookieKeys) != 1 {
		t.Fatalf("keys: host %d, user CA %v, login CAs %d, cookie %d", len(cfg.SSHHostKeys), cfg.SSHUserCA != nil, len(cfg.SSHLoginCAKeys), len(cfg.CookieKeys))
	}
	verifyLeaf(t, dir, "sbx", "demo-3000.sbx.localhost")
	verifyLeaf(t, dir, "tunnel", "tunnel.localhost")

	// The worker's token is the first worker token the gateway accepts.
	var tokens map[string][]string
	b, _ := os.ReadFile(filepath.Join(dir, "service-tokens.json"))
	if err := json.Unmarshal(b, &tokens); err != nil {
		t.Fatal(err)
	}
	w, _ := os.ReadFile(filepath.Join(dir, "worker-gateway-token"))
	if len(tokens["worker"]) == 0 || strings.TrimSpace(string(w)) != tokens["worker"][0] {
		t.Fatalf("worker-gateway-token %q, tokens %v", w, tokens)
	}
	for _, k := range []string{"api", "worker", "gateway"} {
		if len(tokens[k]) != 1 || len(tokens[k][0]) < 32 {
			t.Fatalf("tokens[%q] = %v", k, tokens[k])
		}
	}
	apiTok, _ := os.ReadFile(filepath.Join(dir, "api-token"))
	if strings.TrimSpace(string(apiTok)) == "" || strings.TrimSpace(string(apiTok)) == tokens["gateway"][0] {
		t.Fatalf("api-token %q must be its own secret", apiTok)
	}
	// The login CA keys file holds the login CA public key.
	pub, _ := os.ReadFile(filepath.Join(dir, "ssh_login_ca.pub"))
	keys, _ := os.ReadFile(filepath.Join(dir, "login-ca-keys"))
	if !bytes.Contains(keys, bytes.TrimSpace(pub)) {
		t.Fatalf("login-ca-keys %q lacks ssh_login_ca.pub %q", keys, pub)
	}
}

func TestDevSecretsRecreatesOnlyMissing(t *testing.T) {
	dir := t.TempDir()
	generate(t, dir)
	before := snapshot(t, dir)
	for _, name := range []string{"sbx.pem", "sbx.key", "worker-gateway-token", "ssh_user_ca.pub", "login-ca-keys"} {
		if err := os.Remove(filepath.Join(dir, name)); err != nil {
			t.Fatal(err)
		}
	}
	created := generate(t, dir)
	slices.Sort(created)
	if want := []string{"login-ca-keys", "sbx.key", "sbx.pem", "ssh_user_ca.pub", "worker-gateway-token"}; !slices.Equal(created, want) {
		t.Fatalf("created %v, want %v", created, want)
	}
	after := snapshot(t, dir)
	// Derived files come back unchanged; the new leaf still chains to the
	// old CA.
	for _, name := range []string{"worker-gateway-token", "ssh_user_ca.pub", "login-ca-keys", "ca.pem"} {
		if after[name] != before[name] {
			t.Errorf("%s differs after regeneration", name)
		}
	}
	verifyLeaf(t, dir, "sbx", "x.sbx.localhost")
}

func TestDevSecretsIncompletePair(t *testing.T) {
	dir := t.TempDir()
	generate(t, dir)
	for _, name := range []string{"tunnel.key", "ssh_host_ed25519_key"} {
		if err := os.Remove(filepath.Join(dir, name)); err != nil {
			t.Fatal(err)
		}
		_, err := devsecrets.Generate(devsecrets.Options{Dir: dir})
		if err == nil || !strings.Contains(err.Error(), name) {
			t.Fatalf("without %s: err = %v, want one naming it", name, err)
		}
		if _, err := os.Stat(filepath.Join(dir, name)); !errors.Is(err, fs.ErrNotExist) {
			t.Fatalf("%s was recreated next to its old pair", name)
		}
		// Removing the rest of the pair lets the next run recreate it.
		other := strings.TrimSuffix(name, ".key") + ".pem"
		if name == "ssh_host_ed25519_key" {
			other = name + ".pub"
		}
		if err := os.Remove(filepath.Join(dir, other)); err != nil {
			t.Fatal(err)
		}
		generate(t, dir)
	}
}

func TestDevSecretsNames(t *testing.T) {
	dir := t.TempDir()
	if _, err := devsecrets.Generate(devsecrets.Options{Dir: dir, Domain: "sbx.example.test", TunnelHost: "t.example.test"}); err != nil {
		t.Fatal(err)
	}
	verifyLeaf(t, dir, "sbx", "a-8080.sbx.example.test")
	verifyLeaf(t, dir, "tunnel", "t.example.test")

	// The dev CA is name-constrained: it cannot vouch for other hosts.
	caPEM, _ := os.ReadFile(filepath.Join(dir, "ca.pem"))
	roots := x509.NewCertPool()
	roots.AppendCertsFromPEM(caPEM)
	pair, err := tls.LoadX509KeyPair(filepath.Join(dir, "sbx.pem"), filepath.Join(dir, "sbx.key"))
	if err != nil {
		t.Fatal(err)
	}
	if _, err := pair.Leaf.Verify(x509.VerifyOptions{DNSName: "example.com", Roots: roots}); err == nil {
		t.Fatal("sbx.pem verifies for example.com")
	}
	blk, _ := pem.Decode(caPEM)
	ca, err := x509.ParseCertificate(blk.Bytes)
	if err != nil {
		t.Fatal(err)
	}
	if !ca.PermittedDNSDomainsCritical || !slices.Contains(ca.PermittedDNSDomains, "sbx.example.test") {
		t.Fatalf("CA name constraints: critical=%v permitted=%v", ca.PermittedDNSDomainsCritical, ca.PermittedDNSDomains)
	}
}
