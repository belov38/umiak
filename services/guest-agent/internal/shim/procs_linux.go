//go:build linux

package shim

import (
	"errors"
	"os"
	"strconv"
	"strings"
	"syscall"

	"golang.org/x/sys/unix"
)

// Once the main process is reaped its pid, and so its process group id, may
// be reused by an unrelated process. From then on the shim never signals a
// bare pgid: it signals the leftover processes one by one, through a pidfd
// opened after checking that the pid still belongs to the command.

var errZombie = errors.New("shim: zombie")

// readPPid returns the parent pid from /proc/<pid>/stat. A zombie counts as
// gone: it only waits for the next reap.
func readPPid(pid int) (int, error) {
	data, err := os.ReadFile("/proc/" + strconv.Itoa(pid) + "/stat")
	if err != nil {
		return 0, err
	}
	// The command name may contain spaces and parentheses; the fields
	// after the last ")" are "state ppid ...".
	s := string(data)
	i := strings.LastIndexByte(s, ')')
	if i < 0 {
		return 0, errors.New("shim: malformed stat")
	}
	f := strings.Fields(s[i+1:])
	if len(f) < 2 {
		return 0, errors.New("shim: malformed stat")
	}
	if f[0] == "Z" {
		return 0, errZombie
	}
	return strconv.Atoi(f[1])
}

// descendants returns every live process below root in the process tree.
// The shim is a subreaper, so orphaned leftovers stay below it even after
// setsid or a double fork.
func descendants(root int) ([]int, error) {
	entries, err := os.ReadDir("/proc")
	if err != nil {
		return nil, err
	}
	children := make(map[int][]int)
	for _, e := range entries {
		pid, err := strconv.Atoi(e.Name())
		if err != nil {
			continue
		}
		ppid, err := readPPid(pid)
		if err != nil {
			continue // exited meanwhile
		}
		children[ppid] = append(children[ppid], pid)
	}
	var out []int
	queue := append([]int(nil), children[root]...)
	for len(queue) > 0 {
		pid := queue[0]
		queue = queue[1:]
		out = append(out, pid)
		queue = append(queue, children[pid]...)
	}
	return out, nil
}

// isDescendant reports whether pid is currently below root.
func isDescendant(pid, root int) bool {
	for range 4096 { // bounds a pathological chain
		ppid, err := readPPid(pid)
		if err != nil || ppid <= 0 {
			return false
		}
		if ppid == root {
			return true
		}
		pid = ppid
	}
	return false
}

// signalPid sends sig to pid if owned(pid) still holds once a pidfd pins
// the process, so a pid reused after the check is never signalled. Without
// pidfd support (kernel < 5.3) it falls back to kill after the check.
func signalPid(pid int, sig syscall.Signal, owned func(int) bool) bool {
	fd, err := unix.PidfdOpen(pid, 0)
	if errors.Is(err, unix.ENOSYS) {
		return owned(pid) && unix.Kill(pid, sig) == nil
	}
	if err != nil {
		return false // gone
	}
	defer func() { _ = unix.Close(fd) }()
	if !owned(pid) {
		return false
	}
	return unix.PidfdSendSignal(fd, sig, nil, 0) == nil
}
