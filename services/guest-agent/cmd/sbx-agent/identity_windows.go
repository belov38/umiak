package main

import (
	"github.com/belov38/boat-dev-clone/services/guest-agent/internal/claim"
	"github.com/belov38/boat-dev-clone/services/guest-agent/internal/ident"
)

// platformDeps wires the Windows identity: SMBIOS source, WindowsResetter
// with the overwriting secrets wipe, and seal stopping sbx-agent and sshd.
func platformDeps(d *deps) {
	l := d.layout
	d.source = ident.NewFirmwareSource()
	d.winResetter = ident.WindowsResetter{Layout: l, Wipe: func() error { return claim.WipeSecretsDir(l) }}
	d.stopAgent = ident.StopServices
}
