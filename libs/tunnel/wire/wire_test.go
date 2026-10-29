package wire_test

import (
	"bytes"
	"testing"

	"github.com/belov38/boat-dev-clone/libs/tunnel/wire"
)

func TestSecretRoundTrip(t *testing.T) {
	b, err := wire.NewSecret()
	if err != nil {
		t.Fatal(err)
	}
	if len(b) != wire.SecretLen {
		t.Fatalf("len = %d, want %d", len(b), wire.SecretLen)
	}
	s := wire.EncodeSecret(b)
	if len(s) != 43 {
		t.Fatalf("encoded len = %d, want 43 (base64url without padding)", len(s))
	}
	got, err := wire.DecodeSecret(s)
	if err != nil {
		t.Fatal(err)
	}
	if !bytes.Equal(got, b) {
		t.Fatal("round trip mismatch")
	}
	h := wire.HashSecret(b)
	if len(h) != 32 {
		t.Fatalf("hash len = %d", len(h))
	}
	if bytes.Equal(h, b) {
		t.Fatal("hash must differ from secret")
	}
}

func TestDecodeSecretRejectsWrongLength(t *testing.T) {
	for _, n := range []int{0, 16, 31, 33, 64} {
		s := wire.EncodeSecret(make([]byte, n))
		if _, err := wire.DecodeSecret(s); err == nil {
			t.Errorf("len %d: expected error", n)
		}
	}
	if _, err := wire.DecodeSecret("not base64 !!"); err == nil {
		t.Error("garbage: expected error")
	}
}

func TestSMBIOSSerialRoundTrip(t *testing.T) {
	bs := bytes.Repeat([]byte{0xAB}, wire.SecretLen)
	s := wire.SMBIOSSerial("m-123", bs)
	id, got, err := wire.ParseSMBIOSSerial(s)
	if err != nil {
		t.Fatal(err)
	}
	if id != "m-123" || !bytes.Equal(got, bs) {
		t.Fatalf("got %q %x", id, got)
	}
	if _, _, err := wire.ParseSMBIOSSerial("sbx2:m-123:" + wire.EncodeSecret(bs)); err == nil {
		t.Error("sbx2 must be rejected")
	}
	for _, bad := range []string{"", "sbx1:", "sbx1:m", "sbx1::" + wire.EncodeSecret(bs), "sbx1:m:AAAA"} {
		if _, _, err := wire.ParseSMBIOSSerial(bad); err == nil {
			t.Errorf("%q: expected error", bad)
		}
	}
}

func TestCompareVersions(t *testing.T) {
	cases := []struct {
		a, b string
		want int
	}{
		{"1.2.3", "1.10.0", -1},
		{"1.10.0", "1.2.3", 1},
		{"1.0.0-rc.1", "1.0.0", -1},
		{"1.0.0", "1.0.0-rc.1", 1},
		{"v1.0.0", "1.0.0", 0},
		{"1.0.0-alpha", "1.0.0-alpha.1", -1},
		{"1.0.0-alpha.1", "1.0.0-alpha.beta", -1},
		{"1.0.0-rc.2", "1.0.0-rc.10", -1},
		{"1.0.0-1", "1.0.0-alpha", -1},
		{"1.0.0+build1", "1.0.0+build2", 0},
		{"2.0.0", "1.99.99", 1},
	}
	for _, c := range cases {
		got, err := wire.CompareVersions(c.a, c.b)
		if err != nil {
			t.Errorf("%s vs %s: %v", c.a, c.b, err)
			continue
		}
		if got != c.want {
			t.Errorf("%s vs %s = %d, want %d", c.a, c.b, got, c.want)
		}
	}
	for _, bad := range []string{"", "garbage", "1.2", "1.2.x", "1.2.3.4", "01.2.3", "1.2.3-"} {
		if _, err := wire.CompareVersions(bad, "1.0.0"); err == nil {
			t.Errorf("%q: expected error", bad)
		}
		if _, err := wire.CompareVersions("1.0.0", bad); err == nil {
			t.Errorf("%q (b): expected error", bad)
		}
	}
}
