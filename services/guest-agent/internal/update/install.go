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
// Activating abandons an unfinished self-update (see abandonPending).
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
	p, err := placeVersion(l, pkgDir, m, keys)
	if err != nil {
		return nil, err
	}
	p.commit()
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

// placement is a version placed by placeVersion. The caller ends it with
// commit (keep the new build) or undo (restore what was there).
type placement struct {
	dir     string // versions/<v>
	old     string // a replaced build moved aside, or ""
	created bool   // dir was (re)written by this placement
}

// commit drops a replaced build.
func (p *placement) commit() {
	if p.old == "" {
		return
	}
	if err := os.RemoveAll(p.old); err != nil {
		slog.Warn("update: cannot remove replaced version", "dir", p.old, "err", err)
	}
	p.old = ""
}

// undo removes a newly placed build and puts a replaced build back.
func (p *placement) undo() {
	if !p.created {
		return
	}
	if err := os.RemoveAll(p.dir); err != nil {
		slog.Warn("update: cannot remove rejected version", "dir", p.dir, "err", err)
		return
	}
	if p.old != "" {
		if err := os.Rename(p.old, p.dir); err != nil {
			slog.Error("update: cannot restore replaced version", "dir", p.dir, "err", err)
		}
		p.old = ""
	}
	p.created = false
}

// placeVersion moves the verified package in pkgDir to versions/<v>. An
// existing directory with the same signed manifest that still verifies is
// kept (created is false); a different build there is moved aside until the
// placement is committed or undone. The directory's mtime is set to now, so
// GCVersions leaves a freshly placed version alone.
func placeVersion(l paths.Layout, pkgDir string, m *Manifest, keys []ed25519.PublicKey) (*placement, error) {
	p := &placement{dir: VersionDir(l, m.Version)}
	if err := os.MkdirAll(l.VersionsDir, 0o755); err != nil {
		return nil, err
	}
	if _, err := os.Lstat(p.dir); err == nil {
		if sameVersion(pkgDir, p.dir, keys) {
			now := time.Now()
			if err := os.Chtimes(p.dir, now, now); err != nil {
				return nil, err
			}
			return p, nil
		}
		p.old = filepath.Join(l.VersionsDir, incomingPrefix+"old-"+randHex())
		if err := os.Rename(p.dir, p.old); err != nil {
			return nil, err
		}
		slog.Warn("update: replacing a different build of an installed version", "version", m.Version)
	}
	restoreOld := func() {
		if p.old != "" {
			if err := os.Rename(p.old, p.dir); err != nil {
				slog.Error("update: cannot restore replaced version", "dir", p.dir, "err", err)
			}
		}
	}
	if err := os.Chmod(pkgDir, 0o755); err != nil {
		restoreOld()
		return nil, err
	}
	if err := os.Chmod(filepath.Join(pkgDir, BinaryName), 0o755); err != nil {
		restoreOld()
		return nil, err
	}
	if err := os.Rename(pkgDir, p.dir); err != nil {
		// StagingDir and VersionsDir may be on different filesystems.
		tmp := filepath.Join(l.VersionsDir, incomingPrefix+randHex())
		if cerr := copyTree(pkgDir, tmp); cerr != nil {
			_ = os.RemoveAll(tmp)
			restoreOld()
			return nil, errors.Join(err, cerr)
		}
		if err := os.Rename(tmp, p.dir); err != nil {
			_ = os.RemoveAll(tmp)
			restoreOld()
			return nil, err
		}
	}
	p.created = true
	now := time.Now()
	if err := os.Chtimes(p.dir, now, now); err != nil {
		p.undo()
		return nil, err
	}
	if err := syncDir(l.VersionsDir); err != nil {
		p.undo()
		return nil, err
	}
	return p, nil
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

// activate makes v the current version (see makeCurrent) and points the
// CLI link at current. An unfinished self-update is abandoned: the operator
// chose the version.
func activate(l paths.Layout, v string) error {
	if _, err := makeCurrent(l, v); err != nil {
		return err
	}
	if err := abandonPending(l, "abandoned by install-package "+v); err != nil {
		return err
	}
	if err := pointBinLink(l); err != nil {
		return fmt.Errorf("update: link %s: %w", l.BinLink, err)
	}
	return nil
}

// makeCurrent points current at v and previous at the old current, unless v
// is current already. It returns the old current ("" if none).
func makeCurrent(l paths.Layout, v string) (string, error) {
	cur, err := LinkVersion(l.CurrentLink)
	if err != nil {
		return "", err
	}
	if cur == v {
		return cur, nil
	}
	if cur != "" {
		if err := pointLink(l, l.PreviousLink, cur); err != nil {
			return cur, fmt.Errorf("update: switch previous: %w", err)
		}
	}
	if err := pointLink(l, l.CurrentLink, v); err != nil {
		return cur, fmt.Errorf("update: switch current: %w", err)
	}
	return cur, nil
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
