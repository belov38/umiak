package ident

import (
	"context"
	"errors"
	"testing"
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
