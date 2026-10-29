package quiesce

import (
	"encoding/json"
	"errors"
	"fmt"
	"io/fs"
	"os"
	"path/filepath"
	"strings"
	"time"
)

// MarkerTTL is how long an auto-thaw marker answers Thaw (decision 3).
const MarkerTTL = time.Hour

// markerSuffix ends every marker file name.
const markerSuffix = ".json"

// maxLeaseID bounds a lease id; it names a unit and a marker file.
const maxLeaseID = 200

// Lease is the quiesce lease record in Layout.QuiesceFile (tmpfs). It is
// rewritten before every step, so a crash at any point leaves enough to
// undo the step: a container id is recorded before its pause, a hook before
// it runs with freeze, a mount before its FIFREEZE.
type Lease struct {
	// ID is the lease id.
	ID string `json:"lease_id"`
	// Deadline is when the lease thaws on its own.
	Deadline time.Time `json:"deadline"`
	// Paused lists the containers to unpause on thaw.
	Paused []string `json:"paused,omitempty"`
	// Frozen lists the mount points in freeze order.
	Frozen []string `json:"frozen,omitempty"`
	// Hooks lists the hooks run with freeze, in run order.
	Hooks []string `json:"hooks,omitempty"`
}

// marker records an automatic thaw in Layout.QuiesceThawedDir/<id>.json.
type marker struct {
	LeaseID string    `json:"lease_id"`
	At      time.Time `json:"at"`
	By      string    `json:"by"`
	// Reported is set once the agent emitted quiesce.auto_thawed for it.
	// The watchdog unit writes markers unreported.
	Reported bool `json:"reported"`
}

// validLeaseID accepts the ids that form a unit name and a file name:
// [A-Za-z0-9:_.-], not "." or "..".
func validLeaseID(id string) bool {
	if id == "" || len(id) > maxLeaseID || id == "." || id == ".." {
		return false
	}
	for i := 0; i < len(id); i++ {
		c := id[i]
		switch {
		case c >= 'a' && c <= 'z', c >= 'A' && c <= 'Z', c >= '0' && c <= '9',
			c == ':', c == '_', c == '.', c == '-':
		default:
			return false
		}
	}
	return true
}

// writeFile replaces path with data through a temporary file and a rename.
// The lease and the markers live on tmpfs, so there is no fsync.
func writeFile(path string, data []byte) error {
	if err := os.MkdirAll(filepath.Dir(path), 0o700); err != nil {
		return err
	}
	tmp := path + ".tmp"
	if err := os.WriteFile(tmp, data, 0o600); err != nil {
		return err
	}
	if err := os.Rename(tmp, path); err != nil {
		_ = os.Remove(tmp)
		return err
	}
	return nil
}

// readLease reads the lease file. A missing file returns nil, nil.
func readLease(path string) (*Lease, error) {
	data, err := os.ReadFile(path)
	if errors.Is(err, fs.ErrNotExist) {
		return nil, nil
	}
	if err != nil {
		return nil, fmt.Errorf("quiesce: read lease: %w", err)
	}
	var l Lease
	if err := json.Unmarshal(data, &l); err != nil {
		return nil, fmt.Errorf("quiesce: decode lease %s: %w", path, err)
	}
	return &l, nil
}

// writeLease writes l to path.
func writeLease(path string, l *Lease) error {
	data, err := json.Marshal(l)
	if err != nil {
		return err
	}
	if err := writeFile(path, data); err != nil {
		return fmt.Errorf("quiesce: write lease: %w", err)
	}
	return nil
}

// removeLease deletes the lease file; a missing file is not an error.
func removeLease(path string) error {
	if err := os.Remove(path); err != nil && !errors.Is(err, fs.ErrNotExist) {
		return fmt.Errorf("quiesce: remove lease: %w", err)
	}
	return nil
}

// markerPath returns the marker file of lease id in dir.
func markerPath(dir, id string) string {
	return filepath.Join(dir, id+markerSuffix)
}

// writeMarker writes m into dir and drops markers older than MarkerTTL.
func writeMarker(dir string, m marker) error {
	if !validLeaseID(m.LeaseID) {
		return fmt.Errorf("quiesce: invalid lease id %q", m.LeaseID)
	}
	data, err := json.Marshal(m)
	if err != nil {
		return err
	}
	if err := writeFile(markerPath(dir, m.LeaseID), data); err != nil {
		return fmt.Errorf("quiesce: write marker: %w", err)
	}
	pruneMarkers(dir, m.At)
	return nil
}

// readMarker returns the live marker of lease id, if any. A marker older
// than MarkerTTL at now counts as absent.
func readMarker(dir, id string, now time.Time) (marker, bool) {
	if !validLeaseID(id) {
		return marker{}, false
	}
	data, err := os.ReadFile(markerPath(dir, id))
	if err != nil {
		return marker{}, false
	}
	var m marker
	if json.Unmarshal(data, &m) != nil || m.LeaseID != id || now.Sub(m.At) > MarkerTTL {
		return marker{}, false
	}
	return m, true
}

// listMarkers returns the live markers in dir.
func listMarkers(dir string, now time.Time) []marker {
	entries, err := os.ReadDir(dir)
	if err != nil {
		return nil
	}
	var out []marker
	for _, e := range entries {
		id, ok := strings.CutSuffix(e.Name(), markerSuffix)
		if !ok || !e.Type().IsRegular() {
			continue
		}
		if m, ok := readMarker(dir, id, now); ok {
			out = append(out, m)
		}
	}
	return out
}

// pruneMarkers removes markers (and leftover temporary files) older than
// MarkerTTL at now.
func pruneMarkers(dir string, now time.Time) {
	entries, err := os.ReadDir(dir)
	if err != nil {
		return
	}
	for _, e := range entries {
		name := e.Name()
		if !e.Type().IsRegular() {
			continue
		}
		p := filepath.Join(dir, name)
		if id, ok := strings.CutSuffix(name, markerSuffix); ok {
			if _, live := readMarker(dir, id, now); live {
				continue
			}
		}
		if info, err := e.Info(); err == nil && now.Sub(info.ModTime()) <= MarkerTTL && !strings.HasSuffix(name, markerSuffix) {
			// A temporary file of a write in progress.
			continue
		}
		_ = os.Remove(p)
	}
}
