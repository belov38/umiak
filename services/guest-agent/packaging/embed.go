// Package packaging embeds the files that install-package lays out on a
// machine: the systemd units, the agent.toml template and the pinned update
// keys used to verify the first installed package (spec S3 sections 17.1-17.3).
package packaging

import (
	"embed"
	"io/fs"
)

//go:embed systemd/*.service systemd/*.slice
var units embed.FS

// Units holds the systemd unit files at its root (umiak-agent.service,
// umiak-identity.service, umiak-agent-rollback.service, umiak-cmd.slice).
var Units fs.FS = mustSub(units, "systemd")

// AgentTOML is the /etc/umiak-agent/agent.toml template with the defaults.
//
//go:embed agent.toml
var AgentTOML []byte

// UpdateKeys is trust/update-keys.pub: the pinned public keys that verify a
// package when no version is installed yet. The template builder (S5) reads
// the same file from the repository.
//
//go:embed trust/update-keys.pub
var UpdateKeys []byte

func mustSub(f fs.FS, dir string) fs.FS {
	sub, err := fs.Sub(f, dir)
	if err != nil {
		panic(err)
	}
	return sub
}
