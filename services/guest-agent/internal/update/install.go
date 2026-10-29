package update

import (
	"bytes"
	"context"
	"crypto/ed25519"
	"errors"
	"fmt"
	"io"
	"io/fs"
	"log/slog"
	"os"
	"os/exec"
	"path/filepath"
	"runtime"
	"strings"
	"time"

	"github.com/belov38/boat-dev-clone/services/guest-agent/internal/fsutil"
	"github.com/belov38/boat-dev-clone/services/guest-agent/internal/paths"
)

// InstallOptions controls what Install does besides placing the version.
type InstallOptions struct {
	// Activate points previous at the old current, current at the new
	// version and the CLI link at current/sbx-agent.
	Activate bool
	// InstallUnits writes Units into SystemdUnitDir, reloads systemd and
	// enables sbx-identity.service and sbx-agent.service.
	InstallUnits bool
	// WriteConfig writes Config to agent.toml if that file is absent.
	WriteConfig bool
	// Units holds the unit files at its root.
	Units fs.FS
	// Config is the agent.toml template.
	Config []byte
	// Systemctl runs systemctl; nil means the real one.
	Systemctl func(args ...string) error
}

// enabledUnits are enabled by an install with units.
var enabledUnits = []string{"sbx-identity.service", "sbx-agent.service"}

// Install installs the package at tarPath (spec 17.1, `sbx-agent
// install-package`): unpack into StagingDir, verify against keys and the
// running platform, move to versions/<v> and, per opts, activate it, install
// the units and write the config. An already installed identical version is
// kept as is; reinstalling the current version leaves previous alone.
func Install(l paths.Layout, tarPath string, keys []ed25519.PublicKey, opts InstallOptions) (*Manifest, error) {
	m, err := stageAndPlace(l, tarPath, keys)
	if err != nil {
		return nil, err
	}
	if opts.Activate {
		if err := activate(l, m.Version); err != nil {
			return nil, err
		}
	}
	if opts.InstallUnits {
		sc := opts.Systemctl
		if sc == nil {
			sc = Systemctl
		}
		if err := installUnits(l, opts.Units, sc); err != nil {
			return nil, err
		}
	}
	if opts.WriteConfig {
		if err := writeConfigIfAbsent(l, opts.Config); err != nil {
			return nil, err
		}
	}
	return m, nil
}

// stageAndPlace unpacks and verifies a package and places it in
// versions/<v>.
func stageAndPlace(l paths.Layout, tarPath string, keys []ed25519.PublicKey) (*Manifest, error) {
	pkgDir, cleanup, m, err := stage(l, tarPath, keys)
	if err != nil {
		return nil, err
	}
	defer cleanup()
	if _, err := placeVersion(l, pkgDir, m, keys); err != nil {
		return nil, err
	}
	return m, nil
}

// stage unpacks tarPath into a fresh directory under StagingDir and verifies
// it. cleanup removes the directory.
func stage(l paths.Layout, tarPath string, keys []ed25519.PublicKey) (pkgDir string, cleanup func(), m *Manifest, err error) {
	if err := os.MkdirAll(l.StagingDir, 0o700); err != nil {
		return "", nil, nil, err
	}
	tmp, err := os.MkdirTemp(l.StagingDir, stagingPrefix)
	if err != nil {
		return "", nil, nil, err
	}
	cleanup = func() {
		if err := os.RemoveAll(tmp); err != nil {
			slog.Warn("update: cannot remove staging directory", "dir", tmp, "err", err)
		}
	}
	pkgDir = filepath.Join(tmp, "pkg")
	if err := Unpack(tarPath, pkgDir); err != nil {
		cleanup()
		return "", nil, nil, err
	}
	m, err = Verify(pkgDir, keys)
	if err == nil {
		err = checkPlatform(m)
	}
	if err != nil {
		cleanup()
		return "", nil, nil, err
	}
	return pkgDir, cleanup, m, nil
}

// checkPlatform rejects a package built for another OS or architecture.
func checkPlatform(m *Manifest) error {
	if m.OS != runtime.GOOS || m.Arch != runtime.GOARCH {
		return invalidPackage("package is for %s/%s, this machine is %s/%s", m.OS, m.Arch, runtime.GOOS, runtime.GOARCH)
	}
	return nil
}

// placeVersion moves the verified package in pkgDir to versions/<v>. An
// existing directory with the same signed manifest that still verifies is
// kept (created is false); anything else there is replaced.
func placeVersion(l paths.Layout, pkgDir string, m *Manifest, keys []ed25519.PublicKey) (created bool, err error) {
	dst := VersionDir(l, m.Version)
	if err := os.MkdirAll(l.VersionsDir, 0o755); err != nil {
		return false, err
	}
	var old string
	if _, err := os.Lstat(dst); err == nil {
		if sameVersion(pkgDir, dst, keys) {
			return false, nil
		}
		old = filepath.Join(l.VersionsDir, incomingPrefix+"old-"+randHex())
		if err := os.Rename(dst, old); err != nil {
			return false, err
		}
		slog.Warn("update: replacing a different build of an installed version", "version", m.Version)
	}
	if err := os.Chmod(pkgDir, 0o755); err != nil {
		return false, err
	}
	if err := os.Rename(pkgDir, dst); err != nil {
		// StagingDir and VersionsDir may be on different filesystems.
		tmp := filepath.Join(l.VersionsDir, incomingPrefix+randHex())
		if cerr := copyTree(pkgDir, tmp); cerr != nil {
			_ = os.RemoveAll(tmp)
			return false, errors.Join(err, cerr)
		}
		if err := os.Rename(tmp, dst); err != nil {
			_ = os.RemoveAll(tmp)
			return false, err
		}
	}
	if err := syncDir(l.VersionsDir); err != nil {
		return false, err
	}
	if old != "" {
		if err := os.RemoveAll(old); err != nil {
			slog.Warn("update: cannot remove replaced version", "dir", old, "err", err)
		}
	}
	return true, nil
}

