package portauth

import (
	"bytes"
	"encoding/base64"
	"errors"
	"strings"
	"testing"
	"time"

	"github.com/belov38/umiak/services/gateway/internal/config"
)

var (
	keyA = config.CookieKey{ID: "a", Key: bytes.Repeat([]byte{0xa1}, 32)}
	keyB = config.CookieKey{ID: "b", Key: bytes.Repeat([]byte{0xb2}, 32)}
)

func fixedNow() time.Time { return time.Unix(1_800_000_000, 0) }

func testSession() Session {
	return Session{
		Label:  "quiet-otter-lamp-5173",
		Mode:   ModeSSO,
		Epoch:  7,
		UserID: "usr_1",
		Email:  "a@b.c",
		Expiry: fixedNow().Add(time.Hour),
	}
}

func TestCodecRoundTrip(t *testing.T) {
	c := NewCodec([]config.CookieKey{keyA}, fixedNow)
	s := testSession()
	v := c.SealSession(s)
	if !strings.HasPrefix(v, "v1.a.") || strings.Count(v, ".") != 3 {
		t.Fatalf("sealed = %q, want v1.a.<payload>.<mac>", v)
	}
	parts := strings.Split(v, ".")
	payload, err := base64.RawURLEncoding.DecodeString(parts[2])
	if err != nil {
		t.Fatal(err)
	}
	want := `{"l":"quiet-otter-lamp-5173","m":"s","e":7,"u":"usr_1","em":"a@b.c","x":1800003600}`
	if string(payload) != want {
		t.Errorf("payload = %s, want %s", payload, want)
	}
	got, err := c.OpenSession(v)
	if err != nil {
		t.Fatal(err)
	}
	if got != s {
		t.Errorf("OpenSession = %+v, want %+v", got, s)
	}

	// Token mode carries no user fields.
	tok := Session{Label: "x-3000", Mode: ModeToken, Epoch: 1, Expiry: fixedNow().Add(time.Minute)}
	got, err = c.OpenSession(c.SealSession(tok))
	if err != nil || got != tok {
		t.Errorf("token session = %+v, %v", got, err)
	}
	// Desktop mode is accepted by the codec (seam for S10).
	d := Session{Label: "x-desktop", Mode: ModeDesktop, Epoch: 1, Expiry: fixedNow().Add(time.Minute)}
	if _, err := c.OpenSession(c.SealSession(d)); err != nil {
		t.Errorf("desktop session: %v", err)
	}

	st := State{State: "abc", RD: "/page?x=1", Label: "x-3000", Expiry: fixedNow().Add(10 * time.Minute)}
	sv := c.SealState(st)
	if !strings.HasPrefix(sv, "v1s.a.") {
		t.Fatalf("sealed state = %q", sv)
	}
	gotSt, err := c.OpenState(sv)
	if err != nil || gotSt != st {
		t.Errorf("OpenState = %+v, %v", gotSt, err)
	}
}

func TestCodecExpiry(t *testing.T) {
	c := NewCodec([]config.CookieKey{keyA}, fixedNow)
	s := testSession()
	s.Expiry = fixedNow()
	if _, err := c.OpenSession(c.SealSession(s)); !errors.Is(err, ErrInvalidCookie) {
		t.Errorf("expired session err = %v", err)
	}
	st := State{State: "s", RD: "/", Label: "x-3000", Expiry: fixedNow().Add(-time.Second)}
	if _, err := c.OpenState(c.SealState(st)); !errors.Is(err, ErrInvalidCookie) {
		t.Errorf("expired state err = %v", err)
	}
}

func TestCodecRotation(t *testing.T) {
	signer := NewCodec([]config.CookieKey{keyA}, fixedNow)
	v := signer.SealSession(testSession())

	both := NewCodec([]config.CookieKey{keyB, keyA}, fixedNow)
	if _, err := both.OpenSession(v); err != nil {
		t.Errorf("[B, A] rejected a cookie signed by A: %v", err)
	}
	if nv := both.SealSession(testSession()); !strings.HasPrefix(nv, "v1.b.") {
		t.Errorf("[B, A] signs with %q, want kid b", nv)
	}

	onlyB := NewCodec([]config.CookieKey{keyB}, fixedNow)
	if _, err := onlyB.OpenSession(v); !errors.Is(err, ErrInvalidCookie) {
		t.Errorf("[B] accepted a cookie signed by A: %v", err)
	}
}

