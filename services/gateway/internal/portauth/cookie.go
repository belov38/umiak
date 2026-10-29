// Package portauth implements the token and sso access modes of published
// ports (spec 8): the signed gateway cookies, the access checks, the reserved
// /__sbx/* endpoints and the request strip helper (7.4).
package portauth

import (
	"crypto/hmac"
	"crypto/sha256"
	"encoding/base64"
	"encoding/json"
	"errors"
	"fmt"
	"strings"
	"time"

	"github.com/belov38/boat-dev-clone/services/gateway/internal/config"
)

// Cookie names. All are __Host- cookies: no Domain, Path=/, Secure.
//
// Every login gets its own state cookie, StateCookiePrefix + "_" + the first
// stateKeyLen characters of its state, so parallel logins (several tabs,
// session restore) do not overwrite each other's state.
const (
	AuthCookie        = "__Host-sbx_auth"
	StateCookiePrefix = "__Host-sbx_state"
	stateKeyLen       = 8
)

// stateCookieName returns the state cookie name for state. It reports false
// when state is too short to name a cookie.
func stateCookieName(state string) (string, bool) {
	if len(state) < stateKeyLen {
		return "", false
	}
	return StateCookiePrefix + "_" + state[:stateKeyLen], true
}

// isStateCookie reports whether name is a state cookie name (prefix match,
// case-insensitive).
func isStateCookie(name string) bool {
	return len(name) >= len(StateCookiePrefix) && strings.EqualFold(name[:len(StateCookiePrefix)], StateCookiePrefix)
}

// Session modes (the "m" field).
const (
	ModeToken   = "t"
	ModeSSO     = "s"
	ModeDesktop = "d" // accepted by the codec only; a seam for S10
)

// Version tags. The tag is part of the MAC input, so an auth cookie can never
// be opened as a state cookie and vice versa.
const (
	tagSession = "v1"
	tagState   = "v1s"
)

// ErrInvalidCookie is returned for every cookie that cannot be opened: bad
// format, unknown version or kid, bad MAC, bad payload or expired.
var ErrInvalidCookie = errors.New("portauth: invalid cookie")

// Session is the payload of __Host-sbx_auth (spec 8.2).
type Session struct {
	Label  string
	Mode   string // ModeToken, ModeSSO or ModeDesktop
	Epoch  int64
	UserID string // sso only
	Email  string // sso only
	Expiry time.Time
}

// State is the payload of __Host-sbx_state (spec 8.4).
type State struct {
	State  string
	RD     string
	Label  string
	Expiry time.Time
}

type sessionWire struct {
	L  string `json:"l"`
	M  string `json:"m"`
	E  int64  `json:"e"`
	U  string `json:"u,omitempty"`
	Em string `json:"em,omitempty"`
	X  int64  `json:"x"`
}

type stateWire struct {
	S  string `json:"s"`
	RD string `json:"rd"`
	L  string `json:"l"`
	X  int64  `json:"x"`
}

// Codec seals and opens the gateway cookies:
// <tag>.<kid>.<b64url(payload)>.<b64url(HMAC-SHA256(key[kid], "<tag>.<kid>.<b64url(payload)>"))>.
// The first key signs; all keys verify. It is safe for concurrent use.
type Codec struct {
	keys []config.CookieKey
	now  func() time.Time
}

// NewCodec returns a codec for keys. now nil means time.Now. It panics when
// keys is empty or a key id is not cookie-safe: config loading rejects both,
// so a panic here is a programming error.
func NewCodec(keys []config.CookieKey, now func() time.Time) *Codec {
	if len(keys) == 0 {
		panic("portauth: no cookie keys")
	}
	for _, k := range keys {
		if !config.ValidCookieKeyID(k.ID) {
			panic(fmt.Sprintf("portauth: cookie key id %q has characters not allowed in a cookie", k.ID))
		}
	}
	if now == nil {
		now = time.Now
	}
	return &Codec{keys: keys, now: now}
}

