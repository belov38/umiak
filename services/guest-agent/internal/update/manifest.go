// Package update installs signed agent packages, performs the self-update
// with confirmation and rollback, and cleans up old versions (spec S3
// section 17).
package update

import (
	"fmt"
	"time"
)

// ManifestFormat is the Format value of a v1 manifest.
const ManifestFormat = "sbx-agent-manifest/v1"

// Entry names inside a package and a version directory.
const (
	BinaryName     = "sbx-agent"
	ManifestName   = "manifest.json"
	SignatureName  = "manifest.sig"
	TrustDir       = "trust"
	TunnelCAName   = "trust/tunnel-ca.pem"
	UpdateKeysName = "trust/update-keys.pub"
)

// requiredFiles must be listed in every manifest.
var requiredFiles = []string{BinaryName, TunnelCAName, UpdateKeysName}

// Manifest is manifest.json of a package (spec 17.1). manifest.sig is the
// raw 64-byte ed25519 signature over the exact bytes of manifest.json.
type Manifest struct {
	// Format is ManifestFormat.
	Format string `json:"format"`
	// Version names the version directory; see ValidVersion.
	Version string `json:"version"`
	// OS and Arch are GOOS and GOARCH of the binary.
	OS   string `json:"os"`
	Arch string `json:"arch"`
	// Files maps every package entry except manifest.json and manifest.sig
	// (slash-separated relative name) to its lowercase hex sha256.
	Files map[string]string `json:"files"`
	// CreatedAt is when the package was built.
	CreatedAt time.Time `json:"created_at"`
	// MinRollbackVersion is reserved for a breaking state change (spec
	// 17.5); empty means no restriction.
	MinRollbackVersion string `json:"min_rollback_version,omitempty"`
}

// maxVersionLen bounds a version string.
const maxVersionLen = 64

// ValidVersion checks that v is usable as a directory name: 1..64 bytes of
// [A-Za-z0-9._+-], not starting with '.'.
func ValidVersion(v string) error {
	if v == "" || len(v) > maxVersionLen || v[0] == '.' {
		return fmt.Errorf("update: invalid version %q", v)
	}
	for i := 0; i < len(v); i++ {
		c := v[i]
		switch {
		case c >= 'a' && c <= 'z', c >= 'A' && c <= 'Z', c >= '0' && c <= '9', c == '.', c == '_', c == '+', c == '-':
		default:
			return fmt.Errorf("update: invalid version %q", v)
		}
	}
	return nil
}
