// Package devsecrets creates the secrets a gateway needs for a local stack
// (docker compose): a dev CA with the umiak wildcard and tunnel certificates,
// the cookie keys, the SSH host keys and CAs, and the service tokens. It only
// creates missing files and optionally renews TLS leaves, so it is safe to run daily.
package devsecrets

import (
	"bytes"
	"crypto"
	"crypto/ecdsa"
	"crypto/ed25519"
	"crypto/elliptic"
	"crypto/rand"
	"crypto/tls"
	"crypto/x509"
	"crypto/x509/pkix"
	"encoding/base64"
	"encoding/hex"
	"encoding/json"
	"encoding/pem"
	"errors"
	"fmt"
	"io/fs"
	"math/big"
	"os"
	"path/filepath"
	"slices"
	"strconv"
	"strings"
	"time"

	"golang.org/x/crypto/ssh"
)

// Defaults of the names.
const (
	DefaultDomain     = "umiak.localhost"
	DefaultTunnelHost = "tunnel.localhost"
	DefaultSSHHost    = "ssh.localhost"
)

// File names in the output directory.
const (
	FileCACert        = "ca.pem"
	FileCAKey         = "ca.key"
	FileUmiakCert     = "umiak.pem"
	FileUmiakKey      = "umiak.key"
	FileTunnelCert    = "tunnel.pem"
	FileTunnelKey     = "tunnel.key"
	FileCookieKeys    = "cookie-keys"
	FileHostEd25519   = "ssh_host_ed25519_key"
	FileHostECDSA     = "ssh_host_ecdsa_key"
	FileUserCA        = "ssh_user_ca"
	FileLoginCA       = "ssh_login_ca"
	FileLoginCAKeys   = "login-ca-keys"
	FileServiceTokens = "service-tokens.json"
	FileAPIToken      = "api-token"
	FileWorkerGWToken = "worker-gateway-token"
	// FileIngressDesktopKey is 32 raw random bytes: the HMAC key shared by the
	// gateway and the owner ingress (UMIAK_GATEWAY_INGRESS_DESKTOP_KEY_FILE).
	// Two readers in the quickstart stack: the gateway (uid Owner.UID, after
	// the root wrapper drops privileges) reads it as the file owner, and the
	// quickstart ingress (Node, uid/gid WorkerOwner, read-only mount) reads
	// it through the group. So the file is owned by Owner.UID:WorkerOwner.GID
	// with mode 0640. Standalone gateway test environments have no
	// owner ingress, the gateway must NOT be pointed at the file; the feature
	// stays disabled there.
	FileIngressDesktopKey = "ingress-desktop-key"
	modeSecret            = 0o600
	modeGroupRead         = 0o640
	modePublic            = 0o644
	caValidity            = 10 * 365 * 24 * time.Hour
	leafValidity          = 397 * 24 * time.Hour // within the browser and macOS caps
	clockSkewAllowance    = time.Hour
)

// Owner is a numeric owner of the created files.
type Owner struct{ UID, GID int }

// ParseOwner parses "uid:gid"; an empty string is no owner (nil).
func ParseOwner(s string) (*Owner, error) {
	if s == "" {
		return nil, nil
	}
	u, g, ok := strings.Cut(s, ":")
	uid, err1 := strconv.Atoi(u)
	gid, err2 := strconv.Atoi(g)
	if !ok || err1 != nil || err2 != nil || uid < 0 || gid < 0 {
		return nil, fmt.Errorf("invalid owner %q, want uid:gid", s)
	}
	return &Owner{UID: uid, GID: gid}, nil
}

// Options configure Generate.
type Options struct {
	// Dir is the output directory; it is created (0700) when missing.
	Dir string
	// Domain is the umiak domain; the certificate is for *.Domain and Domain.
	Domain string
	// TunnelHost is the agents' tunnel host name.
	TunnelHost string
	// SSHHost is the SSH host name, used in the comments of the host keys.
	SSHHost string
	// Owner, when set, owns every created file (the gateway's user in a
	// container).
	Owner *Owner
	// WorkerOwner, when set, owns worker-gateway-token instead of Owner (the
	// worker's user).
	WorkerOwner *Owner
	// Now is the clock of the certificates; nil is time.Now.
	Now func() time.Time
	// RenewBefore renews existing TLS leaves expiring within this duration.
	// Zero disables renewal. Enabled renewal also reconciles desired DNS names.
	// The CA and leaf private keys are preserved.
	RenewBefore time.Duration
}

