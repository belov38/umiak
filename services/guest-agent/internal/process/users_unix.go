//go:build !windows

package process

import (
	"bytes"
	"fmt"
	"os"
	"os/user"
	"strconv"
)

// passwdFile is read for the login shell, which os/user does not expose.
const passwdFile = "/etc/passwd"

// defaultShell is the shell of a user without a passwd entry.
const defaultShell = "/bin/sh"

func fromOSUser(u *user.User) (*User, error) {
	uid, err := parseID(u.Uid)
	if err != nil {
		return nil, fmt.Errorf("process: user %s: uid: %w", u.Username, err)
	}
	gid, err := parseID(u.Gid)
	if err != nil {
		return nil, fmt.Errorf("process: user %s: gid: %w", u.Username, err)
	}
	gids, err := u.GroupIds()
	if err != nil {
		return nil, fmt.Errorf("process: user %s: groups: %w", u.Username, err)
	}
	groups := make([]uint32, 0, len(gids))
	for _, g := range gids {
		id, err := parseID(g)
		if err != nil {
			return nil, fmt.Errorf("process: user %s: group: %w", u.Username, err)
		}
		groups = append(groups, id)
	}
	shell := defaultShell
	if data, err := os.ReadFile(passwdFile); err == nil {
		if s := passwdShell(data, u.Username); s != "" {
			shell = s
		}
	}
	return &User{Name: u.Username, UID: uid, GID: gid, Groups: groups, Home: u.HomeDir, Shell: shell}, nil
}

func parseID(s string) (uint32, error) {
	n, err := strconv.ParseUint(s, 10, 32)
	if err != nil {
		return 0, err
	}
	return uint32(n), nil
}

// passwdShell returns the shell field of name in a passwd file, or "".
func passwdShell(data []byte, name string) string {
	for line := range bytes.SplitSeq(data, []byte("\n")) {
		if len(line) == 0 || line[0] == '#' {
			continue
		}
		f := bytes.Split(line, []byte(":"))
		if len(f) == 7 && string(f[0]) == name {
			return string(bytes.TrimSpace(f[6]))
		}
	}
	return ""
}
