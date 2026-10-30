package ident

import (
	"bytes"
	"encoding/binary"
	"errors"
	"fmt"
	"strconv"
	"time"

	"github.com/google/uuid"
)

const (
	// rawSMBIOSHeaderLen is the size of the RawSMBIOSData header that
	// GetSystemFirmwareTable('RSMB') puts before the table: Used20CallingMethod,
	// MajorVersion, MinorVersion, DmiRevision (one byte each) and Length (u32).
	rawSMBIOSHeaderLen = 8

	smbiosTypeSystem = 1
	smbiosTypeEnd    = 127

	// Offsets inside the type 1 (System Information) structure.
	smbiosSerialOff = 7
	smbiosUUIDOff   = 8
	smbiosFamilyOff = 26
	smbiosUUIDEnd   = smbiosUUIDOff + 16
)

// ParseSMBIOSType1 extracts the product UUID, serial number and family from
// the System Information structure (type 1) of raw, the RawSMBIOSData returned
// by GetSystemFirmwareTable('RSMB', 0). The UUID is formatted in lower-case
// canonical form, empty if the firmware reports it as not set. Serial and
// family are empty if the structure has no such string. The values are never
// included in an error message.
func ParseSMBIOSType1(raw []byte) (id, serial, family string, err error) {
	if len(raw) < rawSMBIOSHeaderLen {
		return "", "", "", errors.New("ident: smbios: table header is truncated")
	}
	major, minor := raw[1], raw[2]
	size := binary.LittleEndian.Uint32(raw[4:8])
	if uint64(size) > uint64(len(raw)-rawSMBIOSHeaderLen) {
		return "", "", "", errors.New("ident: smbios: table is truncated")
	}
	table := raw[rawSMBIOSHeaderLen : rawSMBIOSHeaderLen+int(size)]

	for off := 0; off+4 <= len(table); {
		typ, length := table[off], int(table[off+1])
		if typ == smbiosTypeEnd {
			break
		}
		if length < 4 || off+length > len(table) {
			return "", "", "", fmt.Errorf("ident: smbios: bad structure at offset %d", off)
		}
		formatted := table[off : off+length]
		strs, next, err := smbiosStrings(table, off+length)
		if err != nil {
			return "", "", "", err
		}
		if typ == smbiosTypeSystem {
			return parseSystemInfo(formatted, strs, major, minor)
		}
		off = next
	}
	return "", "", "", errors.New("ident: smbios: no system information structure")
}

// smbiosStrings reads the string set that starts at table[start] and returns
// the strings and the offset of the next structure. The set ends with a double
// NUL; an empty set is just the two NULs.
func smbiosStrings(table []byte, start int) (strs []string, next int, err error) {
	rest := table[start:]
	if len(rest) >= 2 && rest[0] == 0 && rest[1] == 0 {
		return nil, start + 2, nil
	}
	end := bytes.Index(rest, []byte{0, 0})
	if end < 0 {
		return nil, 0, errors.New("ident: smbios: unterminated string set")
	}
	for _, s := range bytes.Split(rest[:end], []byte{0}) {
		strs = append(strs, string(s))
	}
	return strs, start + end + 2, nil
}

func parseSystemInfo(b []byte, strs []string, major, minor byte) (id, serial, family string, err error) {
	if len(b) < smbiosUUIDEnd {
		return "", "", "", errors.New("ident: smbios: system information structure is too short")
	}
	str := func(off int) (string, error) {
		if off >= len(b) || b[off] == 0 {
			return "", nil
		}
		i := int(b[off])
		if i > len(strs) {
			return "", fmt.Errorf("ident: smbios: string index %d at offset %d is out of range", i, off)
		}
		return strs[i-1], nil
	}
	if serial, err = str(smbiosSerialOff); err != nil {
		return "", "", "", err
	}
	if family, err = str(smbiosFamilyOff); err != nil {
		return "", "", "", err
	}
	return formatSMBIOSUUID(b[smbiosUUIDOff:smbiosUUIDEnd], major, minor), serial, family, nil
}

// formatSMBIOSUUID formats the 16 UUID bytes. From SMBIOS 2.6 the first three
// fields are little-endian (the byte order Linux uses for product_uuid);
// older tables store them as written. All zero and all 0xFF mean the UUID is
// not set.
func formatSMBIOSUUID(b []byte, major, minor byte) string {
	if allBytes(b, 0x00) || allBytes(b, 0xff) {
		return ""
	}
	var u uuid.UUID
	copy(u[:], b)
	if major > 2 || (major == 2 && minor >= 6) {
		u[0], u[1], u[2], u[3] = b[3], b[2], b[1], b[0]
		u[4], u[5] = b[5], b[4]
		u[6], u[7] = b[7], b[6]
	}
	return u.String()
}

func allBytes(b []byte, v byte) bool {
	for _, c := range b {
		if c != v {
			return false
		}
	}
	return true
}

// BootIDFor derives the boot id from the machine UUID and the boot counter:
// a UUIDv5 of the decimal counter in the namespace of the machine UUID. A
// machine UUID that is not set or does not parse falls back to the nil
// namespace, so the boot id stays valid and stable per counter value.
func BootIDFor(machineUUID string, bootCount uint32) string {
	ns, err := uuid.Parse(machineUUID)
	if err != nil {
		ns = uuid.Nil
	}
	return uuid.NewSHA1(ns, []byte(strconv.FormatUint(uint64(bootCount), 10))).String()
}

// BootIDFromBootTime derives the boot id from the machine UUID and the
// kernel boot time, the fallback when the boot counter cannot be read (S9
// spec 12.4): a UUIDv5 of "boottime:<unix seconds>" in the namespace of the
// machine UUID. The time is rounded to whole seconds, so the sub-second
// jitter of the kernel value keeps the id; a step of the system clock moves
// the kernel boot time and changes it.
func BootIDFromBootTime(machineUUID string, boot time.Time) string {
	ns, err := uuid.Parse(machineUUID)
	if err != nil {
		ns = uuid.Nil
	}
	secs := boot.Round(time.Second).Unix()
	return uuid.NewSHA1(ns, []byte("boottime:"+strconv.FormatInt(secs, 10))).String()
}
