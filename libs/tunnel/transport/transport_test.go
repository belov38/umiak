package transport_test

import (
	"bytes"
	"errors"
	"net/http"
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