// Generate creates the missing files of the set and returns the names of
// the files it wrote. Existing keys, certificates and tokens are never
// changed unless RenewBefore enables leaf certificate renewal. The two derived
// files, login-ca-keys (from ssh_login_ca) and
// worker-gateway-token (from service-tokens.json), are rewritten whenever
// they differ from their source, so a recreated source never leaves them
// stale. A key pair with one half missing is an error naming the missing
// file: a new half would not match the old one. With Owner or WorkerOwner
// set, existing files of the set are handed to them too.
func Generate(o Options) ([]string, error) {
	if o.RenewBefore < 0 {
		return nil, errors.New("devsecrets: renew-before must not be negative")
	}
	if o.Dir == "" {
		return nil, errors.New("devsecrets: no directory")
	}
	if o.Domain == "" {
		o.Domain = DefaultDomain
	}
	if o.TunnelHost == "" {
		o.TunnelHost = DefaultTunnelHost
	}
	if o.SSHHost == "" {
		o.SSHHost = DefaultSSHHost
	}
	if o.Now == nil {
		o.Now = time.Now
	}
	if err := os.MkdirAll(o.Dir, 0o700); err != nil {
		return nil, fmt.Errorf("devsecrets: %w", err)
	}
	g := &gen{o: o}
	steps := []func() error{
		g.tls,
		func() error { return g.once(FileCookieKeys, modeSecret, cookieKeys) },
		func() error { return g.sshKey(FileHostEd25519, ed25519Key, "umiak-gateway@"+o.SSHHost) },
		func() error { return g.sshKey(FileHostECDSA, ecdsaKey, "umiak-gateway@"+o.SSHHost) },
		func() error { return g.sshKey(FileUserCA, ed25519Key, "umiak-gateway user CA") },
		func() error { return g.sshKey(FileLoginCA, ed25519Key, "umiak login CA") },
		func() error { return g.derived(FileLoginCAKeys, modePublic, g.loginCAKeys) },
		func() error { return g.once(FileServiceTokens, modeSecret, serviceTokens) },
		func() error { return g.once(FileAPIToken, modeSecret, tokenFile) },
		func() error { return g.derived(FileWorkerGWToken, modeSecret, g.workerToken) },
		func() error { return g.once(FileIngressDesktopKey, g.mode(FileIngressDesktopKey), randomKey) },
		g.chownAll,
	}
	for _, s := range steps {
		if err := s(); err != nil {
			return g.created, fmt.Errorf("devsecrets: %w", err)
		}
	}
	return g.created, nil
}

// allFiles are the files of the set, for chownAll.
var allFiles = []string{
	FileCACert, FileCAKey, FileUmiakCert, FileUmiakKey, FileTunnelCert, FileTunnelKey,
	FileCookieKeys,
	FileHostEd25519, FileHostEd25519 + ".pub", FileHostECDSA, FileHostECDSA + ".pub",
	FileUserCA, FileUserCA + ".pub", FileLoginCA, FileLoginCA + ".pub", FileLoginCAKeys,
	FileServiceTokens, FileAPIToken, FileWorkerGWToken, FileIngressDesktopKey,
}

// lchown changes the owner of a file; tests replace it.
var lchown = os.Lchown

// owner returns the owner of name: WorkerOwner for the worker token, when
// set, else Owner. The ingress key is split: the gateway's UID (owner read)
// and the worker's GID (group read by the quickstart ingress).
func (g *gen) owner(name string) *Owner {
	switch name {
	case FileWorkerGWToken:
		if g.o.WorkerOwner != nil {
			return g.o.WorkerOwner
		}
	case FileIngressDesktopKey:
		switch {
		case g.o.Owner != nil && g.o.WorkerOwner != nil:
			return &Owner{UID: g.o.Owner.UID, GID: g.o.WorkerOwner.GID}
		case g.o.WorkerOwner != nil:
			return g.o.WorkerOwner
		}
	}
	return g.o.Owner
}

// mode returns the mode of the once-created file name: the ingress key is
// group-readable when a worker group is configured.
func (g *gen) mode(name string) fs.FileMode {
	if name == FileIngressDesktopKey && g.o.WorkerOwner != nil {
		return modeGroupRead
	}
	return modeSecret
}

