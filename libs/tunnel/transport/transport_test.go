package transport_test

import (
	"bytes"
	"encoding/base64"
	"encoding/hex"
	"errors"
	"fmt"
	"io"
	"log/slog"
	"net/http"
	"strings"
	"testing"

	"github.com/belov38/boat-dev-clone/libs/tunnel/transport"
	"github.com/belov38/boat-dev-clone/libs/tunnel/wire"
)

func TestHelloHeaderRoundTrip(t *testing.T) {
	secret := bytes.Repeat([]byte{7}, wire.SecretLen)
	for _, scheme := range []transport.AuthScheme{transport.AuthBootstrap, transport.AuthToken} {
		in := transport.Hello{
			MachineID:       "0f8fad5b-d9cb-469f-a165-70867728950e",
			BootID:          "boot-1",
			AgentInstanceID: "inst-1",
			Vmgenid:         "vg-1",
			AgentVersion:    "1.2.3",
			Scheme:          scheme,
			Secret:          secret,
		}
		h := in.Header()
		prefix := wire.SchemeBearer
		if scheme == transport.AuthBootstrap {
			prefix = wire.SchemeBootstrap
		}
		if got, want := h.Get("Authorization"), prefix+" "+wire.EncodeSecret(secret); got != want {
			t.Fatalf("Authorization = %q, want %q", got, want)
		}
		if h.Get(wire.HeaderMachineID) != in.MachineID {
			t.Fatalf("machine id header = %q", h.Get(wire.HeaderMachineID))
		}
		out, err := transport.ParseHello(h)
		if err != nil {
			t.Fatal(err)
		}
		if out.MachineID != in.MachineID || out.BootID != in.BootID || out.AgentInstanceID != in.AgentInstanceID ||
			out.Vmgenid != in.Vmgenid || out.AgentVersion != in.AgentVersion || out.Scheme != scheme ||
			!bytes.Equal(out.Secret, secret) {
			t.Fatalf("round trip mismatch: %+v", out)
		}
	}
}

func TestParseHelloErrors(t *testing.T) {
	secret := wire.EncodeSecret(bytes.Repeat([]byte{1}, wire.SecretLen))
	cases := []struct {
		name   string
		header http.Header
		status int
	}{
		{"no auth", http.Header{wire.HeaderMachineID: {"0f8fad5b-d9cb-469f-a165-70867728950e"}}, 401},
		{"bad scheme", http.Header{wire.HeaderMachineID: {"0f8fad5b-d9cb-469f-a165-70867728950e"}, "Authorization": {"Basic " + secret}}, 401},
		{"bad secret", http.Header{wire.HeaderMachineID: {"0f8fad5b-d9cb-469f-a165-70867728950e"}, "Authorization": {"Bearer short"}}, 401},
		{"no space", http.Header{wire.HeaderMachineID: {"0f8fad5b-d9cb-469f-a165-70867728950e"}, "Authorization": {"Bearer"}}, 401},
		{"no machine id", http.Header{"Authorization": {"Bearer " + secret}}, 400},
		{"machine id not a uuid", http.Header{wire.HeaderMachineID: {"garbage"}, "Authorization": {"Bearer " + secret}}, 400},
	}
	for _, c := range cases {
		_, err := transport.ParseHello(c.header)
		var rej *transport.RejectError
		if !errors.As(err, &rej) {
			t.Errorf("%s: err = %v, want *RejectError", c.name, err)
			continue
		}
		if rej.Status != c.status {
			t.Errorf("%s: status = %d, want %d", c.name, rej.Status, c.status)
		}
	}
}

