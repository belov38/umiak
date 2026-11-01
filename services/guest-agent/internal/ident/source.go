// Package ident reads the machine identity that the hypervisor passes through
// smbios, resets machine-local state when the identity changes (spec section
// 7.2) and prepares an image for use as a template (section 7.3).
package ident

import "context"

// Raw holds the unparsed values of the identity sources.
type Raw struct {
	// Serial is the smbios product serial: umiak1:<machineId>:<base64url(BS)>.
	Serial string
	// UUID is the smbios product UUID. It must equal the machine id.
	UUID string
	// Family is the smbios product family: umiakt1:<tunnel url> or empty.
	Family string
	// BootID is the kernel boot id.
	BootID string
}

// Source reads the raw identity values.
type Source interface {
	Read(ctx context.Context) (Raw, error)
}

// Static is a Source that returns a fixed value. It is meant for tests.
type Static struct {
	Raw
}

// Read returns the fixed value.
func (s Static) Read(context.Context) (Raw, error) { return s.Raw, nil }

// SysfsSource reads the identity from sysfs (Linux only).
type SysfsSource struct {
	// Dir is the DMI directory, normally /sys/class/dmi/id.
	Dir string
	// BootIDPath is the kernel boot id file, normally
	// /proc/sys/kernel/random/boot_id.
	BootIDPath string
}
