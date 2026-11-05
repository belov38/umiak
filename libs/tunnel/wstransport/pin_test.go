package wstransport

import (
	"crypto/ecdsa"
	"crypto/elliptic"
	"crypto/rand"
	"crypto/sha256"
	"crypto/tls"
	"crypto/x509"
	"crypto/x509/pkix"
	"encoding/hex"
	"math/big"
	"testing"
	"time"
)

func pinChain(t *testing.T) ([]*x509.Certificate, string) {
	t.Helper()
	now := time.Now()
	key, _ := ecdsa.GenerateKey(elliptic.P256(), rand.Reader)
	ca := &x509.Certificate{SerialNumber: big.NewInt(1), Subject: pkix.Name{CommonName: "fixture CA"}, NotBefore: now.Add(-time.Hour), NotAfter: now.Add(time.Hour), IsCA: true, BasicConstraintsValid: true, KeyUsage: x509.KeyUsageCertSign}
	der, e := x509.CreateCertificate(rand.Reader, ca, ca, key.Public(), key)
	if e != nil {
		t.Fatal(e)
	}
	ca, e = x509.ParseCertificate(der)
	if e != nil {
		t.Fatal(e)
	}
	leafKey, _ := ecdsa.GenerateKey(elliptic.P256(), rand.Reader)
	leaf := &x509.Certificate{SerialNumber: big.NewInt(2), DNSNames: []string{"tunnel.test"}, NotBefore: now.Add(-time.Hour), NotAfter: now.Add(time.Hour), ExtKeyUsage: []x509.ExtKeyUsage{x509.ExtKeyUsageServerAuth}, KeyUsage: x509.KeyUsageDigitalSignature}
	der, e = x509.CreateCertificate(rand.Reader, leaf, ca, leafKey.Public(), key)
	if e != nil {
		t.Fatal(e)
	}
	leaf, e = x509.ParseCertificate(der)
	if e != nil {
		t.Fatal(e)
	}
	sum := sha256.Sum256(ca.Raw)
	return []*x509.Certificate{leaf, ca}, hex.EncodeToString(sum[:])
}
func TestPinnedCAExclusiveX509Verification(t *testing.T) {
	chain, pin := pinChain(t)
	state := tls.ConnectionState{PeerCertificates: chain, ServerName: "tunnel.test"}
	verify, err := PinnedCAVerifier(pin)
	if err != nil {
		t.Fatal(err)
	}
	if err := verify(state); err != nil {
		t.Fatal(err)
	}
	for name, cs := range map[string]tls.ConnectionState{"hostname": {PeerCertificates: chain, ServerName: "other.test"}, "missing root": {PeerCertificates: chain[:1], ServerName: "tunnel.test"}, "empty": {}} {
		t.Run(name, func(t *testing.T) {
			if verify(cs) == nil {
				t.Fatal("accepted invalid chain")
			}
		})
	}
	other, _ := pinChain(t)
	if verify(tls.ConnectionState{PeerCertificates: other, ServerName: "tunnel.test"}) == nil {
		t.Fatal("accepted another install CA")
	}
	for _, bad := range []string{"", "xyz", pin + "0"} {
		if _, err := PinnedCAVerifier(bad); err == nil {
			t.Fatal("accepted malformed pin")
		}
	}
	leafPin := sha256.Sum256(chain[0].Raw)
	v, _ := PinnedCAVerifier(hex.EncodeToString(leafPin[:]))
	if v(state) == nil {
		t.Fatal("accepted non-CA pin")
	}
	chain[0].NotAfter = time.Now().Add(-time.Hour)
	if verify(state) == nil {
		t.Fatal("accepted expired certificate")
	}
}
