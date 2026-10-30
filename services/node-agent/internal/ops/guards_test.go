package ops

import (
	"testing"

	"github.com/belov38/boat-dev-clone/services/node-agent/internal/config"
)

func testConfig() config.Config {
	c := config.Default()
	c.VMIDMin, c.VMIDMax, c.TemplateMin, c.TemplateMax, c.TemplateVMID, c.ClusterID = 500, 589, 597, 599, 599, 1
	return c
}

func TestValidOrigin(t *testing.T) {
	cfg := testConfig()
	for _, name := range []string{"base-599-disk-0", "sbx-snap-abc-scsi0", "vm-500-disk-0", "vm-589-disk-1"} {
		if err := ValidOrigin(cfg, name); err != nil {
			t.Errorf("ValidOrigin(%q) = %v, want nil", name, err)
		}
	}
	for _, name := range []string{"base-9000-disk-0", "vm-108-disk-1", "vm-599-disk-0", "vm-590-disk-0", "vm-598-disk-1", "vm-600-disk-0", "root", "data", "../x", "vm-500-disk-0;rm", "", "sbx-snap-", "base-599-disk-0 ", "base-0598-disk-0", "vm-0500-disk-0"} {
		if err := ValidOrigin(cfg, name); err == nil {
			t.Errorf("ValidOrigin(%q) = nil, want error", name)
		}
	}
}

func TestValidOriginOnlyTemplateSlots(t *testing.T) {
	cfg := testConfig()
	cfg.TemplateVMID = 0
	for _, name := range []string{"base-597-disk-0", "base-598-disk-0", "base-599-disk-0"} {
		if err := ValidOrigin(cfg, name); err != nil {
			t.Errorf("ValidOrigin(%q) = %v, want nil", name, err)
		}
	}
	// Sandbox VMIDs and dev infrastructure (590-596) are never template origins.
	for _, name := range []string{"base-500-disk-0", "base-589-disk-0", "base-590-disk-0", "base-596-disk-0", "base-9000-disk-0", "base-499-disk-0", "base-600-disk-0", "base-9001-disk-0", "base-598"} {
		if err := ValidOrigin(cfg, name); err == nil {
			t.Errorf("ValidOrigin(%q) = nil, want error", name)
		}
	}
}

func TestValidTargetName(t *testing.T) {
	cfg := testConfig()
	for _, name := range []string{"vm-500-disk-0", "vm-589-disk-2", "sbx-snap-k3j9x2m4qa-scsi0"} {
		if err := ValidTargetName(cfg, name); err != nil {
			t.Errorf("ValidTargetName(%q) = %v, want nil", name, err)
		}
	}
	for _, name := range []string{"base-599-disk-0", "vm-599-disk-0", "vm-590-disk-0", "vm-598-disk-0", "vm-108-disk-0", "vm-500-cloudinit", "vm-500-disk-x", "Vm-500-disk-0", "sbx-snap-UPPER-scsi0", "sbx-tpl", "data", "vm-0598-disk-0", "vm-00500-disk-0"} {
		if err := ValidTargetName(cfg, name); err == nil {
			t.Errorf("ValidTargetName(%q) = nil, want error", name)
		}
	}
}

func TestValidTags(t *testing.T) {
	cfg := testConfig()
	ok := [][]string{
		{"sbx", "sbx-vm-500"},
		{"sbx", "sbx-snap-k3j9x2m4qa", "sbx-src-500"},
	}
	for _, tags := range ok {
		if err := ValidTags(cfg, tags); err != nil {
			t.Errorf("ValidTags(%v) = %v, want nil", tags, err)
		}
	}
	bad := [][]string{
		{},
		{"sbx-vm-500"},
		{"sbx", "sbx-tpl"},
		{"sbx", "anything"},
		{"sbx", "sbx-vm-108"},
		{"sbx", "sbx-vm-599"},
		{"sbx", "sbx-src-9000"},
		{"sbx", "sbx-vm-0500"},
	}
	for _, tags := range bad {
		if err := ValidTags(cfg, tags); err == nil {
			t.Errorf("ValidTags(%v) = nil, want error", tags)
		}
	}
}

func TestValidSnapshotItemRequiresMatchingOwnerTag(t *testing.T) {
	cfg := testConfig()
	good := []SnapshotItem{
		{Origin: "base-599-disk-0", Name: "vm-500-disk-0", Tags: []string{"sbx", "sbx-vm-500"}},
		{Origin: "vm-500-disk-0", Name: "sbx-snap-abc12-scsi0", Tags: []string{"sbx", "sbx-snap-abc12", "sbx-src-500"}, ActivationSkip: true},
	}
	for _, it := range good {
		if err := ValidSnapshotItem(cfg, it); err != nil {
			t.Errorf("ValidSnapshotItem(%+v) = %v, want nil", it, err)
		}
	}
	bad := []SnapshotItem{
		{Origin: "base-599-disk-0", Name: "vm-500-disk-0", Tags: []string{"sbx", "sbx-vm-501"}},
		{Origin: "base-599-disk-0", Name: "vm-500-disk-0", Tags: []string{"sbx"}},
		{Origin: "vm-500-disk-0", Name: "sbx-snap-abc12-scsi0", Tags: []string{"sbx", "sbx-snap-other"}},
		{Origin: "base-9000-disk-0", Name: "vm-500-disk-0", Tags: []string{"sbx", "sbx-vm-500"}},
	}
	for _, it := range bad {
		if err := ValidSnapshotItem(cfg, it); err == nil {
			t.Errorf("ValidSnapshotItem(%+v) = nil, want error", it)
		}
	}
}

func TestValidMAC(t *testing.T) {
	cfg := testConfig()
	for _, mac := range []string{"02:01:00:00:01:F4", "02:01:00:00:01:f4", "02:01:00:00:02:4d"} {
		if _, err := ValidMAC(cfg, mac); err != nil {
			t.Errorf("ValidMAC(%q) = %v, want nil", mac, err)
		}
	}
	for _, mac := range []string{"02:02:00:00:01:F4", "02:01:00:00:00:6C", "BC:24:11:F4:55:64", "02:01:00:00:02:57", "02:01:00:00:02:56", "02:01:00:00:02:4e", "02:01:00:00:01", "zz:01:00:00:01:F4"} {
		if _, err := ValidMAC(cfg, mac); err == nil {
			t.Errorf("ValidMAC(%q) = nil, want error", mac)
		}
	}
}
