package ident

import (
	"context"
	"fmt"
	"os"

	"github.com/belov38/boat-dev-clone/services/guest-agent/internal/paths"
)

// SealWindows prepares a Windows image for use as a template (S9 spec
// 12.11). It stops the services with stop, then removes the agent state
// (identity.json included) and run directories, wipes the secrets
// directory with wipeSecrets, removes the SSH host keys and restores the
// template SSH CA keys. The version directory stays. If stop fails nothing
// is removed. A nil stop is allowed; a nil wipeSecrets removes the secrets
// directory without overwriting it. MachineGuid, the computer name and the
// password are changed by identity apply on the clone.
func SealWindows(ctx context.Context, l paths.Layout, stop, wipeSecrets func() error) error {
	if err := ctx.Err(); err != nil {
		return err
	}
	if stop != nil {
		if err := stop(); err != nil {
			return fmt.Errorf("ident: stop services: %w", err)
		}
	}
	for _, p := range managedFiles(l) {
		if err := os.RemoveAll(p); err != nil {
			return fmt.Errorf("ident: remove managed file %s: %w", p, err)
		}
	}
	for _, p := range []string{l.StateDir, l.RunDir} {
		if err := os.RemoveAll(p); err != nil {
			return fmt.Errorf("ident: remove %s: %w", p, err)
		}
	}
	if wipeSecrets != nil {
		if err := wipeSecrets(); err != nil {
			return fmt.Errorf("ident: wipe secrets: %w", err)
		}
	}
	for _, p := range []string{l.SecretsDir, l.SecretsStateFile} {
		if err := os.RemoveAll(p); err != nil {
			return fmt.Errorf("ident: remove %s: %w", p, err)
		}
	}
	if err := removeHostKeys(l.SSHDir); err != nil {
		return err
	}
	return restoreSSHUserCA(l)
}
