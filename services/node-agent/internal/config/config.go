// Package config loads /etc/umiak-node.toml.
package config

import (
	"bytes"
	"errors"
	"fmt"
	"os"

	"github.com/pelletier/go-toml/v2"
)

// DefaultPath is where the runbook installs the config.
const DefaultPath = "/etc/umiak-node.toml"

// Config describes the node resources umiak-node may touch.
type Config struct {
	// Offline layer origin/trust are operator-owned settings, never request URLs or keys.
	LayerBaseURL    string `toml:"layerBaseURL" json:"layerBaseURL"`
	LayerKeysFile   string `toml:"layerKeysFile" json:"layerKeysFile"`
	LayerCacheBytes int64  `toml:"layerCacheBytes" json:"layerCacheBytes"`
	GuestSubnet     string `toml:"guestSubnet" json:"guestSubnet"`
	Node            string `toml:"node" json:"node"`
	VG              string `toml:"vg" json:"vg"`
	ThinPool        string `toml:"thinPool" json:"thinPool"`
	Storage         string `toml:"storage" json:"storage"`
	// VMIDMin..VMIDMax: sandbox machines (pve: 500-589).
	VMIDMin int `toml:"vmidMin" json:"vmidMin"`
	VMIDMax int `toml:"vmidMax" json:"vmidMax"`
	// TemplateMin..TemplateMax: template slots (pve: 597-599). Their base-<id>-* disks, tagged
	// umiak-tpl, are clone origins. 590-596 (dev infrastructure) is in neither range.
	TemplateMin  int    `toml:"templateVmidMin" json:"templateVmidMin"`
	TemplateMax  int    `toml:"templateVmidMax" json:"templateVmidMax"`
	TemplateVMID int    `toml:"templateVmid" json:"templateVmid"` // legacy template, 0 = none
	SDNZone      string `toml:"sdnZone" json:"sdnZone"`
	VNet         string `toml:"vnet" json:"vnet"`
	ClusterID    int    `toml:"clusterId" json:"clusterId"`
	LeaseFile    string `toml:"leaseFile" json:"leaseFile"`
	EthersFile   string `toml:"ethersFile" json:"ethersFile"`
	MacCacheFile string `toml:"macCacheFile" json:"macCacheFile"`
	IsoDir       string `toml:"isoDir" json:"isoDir"`
	ImportDir    string `toml:"importDir" json:"importDir"`
	StateDir     string `toml:"stateDir" json:"stateDir"` // umiak-node's own cache files (media.sha256)
}

// Default returns the PoC values from the S1 spec.
func Default() Config {
	return Config{
		GuestSubnet:  "10.88.0.0/24",
		Node:         "pve",
		VG:           "pve",
		ThinPool:     "data",
		Storage:      "local-lvm",
		VMIDMin:      500,
		VMIDMax:      589,
		TemplateMin:  597,
		TemplateMax:  599,
		SDNZone:      "umiak",
		VNet:         "umiak0",
		ClusterID:    1,
		LeaseFile:    "/var/lib/misc/dnsmasq.umiak.leases",
		EthersFile:   "/etc/dnsmasq.d/umiak/ethers",
		MacCacheFile: "/etc/pve/sdn/mac-cache.json",
		IsoDir:       "/var/lib/vz/template/iso",
		ImportDir:    "/var/lib/vz/import",
		StateDir:     "/var/lib/umiak-node",
	}
}

// Load reads the file on top of Default and validates the result.
func Load(path string) (Config, error) {
	c := Default()
	data, err := os.ReadFile(path) //nolint:gosec // path comes from the operator flag, not from requests
	if err != nil {
		return c, err
	}
	dec := toml.NewDecoder(bytes.NewReader(data))
	dec.DisallowUnknownFields()
	if err := dec.Decode(&c); err != nil {
		return c, fmt.Errorf("parse %s: %w", path, err)
	}
	return c, c.Validate()
}

// Validate checks that the ranges cannot reach the host's other guests by accident.
func (c Config) Validate() error {
	switch {
	case c.VMIDMin < 100 || c.VMIDMax < c.VMIDMin:
		return errors.New("invalid vmid range")
	case c.TemplateMin < 100 || c.TemplateMax < c.TemplateMin:
		return errors.New("invalid template vmid range")
	case c.TemplateMin <= c.VMIDMax && c.VMIDMin <= c.TemplateMax:
		return errors.New("the template vmid range overlaps the sandbox range")
	case c.TemplateVMID != 0 && !c.IsTemplateSlot(c.TemplateVMID):
		return errors.New("templateVmid must be inside the template vmid range")
	case c.ClusterID < 0 || c.ClusterID > 255:
		return errors.New("clusterId must fit in one byte")
	case c.IsoDir == "" || c.ImportDir == "" || c.StateDir == "":
		return errors.New("isoDir, importDir and stateDir must not be empty")
	case c.VG == "" || c.ThinPool == "" || c.VNet == "" || c.Node == "":
		return errors.New("vg, thinPool, vnet and node are required")
	}
	return nil
}

// InRange reports whether vmid belongs to sandbox machines.
func (c Config) InRange(vmid int) bool {
	return vmid >= c.VMIDMin && vmid <= c.VMIDMax && vmid != c.TemplateVMID
}

// IsTemplateSlot reports whether vmid is one of the template slots.
func (c Config) IsTemplateSlot(vmid int) bool {
	return vmid >= c.TemplateMin && vmid <= c.TemplateMax
}
