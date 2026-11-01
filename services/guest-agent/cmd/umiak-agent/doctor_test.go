package main

import (
	"bytes"
	"context"
	"encoding/json"
	"strings"
	"testing"

	"github.com/belov38/umiak/libs/tunnel/wire"

	"github.com/belov38/umiak/services/guest-agent/internal/ident"
)

func TestDoctorCLI(t *testing.T) {
	bs := bytes.Repeat([]byte{9}, wire.SecretLen)
	d, _ := testDeps(t, ident.Static{Raw: ident.Raw{
		Serial: wire.SMBIOSSerial(cliMachineID, bs),
		Family: "umiakt1:wss://family.test/v1/connect",
	}})
	d.isActive = func(context.Context, string) string { return "active" }
	d.statfs = func(string) (uint64, uint64, error) { return 10, 5, nil }

	var out, errOut bytes.Buffer
	if code := runWith(context.Background(), d, []string{"doctor", "--json"}, &out, &errOut); code != 0 {
		t.Fatalf("exit = %d, stderr = %s", code, errOut.String())
	}
	if strings.Contains(out.String(), wire.EncodeSecret(bs)) {
		t.Fatal("doctor output contains the boot secret")
	}
	var m struct {
		Units     map[string]string `json:"units"`
		TunnelURL struct {
			URL    string `json:"url"`
			Source string `json:"source"`
		} `json:"tunnel_url"`
	}
	if err := json.Unmarshal(out.Bytes(), &m); err != nil {
		t.Fatalf("doctor --json: %v\n%s", err, out.String())
	}
	if m.Units["umiak-agent"] != "active" || m.TunnelURL.Source != "smbios" || m.TunnelURL.URL != "wss://family.test/v1/connect" {
		t.Errorf("doctor --json = %s", out.String())
	}

	out.Reset()
	if code := runWith(context.Background(), d, []string{"doctor"}, &out, &errOut); code != 0 {
		t.Fatalf("exit = %d, stderr = %s", code, errOut.String())
	}
	if !strings.Contains(out.String(), "tunnel url: wss://family.test/v1/connect (smbios)") {
		t.Errorf("doctor = %s", out.String())
	}
}
