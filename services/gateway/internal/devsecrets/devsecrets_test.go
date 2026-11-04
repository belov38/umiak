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

	"github.com/belov38/umiak/services/gateway/internal/config"
	"github.com/belov38/umiak/services/gateway/internal/devsecrets"
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
		"UMIAK_GATEWAY_INTERNAL_URL":           "http://gateway:7000",
		"UMIAK_GATEWAY_DATABASE_URL":           "postgres://umiak:umiak@postgres:5432/umiak",
		"UMIAK_GATEWAY_PREVIEW_DOMAIN":         "umiak.localhost",
		"UMIAK_GATEWAY_TUNNEL_HOST":            "tunnel.localhost",
		"UMIAK_GATEWAY_SSH_HOST":               "ssh.localhost",
		"UMIAK_GATEWAY_API_URL":                "http://api:8082",
		"UMIAK_GATEWAY_API_TOKEN_FILE":         f("api-token"),
		"UMIAK_GATEWAY_SERVICE_TOKENS_FILE":    f("service-tokens.json"),
		"UMIAK_GATEWAY_COOKIE_KEYS_FILE":       f("cookie-keys"),
		"UMIAK_GATEWAY_TLS_PREVIEW_CERT_FILE":  f("umiak.pem"),
		"UMIAK_GATEWAY_TLS_PREVIEW_KEY_FILE":   f("umiak.key"),
		"UMIAK_GATEWAY_TLS_TUNNEL_CERT_FILE":   f("tunnel.pem"),
		"UMIAK_GATEWAY_TLS_TUNNEL_KEY_FILE":    f("tunnel.key"),
		"UMIAK_GATEWAY_SSH_HOST_KEY_FILES":     f("ssh_host_ed25519_key") + "," + f("ssh_host_ecdsa_key"),
		"UMIAK_GATEWAY_SSH_USER_CA_KEY_FILE":   f("ssh_user_ca"),
		"UMIAK_GATEWAY_SSH_LOGIN_CA_KEYS_FILE": f("login-ca-keys"),
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
		"umiak.key", "umiak.pem", "service-tokens.json",
		"ssh_host_ecdsa_key", "ssh_host_ecdsa_key.pub", "ssh_host_ed25519_key", "ssh_host_ed25519_key.pub",
		"ssh_login_ca", "ssh_login_ca.pub", "ssh_user_ca", "ssh_user_ca.pub",
		"tunnel.key", "tunnel.pem", "worker-gateway-token", "ingress-desktop-key",
	}
	slices.Sort(created)
	slices.Sort(want)
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
	verifyLeaf(t, dir, "umiak", "demo-3000.umiak.localhost")
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
	for _, name := range []string{"umiak.pem", "umiak.key", "worker-gateway-token", "ssh_user_ca.pub", "login-ca-keys"} {
		if err := os.Remove(filepath.Join(dir, name)); err != nil {
			t.Fatal(err)
		}
	}
	created := generate(t, dir)
	slices.Sort(created)
	if want := []string{"login-ca-keys", "ssh_user_ca.pub", "umiak.key", "umiak.pem", "worker-gateway-token"}; !slices.Equal(created, want) {
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
	verifyLeaf(t, dir, "umiak", "x.umiak.localhost")
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
	if _, err := devsecrets.Generate(devsecrets.Options{Dir: dir, Domain: "umiak.example.test", TunnelHost: "t.example.test"}); err != nil {
		t.Fatal(err)
	}
	verifyLeaf(t, dir, "umiak", "a-8080.umiak.example.test")
	verifyLeaf(t, dir, "tunnel", "t.example.test")

	// The dev CA is name-constrained: it cannot vouch for other hosts.
	caPEM, _ := os.ReadFile(filepath.Join(dir, "ca.pem"))
	roots := x509.NewCertPool()
	roots.AppendCertsFromPEM(caPEM)
	pair, err := tls.LoadX509KeyPair(filepath.Join(dir, "umiak.pem"), filepath.Join(dir, "umiak.key"))
	if err != nil {
		t.Fatal(err)
	}
	if _, err := pair.Leaf.Verify(x509.VerifyOptions{DNSName: "example.com", Roots: roots}); err == nil {
		t.Fatal("umiak.pem verifies for example.com")
	}
	blk, _ := pem.Decode(caPEM)
	ca, err := x509.ParseCertificate(blk.Bytes)
	if err != nil {
		t.Fatal(err)
	}
	if !ca.PermittedDNSDomainsCritical || !slices.Contains(ca.PermittedDNSDomains, "umiak.example.test") {
		t.Fatalf("CA name constraints: critical=%v permitted=%v", ca.PermittedDNSDomainsCritical, ca.PermittedDNSDomains)
	}
}

