package config

import (
	"os"
	"path/filepath"
	"testing"
)

func TestLoadMergesFileOverDefaults(t *testing.T) {
	path := filepath.Join(t.TempDir(), "sbx-node.toml")
	if err := os.WriteFile(path, []byte("vmidMin = 500\nvmidMax = 589\ntemplateVmidMin = 597\ntemplateVmidMax = 599\ntemplateVmid = 599\nleaseFile = \"/tmp/x.leases\"\n"), 0o600); err != nil {
		t.Fatal(err)
	}
	c, err := Load(path)
	if err != nil {
		t.Fatalf("Load: %v", err)
	}
	if c.VG != "pve" || c.ThinPool != "data" || c.VNet != "sbx0" || c.SDNZone != "sbx" || c.ClusterID != 1 || c.Node != "pve" {
		t.Errorf("defaults not kept: %+v", c)
	}
	if c.LeaseFile != "/tmp/x.leases" {
		t.Errorf("LeaseFile = %q", c.LeaseFile)
	}
}

func TestLoadRejectsUnknownKeysAndBadRange(t *testing.T) {
	dir := t.TempDir()
	cases := map[string]string{
		"unknown":      "vgg = \"pve\"\n",
		"inverted":     "vmidMin = 600\nvmidMax = 500\n",
		"low":          "vmidMin = 99\n",
		"tplOutside":   "templateVmid = 9000\n",
		"tplInSandbox": "templateVmid = 520\n",
		"overlap":      "vmidMax = 597\n",
		"tplInverted":  "templateVmidMin = 599\ntemplateVmidMax = 597\n",
		"clusterRange": "clusterId = 256\n",
	}
	for name, body := range cases {
		path := filepath.Join(dir, name+".toml")
		if err := os.WriteFile(path, []byte(body), 0o600); err != nil {
			t.Fatal(err)
		}
		if _, err := Load(path); err == nil {
			t.Errorf("%s: Load succeeded, want error", name)
		}
	}
}

func TestLoadWithoutTemplateVmid(t *testing.T) {
	path := filepath.Join(t.TempDir(), "sbx-node.toml")
	if err := os.WriteFile(path, []byte("vmidMin = 500\nvmidMax = 589\n"), 0o600); err != nil {
		t.Fatal(err)
	}
	c, err := Load(path)
	if err != nil {
		t.Fatalf("Load: %v", err)
	}
	if c.TemplateVMID != 0 || !c.InRange(589) || !c.InRange(500) || c.InRange(590) {
		t.Errorf("TemplateVMID = %d, InRange(589) = %v, InRange(590) = %v", c.TemplateVMID, c.InRange(589), c.InRange(590))
	}
	if !c.IsTemplateSlot(597) || !c.IsTemplateSlot(599) || c.IsTemplateSlot(596) || c.IsTemplateSlot(589) {
		t.Errorf("template slots: %d-%d", c.TemplateMin, c.TemplateMax)
	}
	if c.IsoDir != "/var/lib/vz/template/iso" || c.ImportDir != "/var/lib/vz/import" {
		t.Errorf("media dirs = %q, %q", c.IsoDir, c.ImportDir)
	}
}

func TestDefaultLayout(t *testing.T) {
	c := Default()
	if err := c.Validate(); err != nil {
		t.Fatal(err)
	}
	if !c.InRange(500) || !c.InRange(589) {
		t.Error("500 and 589 must be sandbox VMIDs")
	}
	// 590-596 dev infrastructure, 597-599 templates.
	for _, id := range []int{590, 593, 596, 597, 599, 499, 600, 108} {
		if c.InRange(id) {
			t.Errorf("%d must not be a sandbox VMID", id)
		}
	}
	for _, id := range []int{590, 596, 589, 600} {
		if c.IsTemplateSlot(id) {
			t.Errorf("%d must not be a template slot", id)
		}
	}
}
