package httpproxy

import (
	"errors"
	"io"
	"net/http"
	"net/netip"
	"net/textproto"
	"strconv"
	"strings"
	"sync/atomic"
	"testing"
)

func prefixes(s ...string) []netip.Prefix {
	out := make([]netip.Prefix, 0, len(s))
	for _, p := range s {
		out = append(out, netip.MustParsePrefix(p))
	}
	return out
}

func reqFrom(remote string, xff ...string) *http.Request {
	r := &http.Request{RemoteAddr: remote, Header: http.Header{}}
	for _, v := range xff {
		r.Header.Add("X-Forwarded-For", v)
	}
	return r
}

func TestClientIP(t *testing.T) {
	trusted := prefixes("10.0.0.0/8", "fd00::/8")
	cases := []struct {
		name    string
		remote  string
		xff     []string
		trusted []netip.Prefix
		want    string
	}{
		{"no trusted proxies ignores xff", "203.0.113.5:1234", []string{"6.6.6.6"}, nil, "203.0.113.5"},
		{"untrusted peer ignores xff", "203.0.113.5:1234", []string{"6.6.6.6"}, trusted, "203.0.113.5"},
		{"trusted peer, right-most untrusted", "10.0.0.1:80", []string{"6.6.6.6, 198.51.100.7, 10.1.1.1"}, trusted, "198.51.100.7"},
		{"trusted peer, several header lines", "10.0.0.1:80", []string{"6.6.6.6", "198.51.100.7", "10.1.1.1"}, trusted, "198.51.100.7"},
		{"all trusted takes left-most", "10.0.0.1:80", []string{"10.9.9.9, 10.1.1.1"}, trusted, "10.9.9.9"},
		{"trusted peer without xff", "10.0.0.1:80", nil, trusted, "10.0.0.1"},
		{"malformed xff falls back", "10.0.0.1:80", []string{"6.6.6.6, not-an-ip"}, trusted, "10.0.0.1"},
		{"malformed entry: last trusted hop", "10.0.0.1:80", []string{"6.6.6.6,,10.1.1.1"}, trusted, "10.1.1.1"},
		{"malformed entry left of the client", "10.0.0.1:80", []string{"garbage, 198.51.100.7, 10.1.1.1"}, trusted, "198.51.100.7"},
		{"ipv6 remote", "[2001:db8::1]:443", nil, nil, "2001:db8::1"},
		{"ipv4-mapped remote is unmapped", "[::ffff:203.0.113.9]:443", nil, nil, "203.0.113.9"},
		{"trusted v6 peer", "[fd00::1]:80", []string{"2001:db8::7"}, trusted, "2001:db8::7"},
		{"xff with port", "10.0.0.1:80", []string{"198.51.100.7:5555"}, trusted, "198.51.100.7"},
		{"xff with bracketed v6 and port", "10.0.0.1:80", []string{"[2001:db8::9]:5555"}, trusted, "2001:db8::9"},
		{"remote without port", "203.0.113.5", nil, nil, "203.0.113.5"},
	}
	for _, c := range cases {
		t.Run(c.name, func(t *testing.T) {
			got := ClientIP(reqFrom(c.remote, c.xff...), c.trusted)
			if got.String() != c.want {
				t.Fatalf("ClientIP = %s, want %s", got, c.want)
			}
		})
	}
	if got := ClientIP(reqFrom("garbage"), nil); got.IsValid() {
		t.Fatalf("ClientIP(garbage) = %s, want invalid", got)
	}
}

