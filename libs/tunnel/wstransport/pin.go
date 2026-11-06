package wstransport

import (
	"crypto/sha256"
	"crypto/tls"
	"crypto/x509"
	"encoding/hex"
	"errors"
	"strings"
)

// PinnedCAVerifier authenticates only the firmware-pinned CA. The peer supplies
// its certificate, but cannot choose its fingerprint or bypass normal x509 checks.
func PinnedCAVerifier(pin string) (func(tls.ConnectionState) error, error) {
	decoded, err := hex.DecodeString(pin)
	if err != nil || len(decoded) != sha256.Size || strings.ToLower(pin) != pin {
		return nil, errors.New("tunnel: invalid CA fingerprint")
	}
	return func(cs tls.ConnectionState) error {
		if len(cs.PeerCertificates) == 0 || cs.ServerName == "" {
			return errors.New("tunnel: missing peer chain or hostname")
		}
		roots := x509.NewCertPool()
		intermediates := x509.NewCertPool()
		found := false
		for i, cert := range cs.PeerCertificates {
			sum := sha256.Sum256(cert.Raw)
			if hex.EncodeToString(sum[:]) == pin && cert.IsCA && cert.BasicConstraintsValid {
				roots.AddCert(cert)
				found = true
			} else if i > 0 {
				intermediates.AddCert(cert)
			}
		}
		if !found {
			return errors.New("tunnel: peer chain does not contain pinned CA")
		}
		_, err := cs.PeerCertificates[0].Verify(x509.VerifyOptions{Roots: roots, Intermediates: intermediates, DNSName: cs.ServerName, KeyUsages: []x509.ExtKeyUsage{x509.ExtKeyUsageServerAuth}})
		return err
	}, nil
}
