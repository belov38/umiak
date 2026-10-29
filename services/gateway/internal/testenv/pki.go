package testenv

import (
	"crypto/ecdsa"
	"crypto/ed25519"
	"crypto/elliptic"
	"crypto/rand"
	"crypto/tls"
	"crypto/x509"
	"crypto/x509/pkix"
	"encoding/pem"
	"fmt"
	"math/big"
	"os"
	"path/filepath"
	"time"

	"golang.org/x/crypto/ssh"

	"github.com/belov38/boat-dev-clone/services/gateway/internal/config"
)

// certValidity is the lifetime of the certificates issued by default.
const certValidity = 24 * time.Hour

// PKI is a throw-away certificate authority with the two serving
// certificates of the gateway. Everything is generated at runtime; the PEM
// files live in the test's temporary directory.
type PKI struct {
	CA    *x509.Certificate
	caKey *ecdsa.PrivateKey
	// Roots trusts CA only.
	Roots *x509.CertPool

	// Sbx is the wildcard certificate *.SbxDomain.
	Sbx tls.Certificate
	// Tunnel is the certificate of TunnelHost.
	Tunnel tls.Certificate

	SbxCertFile, SbxKeyFile       string
	TunnelCertFile, TunnelKeyFile string
}

// NewPKI creates a PKI with its PEM files in dir, for tests that need
// certificates without a whole Env.
func NewPKI(dir string) (*PKI, error) { return newPKI(dir) }

func newPKI(dir string) (*PKI, error) {
	key, err := ecdsa.GenerateKey(elliptic.P256(), rand.Reader)
	if err != nil {
		return nil, err
	}
	now := time.Now()
	tmpl := &x509.Certificate{
		SerialNumber:          serial(),
		Subject:               pkix.Name{CommonName: "sbx test CA"},
		NotBefore:             now.Add(-time.Hour),
		NotAfter:              now.Add(certValidity),
		KeyUsage:              x509.KeyUsageCertSign | x509.KeyUsageCRLSign | x509.KeyUsageDigitalSignature,
		BasicConstraintsValid: true,
		IsCA:                  true,
	}
	der, err := x509.CreateCertificate(rand.Reader, tmpl, tmpl, &key.PublicKey, key)
	if err != nil {
		return nil, err
	}
	ca, err := x509.ParseCertificate(der)
	if err != nil {
		return nil, err
	}
	p := &PKI{CA: ca, caKey: key, Roots: x509.NewCertPool()}
	p.Roots.AddCert(ca)

	p.SbxCertFile, p.SbxKeyFile = filepath.Join(dir, "sbx.crt"), filepath.Join(dir, "sbx.key")
	if p.Sbx, err = p.issueFiles(p.SbxCertFile, p.SbxKeyFile, "*."+SbxDomain); err != nil {
		return nil, err
	}
	p.TunnelCertFile, p.TunnelKeyFile = filepath.Join(dir, "tunnel.crt"), filepath.Join(dir, "tunnel.key")
	if p.Tunnel, err = p.issueFiles(p.TunnelCertFile, p.TunnelKeyFile, TunnelHost); err != nil {
		return nil, err
	}
	return p, nil
}

func (p *PKI) issueFiles(certFile, keyFile string, names ...string) (tls.Certificate, error) {
	certPEM, keyPEM, err := p.Issue(certValidity, names...)
	if err != nil {
		return tls.Certificate{}, err
	}
	if err := os.WriteFile(certFile, certPEM, 0o600); err != nil {
		return tls.Certificate{}, err
	}
	if err := os.WriteFile(keyFile, keyPEM, 0o600); err != nil {
		return tls.Certificate{}, err
	}
	return tls.X509KeyPair(certPEM, keyPEM)
}

// Issue signs a server certificate for the DNS names, valid from an hour ago
// for validFor, and returns the PEM certificate and the PEM PKCS#8 key.
func (p *PKI) Issue(validFor time.Duration, names ...string) (certPEM, keyPEM []byte, err error) {
	key, err := ecdsa.GenerateKey(elliptic.P256(), rand.Reader)
	if err != nil {
		return nil, nil, err
	}
	now := time.Now()
	tmpl := &x509.Certificate{
		SerialNumber: serial(),
		Subject:      pkix.Name{CommonName: names[0]},
		DNSNames:     names,
		NotBefore:    now.Add(-time.Hour),
		NotAfter:     now.Add(validFor),
		KeyUsage:     x509.KeyUsageDigitalSignature,
		ExtKeyUsage:  []x509.ExtKeyUsage{x509.ExtKeyUsageServerAuth},
	}
	der, err := x509.CreateCertificate(rand.Reader, tmpl, p.CA, &key.PublicKey, p.caKey)
	if err != nil {
		return nil, nil, err
	}
	kder, err := x509.MarshalPKCS8PrivateKey(key)
	if err != nil {
		return nil, nil, err
	}
	return pem.EncodeToMemory(&pem.Block{Type: "CERTIFICATE", Bytes: der}),
		pem.EncodeToMemory(&pem.Block{Type: "PRIVATE KEY", Bytes: kder}), nil
}

func serial() *big.Int {
	n, err := rand.Int(rand.Reader, new(big.Int).Lsh(big.NewInt(1), 127))
	if err != nil {
		panic(err)
	}
	return n
}

// Keys are the non-TLS secrets of the gateway.
type Keys struct {
	// Cookie is the session cookie key, id "k1".
	Cookie config.CookieKey
	// SSHHost is the gateway's SSH host key (ed25519).
	SSHHost ssh.Signer
	// UserCA signs the user certificates the gateway presents to sshd.
	UserCA ssh.Signer
	// LoginCA signs short-lived login certificates of clients.
	LoginCA ssh.Signer
}

func newKeys() (*Keys, error) {
	cookie := make([]byte, 32)
	if _, err := rand.Read(cookie); err != nil {
		return nil, err
	}
	k := &Keys{Cookie: config.CookieKey{ID: "k1", Key: cookie}}
	for _, dst := range []*ssh.Signer{&k.SSHHost, &k.UserCA, &k.LoginCA} {
		_, priv, err := ed25519.GenerateKey(rand.Reader)
		if err != nil {
			return nil, err
		}
		s, err := ssh.NewSignerFromKey(priv)
		if err != nil {
			return nil, fmt.Errorf("ssh signer: %w", err)
		}
		*dst = s
	}
	return k, nil
}
