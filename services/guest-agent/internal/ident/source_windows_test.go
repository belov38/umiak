package ident

import (
	"context"
	"errors"
	"testing"

	"github.com/belov38/umiak/services/guest-agent/internal/winapi"
)

func TestFirmwareSourceRead(t *testing.T) {
	table := smbTable(smbType0, smbType1(smbWireUUID, 1, 2, true, smbSerial, smbFamily), smbEnd)
	src := FirmwareSource{
		ReadTable: func() ([]byte, error) { return table, nil },
		BootCount: func() (uint32, error) { return 5, nil },
	}
	raw, err := src.Read(context.Background())
	if err != nil {
		t.Fatal(err)
	}
	const machine = "00112233-4455-6677-8899-aabbccddeeff"
	want := Raw{Serial: smbSerial, UUID: machine, Family: smbFamily, BootID: BootIDFor(machine, 5)}
	if raw != want {
		t.Errorf("raw = %+v, want %+v", raw, want)
	}
}

func TestFirmwareSourceBootCountFailure(t *testing.T) {
	table := smbTable(smbType1(smbWireUUID, 1, 0, true, smbSerial), smbEnd)
	src := FirmwareSource{
		ReadTable: func() ([]byte, error) { return table, nil },
		BootCount: func() (uint32, error) { return 0, errors.New("no key") },
	}
	raw, err := src.Read(context.Background())
	if err != nil {
		t.Fatal(err)
	}
	if raw.BootID != "" || raw.Serial != smbSerial {
		t.Errorf("raw = %+v", raw)
	}
}

func TestFirmwareSourceTableError(t *testing.T) {
	src := FirmwareSource{
		ReadTable: func() ([]byte, error) { return nil, errors.New("denied") },
		BootCount: func() (uint32, error) { return 1, nil },
	}
	if _, err := src.Read(context.Background()); err == nil {
		t.Error("want error")
	}
}

// TestNewFirmwareSourceRealTable reads the SMBIOS table of the machine the
// test runs on. Hosts without SMBIOS data (some containers) are skipped.
func TestNewFirmwareSourceRealTable(t *testing.T) {
	src := NewFirmwareSource()
	table, err := src.ReadTable()
	if err != nil {
		t.Skipf("no SMBIOS table: %v", err)
	}
	if _, _, _, err := ParseSMBIOSType1(table); err != nil {
		t.Errorf("parse real table: %v", err)
	}
	if _, err := src.BootCount(); err != nil {
		t.Errorf("boot count: %v", err)
	}
}

func TestFirmwareSourceVolatileFallback(t *testing.T) {
	table := smbTable(smbType1(smbWireUUID, 1, 0, true, smbSerial), smbEnd)
	src := FirmwareSource{
		ReadTable:      func() ([]byte, error) { return table, nil },
		BootCount:      func() (uint32, error) { return 0, errors.New("no key") },
		FallbackBootID: func() (string, error) { return "volatile-1", nil },
	}
	raw, err := src.Read(context.Background())
	if err != nil {
		t.Fatal(err)
	}
	if raw.BootID != "volatile-1" {
		t.Errorf("boot id = %q, want the volatile one", raw.BootID)
	}
}

// TestVolatileBootIDStable reads the volatile boot id twice: the same id
// within one boot (the test runs as SYSTEM or an elevated administrator).
func TestVolatileBootIDStable(t *testing.T) {
	a, err := winapi.VolatileBootID()
	if err != nil {
		t.Fatal(err)
	}
	b, err := winapi.VolatileBootID()
	if err != nil {
		t.Fatal(err)
	}
	if a == "" || a != b {
		t.Errorf("volatile boot ids %q, %q", a, b)
	}
}