func TestForwardedFor(t *testing.T) {
	trusted := prefixes("10.0.0.0/8")
	cases := []struct {
		name    string
		remote  string
		xff     []string
		trusted []netip.Prefix
		want    string
	}{
		{"edge replaces the client chain", "203.0.113.5:1", []string{"6.6.6.6"}, nil, "203.0.113.5"},
		{"untrusted peer replaces the chain", "203.0.113.5:1", []string{"6.6.6.6"}, trusted, "203.0.113.5"},
		{"trusted chain kept from the client on", "10.0.0.1:1", []string{"6.6.6.6, 198.51.100.7, 10.1.1.1"}, trusted, "198.51.100.7, 10.1.1.1, 10.0.0.1"},
		{"all trusted keeps everything", "10.0.0.1:1", []string{"10.9.9.9, 10.1.1.1"}, trusted, "10.9.9.9, 10.1.1.1, 10.0.0.1"},
		{"trusted peer without xff", "10.0.0.1:1", nil, trusted, "10.0.0.1"},
		{"malformed entry: chain from the last trusted hop", "10.0.0.1:1", []string{"x, 10.1.1.1"}, trusted, "10.1.1.1, 10.0.0.1"},
		{"malformed entry left of the client", "10.0.0.1:1", []string{"x, 198.51.100.7, 10.1.1.1"}, trusted, "198.51.100.7, 10.1.1.1, 10.0.0.1"},
		{"malformed right-most entry", "10.0.0.1:1", []string{"198.51.100.7, x"}, trusted, "10.0.0.1"},
	}
	for _, c := range cases {
		t.Run(c.name, func(t *testing.T) {
			if got := forwardedFor(reqFrom(c.remote, c.xff...), c.trusted); got != c.want {
				t.Fatalf("forwardedFor = %q, want %q", got, c.want)
			}
		})
	}
}

func TestForwardedHeader(t *testing.T) {
	cases := []struct {
		ip, host, want string
	}{
		{"203.0.113.5", "app-3000.sbx.test", "for=203.0.113.5;proto=https;host=app-3000.sbx.test"},
		{"2001:db8::1", "app-3000.sbx.test", `for="[2001:db8::1]";proto=https;host=app-3000.sbx.test`},
		{"203.0.113.5", "app-3000.sbx.test:443", `for=203.0.113.5;proto=https;host="app-3000.sbx.test:443"`},
	}
	for _, c := range cases {
		if got := forwardedHeader(netip.MustParseAddr(c.ip), c.host); got != c.want {
			t.Errorf("forwardedHeader(%s, %s) = %q, want %q", c.ip, c.host, got, c.want)
		}
	}
	if got := forwardedHeader(netip.Addr{}, "h.sbx.test"); got != "for=unknown;proto=https;host=h.sbx.test" {
		t.Errorf("forwardedHeader(invalid) = %q", got)
	}
}

func TestRequestIDFormat(t *testing.T) {
	for _, keep := range []string{"a", "abc-123_X.y", strings.Repeat("z", 128), "with space", "~!@#"} {
		if got := requestID(keep); got != keep {
			t.Errorf("requestID(%q) = %q, want it kept", keep, got)
		}
	}
	for _, repl := range []string{"", strings.Repeat("z", 129), "tab\there", "nul\x00", "ünïcode", "del\x7f"} {
		got := requestID(repl)
		if got == repl || !isULID(got) {
			t.Errorf("requestID(%q) = %q, want a new ULID", repl, got)
		}
	}
	a, b := newULID(), newULID()
	if a == b || !isULID(a) || !isULID(b) {
		t.Fatalf("newULID = %q, %q", a, b)
	}
}

func isULID(s string) bool {
	if len(s) != 26 {
		return false
	}
	for _, c := range s {
		if !strings.ContainsRune(crockford, c) {
			return false
		}
	}
	return s[0] <= '7'
}

func TestStripRequestHeaders(t *testing.T) {
	h := http.Header{}
	drop := []string{
		"Sbx-Foo", "Sbx-Port-Token", "X-Sbx-User-Email", "X-Sbx-Anything",
		"X-Auth-Request-Email", "X-Auth-Request-User", "X-Auth-Request-Groups",
		"X-Forwarded-Email", "X-Forwarded-User", "X-Forwarded-Groups",
		"X-Forwarded-Preferred-Username", "X-Forwarded-Access-Token", "X-Real-Ip",
		"X-Forwarded-Port", "X-Request-Id",
		"Forwarded", "X-Forwarded-For", "X-Forwarded-Host", "X-Forwarded-Proto",
		"True-Client-Ip", "X-Client-Ip", "Client-Ip", "Cf-Connecting-Ip", "X-Original-Forwarded-For",
	}
	for _, k := range drop {
		h.Set(k, "v")
	}
	h["sbx-lower"] = []string{"v"} // a non-canonical key
	// Underscore spellings: CGI-style servers map them to the same variable.
	for _, k := range []string{
		"X_Sbx_User_Email", "Sbx_Foo", "X_Forwarded_For", "X_Forwarded_Email", "X_Real_Ip",
		"X_Auth_Request_Email", "X_forwarded_host", "X_Forwarded_Proto", "X_Forwarded_Port",
		"True_Client_Ip", "Cf_Connecting_Ip", "X_Original_Forwarded_For", "X_Request_Id",
	} {
		h[k] = []string{"v"}
	}
	keep := []string{"Authorization", "X-Sbxish", "Sbxfoo", "X-Forwarded-Prefix", "Cookie"}
	for _, k := range keep {
		h.Set(k, "v")
	}
	stripRequestHeaders(h)
	for k := range h {
		if !contains(keep, k) {
			t.Errorf("header %s kept", k)
		}
	}
	for _, k := range keep {
		if h.Get(k) != "v" {
			t.Errorf("header %s dropped", k)
		}
	}
}