// chownAll hands every existing file of the set to its owner, so files
// created by an earlier run (or as another user) are readable by the
// configured users too.
func (g *gen) chownAll() error {
	for _, name := range allFiles {
		o := g.owner(name)
		if o == nil {
			continue
		}
		ok, err := g.exists(name)
		if err != nil {
			return err
		}
		if !ok {
			continue
		}
		if err := lchown(g.path(name), o.UID, o.GID); err != nil {
			return err
		}
		if name == FileIngressDesktopKey {
			if err := os.Chmod(g.path(name), g.mode(name)); err != nil {
				return err
			}
		}
	}
	return nil
}

type gen struct {
	o       Options
	created []string
	ca      *x509.Certificate
	caKey   crypto.Signer
}

func (g *gen) path(name string) string { return filepath.Join(g.o.Dir, name) }

func (g *gen) exists(name string) (bool, error) {
	_, err := os.Lstat(g.path(name))
	switch {
	case err == nil:
		return true, nil
	case errors.Is(err, fs.ErrNotExist):
		return false, nil
	default:
		return false, err
	}
}

// pair reports whether both files exist; exactly one is an error.
func (g *gen) pair(a, b string) (bool, error) {
	ea, err := g.exists(a)
	if err != nil {
		return false, err
	}
	eb, err := g.exists(b)
	if err != nil {
		return false, err
	}
	switch {
	case ea && eb:
		return true, nil
	case ea:
		return false, fmt.Errorf("%s is missing next to %s: remove %s too to create a new pair", b, a, a)
	case eb:
		return false, fmt.Errorf("%s is missing next to %s: remove %s too to create a new pair", a, b, b)
	}
	return false, nil
}

// once writes name with the output of content when the file is missing.
func (g *gen) once(name string, mode fs.FileMode, content func() ([]byte, error)) error {
	ok, err := g.exists(name)
	if err != nil || ok {
		return err
	}
	data, err := content()
	if err != nil {
		return fmt.Errorf("%s: %w", name, err)
	}
	return g.write(name, data, mode)
}

// derived writes name with the output of content when the file is missing
// or its content differs.
func (g *gen) derived(name string, mode fs.FileMode, content func() ([]byte, error)) error {
	data, err := content()
	if err != nil {
		return fmt.Errorf("%s: %w", name, err)
	}
	cur, err := os.ReadFile(g.path(name))
	switch {
	case err == nil && bytes.Equal(cur, data):
		return nil
	case err != nil && !errors.Is(err, fs.ErrNotExist):
		return err
	}
	return g.write(name, data, mode)
}

// write creates (or replaces) name through a temporary file, so a crash never leaves a
// partial file that a later run would keep.
func (g *gen) write(name string, data []byte, mode fs.FileMode) error {
	f, err := os.CreateTemp(g.o.Dir, "."+name+".tmp-*")
	if err != nil {
		return err
	}
	tmp := f.Name()
	ok := false
	defer func() {
		if !ok {
			_ = f.Close()
			_ = os.Remove(tmp)
		}
	}()
	if _, err := f.Write(data); err != nil {
		return err
	}
	if err := f.Chmod(mode); err != nil {
		return err
	}
	if owner := g.owner(name); owner != nil {
		if err := f.Chown(owner.UID, owner.GID); err != nil {
			return err
		}
	}
	if err := f.Close(); err != nil {
		return err
	}
	if err := os.Rename(tmp, g.path(name)); err != nil {
		return err
	}
	ok = true
	g.created = append(g.created, name)
	return nil
}

