package update

import (
	"errors"
	"fmt"
	"io/fs"
	"log/slog"
	"os"
	"path/filepath"

	"github.com/belov38/umiak/services/guest-agent/internal/paths"
)

// RepairCurrent recreates a missing current link, which a crash during a
// junction switch can leave behind on Windows (see pointLink): it points
// current at the target of pending-update.json, else at its from version,
// else at the version of previous, whichever is installed first. It returns
// the version current now points to, or "" when current exists.
func RepairCurrent(l paths.Layout) (string, error) {
	if _, err := os.Lstat(l.CurrentLink); err == nil || !errors.Is(err, fs.ErrNotExist) {
		return "", err
	}
	var candidates []string
	if p, ok, err := readPending(l); err != nil {
		slog.Warn("update: unreadable pending update while repairing current", "err", err)
	} else if ok {
		candidates = append(candidates, p.To, p.From)
	}
	if prev, err := LinkVersion(l.PreviousLink); err == nil && prev != "" {
		candidates = append(candidates, prev)
	}
	for _, v := range candidates {
		if !versionInstalled(l, v) {
			continue
		}
		if err := pointLink(l, l.CurrentLink, v); err != nil {
			return "", fmt.Errorf("update: recreate current: %w", err)
		}
		slog.Warn("update: current was missing, recreated", "version", v)
		return v, nil
	}
	return "", errors.New("update: current is missing and no pending update or previous version is installed")
}

// versionInstalled reports whether v is a valid version with an agent
// binary in its directory.
func versionInstalled(l paths.Layout, v string) bool {
	if ValidVersion(v) != nil {
		return false
	}
	fi, err := os.Stat(filepath.Join(VersionDir(l, v), BinaryName))
	return err == nil && fi.Mode().IsRegular()
}
