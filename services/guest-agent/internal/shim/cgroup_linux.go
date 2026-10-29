//go:build linux

package shim

import (
	"bufio"
	"bytes"
	"errors"
	"fmt"
	"log/slog"
	"os"
	"path/filepath"
	"strconv"
	"strings"

	"golang.org/x/sys/unix"
)

// cgroupMount is the cgroup v2 mount point.
const cgroupMount = "/sys/fs/cgroup"

// payloadControllers are enabled for the children of the unit cgroup.
var payloadControllers = []string{"memory", "pids", "cpu"}

// cgroup is the payload cgroup of the command (spec section 9.3): the unit
// cgroup holds two leaves, shim (the shim itself) and payload (the command
// and everything it spawns).
type cgroup struct {
	dir string // payload directory
	fd  int    // open payload directory for CLONE_INTO_CGROUP
}

// setupCgroup moves the shim into <unit>/shim, enables the payload
// controllers in <unit> and creates <unit>/payload. The unit cgroup is the
// one systemd started the shim in (Delegate=yes).
func setupCgroup(log *slog.Logger) (*cgroup, error) {
	rel, err := ownCgroup("/proc/self/cgroup")
	if err != nil {
		return nil, err
	}
	unit := filepath.Join(cgroupMount, rel)
	leaf := filepath.Join(unit, "shim")
	if err := os.Mkdir(leaf, 0o755); err != nil && !errors.Is(err, os.ErrExist) {
		return nil, fmt.Errorf("shim: cgroup: %w", err)
	}
	// No internal processes: the shim must leave the unit cgroup before
	// subtree_control can be set there.
	if err := writeCgroupFile(filepath.Join(leaf, "cgroup.procs"), strconv.Itoa(os.Getpid())); err != nil {
		return nil, err
	}
	for _, c := range payloadControllers {
		if err := writeCgroupFile(filepath.Join(unit, "cgroup.subtree_control"), "+"+c); err != nil {
			// A missing controller only loses accounting; the cgroup still
			// contains and kills the payload.
			log.Warn("shim: cannot enable cgroup controller", "controller", c, "err", err)
		}
	}
	payload := filepath.Join(unit, "payload")
	if err := os.Mkdir(payload, 0o755); err != nil && !errors.Is(err, os.ErrExist) {
		return nil, fmt.Errorf("shim: cgroup: %w", err)
	}
	fd, err := unix.Open(payload, unix.O_RDONLY|unix.O_DIRECTORY|unix.O_CLOEXEC, 0)
	if err != nil {
		return nil, fmt.Errorf("shim: open payload cgroup: %w", err)
	}
	return &cgroup{dir: payload, fd: fd}, nil
}

// ownCgroup returns the cgroup v2 path of the process from a
// /proc/<pid>/cgroup file (the "0::<path>" line).
func ownCgroup(procFile string) (string, error) {
	data, err := os.ReadFile(procFile)
	if err != nil {
		return "", fmt.Errorf("shim: cgroup: %w", err)
	}
	sc := bufio.NewScanner(bytes.NewReader(data))
	for sc.Scan() {
		if rest, ok := strings.CutPrefix(sc.Text(), "0::"); ok {
			if rest == "" || rest == "/" {
				return "", errors.New("shim: cgroup: running in the root cgroup")
			}
			return rest, nil
		}
	}
	return "", errors.New("shim: cgroup: no cgroup v2 entry")
}

// writeCgroupFile writes value with a single write to an existing file.
func writeCgroupFile(path, value string) error {
	f, err := os.OpenFile(path, os.O_WRONLY, 0)
	if err == nil {
		_, err = f.WriteString(value)
		err = errors.Join(err, f.Close())
	}
	if err != nil {
		return fmt.Errorf("shim: write %s: %w", path, err)
	}
	return nil
}

// kill kills every process in the payload (cgroup.kill, kernel 5.14+).
func (c *cgroup) kill() error {
	return writeCgroupFile(filepath.Join(c.dir, "cgroup.kill"), "1")
}

// populated reports whether a process is left in the payload.
func (c *cgroup) populated() (bool, error) {
	v, err := c.keyed("cgroup.events", "populated")
	return v != 0, err
}

// oomKills returns the oom_kill counter of the payload.
func (c *cgroup) oomKills() (uint64, error) {
	return c.keyed("memory.events", "oom_kill")
}

// keyed reads one "key value" line of a cgroup file.
func (c *cgroup) keyed(file, key string) (uint64, error) {
	data, err := os.ReadFile(filepath.Join(c.dir, file))
	if err != nil {
		return 0, err
	}
	for line := range strings.SplitSeq(string(data), "\n") {
		k, v, ok := strings.Cut(line, " ")
		if ok && k == key {
			return strconv.ParseUint(strings.TrimSpace(v), 10, 64)
		}
	}
	return 0, fmt.Errorf("shim: %s: no %s", file, key)
}