// tls creates the dev CA and the two leaf pairs that are missing.
func (g *gen) tls() error {
	haveCA, err := g.pair(FileCACert, FileCAKey)
	if err != nil {
		return err
	}
	haveUmiak, err := g.pair(FileUmiakCert, FileUmiakKey)
	if err != nil {
		return err
	}
	haveTunnel, err := g.pair(FileTunnelCert, FileTunnelKey)
	if err != nil {
		return err
	}
	if !haveCA && (haveUmiak || haveTunnel) {
		return fmt.Errorf("%s and %s are missing while certificates of the old CA exist: remove %s, %s, %s and %s too",
			FileCACert, FileCAKey, FileUmiakCert, FileUmiakKey, FileTunnelCert, FileTunnelKey)
	}
	if haveUmiak && haveTunnel && g.o.RenewBefore == 0 {
		return nil
	}
	if haveCA {
		if err := g.loadCA(); err != nil {
			return err
		}
	} else if err := g.newCA(); err != nil {
		return err
	}
	if !haveUmiak {
		if err := g.leaf(FileUmiakCert, FileUmiakKey, []string{"*." + g.o.Domain, g.o.Domain}); err != nil {
			return err
		}
	}
	if !haveTunnel {
		if err := g.leaf(FileTunnelCert, FileTunnelKey, []string{g.o.TunnelHost}); err != nil {
			return err
		}
	}
	if g.o.RenewBefore > 0 {
		if err := g.renewLeaf(FileUmiakCert, FileUmiakKey, []string{"*." + g.o.Domain, g.o.Domain}); err != nil {
			return err
		}
		if err := g.renewLeaf(FileTunnelCert, FileTunnelKey, []string{g.o.TunnelHost}); err != nil {
			return err
		}
	}

	return nil
}

func (g *gen) newCA() error {
	key, err := ecdsa.GenerateKey(elliptic.P256(), rand.Reader)
	if err != nil {
		return err
	}
	var id [4]byte
	_, _ = rand.Read(id[:])
	now := g.o.Now()
	tmpl := &x509.Certificate{
		SerialNumber:          serial(),
		Subject:               pkix.Name{CommonName: "umiak dev CA " + hex.EncodeToString(id[:]), Organization: []string{"umiak local development"}},
		NotBefore:             now.Add(-clockSkewAllowance),
		NotAfter:              now.Add(caValidity),
		IsCA:                  true,
		BasicConstraintsValid: true,
		MaxPathLenZero:        true,
		KeyUsage:              x509.KeyUsageCertSign | x509.KeyUsageCRLSign,
		// A trusted dev CA can only vouch for the stack's own names.
		PermittedDNSDomainsCritical: true,
		PermittedDNSDomains:         uniq(g.o.Domain, g.o.TunnelHost, g.o.SSHHost),
	}
	der, err := x509.CreateCertificate(rand.Reader, tmpl, tmpl, key.Public(), key)
	if err != nil {
		return err
	}
	cert, err := x509.ParseCertificate(der)
	if err != nil {
		return err
	}
	keyPEM, err := pkcs8PEM(key)
	if err != nil {
		return err
	}
	if err := g.write(FileCAKey, keyPEM, modeSecret); err != nil {
		return err
	}
	if err := g.write(FileCACert, pem.EncodeToMemory(&pem.Block{Type: "CERTIFICATE", Bytes: der}), modePublic); err != nil {
		return err
	}
	g.ca, g.caKey = cert, key
	return nil
}

func (g *gen) loadCA() error {
	certPEM, err := os.ReadFile(g.path(FileCACert))
	if err != nil {
		return err
	}
	blk, _ := pem.Decode(certPEM)
	if blk == nil || blk.Type != "CERTIFICATE" {
		return fmt.Errorf("%s: no certificate", FileCACert)
	}
	cert, err := x509.ParseCertificate(blk.Bytes)
	if err != nil {
		return fmt.Errorf("%s: %w", FileCACert, err)
	}
	keyPEM, err := os.ReadFile(g.path(FileCAKey))
	if err != nil {
		return err
	}
	kb, _ := pem.Decode(keyPEM)
	if kb == nil {
		return fmt.Errorf("%s: no PEM key", FileCAKey)
	}
	k, err := x509.ParsePKCS8PrivateKey(kb.Bytes)
	if err != nil {
		return fmt.Errorf("%s: %w", FileCAKey, err)
	}
	signer, ok := k.(crypto.Signer)
	if !ok {
		return fmt.Errorf("%s: unsupported key type %T", FileCAKey, k)
	}
	g.ca, g.caKey = cert, signer
	return nil
}

