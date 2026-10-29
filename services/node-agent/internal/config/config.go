// Package config loads /etc/sbx-node.toml.
package config

import (
	"bytes"
	"errors"
	"fmt"
	"os"

	"github.com/pelletier/go-toml/v2"
)

// DefaultPath is where the runbook installs the config.
const DefaultPath = "/etc/sbx-node.toml"

// Config describes the node resources sbx-node may touch.
type Config struct {
	Node         string `toml:"node" json:"node"`
	VG           string `toml:"vg" json:"vg"`
	ThinPool     string `toml:"thinPool" json:"thinPool"`
	Storage      string `toml:"storage" json:"storage"`
	VMIDMin      int    `toml:"vmidMin" json:"vmidMin"`
	VMIDMax      int    `toml:"vmidMax" json:"vmidMax"`
	TemplateVMID int    `toml:"templateVmid" json:"templateVmid"`
	SDNZone      string `toml:"sdnZone" json:"sdnZone"`
	VNet         string `toml:"vnet" json:"vnet"`
	ClusterID    int    `toml:"clusterId" json:"clusterId"`
	LeaseFile    string `toml:"leaseFile" json:"leaseFile"`
}

// Default returns the PoC values from the S1 spec.
func Default() Config {
	return Config{
		Node:         "pve",
		VG:           "pve",
		ThinPool:     "data",
		Storage:      "local-lvm",
		VMIDMin:      500,
		VMIDMax:      599,
		TemplateVMID: 599,
		SDNZone:      "sbx",
		VNet:         "sbx0",
		ClusterID:    1,
		LeaseFile:    "/var/lib/misc/dnsmasq.sbx.leases",
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
	case c.TemplateVMID < c.VMIDMin || c.TemplateVMID > c.VMIDMax:
		return errors.New("templateVmid must be inside the vmid range")
	case c.ClusterID < 0 || c.ClusterID > 255:
		return errors.New("clusterId must fit in one byte")
	case c.VG == "" || c.ThinPool == "" || c.VNet == "" || c.Node == "":
		return errors.New("vg, thinPool, vnet and node are required")
	}
	return nil
}

// InRange reports whether vmid belongs to sandbox machines (the template is excluded).
func (c Config) InRange(vmid int) bool {
	return vmid >= c.VMIDMin && vmid <= c.VMIDMax && vmid != c.TemplateVMID
}
