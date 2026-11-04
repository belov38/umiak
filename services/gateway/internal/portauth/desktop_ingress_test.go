package portauth

import (
	"net/http"
	"net/http/httptest"
	"testing"
	"time"

	"github.com/belov38/umiak/services/gateway/internal/cpapi"
	"github.com/belov38/umiak/services/gateway/internal/routes"
)

const ingressLabel = "brave-otter-lake-desktop"

func ingressKey() []byte {
	k := make([]byte, 32)
	for i := range k {
		k[i] = byte(i)
	}
	return k
}

// TestIngressDesktopGoldenVector pins the wire format for the Node signer.
// Key: bytes 0x00..0x1f; label brave-otter-lake-desktop; exp 1800000030.
func TestIngressDesktopGoldenVector(t *testing.T) {
	const want = "brave-otter-lake-desktop.1800000030.w5ToK3OgWoDIjQyZJxRrOLHdue4nMbyOKoD_UQbfkgo"
	if got := SignIngressDesktop(ingressKey(), ingressLabel, 1_800_000_030); got != want {
		t.Fatalf("golden = %q", got)
	}
}

func ingressCheck(t *testing.T, header string, mut func(*http.Request)) (Result, *httptest.ResponseRecorder) {
	t.Helper()
	h := newHarness(t, func(c *Config) {
		c.IngressDesktopKey = ingressKey()
		c.Now = fixedNow
	})
	l := routes.Label{Raw: ingressLabel, Slug: "brave-otter-lake", Kind: routes.KindDesktop}
	r := httptest.NewRequestWithContext(t.Context(), "GET", "http://"+ingressLabel+"."+testDomain+":8085/stream", nil)
	r.Header.Set("Upgrade", "websocket")
	r.Header.Set("Origin", "https://evil.example")
	if header != "" {
		r.Header.Set(IngressDesktopHeader, header)
	}
	if mut != nil {
		mut(r)
	}
	w := httptest.NewRecorder()
	return h.auth.CheckDesktop(w, r, l, cpapi.Route{Access: "token", AuthEpoch: 7}, clientIP, "rid", nil), w
}

func TestIngressDesktopValid(t *testing.T) {
	exp := fixedNow().Add(30 * time.Second).Unix()
	res, _ := ingressCheck(t, SignIngressDesktop(ingressKey(), ingressLabel, exp), nil)
	if !res.Proceed || !res.Ingress {
		t.Fatalf("valid credential rejected: %+v", res)
	}
}

func TestIngressDesktopRejected(t *testing.T) {
	now := fixedNow()
	key := ingressKey()
	other := append([]byte{}, key...)
	other[0] ^= 1
	good := SignIngressDesktop(key, ingressLabel, now.Add(30*time.Second).Unix())
	cases := map[string]string{
		"wrong label":   SignIngressDesktop(key, "other-otter-lake-desktop", now.Add(30*time.Second).Unix()),
		"expired":       SignIngressDesktop(key, ingressLabel, now.Unix()-1),
		"exp is now":    SignIngressDesktop(key, ingressLabel, now.Unix()),
		"too far":       SignIngressDesktop(key, ingressLabel, now.Add(61*time.Second).Unix()),
		"wrong key":     SignIngressDesktop(other, ingressLabel, now.Add(30*time.Second).Unix()),
		"bad mac":       good[:len(good)-2] + "AA",
		"padded mac":    good + "=",
		"two parts":     ingressLabel + ".1800000030",
		"junk":          "junk",
		"non-canonical": ingressLabel + ".+1800000030." + good[len(good)-43:],
	}
	for name, v := range cases {
		t.Run(name, func(t *testing.T) {
			res, w := ingressCheck(t, v, nil)
			if res.Proceed || w.Code != http.StatusForbidden {
				t.Fatalf("accepted or wrong status: %+v %d", res, w.Code)
			}
		})
	}
}

func TestIngressDesktopInvalidDoesNotFallBackToCookie(t *testing.T) {
	h := newHarness(t, func(c *Config) { c.IngressDesktopKey = ingressKey(); c.Now = fixedNow })
	l := routes.Label{Raw: ingressLabel, Kind: routes.KindDesktop}
	rt := cpapi.Route{Access: "token", AuthEpoch: 7}
	cookie := h.auth.sessionCookie(Session{Label: ingressLabel, Mode: ModeDesktop, Epoch: 7, UserID: "u"}, time.Hour)
	r := httptest.NewRequestWithContext(t.Context(), "GET", "http://"+ingressLabel+"."+testDomain+"/", nil)
	r.AddCookie(cookie)
	if !h.auth.CheckDesktop(httptest.NewRecorder(), r, l, rt, clientIP, "rid", nil).Proceed {
		t.Fatal("cookie baseline rejected")
	}
	r.Header.Set(IngressDesktopHeader, "garbage")
	w := httptest.NewRecorder()
	if h.auth.CheckDesktop(w, r, l, rt, clientIP, "rid", nil).Proceed || w.Code != 403 {
		t.Fatalf("invalid header fell back to cookie: %d", w.Code)
	}
}

func TestIngressDesktopDisabledWithoutKey(t *testing.T) {
	h := newHarness(t, func(c *Config) { c.Now = fixedNow })
	l := routes.Label{Raw: ingressLabel, Kind: routes.KindDesktop}
	r := httptest.NewRequestWithContext(t.Context(), "GET", "http://"+ingressLabel+"."+testDomain+"/", nil)
	r.Header.Set(IngressDesktopHeader, SignIngressDesktop(ingressKey(), ingressLabel, fixedNow().Unix()+30))
	w := httptest.NewRecorder()
	if h.auth.CheckDesktop(w, r, l, cpapi.Route{Access: "token"}, clientIP, "rid", nil).Proceed || w.Code != 403 {
		t.Fatalf("accepted without key: %d", w.Code)
	}
}

func TestIngressDesktopAbsentHeaderUnchanged(t *testing.T) {
	res, w := ingressCheck(t, "", nil)
	if res.Proceed || res.Ingress || w.Code != http.StatusForbidden {
		t.Fatalf("foreign-origin websocket without header: %+v %d", res, w.Code)
	}
}
