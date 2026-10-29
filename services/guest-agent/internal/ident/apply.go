package ident

import (
	"bufio"
	"context"
	"errors"
	"fmt"
	"io/fs"
	"log/slog"
	"os"
	"path/filepath"
	"sort"
	"strings"

	"golang.org/x/crypto/ssh"

	"github.com/belov38/boat-dev-clone/services/guest-agent/internal/fsutil"
	"github.com/belov38/boat-dev-clone/services/guest-agent/internal/paths"
)

const (
	hostsBegin = "# BEGIN sbx"
	hostsEnd   = "# END sbx"
	// uninitializedMachineID is what systemd treats as "no machine-id yet".
	uninitializedMachineID = "uninitialized"
)

// Apply makes the machine state match id (spec section 7.2). If identity.json
// already records the same machine id it does nothing and returns false.
// Otherwise it wipes agent state, resets machine-id, SSH host keys and
// hostname, and writes identity.json with ResetPending set as the last step, so
// an interrupted apply is repeated on the next boot.
//
// With fromAgent set (the agent found a mismatch itself because
// sbx-identity.service did not run) it also restarts sshd and renews network
// leases; failures of those two steps are logged and do not fail the apply.
func Apply(ctx context.Context, l paths.Layout, id Identity, r Resetter, fromAgent bool) (changed bool, err error) {
	if err := ctx.Err(); err != nil {
		return false, err
	}
	hexID, ok := machineIDHex(id.MachineID)
	if !ok {
		return false, errors.New("ident: invalid machine id")
	}

	old, err := LoadFile(l.IdentityFile)
	switch {
	case err == nil:
		if oldHex, _ := machineIDHex(old.MachineID); oldHex == hexID {
			return false, nil
		}
	case errors.Is(err, fs.ErrNotExist):
		old = &File{}
	default:
		slog.Warn("identity.json is unreadable, treating the machine as new", "err", err)
		old = &File{}
	}

	if err := wipeState(l); err != nil {
		return false, err
	}
	if err := resetManagedFiles(l); err != nil {
		return false, err
	}
	written, err := applyMachineID(l, hexID, old.WrittenMachineID)
	if err != nil {
		return false, err
	}
	if err := linkDbusMachineID(l); err != nil {
		return false, err
	}
	if err := r.RegenerateHostKeys(); err != nil {
		return false, fmt.Errorf("ident: regenerate host keys: %w", err)
	}
	fps, err := hostKeyFingerprints(l.SSHDir)
	if err != nil {
		return false, err
	}
	if err := applyHostname(l, r, DefaultHostname(id.MachineID)); err != nil {
		return false, err
	}
	if fromAgent {
		if err := r.RestartSSH(); err != nil {
			slog.Warn("restart ssh after identity reset failed", "err", err)
		}
		if err := r.ReloadNetwork(); err != nil {
			slog.Warn("renew network after identity reset failed", "err", err)
		}
	}

	f := &File{
		MachineID:           id.MachineID,
		WrittenMachineID:    written,
		HostKeyFingerprints: fps,
		ResetPending:        true,
	}
	if err := f.Save(l.IdentityFile); err != nil {
		return false, fmt.Errorf("ident: write identity.json: %w", err)
	}
	return true, nil
}

// wipeState removes the agent state that belongs to the previous identity.
// The directories themselves are left for the agent to recreate.
func wipeState(l paths.Layout) error {
	for _, p := range []string{l.StateDB, l.CommandsDir, l.UploadsDir, l.PendingUpdateFile} {
		if err := os.RemoveAll(p); err != nil {
			return fmt.Errorf("ident: wipe %s: %w", p, err)
		}
	}
	for _, p := range managedFiles(l) {
		if err := os.RemoveAll(p); err != nil {
			return fmt.Errorf("ident: wipe managed file %s: %w", p, err)
		}
	}
	return nil
}

// managedFiles returns the absolute paths listed in the managed-files list,
// one per line; blank lines, comments and relative paths are skipped.
func managedFiles(l paths.Layout) []string {
	f, err := os.Open(l.ManagedFilesList)
	if err != nil {
		return nil
	}
	defer func() { _ = f.Close() }()
	var out []string
	sc := bufio.NewScanner(f)
	for sc.Scan() {
		line := strings.TrimSpace(sc.Text())
		if line == "" || strings.HasPrefix(line, "#") || !filepath.IsAbs(line) {
			continue
		}
		out = append(out, filepath.Clean(line))
	}
	return out
}

// resetManagedFiles restores the files that the claim changes to their
// template state: an empty /etc/sbx/env and the template SSH CA keys.
func resetManagedFiles(l paths.Layout) error {
	if err := os.MkdirAll(filepath.Dir(l.SbxEnvFile), 0o755); err != nil {
		return err
	}
	if err := fsutil.WriteFileAtomic(l.SbxEnvFile, nil, 0o644); err != nil {
		return fmt.Errorf("ident: empty sbx env: %w", err)
	}
	ca, err := os.ReadFile(l.TemplateSSHCA)
	if err != nil && !errors.Is(err, fs.ErrNotExist) {
		return fmt.Errorf("ident: read template ssh ca: %w", err)
	}
	if err := os.MkdirAll(filepath.Dir(l.SSHUserCA), 0o755); err != nil {
		return err
	}
	if err := fsutil.WriteFileAtomic(l.SSHUserCA, ca, 0o644); err != nil {
		return fmt.Errorf("ident: write ssh user ca: %w", err)
	}
	return nil
}

