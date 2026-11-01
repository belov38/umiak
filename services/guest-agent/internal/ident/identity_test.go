package ident

import (
	"bytes"
	"strings"
	"testing"

	"github.com/belov38/umiak/libs/tunnel/wire"
)

const (
	testMachineID = "0190a1b2-c3d4-7e5f-8a9b-0c1d2e3f4a5b"
	testHex       = "0190a1b2c3d47e5f8a9b0c1d2e3f4a5b"
	testHostname  = "umiak-0c1d2e3f4a5b"
)

func testBS() []byte { return bytes.Repeat([]byte{0xab}, wire.SecretLen) }

func testSerial(machineID string) string { return wire.SMBIOSSerial(machineID, testBS()) }

func TestParseSerial(t *testing.T) {
	t.Run("valid", func(t *testing.T) {
		id, err := Parse(Raw{Serial: " " + testSerial(testMachineID) + "\n", UUID: testMachineID, BootID: "boot-1"})
		if err != nil {
			t.Fatal(err)
		}
		if id.MachineID != testMachineID {
			t.Errorf("MachineID = %q", id.MachineID)
		}
		if !bytes.Equal(id.BS, testBS()) {
			t.Errorf("BS mismatch")
		}
		if id.BootID != "boot-1" {
			t.Errorf("BootID = %q", id.BootID)
		}
		if len(id.Warnings) != 0 {
			t.Errorf("warnings = %v", id.Warnings)
		}
	})
	t.Run("uuid mismatch warns", func(t *testing.T) {
		id, err := Parse(Raw{Serial: testSerial(testMachineID), UUID: "11111111-2222-3333-4444-555555555555"})
		if err != nil {
			t.Fatal(err)
		}
		if id.MachineID != testMachineID || len(id.Warnings) != 1 {
			t.Errorf("id = %+v", id)
		}
	})
	t.Run("uuid case is ignored", func(t *testing.T) {
		id, err := Parse(Raw{Serial: testSerial(testMachineID), UUID: strings.ToUpper(testMachineID)})
		if err != nil {
			t.Fatal(err)
		}
		if len(id.Warnings) != 0 {
			t.Errorf("warnings = %v", id.Warnings)
		}
	})
	for _, tt := range []struct{ name, serial string }{
		{"empty", ""},
		{"wrong version", "umiak2:" + testMachineID + ":" + wire.EncodeSecret(testBS())},
		{"no secret", "umiak1:" + testMachineID},
		{"bad base64", "umiak1:" + testMachineID + ":!!!"},
		{"short secret", "umiak1:" + testMachineID + ":" + wire.EncodeSecret([]byte("short"))},
		{"machine id not a uuid", testSerial("not-a-uuid")},
		{"machine id too short", testSerial("0190a1b2")},
		{"machine id not hex", testSerial("zzzzzzzz-c3d4-7e5f-8a9b-0c1d2e3f4a5b")},
	} {
		t.Run("malformed/"+tt.name, func(t *testing.T) {
			if _, err := Parse(Raw{Serial: tt.serial}); err == nil {
				t.Error("want error")
			}
		})
	}
	t.Run("error does not leak the secret", func(t *testing.T) {
		_, err := Parse(Raw{Serial: testSerial("not-a-uuid")})
		if err == nil || strings.Contains(err.Error(), wire.EncodeSecret(testBS())) {
			t.Errorf("err = %v", err)
		}
	})
}

func TestParseFamily(t *testing.T) {
	long := "wss://" + strings.Repeat("a", 194) // 200 bytes
	for _, tt := range []struct {
		name, family, want string
		warn               bool
	}{
		{"valid", "umiakt1:wss://h.example.com/v1/connect", "wss://h.example.com/v1/connect", false},
		{"valid with port", "umiakt1:wss://h:8443/v1/connect", "wss://h:8443/v1/connect", false},
		{"trailing newline", "umiakt1:wss://h/v1/connect\n", "wss://h/v1/connect", false},
		{"exactly 200 bytes", "umiakt1:" + long, long, false},
		{"201 bytes", "umiakt1:" + long + "a", "", true},
		{"http", "umiakt1:http://h/v1/connect", "", true},
		{"ws", "umiakt1:ws://h/v1/connect", "", true},
		{"empty host", "umiakt1:wss:///v1/connect", "", true},
		{"no scheme", "umiakt1:h/v1/connect", "", true},
		{"no prefix", "wss://h/v1/connect", "", true},
		{"other prefix", "umiakt2:wss://h/v1/connect", "", true},
		{"whitespace in url", "umiakt1:wss://h /v1/connect", "", true},
		{"absent", "", "", false},
	} {
		t.Run(tt.name, func(t *testing.T) {
			id, err := Parse(Raw{Serial: testSerial(testMachineID), Family: tt.family})
			if err != nil {
				t.Fatal(err)
			}
			if id.TunnelURL != tt.want {
				t.Errorf("TunnelURL = %q, want %q", id.TunnelURL, tt.want)
			}
			if got := len(id.Warnings) > 0; got != tt.warn {
				t.Errorf("warnings = %v, want warning: %v", id.Warnings, tt.warn)
			}
		})
	}
}

func TestValidHostname(t *testing.T) {
	for _, tt := range []struct {
		s    string
		want bool
	}{
		{"umiak-0c1d2e3f4a5b", true},
		{"a", true},
		{"A1", true},
		{"my-host-1", true},
		{strings.Repeat("a", 63), true},
		{strings.Repeat("a", 64), false},
		{"", false},
		{"-a", false},
		{"a-", false},
		{"a.b", false},
		{"a_b", false},
		{"a b", false},
		{"a\n", false},
		{"хост", false},
	} {
		if got := ValidHostname(tt.s); got != tt.want {
			t.Errorf("ValidHostname(%q) = %v, want %v", tt.s, got, tt.want)
		}
	}
}

func TestDefaultHostname(t *testing.T) {
	if got := DefaultHostname(testMachineID); got != testHostname {
		t.Errorf("got %q", got)
	}
	if got := DefaultHostname(strings.ToUpper(testHex)); got != testHostname {
		t.Errorf("uppercase: got %q", got)
	}
	if !ValidHostname(DefaultHostname(testMachineID)) {
		t.Error("default hostname is not valid")
	}
}
