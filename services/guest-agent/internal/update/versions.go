package update

import (
	"crypto/rand"
	"encoding/hex"
	"errors"
	"fmt"
	"io/fs"
	"log/slog"
	"os"
	"path/filepath"
	"runtime"
	"slices"
	"strings"
	"time"

	"github.com/belov38/boat-dev-clone/services/guest-agent/internal/fsutil"
	"github.com/belov38/boat-dev-clone/services/guest-agent/internal/paths"
	"github.com/belov38/boat-dev-clone/services/guest-agent/internal/shim"
)

// Temporary entry prefixes: unpacked packages in StagingDir and versions
// being copied into VersionsDir. Leftovers are removed by CleanTemp.
const (
	stagingPrefix  = ".pkg-"
	incomingPrefix = ".incoming-"
)

// VersionDir returns the directory of version v.
func VersionDir(l paths.Layout, v string) string {
	return filepath.Join(l.VersionsDir, v)
}

// LinkVersion returns the version a current or previous link (a symlink,
// on Windows a junction) points to, or "" when the link does not exist.
func LinkVersion(link string) (string, error) {
	target, err := os.Readlink(link)
	if errors.Is(err, fs.ErrNotExist) {
		return "", nil
	}
	if err != nil {
		return "", err
	}
	return filepath.Base(target), nil
}

// syncDir fsyncs a directory after a rename into it; a no-op on Windows.
func syncDir(dir string) error {
	if runtime.GOOS == "windows" {
		return nil
	}
	d, err := os.Open(dir)
	if err != nil {
		return err
	}
	defer func() { _ = d.Close() }()
	return d.Sync()
}

// randHex returns 8 random bytes in hex.
func randHex() string {
	var b [8]byte
	_, _ = rand.Read(b[:])
	return hex.EncodeToString(b[:])
}

// gcMinAge protects a version placed recently (an Apply in its selftest
// window, an install-package without activation) from GCVersions.
const gcMinAge = 10 * time.Minute

// GCVersions removes installed versions other than current, previous, the
// two versions of a pending update, keep (the versions of live shims, see
// ShimVersions; spec 17.4 step 7) and versions whose directory changed in
// the last 10 minutes. Temporary entries are left to CleanTemp. In the
// agent use Manager.GC, which also skips while an update is applied.
func GCVersions(l paths.Layout, keep []string) error {
	kept := slices.Clone(keep)
	if p, ok, err := readPending(l); err != nil {
		return fmt.Errorf("update: gc: %w", err)
	} else if ok {
		kept = append(kept, p.From, p.To)
	}
	for _, link := range []string{l.CurrentLink, l.PreviousLink} {
		v, err := LinkVersion(link)
		if err != nil {
			return fmt.Errorf("update: gc: %w", err)
		}
		if v != "" {
			kept = append(kept, v)
		}
	}
	entries, err := os.ReadDir(l.VersionsDir)
	if errors.Is(err, fs.ErrNotExist) {
		return nil
	}
	if err != nil {
		return fmt.Errorf("update: gc: %w", err)
	}
	var errs []error
	for _, e := range entries {
		name := e.Name()
		if !e.IsDir() || strings.HasPrefix(name, ".") || slices.Contains(kept, name) {
			continue
		}
		if fi, err := e.Info(); err != nil || time.Since(fi.ModTime()) < gcMinAge {
			continue
		}
		if err := os.RemoveAll(filepath.Join(l.VersionsDir, name)); err != nil {
			errs = append(errs, err)
			continue
		}
		slog.Info("update: removed old version", "version", name)
	}
	return errors.Join(errs...)
}

// CleanTemp removes unpacked packages left in StagingDir and partial
// copies left in VersionsDir by an interrupted install. Call it only when no
// install runs (at agent start).
func CleanTemp(l paths.Layout) error {
	var errs []error
	for _, d := range []struct{ dir, prefix string }{
		{l.StagingDir, stagingPrefix},
		{l.VersionsDir, incomingPrefix},
	} {
		entries, err := os.ReadDir(d.dir)
		if errors.Is(err, fs.ErrNotExist) {
			continue
		}
		if err != nil {
			errs = append(errs, err)
			continue
		}
		for _, e := range entries {
			if strings.HasPrefix(e.Name(), d.prefix) {
				errs = append(errs, os.RemoveAll(filepath.Join(d.dir, e.Name())))
			}
		}
	}
	return errors.Join(errs...)
}

// ShimVersions returns the agent versions and shim protocol versions of the
// running commands, sorted and unique, from their shim.json. running reports
// whether command id still runs; nil treats every command without exit.json
// as running.
func ShimVersions(l paths.Layout, running func(id string) bool) (versions []string, protos []int) {
	entries, err := os.ReadDir(l.CommandsDir)
	if err != nil {
		return nil, nil
	}
	for _, e := range entries {
		if !e.IsDir() {
			continue
		}
		id, dir := e.Name(), l.CommandDir(e.Name())
		if running != nil {
			if !running(id) {
				continue
			}
		} else if _, err := os.Stat(filepath.Join(dir, shim.ExitJSON)); err == nil {
			continue
		}
		var sf shim.ShimFile
		if err := fsutil.ReadJSON(filepath.Join(dir, shim.ShimJSON), &sf); err != nil {
			continue
		}
		if sf.AgentVersion != "" && !slices.Contains(versions, sf.AgentVersion) {
			versions = append(versions, sf.AgentVersion)
		}
		if sf.ShimProto > 0 && !slices.Contains(protos, sf.ShimProto) {
			protos = append(protos, sf.ShimProto)
		}
	}
	slices.Sort(versions)
	slices.Sort(protos)
	return versions, protos
}