func (g *gen) leaf(certName, keyName string, names []string) error {
	key, err := ecdsa.GenerateKey(elliptic.P256(), rand.Reader)
	if err != nil {
		return err
	}
	now := g.o.Now()
	tmpl := &x509.Certificate{
		SerialNumber: serial(),
		Subject:      pkix.Name{CommonName: names[0]},
		NotBefore:    now.Add(-clockSkewAllowance),
		NotAfter:     now.Add(leafValidity),
		KeyUsage:     x509.KeyUsageDigitalSignature,
		ExtKeyUsage:  []x509.ExtKeyUsage{x509.ExtKeyUsageServerAuth},
		DNSNames:     names,
	}
	der, err := x509.CreateCertificate(rand.Reader, tmpl, g.ca, key.Public(), g.caKey)
	if err != nil {
		return err
	}
	keyPEM, err := pkcs8PEM(key)
	if err != nil {
		return err
	}
	if err := g.write(keyName, keyPEM, modeSecret); err != nil {
		return err
	}
	return g.write(certName, pem.EncodeToMemory(&pem.Block{Type: "CERTIFICATE", Bytes: der}), modePublic)
}

// renewLeaf preserves the private key, so one atomic certificate rename publishes
// a complete matching pair even if the process stops during renewal.
func (g *gen) renewLeaf(certName, keyName string, names []string) error {
	pair, err := tls.LoadX509KeyPair(g.path(certName), g.path(keyName))
	if err != nil {
		return fmt.Errorf("%s: %w", certName, err)
	}
	leaf := pair.Leaf
	now := g.o.Now()
	if leaf.NotAfter.After(now.Add(g.o.RenewBefore)) && slices.Equal(leaf.DNSNames, names) {
		return nil
	}
	if err := leaf.CheckSignatureFrom(g.ca); err != nil {
		return fmt.Errorf("%s: does not chain to the existing CA: %w", certName, err)
	}
	if !g.ca.NotAfter.After(now) {
		return fmt.Errorf("%s: CA expired; renew the CA explicitly", FileCACert)
	}
	notAfter := now.Add(leafValidity)
	if g.ca.NotAfter.Before(notAfter) {
		notAfter = g.ca.NotAfter
	}
	tmpl := &x509.Certificate{
		SerialNumber: serial(), Subject: leaf.Subject,
		NotBefore: now.Add(-clockSkewAllowance), NotAfter: notAfter,
		KeyUsage: leaf.KeyUsage, ExtKeyUsage: leaf.ExtKeyUsage,
		DNSNames: names, IPAddresses: leaf.IPAddresses,
		EmailAddresses: leaf.EmailAddresses, URIs: leaf.URIs,
	}
	tmpl.Subject.CommonName = names[0]
	der, err := x509.CreateCertificate(rand.Reader, tmpl, g.ca, leaf.PublicKey, g.caKey)
	if err != nil {
		return fmt.Errorf("%s: %w", certName, err)
	}
	cert, err := x509.ParseCertificate(der)
	if err != nil {
		return err
	}
	roots := x509.NewCertPool()
	roots.AddCert(g.ca)
	if _, err := cert.Verify(x509.VerifyOptions{Roots: roots, CurrentTime: now}); err != nil {
		return fmt.Errorf("%s: renewed certificate violates CA constraints: %w", certName, err)
	}
	return g.write(certName, pem.EncodeToMemory(&pem.Block{Type: "CERTIFICATE", Bytes: der}), modePublic)
}

func serial() *big.Int {
	n, err := rand.Int(rand.Reader, new(big.Int).Lsh(big.NewInt(1), 127))
	if err != nil {
		panic(err) // crypto/rand does not fail
	}
	return n.Add(n, big.NewInt(1))
}

func pkcs8PEM(key any) ([]byte, error) {
	der, err := x509.MarshalPKCS8PrivateKey(key)
	if err != nil {
		return nil, err
	}
	return pem.EncodeToMemory(&pem.Block{Type: "PRIVATE KEY", Bytes: der}), nil
}

func uniq(items ...string) []string {
	var out []string
	for _, it := range items {
		if it != "" && !slices.Contains(out, it) {
			out = append(out, it)
		}
	}
	return out
}

func ed25519Key() (crypto.PrivateKey, error) {
	_, k, err := ed25519.GenerateKey(rand.Reader)
	return k, err
}

func ecdsaKey() (crypto.PrivateKey, error) {
	return ecdsa.GenerateKey(elliptic.P256(), rand.Reader)
}

