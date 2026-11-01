package wire

import (
	"crypto/rand"
	"crypto/sha256"
	"encoding/base64"
	"errors"
	"fmt"
	"strings"
)

const smbiosVersion = "umiak1"

var errSecretLen = errors.New("secret must be 32 bytes")

// EncodeSecret encodes raw secret bytes for the wire: base64url without padding.
func EncodeSecret(b []byte) string {
	return base64.RawURLEncoding.EncodeToString(b)
}

// DecodeSecret decodes a wire secret and rejects anything that is not exactly
// SecretLen bytes.
func DecodeSecret(s string) ([]byte, error) {
	b, err := base64.RawURLEncoding.DecodeString(s)
	if err != nil {
		return nil, fmt.Errorf("decode secret: %w", err)
	}
	if len(b) != SecretLen {
		return nil, errSecretLen
	}
	return b, nil
}

// HashSecret returns the SHA-256 of the raw secret bytes. The database stores
// only this hash.
func HashSecret(b []byte) []byte {
	h := sha256.Sum256(b)
	return h[:]
}

// NewSecret returns SecretLen random bytes from crypto/rand.
func NewSecret() ([]byte, error) {
	b := make([]byte, SecretLen)
	if _, err := rand.Read(b); err != nil {
		return nil, fmt.Errorf("generate secret: %w", err)
	}
	return b, nil
}

// SMBIOSSerial returns the guest-visible serial "umiak1:<machineId>:<base64url(BS)>".
// S1 base64-encodes it once more when it passes it to the hypervisor.
func SMBIOSSerial(machineID string, bs []byte) string {
	return smbiosVersion + ":" + machineID + ":" + EncodeSecret(bs)
}

// ParseSMBIOSSerial is the inverse of SMBIOSSerial. It rejects other versions.
func ParseSMBIOSSerial(s string) (machineID string, bs []byte, err error) {
	rest, ok := strings.CutPrefix(s, smbiosVersion+":")
	if !ok {
		return "", nil, errors.New("unsupported smbios serial version")
	}
	machineID, enc, ok := strings.Cut(rest, ":")
	if !ok || machineID == "" {
		return "", nil, errors.New("malformed smbios serial")
	}
	bs, err = DecodeSecret(enc)
	if err != nil {
		return "", nil, fmt.Errorf("smbios serial: %w", err)
	}
	return machineID, bs, nil
}
