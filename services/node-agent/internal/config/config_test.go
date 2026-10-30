package config

import (
	"os"
	"path/filepath"
	"testing"
)

func TestLoadMergesFileOverDefaults(t *testing.T) {
	path := filepath.Join(t.TempDir(), "sbx-node.toml")
	if err := os.WriteFile(path, []byte("vmidMin = 500\nvmidMax = 599\ntemplateVmid = 599\nleaseFile = \"/tmp/x.leases\"\n"), 0o600); err != nil {
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
	if err := os.WriteFile(path, []byte("vmidMin = 500\nvmidMax = 599\n"), 0o600); err != nil {
		t.Fatal(err)
	}
	c, err := Load(path)
	if err != nil {
		t.Fatalf("Load: %v", err)
	}
	if c.TemplateVMID != 0 || !c.InRange(599) || !c.InRange(500) {
		t.Errorf("TemplateVMID = %d, InRange(599) = %v", c.TemplateVMID, c.InRange(599))
	}
	if c.IsoDir != "/var/lib/vz/template/iso" || c.ImportDir != "/var/lib/vz/import" {
		t.Errorf("media dirs = %q, %q", c.IsoDir, c.ImportDir)
	}
}

func TestInRangeExcludesTemplate(t *testing.T) {
	c := Default()
	c.TemplateVMID = 599
	if !c.InRange(500) || !c.InRange(598) {
		t.Error("500 and 598 must be in range")
	}
	if c.InRange(599) || c.InRange(499) || c.InRange(600) || c.InRange(108) {
		t.Error("599 (template), 499, 600, 108 must be out of range")
	}
}