func TestParseHelloCanonicalMachineID(t *testing.T) {
	const want = "0f8fad5b-d9cb-469f-a165-70867728950e"
	secret := wire.EncodeSecret(bytes.Repeat([]byte{1}, wire.SecretLen))
	for _, in := range []string{
		want,
		"0F8FAD5B-D9CB-469F-A165-70867728950E",
		"{0F8FAD5B-D9CB-469F-A165-70867728950E}",
		"urn:uuid:0f8fad5b-d9cb-469f-a165-70867728950e",
	} {
		h := http.Header{wire.HeaderMachineID: {in}, "Authorization": {"Bearer " + secret}}
		out, err := transport.ParseHello(h)
		if err != nil || out.MachineID != want {
			t.Errorf("ParseHello(%q) = %q, %v; want %q", in, out.MachineID, err, want)
		}
	}
}

// The secret never shows in formatted or logged output, whatever the verb
// or handler, also when the Hello is nested or behind a pointer.
func TestHelloRedactsSecret(t *testing.T) {
	secret := make([]byte, wire.SecretLen)
	for i := range secret {
		secret[i] = byte(0xA0 + i)
	}
	h := transport.Hello{
		MachineID: "0f8fad5b-d9cb-469f-a165-70867728950e", BootID: "boot-1", AgentInstanceID: "inst-1",
		Vmgenid: "vg-1", AgentVersion: "1.2.3", Scheme: transport.AuthToken, Secret: secret, ProtoVersion: "sbx-tunnel.v1",
	}
	leaks := []string{
		string(secret),
		hex.EncodeToString(secret),
		base64.StdEncoding.EncodeToString(secret),
		base64.RawStdEncoding.EncodeToString(secret),
		base64.RawURLEncoding.EncodeToString(secret),
		fmt.Sprintf("%d", secret),  // [160 161 ...]
		fmt.Sprintf("%#v", secret), // []byte{0xa0, ...}
		fmt.Sprintf("%x", secret[:4]),
	}
	type wrapped struct{ H transport.Hello }
	// fmt prints an unexported field by reflection, without calling any
	// method: a Hello kept in a struct must have dropped its secret first.
	type private struct{ h transport.Hello }
	out, leakOnly := map[string]string{}, map[string]string{}
	for _, verb := range []string{"%v", "%+v", "%#v", "%s", "%d", "%x", "%X", "%q", "%o", "%10.3v", "%-v"} {
		out[verb] = fmt.Sprintf(verb, h)
		out[verb+" pointer"] = fmt.Sprintf(verb, &h)
		out[verb+" nested"] = fmt.Sprintf(verb, wrapped{h})
		// Only checked for leaks: reflection may print the fields in hex.
		leakOnly[verb+" unexported without secret"] = fmt.Sprintf(verb, private{h.WithoutSecret()})
	}
	if h.Secret == nil || h.WithoutSecret().Secret != nil || h.WithoutSecret().MachineID != h.MachineID {
		t.Fatal("WithoutSecret must clear only the copy's secret")
	}
	for name, newHandler := range map[string]func(io.Writer) slog.Handler{
		"text": func(w io.Writer) slog.Handler { return slog.NewTextHandler(w, nil) },
		"json": func(w io.Writer) slog.Handler { return slog.NewJSONHandler(w, nil) },
	} {
		var buf bytes.Buffer
		l := slog.New(newHandler(&buf))
		l.Info("hello", "hello", h, "ptr", &h)
		l.With("hello", h).Info("with")
		l.Info("nested", "w", wrapped{h})
		out["slog "+name] = buf.String()
	}
	for name, s := range leakOnly {
		for _, leak := range leaks {
			if strings.Contains(s, leak) {
				t.Errorf("%s prints the secret (%q): %s", name, leak, s)
			}
		}
	}
	for name, s := range out {
		for _, leak := range leaks {
			if strings.Contains(s, leak) {
				t.Errorf("%s prints the secret (%q): %s", name, leak, s)
			}
		}
		if !strings.Contains(s, "REDACTED") || !strings.Contains(s, h.MachineID) {
			t.Errorf("%s: want the machine id and a redaction mark: %s", name, s)
		}
	}
	t.Logf("%%+v: %s", out["%+v"])
	t.Logf("%%#v: %s", out["%#v"])
	t.Logf("slog json: %s", out["slog json"])
}
