package ident

import (
	"context"
	"errors"
	"fmt"
	"io/fs"
	"log/slog"
	"os"
	"path/filepath"
	"strings"

	"github.com/belov38/boat-dev-clone/services/guest-agent/internal/fsutil"
	"github.com/belov38/boat-dev-clone/services/guest-agent/internal/paths"
)

// EarlyMarker is the content of early.json: the boot whose early step has
// finished (S9 spec 12.3).
type EarlyMarker struct {
	BootID string `json:"bootId"`
}

// LoadEarly reads early.json. A missing file returns an error for which
// errors.Is(err, fs.ErrNotExist) is true.
func LoadEarly(path string) (*EarlyMarker, error) {
	var m EarlyMarker
	if err := fsutil.ReadJSON(path, &m); err != nil {
		return nil, err
	}
	return &m, nil
}

// EarlyDoneForBoot reports whether early.json at path was written for boot
// bootID. A marker without a boot id (the step could not read one), or one
// not owned by SYSTEM or Administrators (Windows), never counts as the
// current boot.
func EarlyDoneForBoot(path, bootID string) bool {
	m, err := LoadEarly(path)
	if err != nil || m.BootID == "" || m.BootID != bootID {
		return false
	}
	trusted, err := fsutil.TrustedOwner(path)
	if err != nil || !trusted {
		slog.Warn("early.json is not owned by the system, ignoring it", "path", path, "err", err)
		return false
	}
	return true
}

// SecureAgentDirs creates run\ (SYSTEM and Administrators) and state\
// (SYSTEM only) with their protected DACLs (S9 spec 12.1); 0700 elsewhere.
func SecureAgentDirs(l paths.Layout) error {
	if err := fsutil.MkdirSecure(l.RunDir, fsutil.SystemAndAdmins); err != nil {
		return fmt.Errorf("ident: secure run dir: %w", err)
	}
	if err := fsutil.MkdirSecure(l.StateDir, fsutil.SystemOnly); err != nil {
		return fmt.Errorf("ident: secure state dir: %w", err)
	}
	return nil
}

// Early is the boot step of Windows (sbx-agent early, spec 12.3), run by the
// computer startup script before any logon, or by the agent service when
// the script did not run. While Windows Setup runs it does nothing. Under
// the global identity mutex it applies the identity (ModeEarly), wipes the
// secrets directory, clears run\ when the boot id changed and writes
// early.json for the current boot. When the computer name changed it
// reboots instead of writing early.json: identity.json is already saved, so
// the next boot finds nothing to change.
//
// An identity that cannot be read or parsed is logged and skipped, the rest
// still runs: a machine without identity must boot.
func Early(ctx context.Context, l paths.Layout, src Source, r WinResetter) error {
	return EarlyIn(ctx, l, src, r, ModeEarly)
}

// EarlyIn is Early with the apply mode of the caller: ModeEarly for the
// startup script, ModeService for the agent service that runs the step
// itself because the script did not.
func EarlyIn(ctx context.Context, l paths.Layout, src Source, r WinResetter, mode ApplyMode) error {
	if SetupInProgress() {
		slog.Info("windows setup is in progress, early step skipped")
		return nil
	}
	unlock, err := lockIdentity(ctx)
	if err != nil {
		return err
	}
	defer unlock()
	// Before early.json is read or anything is written: run\ and state\
	// must not keep the C:\ProgramData ACL, under which users may create
	// files (a planted marker, a squatted socket).
	if err := SecureAgentDirs(l); err != nil {
		return err
	}

	raw, err := src.Read(ctx)
	if err != nil {
		slog.Warn("early: cannot read the identity source, identity not applied", "err", err)
	}
	bootID := strings.TrimSpace(raw.BootID)
	reboot := false
	if err == nil {
		id, perr := Parse(raw)
		if perr != nil {
			slog.Warn("early: invalid identity, not applied", "err", perr)
		} else {
			for _, w := range id.Warnings {
				slog.Warn("early: " + w)
			}
			changed, need, err := applyWindows(ctx, l, id, r, mode)
			if err != nil {
				// No marker: the service repeats the step. The secrets
				// still go before any logon.
				return errors.Join(err, wrapWipe(r.WipeSecrets()))
			}
			if changed {
				slog.Info("identity applied", "machine_id", id.MachineID, "computer_name", WindowsComputerName(id.MachineID))
			}
			reboot = need
		}
	}

	if err := wrapWipe(r.WipeSecrets()); err != nil {
		return err
	}
	if err := cleanRunDirOnNewBoot(l, bootID); err != nil {
		return err
	}
	if reboot {
		slog.Info("rebooting to apply the computer name")
		if err := r.Reboot("sbx identity changed"); err != nil {
			return fmt.Errorf("ident: reboot: %w", err)
		}
		return nil
	}
	if err := fsutil.WriteJSONAtomic(l.EarlyFile, EarlyMarker{BootID: bootID}, 0o644); err != nil {
		return fmt.Errorf("ident: write early.json: %w", err)
	}
	return nil
}

func wrapWipe(err error) error {
	if err != nil {
		return fmt.Errorf("ident: early wipe secrets: %w", err)
	}
	return nil
}

// cleanRunDirOnNewBoot empties run\ when early.json belongs to another boot
// (or is missing, or the boot id is unknown). The shim socket directory and
// the agent's own sockets stay: the service starts in parallel with the
// startup script and may already listen on them.
func cleanRunDirOnNewBoot(l paths.Layout, bootID string) error {
	if EarlyDoneForBoot(l.EarlyFile, bootID) {
		return nil
	}
	entries, err := os.ReadDir(l.RunDir)
	if errors.Is(err, fs.ErrNotExist) {
		return nil
	}
	if err != nil {
		return fmt.Errorf("ident: list run dir: %w", err)
	}
	keep := map[string]bool{}
	for _, p := range []string{l.ShimSockDir, l.AdminSocket, l.EnvSocket} {
		if p != "" {
			keep[filepath.Clean(p)] = true
		}
	}
	for _, e := range entries {
		p := filepath.Join(l.RunDir, e.Name())
		if keep[p] {
			continue
		}
		if err := os.RemoveAll(p); err != nil {
			return fmt.Errorf("ident: clean run dir: %w", err)
		}
	}
	return nil
}
