package ports

import (
	"os"
	"os/user"
	"path/filepath"
	"slices"
	"strconv"
	"strings"
)

// owner is the process holding a listening socket.
type owner struct {
	pid     int
	process string
	user    string
}

// resolveOwners maps each port to the lowest-pid process holding one of its
// sockets, found through /proc/<pid>/fd. Processes that vanish or cannot be
// read are skipped. It walks every process, so callers use it only when the
// port set changed.
func (s *Scanner) resolveOwners(groups []*portGroup) map[uint16]owner {
	if len(groups) == 0 {
		return nil
	}
	portOf := make(map[uint64]uint16)
	for _, g := range groups {
		for _, in := range g.inodes {
			portOf[in] = g.port
		}
	}
	entries, err := os.ReadDir(s.opt.ProcDir)
	if err != nil {
		return nil
	}
	pids := make([]int, 0, len(entries))
	for _, e := range entries {
		if pid, err := strconv.Atoi(e.Name()); err == nil && pid > 0 {
			pids = append(pids, pid)
		}
	}
	// Ascending pid so the lowest pid wins.
	slices.Sort(pids)
	owners := make(map[uint16]owner)
	for _, pid := range pids {
		dir := filepath.Join(s.opt.ProcDir, strconv.Itoa(pid))
		fds, err := os.ReadDir(filepath.Join(dir, "fd"))
		if err != nil {
			continue
		}
		var found []uint16
		for _, fd := range fds {
			link, err := os.Readlink(filepath.Join(dir, "fd", fd.Name()))
			if err != nil {
				continue
			}
			inode, ok := socketInode(link)
			if !ok {
				continue
			}
			if port, ok := portOf[inode]; ok {
				if _, taken := owners[port]; !taken {
					found = append(found, port)
				}
			}
		}
		if len(found) == 0 {
			continue
		}
		o := owner{pid: pid, process: readComm(dir), user: readUser(dir)}
		for _, port := range found {
			owners[port] = o
		}
	}
	return owners
}

// socketInode parses a "socket:[123]" fd link target.
func socketInode(link string) (uint64, bool) {
	rest, ok := strings.CutPrefix(link, "socket:[")
	if !ok {
		return 0, false
	}
	rest, ok = strings.CutSuffix(rest, "]")
	if !ok {
		return 0, false
	}
	n, err := strconv.ParseUint(rest, 10, 64)
	return n, err == nil
}

func readComm(dir string) string {
	data, err := os.ReadFile(filepath.Join(dir, "comm"))
	if err != nil {
		return ""
	}
	return strings.TrimSpace(string(data))
}

// readUser returns the user name of the real uid in <dir>/status, or the
// numeric uid when the name is unknown.
func readUser(dir string) string {
	data, err := os.ReadFile(filepath.Join(dir, "status"))
	if err != nil {
		return ""
	}
	for line := range strings.SplitSeq(string(data), "\n") {
		rest, ok := strings.CutPrefix(line, "Uid:")
		if !ok {
			continue
		}
		f := strings.Fields(rest)
		if len(f) == 0 {
			return ""
		}
		if u, err := user.LookupId(f[0]); err == nil {
			return u.Username
		}
		return f[0]
	}
	return ""
}