// sshKey creates an OpenSSH private key name and its name.pub. With the
// private key alone, only the public file is written.
func (g *gen) sshKey(name string, newKey func() (crypto.PrivateKey, error), comment string) error {
	pub := name + ".pub"
	havePriv, err := g.exists(name)
	if err != nil {
		return err
	}
	havePub, err := g.exists(pub)
	if err != nil {
		return err
	}
	switch {
	case havePriv && havePub:
		return nil
	case havePriv:
		s, err := g.sshSigner(name)
		if err != nil {
			return err
		}
		return g.write(pub, authorizedKey(s.PublicKey(), comment), modePublic)
	case havePub:
		return fmt.Errorf("%s is missing next to %s: remove %s too to create a new pair", name, pub, pub)
	}
	k, err := newKey()
	if err != nil {
		return err
	}
	blk, err := ssh.MarshalPrivateKey(k, comment)
	if err != nil {
		return err
	}
	s, err := ssh.NewSignerFromKey(k)
	if err != nil {
		return err
	}
	if err := g.write(name, pem.EncodeToMemory(blk), modeSecret); err != nil {
		return err
	}
	return g.write(pub, authorizedKey(s.PublicKey(), comment), modePublic)
}

func (g *gen) sshSigner(name string) (ssh.Signer, error) {
	b, err := os.ReadFile(g.path(name))
	if err != nil {
		return nil, err
	}
	s, err := ssh.ParsePrivateKey(b)
	if err != nil {
		return nil, fmt.Errorf("%s: %w", name, err)
	}
	return s, nil
}

func authorizedKey(k ssh.PublicKey, comment string) []byte {
	line := strings.TrimSpace(string(ssh.MarshalAuthorizedKey(k)))
	if comment != "" {
		line += " " + comment
	}
	return []byte(line + "\n")
}

// loginCAKeys is UMIAK_GATEWAY_SSH_LOGIN_CA_KEYS_FILE: the login CA's public
// key in authorized_keys format.
func (g *gen) loginCAKeys() ([]byte, error) {
	s, err := g.sshSigner(FileLoginCA)
	if err != nil {
		return nil, err
	}
	return append([]byte("# CAs of the short-lived SSH login certificates (api signs them with ssh_login_ca)\n"),
		authorizedKey(s.PublicKey(), "umiak login CA")...), nil
}

func cookieKeys() ([]byte, error) {
	k := make([]byte, 32)
	if _, err := rand.Read(k); err != nil {
		return nil, err
	}
	return []byte("k1:" + base64.StdEncoding.EncodeToString(k) + "\n"), nil
}

// randomKey is 32 raw random bytes.
func randomKey() ([]byte, error) {
	k := make([]byte, 32)
	if _, err := rand.Read(k); err != nil {
		return nil, err
	}
	return k, nil
}

func token() (string, error) {
	b := make([]byte, 32)
	if _, err := rand.Read(b); err != nil {
		return "", err
	}
	return base64.RawURLEncoding.EncodeToString(b), nil
}

func tokenFile() ([]byte, error) {
	t, err := token()
	if err != nil {
		return nil, err
	}
	return []byte(t + "\n"), nil
}

// serviceTokens is UMIAK_GATEWAY_SERVICE_TOKENS_FILE: one token per caller.
func serviceTokens() ([]byte, error) {
	set := map[string][]string{}
	for _, k := range []string{"api", "worker", "gateway"} {
		t, err := token()
		if err != nil {
			return nil, err
		}
		set[k] = []string{t}
	}
	b, err := json.MarshalIndent(set, "", "  ")
	if err != nil {
		return nil, err
	}
	return append(b, '\n'), nil
}

// workerToken is the worker's UMIAK_GATEWAY_SERVICE_TOKEN_FILE: the first
// worker token of the service tokens.
func (g *gen) workerToken() ([]byte, error) {
	b, err := os.ReadFile(g.path(FileServiceTokens))
	if err != nil {
		return nil, err
	}
	var set map[string][]string
	if err := json.Unmarshal(b, &set); err != nil {
		return nil, fmt.Errorf("%s: %w", FileServiceTokens, err)
	}
	if len(set["worker"]) == 0 || set["worker"][0] == "" {
		return nil, fmt.Errorf("%s has no worker token", FileServiceTokens)
	}
	return []byte(set["worker"][0] + "\n"), nil
}