func readTrim(t *testing.T, dir, name string) string {
	t.Helper()
	b, err := os.ReadFile(filepath.Join(dir, name))
	if err != nil {
		t.Fatal(err)
	}
	return strings.TrimSpace(string(b))
}

// The derived files follow their sources: a recreated service-tokens.json
// or login CA, or an edited derived file, rewrites them.
func TestDevSecretsDerivedFollowSource(t *testing.T) {
	dir := t.TempDir()
	generate(t, dir)
	oldWorker := readTrim(t, dir, "worker-gateway-token")

	if err := os.Remove(filepath.Join(dir, "service-tokens.json")); err != nil {
		t.Fatal(err)
	}
	written := generate(t, dir)
	slices.Sort(written)
	if want := []string{"service-tokens.json", "worker-gateway-token"}; !slices.Equal(written, want) {
		t.Fatalf("wrote %v, want %v", written, want)
	}
	var tokens map[string][]string
	if err := json.Unmarshal([]byte(readTrim(t, dir, "service-tokens.json")), &tokens); err != nil {
		t.Fatal(err)
	}
	if w := readTrim(t, dir, "worker-gateway-token"); w != tokens["worker"][0] || w == oldWorker {
		t.Fatalf("worker-gateway-token %q, tokens.worker %v, old %q", w, tokens["worker"], oldWorker)
	}

	for _, name := range []string{"ssh_login_ca", "ssh_login_ca.pub"} {
		if err := os.Remove(filepath.Join(dir, name)); err != nil {
			t.Fatal(err)
		}
	}
	written = generate(t, dir)
	slices.Sort(written)
	if want := []string{"login-ca-keys", "ssh_login_ca", "ssh_login_ca.pub"}; !slices.Equal(written, want) {
		t.Fatalf("wrote %v, want %v", written, want)
	}
	pub := strings.Fields(readTrim(t, dir, "ssh_login_ca.pub"))
	if keys := readTrim(t, dir, "login-ca-keys"); !strings.Contains(keys, pub[0]+" "+pub[1]) {
		t.Fatalf("login-ca-keys %q lacks the new login CA %q", keys, pub[1])
	}

	// An edited derived file is put back.
	if err := os.WriteFile(filepath.Join(dir, "worker-gateway-token"), []byte("stale\n"), 0o600); err != nil {
		t.Fatal(err)
	}
	if written := generate(t, dir); !slices.Equal(written, []string{"worker-gateway-token"}) {
		t.Fatalf("wrote %v", written)
	}
	if w := readTrim(t, dir, "worker-gateway-token"); w != tokens["worker"][0] {
		t.Fatalf("worker-gateway-token %q", w)
	}
	if written := generate(t, dir); len(written) != 0 {
		t.Fatalf("a run on a consistent set wrote %v", written)
	}
}

// With an owner, the files of an earlier run are handed over too.
func TestDevSecretsChownExisting(t *testing.T) {
	dir := t.TempDir()
	all := generate(t, dir)

	got := map[string][2]int{}
	restore := devsecrets.SetLchown(func(path string, uid, gid int) error {
		got[filepath.Base(path)] = [2]int{uid, gid}
		return nil
	})
	defer restore()
	written, err := devsecrets.Generate(devsecrets.Options{
		Dir:         dir,
		Owner:       &devsecrets.Owner{UID: 65532, GID: 65532},
		WorkerOwner: &devsecrets.Owner{UID: 1000, GID: 1000},
	})
	if err != nil {
		t.Fatal(err)
	}
	if len(written) != 0 {
		t.Fatalf("wrote %v", written)
	}
	if len(got) != len(all) {
		t.Fatalf("chowned %d files, want %d: %v", len(got), len(all), got)
	}
	for _, name := range all {
		want := [2]int{65532, 65532}
		if name == "worker-gateway-token" || name == "ingress-desktop-key" {
			want = [2]int{1000, 1000}
		}
		if got[name] != want {
			t.Errorf("%s chowned to %v, want %v", name, got[name], want)
		}
	}
}