func TestCodecKidWithDot(t *testing.T) {
	k := config.CookieKey{ID: "2026.10", Key: keyA.Key}
	c := NewCodec([]config.CookieKey{k}, fixedNow)
	if _, err := c.OpenSession(c.SealSession(testSession())); err != nil {
		t.Errorf("kid with a dot: %v", err)
	}
}

func flip(s string, i int) string {
	b := []byte(s)
	if b[i] == 'A' {
		b[i] = 'B'
	} else {
		b[i] = 'A'
	}
	return string(b)
}

func TestCodecTamper(t *testing.T) {
	c := NewCodec([]config.CookieKey{keyA, keyB}, fixedNow)
	v := c.SealSession(testSession())
	parts := strings.Split(v, ".")

	payloadAt := len(parts[0]) + 1 + len(parts[1]) + 1 + 3
	macAt := len(v) - 5

	forged := NewCodec([]config.CookieKey{keyA}, fixedNow).SealSession(testSession())
	forgedB := strings.Replace(forged, "v1.a.", "v1.b.", 1)

	cases := map[string]string{
		"payload byte": flip(v, payloadAt),
		"mac byte":     flip(v, macAt),
		"wrong kid":    "v1.b." + parts[2] + "." + parts[3],
		"kid swapped":  forgedB,
		"unknown kid":  "v1.z." + parts[2] + "." + parts[3],
		"v2":           "v2" + v[2:],
		"as state":     "v1s" + v[2:],
		"empty":        "",
		"no mac":       "v1.a." + parts[2],
		"extra part":   v + ".x",
		"bad base64":   "v1.a.!!!." + parts[3],
	}
	for name, val := range cases {
		if _, err := c.OpenSession(val); !errors.Is(err, ErrInvalidCookie) {
			t.Errorf("%s: OpenSession err = %v, want ErrInvalidCookie", name, err)
		}
	}

	// Non-canonical base64: the last character of the 43-character MAC
	// carries two padding bits. Setting them keeps the decoded bytes, but
	// the strict decoder rejects it.
	const alphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_"
	last := strings.IndexByte(alphabet, v[len(v)-1])
	nonCanonical := v[:len(v)-1] + string(alphabet[last|1])
	if nonCanonical == v {
		nonCanonical = v[:len(v)-1] + string(alphabet[last|2])
	}
	if _, err := c.OpenSession(nonCanonical); !errors.Is(err, ErrInvalidCookie) {
		t.Errorf("non-canonical MAC encoding accepted: %v", err)
	}

	// An auth cookie is never a state cookie, and vice versa.
	if _, err := c.OpenState(v); !errors.Is(err, ErrInvalidCookie) {
		t.Errorf("auth cookie opened as state: %v", err)
	}
	sv := c.SealState(State{State: "s", RD: "/", Label: "x-3000", Expiry: fixedNow().Add(time.Minute)})
	if _, err := c.OpenSession(sv); !errors.Is(err, ErrInvalidCookie) {
		t.Errorf("state cookie opened as session: %v", err)
	}
	// Relabelling the tag does not help: the tag is covered by the MAC.
	if _, err := c.OpenState("v1s" + v[2:]); !errors.Is(err, ErrInvalidCookie) {
		t.Errorf("retagged auth cookie opened as state: %v", err)
	}

	// A well-signed payload with an unknown mode is rejected.
	bad := Session{Label: "x-3000", Mode: "q", Epoch: 1, Expiry: fixedNow().Add(time.Minute)}
	if _, err := c.OpenSession(c.SealSession(bad)); !errors.Is(err, ErrInvalidCookie) {
		t.Errorf("unknown mode err = %v", err)
	}
}