// sameVersion reports whether dst holds the same signed manifest as pkgDir
// and its files still verify.
func sameVersion(pkgDir, dst string, keys []ed25519.PublicKey) bool {
	a, err := os.ReadFile(filepath.Join(pkgDir, ManifestName))
	if err != nil {
		return false
	}
	b, err := os.ReadFile(filepath.Join(dst, ManifestName))
	if err != nil || !bytes.Equal(a, b) {
		return false
	}
	_, err = Verify(dst, keys)
	return err == nil
}

// copyTree copies the regular files and directories of src into dst and
// fsyncs the files.
func copyTree(src, dst string) error {
	return filepath.WalkDir(src, func(p string, d fs.DirEntry, err error) error {
		if err != nil {
			return err
		}
		rel, err := filepath.Rel(src, p)
		if err != nil {
			return err
		}
		target := filepath.Join(dst, rel)
		if d.IsDir() {
			return os.MkdirAll(target, 0o755)
		}
		if !d.Type().IsRegular() {
			return fmt.Errorf("update: %s is not a regular file", rel)
		}
		fi, err := d.Info()
		if err != nil {
			return err
		}
		return copyFile(p, target, fi.Mode().Perm())
	})
}

func copyFile(src, dst string, perm fs.FileMode) (err error) {
	in, err := os.Open(src)
	if err != nil {
		return err
	}
	defer func() { _ = in.Close() }()
	out, err := os.OpenFile(dst, os.O_CREATE|os.O_EXCL|os.O_WRONLY, perm)
	if err != nil {
		return err
	}
	defer func() {
		if cerr := out.Close(); err == nil {
			err = cerr
		}
	}()
	if _, err := io.Copy(out, in); err != nil {
		return err
	}
	return out.Sync()
}

// activate makes v the current version: previous becomes the old current
// (unless v is current already) and the CLI link points at current.
func activate(l paths.Layout, v string) error {
	cur, err := LinkVersion(l.CurrentLink)
	if err != nil {
		return err
	}
	if cur != v {
		if cur != "" {
			if err := pointLink(l, l.PreviousLink, cur); err != nil {
				return fmt.Errorf("update: switch previous: %w", err)
			}
		}
		if err := pointLink(l, l.CurrentLink, v); err != nil {
			return fmt.Errorf("update: switch current: %w", err)
		}
	}
	if err := pointBinLink(l); err != nil {
		return fmt.Errorf("update: link %s: %w", l.BinLink, err)
	}
	return nil
}

// installUnits writes every file at the root of units into SystemdUnitDir,
// reloads systemd and enables the agent units (decision 9).
func installUnits(l paths.Layout, units fs.FS, systemctl func(args ...string) error) error {
	if units == nil {
		return errors.New("update: no unit files to install")
	}
	entries, err := fs.ReadDir(units, ".")
	if err != nil {
		return err
	}
	if err := os.MkdirAll(l.SystemdUnitDir, 0o755); err != nil {
		return err
	}
	for _, e := range entries {
		if !e.Type().IsRegular() {
			continue
		}
		data, err := fs.ReadFile(units, e.Name())
		if err != nil {
			return err
		}
		if err := fsutil.WriteFileAtomic(filepath.Join(l.SystemdUnitDir, e.Name()), data, 0o644); err != nil {
			return fmt.Errorf("update: install unit %s: %w", e.Name(), err)
		}
	}
	if err := systemctl("daemon-reload"); err != nil {
		return err
	}
	return systemctl(append([]string{"enable"}, enabledUnits...)...)
}

// writeConfigIfAbsent writes agent.toml unless it exists.
func writeConfigIfAbsent(l paths.Layout, data []byte) error {
	if _, err := os.Lstat(l.ConfigFile); err == nil {
		return nil
	} else if !errors.Is(err, fs.ErrNotExist) {
		return err
	}
	if err := os.MkdirAll(filepath.Dir(l.ConfigFile), 0o755); err != nil {
		return err
	}
	return fsutil.WriteFileAtomic(l.ConfigFile, data, 0o644)
}

// systemctlTimeout bounds one systemctl call.
const systemctlTimeout = time.Minute

// Systemctl runs systemctl with args and returns its output in the error.
func Systemctl(args ...string) error {
	ctx, cancel := context.WithTimeout(context.Background(), systemctlTimeout)
	defer cancel()
	var out bytes.Buffer
	cmd := exec.CommandContext(ctx, "systemctl", args...)
	cmd.Stdout, cmd.Stderr = &out, &out
	if err := cmd.Run(); err != nil {
		return fmt.Errorf("systemctl %s: %w: %s", strings.Join(args, " "), err, strings.TrimSpace(out.String()))
	}
	return nil
}
