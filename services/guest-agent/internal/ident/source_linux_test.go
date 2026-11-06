package ident

import (
	"context"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

func TestSysfsSource(t *testing.T) {
	dir := t.TempDir()
	boot := filepath.Join(t.TempDir(), "boot_id")
	serial := testSerial(testMachineID)
	mustWrite(t, filepath.Join(dir, "product_serial"), serial+"\n")
	mustWrite(t, filepath.Join(dir, "product_uuid"), testMachineID+"\n")
	mustWrite(t, filepath.Join(dir, "product_family"), "umiakt1:wss://h/v1/connect\n")
	mustWrite(t, boot, "boot-1\n")
	mustWrite(t, filepath.Join(dir, "product_sku"), "umiakca1:"+strings.Repeat("a", 64)+"\n")

	raw, err := SysfsSource{Dir: dir, BootIDPath: boot}.Read(context.Background())
	if err != nil {
		t.Fatal(err)
	}
	want := Raw{Serial: serial, UUID: testMachineID, Family: "umiakt1:wss://h/v1/connect", BootID: "boot-1", SKU: "umiakca1:" + strings.Repeat("a", 64)}
	if raw != want {
		t.Errorf("raw = %+v, want %+v", raw, want)
	}
}

func TestSysfsSourceOptionalFilesMissing(t *testing.T) {
	dir := t.TempDir()
	mustWrite(t, filepath.Join(dir, "product_serial"), "x\n")
	raw, err := SysfsSource{Dir: dir, BootIDPath: filepath.Join(dir, "nope")}.Read(context.Background())
	if err != nil {
		t.Fatal(err)
	}
	if raw.UUID != "" || raw.Family != "" || raw.BootID != "" || raw.Serial != "x" {
		t.Errorf("raw = %+v", raw)
	}
}

func TestSysfsSourceNoSerial(t *testing.T) {
	_, err := SysfsSource{Dir: t.TempDir()}.Read(context.Background())
	if err == nil || !os.IsNotExist(unwrapAll(err)) {
		t.Errorf("err = %v, want a not-exist error", err)
	}
	if err != nil && strings.Contains(err.Error(), "umiak1:") {
		t.Errorf("error leaks serial: %v", err)
	}
}

func unwrapAll(err error) error {
	for {
		u, ok := err.(interface{ Unwrap() error })
		if !ok {
			return err
		}
		err = u.Unwrap()
	}
}
