package ident

import (
	"context"
	"errors"
	"fmt"

	"golang.org/x/sys/windows/registry"

	"github.com/belov38/boat-dev-clone/services/guest-agent/internal/winapi"
)

const (
	// bootCountKey holds the BootId DWORD, which Windows increments on every
	// boot (a wake from sleep is not a boot).
	bootCountKey   = `SYSTEM\CurrentControlSet\Control\Session Manager\Memory Management\PrefetchParameters`
	bootCountValue = "BootId"
)

// FirmwareSource reads the identity from the SMBIOS table and the boot
// counter. The hypervisor puts the claim values into smbios1 and the guest
// sees them as plain strings.
type FirmwareSource struct {
	// ReadTable returns the RawSMBIOSData of GetSystemFirmwareTable('RSMB').
	ReadTable func() ([]byte, error)
	// BootCount returns the boot counter.
	BootCount func() (uint32, error)
}

// Read is not supported: Windows has no sysfs. Use FirmwareSource.
func (SysfsSource) Read(context.Context) (Raw, error) {
	return Raw{}, errors.ErrUnsupported
}

// NewFirmwareSource returns a FirmwareSource wired to the real Windows calls.
func NewFirmwareSource() FirmwareSource {
	return FirmwareSource{
		ReadTable: func() ([]byte, error) { return winapi.GetSystemFirmwareTable(winapi.FirmwareTableRSMB, 0) },
		BootCount: readBootCount,
	}
}

// Read implements Source. vmgenid is not read. A missing SMBIOS table is an
// error; a boot counter that cannot be read leaves BootID empty.
func (s FirmwareSource) Read(ctx context.Context) (Raw, error) {
	if err := ctx.Err(); err != nil {
		return Raw{}, err
	}
	table, err := s.ReadTable()
	if err != nil {
		return Raw{}, fmt.Errorf("ident: read smbios: %w", err)
	}
	id, serial, family, err := ParseSMBIOSType1(table)
	if err != nil {
		return Raw{}, err
	}
	raw := Raw{Serial: serial, UUID: id, Family: family}
	if count, err := s.BootCount(); err == nil {
		raw.BootID = BootIDFor(id, count)
	}
	return raw, nil
}

func readBootCount() (uint32, error) {
	k, err := registry.OpenKey(registry.LOCAL_MACHINE, bootCountKey, registry.QUERY_VALUE)
	if err != nil {
		return 0, fmt.Errorf("ident: open %s: %w", bootCountKey, err)
	}
	defer func() { _ = k.Close() }()
	v, _, err := k.GetIntegerValue(bootCountValue)
	if err != nil {
		return 0, fmt.Errorf("ident: read %s: %w", bootCountValue, err)
	}
	if v > 0xffffffff {
		return 0, errors.New("ident: boot counter out of range")
	}
	return uint32(v), nil
}
