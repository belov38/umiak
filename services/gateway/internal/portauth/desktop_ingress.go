package portauth

import (
	"crypto/hmac"
	"crypto/sha256"
	"encoding/base64"
	"strconv"
	"strings"
	"time"
)

// IngressDesktopHeader carries the per-request credential of the owner
// ingress for a path-addressed desktop viewer. Format:
//
//	<label>.<expUnix>.<mac>
//
// label is the routed desktop label (for example brave-otter-lake-desktop)
// exactly as the gateway routes it: lowercase (routes.ParseHost lowercases
// the Host), so the signer must lowercase the label too,
// expUnix a decimal Unix time in seconds, and mac is
// base64url WITHOUT padding (base64.RawURLEncoding) of
// HMAC-SHA256(key, label + "." + expUnix). The key is 32 raw bytes.
const IngressDesktopHeader = "Umiak-Ingress-Desktop"

// IngressDesktopMaxTTL is how far in the future exp may be.
const IngressDesktopMaxTTL = 60 * time.Second

// SignIngressDesktop builds the header value; the ingress implements the
// same format, and the gateway uses it in tests.
func SignIngressDesktop(key []byte, label string, exp int64) string {
	payload := label + "." + strconv.FormatInt(exp, 10)
	m := hmac.New(sha256.New, key)
	m.Write([]byte(payload))
	return payload + "." + base64.RawURLEncoding.EncodeToString(m.Sum(nil))
}

// validIngressDesktop reports whether values is exactly one well-formed,
// unexpired credential for label, signed with the configured key.
func (a *Auth) validIngressDesktop(values []string, label string) bool {
	if len(a.cfg.IngressDesktopKey) == 0 || len(values) != 1 {
		return false
	}
	parts := strings.Split(values[0], ".")
	if len(parts) != 3 || parts[0] != label {
		return false
	}
	exp, err := strconv.ParseInt(parts[1], 10, 64)
	if err != nil || strconv.FormatInt(exp, 10) != parts[1] {
		return false
	}
	now := a.cfg.Now()
	if !time.Unix(exp, 0).After(now) || time.Unix(exp, 0).After(now.Add(IngressDesktopMaxTTL)) {
		return false
	}
	want := SignIngressDesktop(a.cfg.IngressDesktopKey, parts[0], exp)
	return hmac.Equal([]byte(want), []byte(values[0]))
}