// SealSession returns the signed cookie value of s.
func (c *Codec) SealSession(s Session) string {
	return c.seal(tagSession, sessionWire{L: s.Label, M: s.Mode, E: s.Epoch, U: s.UserID, Em: s.Email, X: s.Expiry.Unix()})
}

// OpenSession verifies v and returns the session. Mode is checked against the
// known set; label, mode and epoch are matched against the route by the
// caller.
func (c *Codec) OpenSession(v string) (Session, error) {
	var w sessionWire
	if err := c.open(tagSession, v, &w); err != nil {
		return Session{}, err
	}
	switch w.M {
	case ModeToken, ModeSSO, ModeDesktop:
	default:
		return Session{}, ErrInvalidCookie
	}
	if !c.live(w.X) {
		return Session{}, ErrInvalidCookie
	}
	return Session{Label: w.L, Mode: w.M, Epoch: w.E, UserID: w.U, Email: w.Em, Expiry: time.Unix(w.X, 0)}, nil
}

// SealState returns the signed cookie value of s.
func (c *Codec) SealState(s State) string {
	return c.seal(tagState, stateWire{S: s.State, RD: s.RD, L: s.Label, X: s.Expiry.Unix()})
}

// OpenState verifies v and returns the state.
func (c *Codec) OpenState(v string) (State, error) {
	var w stateWire
	if err := c.open(tagState, v, &w); err != nil {
		return State{}, err
	}
	if !c.live(w.X) {
		return State{}, ErrInvalidCookie
	}
	return State{State: w.S, RD: w.RD, Label: w.L, Expiry: time.Unix(w.X, 0)}, nil
}

func (c *Codec) live(x int64) bool {
	return c.now().Before(time.Unix(x, 0))
}

func (c *Codec) seal(tag string, payload any) string {
	raw, err := json.Marshal(payload)
	if err != nil {
		// The wire structs hold only strings and integers.
		panic(err)
	}
	k := c.keys[0]
	signed := tag + "." + k.ID + "." + base64.RawURLEncoding.EncodeToString(raw)
	return signed + "." + base64.RawURLEncoding.EncodeToString(mac(k.Key, signed))
}

func (c *Codec) open(tag, v string, dst any) error {
	// The kid may contain dots; base64url never does. So the tag ends at the
	// first dot, the MAC starts after the last one and the payload after the
	// one before it.
	macAt := strings.LastIndexByte(v, '.')
	if macAt < 0 {
		return ErrInvalidCookie
	}
	signed, macB64 := v[:macAt], v[macAt+1:]
	payloadAt := strings.LastIndexByte(signed, '.')
	if payloadAt < 0 {
		return ErrInvalidCookie
	}
	head, payloadB64 := signed[:payloadAt], signed[payloadAt+1:]
	gotTag, kid, ok := strings.Cut(head, ".")
	if !ok || gotTag != tag {
		return ErrInvalidCookie
	}
	key := c.key(kid)
	if key == nil {
		return ErrInvalidCookie
	}
	sig, err := b64.DecodeString(macB64)
	if err != nil || !hmac.Equal(sig, mac(key, signed)) {
		return ErrInvalidCookie
	}
	raw, err := b64.DecodeString(payloadB64)
	if err != nil {
		return ErrInvalidCookie
	}
	if err := json.Unmarshal(raw, dst); err != nil {
		return ErrInvalidCookie
	}
	return nil
}

// b64 decodes strictly: non-zero padding bits are rejected, so every cookie
// has exactly one valid encoding.
var b64 = base64.RawURLEncoding.Strict()

func (c *Codec) key(kid string) []byte {
	for _, k := range c.keys {
		if k.ID == kid {
			return k.Key
		}
	}
	return nil
}

func mac(key []byte, msg string) []byte {
	m := hmac.New(sha256.New, key)
	m.Write([]byte(msg))
	return m.Sum(nil)
}
