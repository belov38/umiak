package ident

import (
	"encoding/binary"
	"strings"
	"testing"

	"github.com/google/uuid"
)

// smbStruct builds one SMBIOS structure: header, formatted body (the bytes
// after the 4-byte header) and the string set.
func smbStruct(typ byte, handle uint16, body []byte, strs ...string) []byte {
	out := []byte{typ, byte(4 + len(body)), byte(handle), byte(handle >> 8)}
	out = append(out, body...)
	if len(strs) == 0 {
		return append(out, 0, 0)
	}
	for _, s := range strs {
		out = append(out, s...)
		out = append(out, 0)
	}
	return append(out, 0)
}

// smbType1 builds a type 1 structure. uuidBytes are the raw 16 bytes at offset
// 8; serialIdx and familyIdx are 1-based string indexes. With family false the
// structure ends after the SKU number (SMBIOS 2.3 layout).
func smbType1(uuidBytes [16]byte, serialIdx, familyIdx byte, family bool, strs ...string) []byte {
	body := []byte{1, 2, 3, serialIdx} // manufacturer, product, version, serial
	body = append(body, uuidBytes[:]...)
	body = append(body, 6, 0) // wake-up type, SKU number
	if family {
		body = append(body, familyIdx)
	}
	return smbStruct(1, 0x100, body, strs...)
}

// smbTable wraps structures into RawSMBIOSData with an SMBIOS 3.5 header.
func smbTable(structs ...[]byte) []byte {
	var table []byte
	for _, s := range structs {
		table = append(table, s...)
	}
	hdr := make([]byte, 8)
	hdr[1], hdr[2], hdr[3] = 3, 5, 0
	binary.LittleEndian.PutUint32(hdr[4:], uint32(len(table)))
	return append(hdr, table...)
}

var (
	smbEnd   = smbStruct(127, 0xfeff, nil)
	smbType0 = smbStruct(0, 0, []byte{1, 2, 0xff, 0xff, 3, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0}, "BIOS", "1.0", "01/01/2025")
	smbType3 = smbStruct(3, 0x300, []byte{1, 1, 2, 0, 0, 3, 3, 3, 3, 0, 0, 0, 0}, "Vendor", "Chassis", "Serial")
	// 00112233-4455-6677-8899-aabbccddeeff with the first three fields little-endian.
	smbWireUUID = [16]byte{0x33, 0x22, 0x11, 0x00, 0x55, 0x44, 0x77, 0x66, 0x88, 0x99, 0xaa, 0xbb, 0xcc, 0xdd, 0xee, 0xff}
)

const (
	smbSerial = "sbx1:0190a1b2-c3d4-7e5f-8a9b-0c1d2e3f4a5b:c2VjcmV0"
	smbFamily = "sbxt1:wss://sbx.example.test/v1/connect"
)

func TestParseSMBIOSType1(t *testing.T) {
	raw := smbTable(
		smbType1(smbWireUUID, 4, 5, true, "QEMU", "Standard PC", "pc-q35-9.0", smbSerial, smbFamily),
		smbEnd,
	)
	u, serial, family, err := ParseSMBIOSType1(raw)
	if err != nil {
		t.Fatal(err)
	}
	if u != "00112233-4455-6677-8899-aabbccddeeff" {
		t.Errorf("uuid = %q", u)
	}
	if serial != smbSerial {
		t.Errorf("serial = %q", serial)
	}
	if family != smbFamily {
		t.Errorf("family = %q", family)
	}
}

func TestParseSMBIOSType1SkipsOtherStructures(t *testing.T) {
	raw := smbTable(
		smbType0,
		smbType3,
		smbType1(smbWireUUID, 1, 2, true, smbSerial, smbFamily),
		smbEnd,
	)
	u, serial, family, err := ParseSMBIOSType1(raw)
	if err != nil {
		t.Fatal(err)
	}
	if u != "00112233-4455-6677-8899-aabbccddeeff" || serial != smbSerial || family != smbFamily {
		t.Errorf("got %q %q %q", u, serial, family)
	}
}

func TestParseSMBIOSType1UUIDByteOrder(t *testing.T) {
	raw := smbTable(smbType1(smbWireUUID, 1, 0, true, smbSerial), smbEnd)
	u, _, _, err := ParseSMBIOSType1(raw)
	if err != nil {
		t.Fatal(err)
	}
	if u != "00112233-4455-6677-8899-aabbccddeeff" {
		t.Errorf("uuid = %q", u)
	}
}

func TestParseSMBIOSType1UUIDOldVersionBigEndian(t *testing.T) {
	raw := smbTable(smbType1(smbWireUUID, 1, 0, true, smbSerial), smbEnd)
	raw[1], raw[2] = 2, 5 // SMBIOS 2.5: the UUID is stored as written
	u, _, _, err := ParseSMBIOSType1(raw)
	if err != nil {
		t.Fatal(err)
	}
	if u != "33221100-5544-7766-8899-aabbccddeeff" {
		t.Errorf("uuid = %q", u)
	}
}

func TestParseSMBIOSType1UUIDNotSet(t *testing.T) {
	for name, b := range map[string]byte{"zero": 0x00, "ones": 0xff} {
		var id [16]byte
		for i := range id {
			id[i] = b
		}
		raw := smbTable(smbType1(id, 1, 0, true, smbSerial), smbEnd)
		u, _, _, err := ParseSMBIOSType1(raw)
		if err != nil {
			t.Fatalf("%s: %v", name, err)
		}
		if u != "" {
			t.Errorf("%s: uuid = %q, want empty", name, u)
		}
	}
}

