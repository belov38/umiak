package update

import (
	"crypto/ed25519"
	"crypto/x509"
	"encoding/base64"
	"encoding/pem"
	"errors"
	"fmt"
	"os"
	"strings"
)

// keyType is the first field of a key line.
const keyType = "ed25519"

// ParseKeys parses an update keys file: one key per line
// "ed25519 <base64 std of the 32-byte public key> [comment]"; blank lines and
// lines starting with '#' are ignored. A file without keys is an error.
func ParseKeys(b []byte) ([]ed25519.PublicKey, error) {
	var keys []ed25519.PublicKey
	for i, line := range strings.Split(string(b), "\n") {
		line = strings.TrimSpace(line)
		if line == "" || strings.HasPrefix(line, "#") {
			continue
		}
		fields := strings.Fields(line)
		if len(fields) < 2 || fields[0] != keyType {
			return nil, fmt.Errorf("update: keys line %d: want %q <base64> [comment]", i+1, keyType)
		}
		raw, err := base64.StdEncoding.DecodeString(fields[1])
		if err != nil {
			return nil, fmt.Errorf("update: keys line %d: %w", i+1, err)
		}
		if len(raw) != ed25519.PublicKeySize {
			return nil, fmt.Errorf("update: keys line %d: key is %d bytes, want %d", i+1, len(raw), ed25519.PublicKeySize)
		}
		keys = append(keys, ed25519.PublicKey(raw))
	}
	if len(keys) == 0 {
		return nil, errors.New("update: no keys")
	}
	return keys, nil
}

// ReadKeys reads and parses the keys file at path.
func ReadKeys(path string) ([]ed25519.PublicKey, error) {
	b, err := os.ReadFile(path)
	if err != nil {
		return nil, err
	}
	return ParseKeys(b)
}

// FormatKey returns the key line of pub for an update keys file.
func FormatKey(pub ed25519.PublicKey, comment string) string {
	line := keyType + " " + base64.StdEncoding.EncodeToString(pub)
	if comment = strings.TrimSpace(comment); comment != "" {
		line += " " + comment
	}
	return line
}

// pemType is the PEM block type of a PKCS #8 private key.
const pemType = "PRIVATE KEY"

// MarshalPrivateKey encodes a signing key as PKCS #8 PEM (the format of
// openssl genpkey -algorithm ed25519).
func MarshalPrivateKey(priv ed25519.PrivateKey) ([]byte, error) {
	der, err := x509.MarshalPKCS8PrivateKey(priv)
	if err != nil {
		return nil, err
	}
	return pem.EncodeToMemory(&pem.Block{Type: pemType, Bytes: der}), nil
}

// ParsePrivateKey decodes a PKCS #8 PEM ed25519 signing key.
func ParsePrivateKey(b []byte) (ed25519.PrivateKey, error) {
	block, _ := pem.Decode(b)
	if block == nil || block.Type != pemType {
		return nil, errors.New("update: signing key is not a PKCS #8 PEM block")
	}
	key, err := x509.ParsePKCS8PrivateKey(block.Bytes)
	if err != nil {
		return nil, fmt.Errorf("update: signing key: %w", err)
	}
	priv, ok := key.(ed25519.PrivateKey)
	if !ok {
		return nil, fmt.Errorf("update: signing key is %T, want ed25519", key)
	}
	return priv, nil
}
