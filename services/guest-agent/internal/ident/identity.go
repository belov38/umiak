package ident

import (
	"encoding/hex"
	"errors"
	"fmt"
	"net/url"
	"os"
	"path/filepath"
	"strings"

	"github.com/belov38/umiak/libs/tunnel/wire"
	"github.com/belov38/umiak/services/guest-agent/internal/fsutil"
)

const (
	// familyPrefix marks a tunnel URL override in product_family (S5 section 14).
	familyPrefix = "umiakt1:"
	// maxTunnelURL is the longest accepted tunnel URL in bytes.
	maxTunnelURL = 200
	// hostnameSuffixLen is the number of trailing machine id hex digits in the
	// default hostname. The leading bits of a UUIDv7 are a timestamp, so
	// neighbouring machines share them.
	hostnameSuffixLen = 12
)

// Identity is the parsed machine identity.
type Identity struct {
	// MachineID is the machine UUID from the smbios serial.
	MachineID string
	// BS is the boot secret. It is kept in memory only and never logged.
	BS []byte
	// BootID is the kernel boot id.
	BootID string
	// TunnelURL is the tunnel URL override from product_family, or "".
	TunnelURL string
	// TunnelCAPin is SHA-256 DER CA trust supplied by boot firmware, never disk state.
	TunnelCAPin string
	// Warnings are non-fatal problems found while parsing, for the log.
	Warnings []string
}

// Parse validates raw and builds an Identity. The returned error never
// contains the serial or the boot secret.
func Parse(raw Raw) (Identity, error) {
	machineID, bs, err := wire.ParseSMBIOSSerial(strings.TrimSpace(raw.Serial))
	if err != nil {
		return Identity{}, fmt.Errorf("ident: %w", err)
	}
	hexID, ok := machineIDHex(machineID)
	if !ok {
		return Identity{}, errors.New("ident: machine id in the smbios serial is not a UUID")
	}
	id := Identity{MachineID: machineID, BS: bs, BootID: strings.TrimSpace(raw.BootID)}
	if u := strings.TrimSpace(raw.UUID); u != "" {
		if uh, ok := machineIDHex(u); !ok || uh != hexID {
			id.Warnings = append(id.Warnings, "product_uuid does not match the machine id from product_serial; using the serial")
		}
	}
	if fam := strings.TrimSpace(raw.Family); fam != "" {
		if u, ok := parseFamily(fam); ok {
			id.TunnelURL = u
		} else {
			id.Warnings = append(id.Warnings, "ignoring invalid tunnel url in product_family")
		}
	}
	if raw.SKU != "" {
		pin, ok := strings.CutPrefix(raw.SKU, "umiakca1:")
		b, err := hex.DecodeString(pin)
		if !ok || err != nil || len(b) != 32 || strings.ToLower(pin) != pin {
			return Identity{}, errors.New("ident: invalid firmware CA pin")
		}
		id.TunnelCAPin = pin
	}
	return id, nil
}

// parseFamily extracts the tunnel URL from a product_family value.
func parseFamily(fam string) (string, bool) {
	raw, ok := strings.CutPrefix(fam, familyPrefix)
	if !ok || raw == "" || len(raw) > maxTunnelURL {
		return "", false
	}
	u, err := url.Parse(raw)
	if err != nil || u.Scheme != "wss" || u.Hostname() == "" {
		return "", false
	}
	return raw, true
}

// machineIDHex returns the lower-case 32-digit hex form of a machine id that
// is written as a UUID with or without dashes.
func machineIDHex(s string) (string, bool) {
	h := strings.ToLower(strings.ReplaceAll(s, "-", ""))
	if len(h) != 32 {
		return "", false
	}
	if _, err := hex.DecodeString(h); err != nil {
		return "", false
	}
	return h, true
}

// DefaultHostname returns umiak-<last 12 hex digits of the machine id>. It is
// the hostname of a machine before claim.
func DefaultHostname(machineID string) string {
	h := strings.ToLower(strings.ReplaceAll(machineID, "-", ""))
	if len(h) > hostnameSuffixLen {
		h = h[len(h)-hostnameSuffixLen:]
	}
	return "umiak-" + h
}

// ValidHostname reports whether s is a single RFC 1123 label of at most 63
// characters.
func ValidHostname(s string) bool {
	if s == "" || len(s) > 63 {
		return false
	}
	for i := 0; i < len(s); i++ {
		c := s[i]
		switch {
		case c >= 'a' && c <= 'z', c >= 'A' && c <= 'Z', c >= '0' && c <= '9':
		case c == '-' && i != 0 && i != len(s)-1:
		default:
			return false
		}
	}
	return true
}

// File is the content of identity.json.
type File struct {
	// MachineID is the identity the agent state belongs to.
	MachineID string `json:"machineId"`
	// WrittenMachineID is the value of /etc/machine-id after the last apply.
	// A clone that still holds it has inherited the machine-id.
	WrittenMachineID string `json:"writtenMachineId"`
	// HostKeyFingerprints are the SHA256 fingerprints of the SSH host keys.
	HostKeyFingerprints []string `json:"hostKeyFingerprints"`
	// ResetPending asks the agent to emit identity.reset as the first event of
	// the new journal and clear the flag.
	ResetPending bool `json:"resetPending"`
	// RenameReboots counts the reboots asked for in a row because the
	// computer name was not in effect while the identity was unchanged
	// (Windows); at MaxRenameReboots the agent stops rebooting.
	RenameReboots int `json:"renameReboots,omitempty"`
	// RebootBoot is the boot id of the boot that asked for the last rename
	// reboot (Windows). While the boot id is unchanged that reboot is still
	// due: the agent asks again and does not become ready.
	RebootBoot string `json:"rebootBoot,omitempty"`
}

// LoadFile reads identity.json. A missing file returns an error for which
// errors.Is(err, fs.ErrNotExist) is true.
func LoadFile(path string) (*File, error) {
	var f File
	if err := fsutil.ReadJSON(path, &f); err != nil {
		return nil, err
	}
	return &f, nil
}

// Save writes identity.json atomically, creating its directory (root 0700,
// spec 4) if needed.
func (f *File) Save(path string) error {
	if err := os.MkdirAll(filepath.Dir(path), 0o700); err != nil {
		return err
	}
	return fsutil.WriteJSONAtomic(path, f, 0o644)
}
