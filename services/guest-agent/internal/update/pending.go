package update

import (
	"errors"
	"fmt"
	"io/fs"
	"os"
	"path/filepath"
	"slices"
	"strings"
	"time"

	"github.com/belov38/boat-dev-clone/services/guest-agent/internal/fsutil"
	"github.com/belov38/boat-dev-clone/services/guest-agent/internal/paths"
)

// Pending is pending-update.json: an update that switched current but was
// not confirmed yet (spec 17.4 step 4). It is a file and not a bbolt record
// because `sbx-agent rollback` reads it while the agent is down.
type Pending struct {
	From     string    `json:"from"`
	To       string    `json:"to"`
	Deadline time.Time `json:"deadline"`
}

// readPending returns the pending update; ok is false when there is none.
func readPending(l paths.Layout) (p Pending, ok bool, err error) {
	err = fsutil.ReadJSON(l.PendingUpdateFile, &p)
	if errors.Is(err, fs.ErrNotExist) {
		return Pending{}, false, nil
	}
	if err != nil {
		return Pending{}, false, err
	}
	return p, true, nil
}

// writePending records p durably.
func writePending(l paths.Layout, p Pending) error {
	if err := os.MkdirAll(filepath.Dir(l.PendingUpdateFile), 0o755); err != nil {
		return err
	}
	return fsutil.WriteJSONAtomic(l.PendingUpdateFile, p, 0o644)
}

// removePending deletes pending-update.json; a missing file is fine.
func removePending(l paths.Layout) error {
	err := os.Remove(l.PendingUpdateFile)
	if errors.Is(err, fs.ErrNotExist) {
		return nil
	}
	return err
}

// readBadVersions returns the versions in bad-versions (one per line).
func readBadVersions(l paths.Layout) ([]string, error) {
	b, err := os.ReadFile(l.BadVersionsFile)
	if errors.Is(err, fs.ErrNotExist) {
		return nil, nil
	}
	if err != nil {
		return nil, err
	}
	var out []string
	for _, line := range strings.Split(string(b), "\n") {
		if line = strings.TrimSpace(line); line != "" && !slices.Contains(out, line) {
			out = append(out, line)
		}
	}
	return out, nil
}

// addBadVersion appends v to bad-versions unless it is listed already.
func addBadVersion(l paths.Layout, v string) error {
	bad, err := readBadVersions(l)
	if err != nil {
		return err
	}
	if slices.Contains(bad, v) {
		return nil
	}
	bad = append(bad, v)
	if err := os.MkdirAll(filepath.Dir(l.BadVersionsFile), 0o755); err != nil {
		return err
	}
	return fsutil.WriteFileAtomic(l.BadVersionsFile, []byte(strings.Join(bad, "\n")+"\n"), 0o644)
}

// rollbackResult is rollback-result.json: a rollback done while the agent
// was down or about to exit. The next agent start reports it as
// update.result{rolled_back} and deletes it.
type rollbackResult struct {
	From  string `json:"from"`
	To    string `json:"to"`
	Error string `json:"error"`
}

// rollbackResultFile is /var/lib/sbx-agent/rollback-result.json.
func rollbackResultFile(l paths.Layout) string {
	return filepath.Join(l.StateDir, "rollback-result.json")
}

func readRollbackResult(l paths.Layout, r *rollbackResult) error {
	return fsutil.ReadJSON(rollbackResultFile(l), r)
}

// revert undoes the unconfirmed update p: to is marked bad, the rollback is
// recorded for the next start, current goes back to from, and the pending
// file is deleted last, so a crash in between leaves a state that the next
// start or rollback finishes. previous is left alone.
func revert(l paths.Layout, p Pending, reason string) error {
	if err := ValidVersion(p.From); err != nil {
		return fmt.Errorf("update: pending update: %w", err)
	}
	if err := addBadVersion(l, p.To); err != nil {
		return fmt.Errorf("update: record bad version: %w", err)
	}
	if err := fsutil.WriteJSONAtomic(rollbackResultFile(l), rollbackResult{From: p.From, To: p.To, Error: reason}, 0o644); err != nil {
		return fmt.Errorf("update: record rollback: %w", err)
	}
	if err := pointLink(l, l.CurrentLink, p.From); err != nil {
		return fmt.Errorf("update: switch current to %s: %w", p.From, err)
	}
	if err := removePending(l); err != nil {
		return fmt.Errorf("update: remove pending update: %w", err)
	}
	return nil
}