func contains(s []string, v string) bool {
	for _, x := range s {
		if x == v {
			return true
		}
	}
	return false
}

func TestCleanResponseHeader(t *testing.T) {
	h := http.Header{}
	h.Add("Set-Cookie", "__Host-sbx_auth=x; Path=/; Secure")
	h.Add("Set-Cookie", "__host-SBX_auth=y")
	h.Add("Set-Cookie", " __Host-sbx_state_abcdefgh=z")
	h.Add("Set-Cookie", "__HOST-SBX_STATE=z")
	h.Add("Set-Cookie", "keep=1; Path=/")
	h.Add("Set-Cookie", "__Host-sbx_authx=2")
	h.Add("Set-Cookie", "=__Host-sbx_auth=v; Path=/")
	h.Add("Set-Cookie", "= __host-SBX_STATE_x=1")
	h.Add("Set-Cookie", "=other")
	h.Set("Sbx-Error", "fake")
	h.Set("Sbx-Instance-Url", "http://x")
	h["sbx-lower"] = []string{"1"}
	h.Set("Alt-Svc", `h3=":443"`)
	h.Set("X-Sbx-App", "1")
	h.Set("X-Request-Id", "app")
	h.Set("X-Sbx-User-Email", "forged@example.com")
	h["x-sbx-user_email"] = []string{"forged@example.com"}
	cleanResponseHeader(h)
	if got := h.Values("Set-Cookie"); len(got) != 3 || got[0] != "keep=1; Path=/" || got[1] != "__Host-sbx_authx=2" || got[2] != "=other" {
		t.Fatalf("Set-Cookie = %q", got)
	}
	// X-Sbx-User-Email is the gateway's identity header (spec 8.4): an app
	// must not make a client believe the gateway set it.
	for _, k := range []string{"Sbx-Error", "Sbx-Instance-Url", "sbx-lower", "Alt-Svc", "X-Request-Id", "X-Sbx-User-Email", "x-sbx-user_email"} {
		if _, ok := h[k]; ok {
			t.Errorf("%s kept", k)
		}
	}
	if h.Get("X-Sbx-App") != "1" {
		t.Error("X-Sbx-App dropped; only Sbx-* is the gateway's on responses")
	}
}

func TestSanitizeTrailers(t *testing.T) {
	tr := http.Header{"Sbx-X": {"1"}, "X-Ok": {"2"}}
	if sanitizeTrailers(tr) {
		t.Fatal("small trailers reported as dropped")
	}
	if len(tr) != 1 || tr.Get("X-Ok") != "2" {
		t.Fatalf("trailers = %v", tr)
	}

	many := http.Header{}
	for i := range maxTrailerFields + 1 {
		many.Set("X-T-"+strconv.Itoa(i), "v")
	}
	if !sanitizeTrailers(many) || len(many) != 0 {
		t.Fatalf("101 fields: kept %d", len(many))
	}

	exact := http.Header{}
	for i := range maxTrailerFields {
		exact.Set("X-T-"+strconv.Itoa(i), "v")
	}
	if sanitizeTrailers(exact) || len(exact) != maxTrailerFields {
		t.Fatalf("100 fields dropped")
	}

	big := http.Header{"X-Big": {strings.Repeat("a", maxTrailerBytes)}}
	if !sanitizeTrailers(big) || len(big) != 0 {
		t.Fatal("over 64 KiB kept")
	}
	if sanitizeTrailers(nil) {
		t.Fatal("nil trailers reported as dropped")
	}
}

