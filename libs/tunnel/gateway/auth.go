package gateway

import (
	"crypto/sha256"
	"crypto/subtle"
	"slices"
	"strings"
)

// tokenEntry is one configured service token, stored as its SHA-256.
type tokenEntry struct {
	caller string
	hash   [sha256.Size]byte
}

// authenticator checks service tokens of the internal listener (spec 5.5).
// Tokens are compared as SHA-256 digests in constant time, and every
// configured token is checked, so neither the length nor the position of a
// match leaks through timing.
type authenticator struct{ tokens []tokenEntry }

func newAuthenticator(ts TokenSet) *authenticator {
	callers := make([]string, 0, len(ts))
	for c := range ts {
		callers = append(callers, c)
	}
	slices.Sort(callers)
	a := &authenticator{}
	for _, c := range callers {
		for _, tok := range ts[c] {
			if tok == "" || c == "" {
				continue
			}
			a.tokens = append(a.tokens, tokenEntry{caller: c, hash: sha256.Sum256([]byte(tok))})
		}
	}
	return a
}

// caller returns the caller name for an Authorization header value
// ("Bearer <service token>").
func (a *authenticator) caller(authorization string) (string, bool) {
	scheme, tok, ok := strings.Cut(authorization, " ")
	if !ok || !strings.EqualFold(scheme, "Bearer") {
		return "", false
	}
	tok = strings.TrimSpace(tok)
	if tok == "" {
		return "", false
	}
	sum := sha256.Sum256([]byte(tok))
	found := -1
	for i := range a.tokens {
		if subtle.ConstantTimeCompare(sum[:], a.tokens[i].hash[:]) == 1 && found < 0 {
			found = i
		}
	}
	if found < 0 {
		return "", false
	}
	return a.tokens[found].caller, true
}
