//go:build !windows

package ident

import (
	"context"
	"fmt"
	"os"
	"path/filepath"

	"github.com/belov38/umiak/services/guest-agent/internal/fsutil"
	"github.com/belov38/umiak/services/guest-agent/internal/paths"
)

// Seal prepares the image for use as a template (spec section 7.3). It stops
// the agent, then removes the whole state directory including identity.json,
// the SSH host keys and the managed files, empties /etc/machine-id and restores
// the template state of /etc/umiak/env and the SSH CA keys. The agent version
// directory stays. If stopAgent fails nothing is removed. A nil stopAgent is
// allowed.
func Seal(ctx context.Context, l paths.Layout, stopAgent func() error) error {
	if err := ctx.Err(); err != nil {
		return err
	}
	if stopAgent != nil {
		if err := stopAgent(); err != nil {
			return fmt.Errorf("ident: stop agent: %w", err)
		}
	}
	for _, p := range managedFiles(l) {
		if err := os.RemoveAll(p); err != nil {
			return fmt.Errorf("ident: remove managed file %s: %w", p, err)
		}
	}
	if err := os.RemoveAll(l.StateDir); err != nil {
		return fmt.Errorf("ident: remove state dir: %w", err)
	}
	if err := removeHostKeys(l.SSHDir); err != nil {
		return err
	}
	if err := os.MkdirAll(filepath.Dir(l.MachineIDFile), 0o755); err != nil {
		return err
	}
	if err := fsutil.WriteFileAtomic(l.MachineIDFile, nil, 0o644); err != nil {
		return fmt.Errorf("ident: empty machine-id: %w", err)
	}
	if err := linkDbusMachineID(l); err != nil {
		return err
	}
	return resetManagedFiles(l)
}
