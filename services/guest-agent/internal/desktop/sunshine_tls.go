package desktop

import (
	"bytes"
	"crypto/tls"
	"encoding/pem"
	"errors"
	"net/http"
	"os"
)

func pinnedSunshineClient(certPath string) *http.Client {
	return &http.Client{Transport: &http.Transport{TLSClientConfig: &tls.Config{MinVersion: tls.VersionTLS12, InsecureSkipVerify: true, VerifyConnection: func(cs tls.ConnectionState) error { //nolint:gosec // exact private certificate pin, fixed loopback endpoint
		b, e := os.ReadFile(certPath)
		if e != nil {
			return e
		}
		block, _ := pem.Decode(b)
		if block == nil || len(cs.PeerCertificates) == 0 || !bytes.Equal(block.Bytes, cs.PeerCertificates[0].Raw) {
			return errors.New("sunshine certificate pin mismatch")
		}
		return nil
	}}}}
}