// applyMachineID writes the new machine-id unless systemd already chose one
// of its own. It returns the machine-id that is in effect afterwards.
func applyMachineID(l paths.Layout, hexID, oldWritten string) (string, error) {
	b, err := os.ReadFile(l.MachineIDFile)
	if err != nil && !errors.Is(err, fs.ErrNotExist) {
		return "", fmt.Errorf("ident: read machine-id: %w", err)
	}
	cur := strings.TrimSpace(string(b))
	if cur != "" && cur != uninitializedMachineID && cur != oldWritten {
		return cur, nil
	}
	if err := os.MkdirAll(filepath.Dir(l.MachineIDFile), 0o755); err != nil {
		return "", err
	}
	if err := fsutil.WriteFileAtomic(l.MachineIDFile, []byte(hexID+"\n"), 0o644); err != nil {
		return "", fmt.Errorf("ident: write machine-id: %w", err)
	}
	return hexID, nil
}

// linkDbusMachineID makes the D-Bus machine-id a symlink to /etc/machine-id.
func linkDbusMachineID(l paths.Layout) error {
	if err := os.MkdirAll(filepath.Dir(l.DbusMachineID), 0o755); err != nil {
		return err
	}
	if err := os.RemoveAll(l.DbusMachineID); err != nil {
		return err
	}
	if err := os.Symlink(l.MachineIDFile, l.DbusMachineID); err != nil {
		return fmt.Errorf("ident: link dbus machine-id: %w", err)
	}
	return nil
}

// applyHostname sets the kernel hostname, /etc/hostname and the managed block
// in /etc/hosts.
func applyHostname(l paths.Layout, r Resetter, name string) error {
	if err := r.SetHostname(name); err != nil {
		return fmt.Errorf("ident: set hostname: %w", err)
	}
	if err := fsutil.WriteFileAtomic(l.HostnameFile, []byte(name+"\n"), 0o644); err != nil {
		return fmt.Errorf("ident: write hostname: %w", err)
	}
	if err := setHostsBlock(l.HostsFile, name); err != nil {
		return fmt.Errorf("ident: write hosts: %w", err)
	}
	return nil
}

// setHostsBlock replaces the managed block of the hosts file with a single
// 127.0.1.1 line for name, or appends the block if there is none.
func setHostsBlock(path, name string) error {
	b, err := os.ReadFile(path)
	if err != nil && !errors.Is(err, fs.ErrNotExist) {
		return err
	}
	block := hostsBegin + "\n127.0.1.1 " + name + "\n" + hostsEnd + "\n"
	lines := strings.SplitAfter(string(b), "\n")
	var out strings.Builder
	replaced := false
	for i := 0; i < len(lines); i++ {
		if strings.TrimSpace(lines[i]) != hostsBegin {
			out.WriteString(lines[i])
			continue
		}
		end := -1
		for j := i + 1; j < len(lines); j++ {
			if strings.TrimSpace(lines[j]) == hostsEnd {
				end = j
				break
			}
		}
		if end < 0 {
			continue // unterminated marker: drop the stray line, append below
		}
		if !replaced {
			out.WriteString(block)
			replaced = true
		}
		i = end
	}
	res := out.String()
	if !replaced {
		if res != "" && !strings.HasSuffix(res, "\n") {
			res += "\n"
		}
		res += block
	}
	if err := os.MkdirAll(filepath.Dir(path), 0o755); err != nil {
		return err
	}
	return fsutil.WriteFileAtomic(path, []byte(res), 0o644)
}

// hostKeyFingerprints returns the sorted SHA256 fingerprints of the public
// host keys in dir.
func hostKeyFingerprints(dir string) ([]string, error) {
	matches, err := filepath.Glob(filepath.Join(dir, "ssh_host_*.pub"))
	if err != nil {
		return nil, err
	}
	fps := []string{}
	for _, m := range matches {
		b, err := os.ReadFile(m)
		if err != nil {
			return nil, fmt.Errorf("ident: read host key: %w", err)
		}
		pub, _, _, _, err := ssh.ParseAuthorizedKey(b)
		if err != nil {
			slog.Warn("skipping unparsable host key", "file", filepath.Base(m), "err", err)
			continue
		}
		fps = append(fps, ssh.FingerprintSHA256(pub))
	}
	sort.Strings(fps)
	return fps, nil
}

// removeHostKeys deletes every ssh_host_* file in dir.
func removeHostKeys(dir string) error {
	matches, err := filepath.Glob(filepath.Join(dir, "ssh_host_*"))
	if err != nil {
		return err
	}
	for _, m := range matches {
		if err := os.Remove(m); err != nil && !errors.Is(err, fs.ErrNotExist) {
			return fmt.Errorf("ident: remove host key: %w", err)
		}
	}
	return nil
}