func TestParseSMBIOSType1NoFamily(t *testing.T) {
	// SMBIOS 2.3 layout (length 0x19): no family field.
	raw := smbTable(smbType1(smbWireUUID, 1, 0, false, smbSerial), smbEnd)
	_, serial, family, err := ParseSMBIOSType1(raw)
	if err != nil {
		t.Fatal(err)
	}
	if serial != smbSerial || family != "" {
		t.Errorf("serial = %q, family = %q", serial, family)
	}
	// Family index 0 means "no string".
	raw = smbTable(smbType1(smbWireUUID, 1, 0, true, smbSerial), smbEnd)
	_, _, family, err = ParseSMBIOSType1(raw)
	if err != nil || family != "" {
		t.Errorf("family = %q, err = %v", family, err)
	}
}

func TestParseSMBIOSType1NoStrings(t *testing.T) {
	raw := smbTable(smbType1(smbWireUUID, 0, 0, true), smbEnd)
	_, serial, family, err := ParseSMBIOSType1(raw)
	if err != nil {
		t.Fatal(err)
	}
	if serial != "" || family != "" {
		t.Errorf("serial = %q, family = %q", serial, family)
	}
}

func TestParseSMBIOSMissingType1(t *testing.T) {
	cases := map[string][]byte{
		"only end marker":  smbTable(smbEnd),
		"type 0 and 3":     smbTable(smbType0, smbType3, smbEnd),
		"no end marker":    smbTable(smbType0, smbType3),
		"empty table":      smbTable(),
		"type 1 after end": smbTable(smbEnd, smbType1(smbWireUUID, 1, 0, true, smbSerial)),
	}
	for name, raw := range cases {
		if _, _, _, err := ParseSMBIOSType1(raw); err == nil {
			t.Errorf("%s: want error", name)
		}
	}
}

func TestParseSMBIOSTruncated(t *testing.T) {
	full := smbTable(smbType0, smbType1(smbWireUUID, 1, 2, true, smbSerial, smbFamily), smbEnd)
	for n := 0; n < len(full); n++ {
		// Must never panic; every strict prefix is an error because the
		// header declares more data than is present.
		if _, _, _, err := ParseSMBIOSType1(full[:n]); err == nil {
			t.Errorf("prefix of %d bytes: want error", n)
		}
	}

	// A consistent header over a table cut inside a structure.
	cut := full[:len(full)-12]
	cutHdr := append([]byte(nil), cut...)
	binary.LittleEndian.PutUint32(cutHdr[4:], uint32(len(cut)-8))
	if _, _, _, err := ParseSMBIOSType1(cutHdr); err == nil {
		t.Error("cut inside a structure: want error")
	}
}

func TestParseSMBIOSMalformed(t *testing.T) {
	// Structure length smaller than its own header.
	bad := smbTable([]byte{1, 2, 0, 0, 0, 0})
	if _, _, _, err := ParseSMBIOSType1(bad); err == nil {
		t.Error("length < 4: want error")
	}
	// Serial index beyond the string set.
	raw := smbTable(smbType1(smbWireUUID, 9, 0, true, smbSerial), smbEnd)
	if _, _, _, err := ParseSMBIOSType1(raw); err == nil {
		t.Error("string index out of range: want error")
	}
	// Type 1 too short to hold a UUID.
	short := smbTable(smbStruct(1, 1, []byte{1, 2, 3, 4}, "a"), smbEnd)
	if _, _, _, err := ParseSMBIOSType1(short); err == nil {
		t.Error("short type 1: want error")
	}
}

func TestParseSMBIOSErrorOmitsSerial(t *testing.T) {
	raw := smbTable(smbType1(smbWireUUID, 9, 0, true, smbSerial), smbEnd)
	_, _, _, err := ParseSMBIOSType1(raw)
	if err == nil || strings.Contains(err.Error(), smbSerial) {
		t.Errorf("err = %v", err)
	}
}

func TestBootIDStableForSameCount(t *testing.T) {
	const machine = "0190a1b2-c3d4-7e5f-8a9b-0c1d2e3f4a5b"
	a := BootIDFor(machine, 7)
	if a != BootIDFor(machine, 7) {
		t.Error("same input gave different boot ids")
	}
	if a == BootIDFor(machine, 8) {
		t.Error("different boot count gave the same boot id")
	}
	if a == BootIDFor("0190a1b2-c3d4-7e5f-8a9b-0c1d2e3f4a5c", 7) {
		t.Error("different machine gave the same boot id")
	}
	id, err := uuid.Parse(a)
	if err != nil {
		t.Fatal(err)
	}
	if id.Version() != 5 {
		t.Errorf("version = %d, want 5", id.Version())
	}
	want := uuid.NewSHA1(uuid.MustParse(machine), []byte("7")).String()
	if a != want {
		t.Errorf("boot id = %s, want %s", a, want)
	}
}

func TestBootIDInvalidMachineUUID(t *testing.T) {
	// An unset or malformed UUID still gives a stable, valid boot id.
	for _, m := range []string{"", "not-a-uuid"} {
		a := BootIDFor(m, 3)
		if _, err := uuid.Parse(a); err != nil {
			t.Errorf("%q: %v", m, err)
		}
		if a != BootIDFor(m, 3) || a == BootIDFor(m, 4) {
			t.Errorf("%q: unstable or count-independent boot id", m)
		}
	}
}