type closeCounter struct{ n atomic.Int32 }

func (c *closeCounter) Close() error {
	c.n.Add(1)
	return errors.New("closed")
}

func TestStreamTracker(t *testing.T) {
	st := NewStreamTracker()
	a, b := &closeCounter{}, &closeCounter{}
	doneA := st.Track(a)
	doneB := st.Track(b)
	if st.Count() != 2 {
		t.Fatalf("Count = %d, want 2", st.Count())
	}
	doneA()
	doneA() // idempotent
	if st.Count() != 1 {
		t.Fatalf("Count after done = %d, want 1", st.Count())
	}
	st.CloseAll()
	if a.n.Load() != 0 || b.n.Load() != 1 {
		t.Fatalf("closes a=%d b=%d, want 0 and 1", a.n.Load(), b.n.Load())
	}
	doneB()
	if st.Count() != 0 {
		t.Fatalf("Count = %d, want 0", st.Count())
	}
	// A stream registered after CloseAll is closed at once.
	c := &closeCounter{}
	doneC := st.Track(c)
	if c.n.Load() != 1 {
		t.Fatalf("late stream closes = %d, want 1", c.n.Load())
	}
	doneC()
	if st.Count() != 0 {
		t.Fatalf("Count = %d, want 0", st.Count())
	}
}

func TestDropUpgrade(t *testing.T) {
	cases := []struct {
		conn []string
		want []string
	}{
		{[]string{"Upgrade"}, nil},
		{[]string{"keep-alive, Upgrade"}, []string{"keep-alive"}},
		{[]string{"upgrade", "X-Hop, close"}, []string{"X-Hop, close"}},
		{nil, nil},
	}
	for _, c := range cases {
		h := http.Header{"Upgrade": {"h2c"}}
		if c.conn != nil {
			h["Connection"] = c.conn
		}
		if !hasUpgrade(h) {
			t.Errorf("hasUpgrade(%v) = false", h)
		}
		dropUpgrade(h)
		if h.Get("Upgrade") != "" || hasUpgrade(h) {
			t.Errorf("Upgrade kept: %v", h)
		}
		if got := h.Values("Connection"); strings.Join(got, "|") != strings.Join(c.want, "|") {
			t.Errorf("Connection %q -> %q, want %q", c.conn, got, c.want)
		}
	}
}

type errBody struct{ err error }

func (b errBody) Read([]byte) (int, error) { return 0, b.err }
func (errBody) Close() error               { return nil }

// Only net/http's own HTTP/1.x trailer read errors end the body cleanly;
// a look-alike text, or any error of an HTTP/2 response, stays an error.
func TestTrailerGuardErrors(t *testing.T) {
	cases := []struct {
		proto int
		err   error
		eof   bool
	}{
		{1, errors.New("http: unexpected EOF reading trailer"), true},
		{1, errors.New("http: suspiciously long trailer after chunked body"), true},
		{1, errors.New("message too large"), true},
		{1, textproto.ProtocolError("malformed MIME header line: x"), true},
		{1, errors.New("read tcp: the peer said trailer"), false},
		{1, io.ErrUnexpectedEOF, false},
		{2, errors.New("http2: server sent GOAWAY and closed the connection; LastStreamID=1, ErrCode=NO_ERROR, debug=\"http: unexpected EOF reading trailer\""), false},
		{2, errors.New("http: unexpected EOF reading trailer"), false},
		{2, textproto.ProtocolError("x"), false},
	}
	for _, tc := range cases {
		res := &http.Response{ProtoMajor: tc.proto, Trailer: http.Header{"X": {"v"}}}
		g := &trailerGuard{ReadCloser: errBody{tc.err}, res: res}
		_, err := g.Read(make([]byte, 1))
		if got := errors.Is(err, io.EOF); got != tc.eof {
			t.Errorf("HTTP/%d %q: read error %v, want EOF %v", tc.proto, tc.err, err, tc.eof)
		}
	}
}
