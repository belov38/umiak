//go:build !windows

package process

import (
	"path"

	agentv1 "github.com/belov38/boat-dev-clone/libs/proto/sbx/agent/v1"
)

// shellArgv runs a shell command with bash, as a login shell unless login
// is false.
func (m *Manager) shellArgv(_ string, _ *User, script string, login bool) ([]string, error) {
	flag := "-lc"
	if !login {
		flag = "-c"
	}
	return []string{"/bin/bash", flag, script}, nil
}

// resolveCwd returns the working directory of a command: the home of u when
// empty, relative paths under it.
func resolveCwd(u *User, cwd string) string {
	switch {
	case cwd == "":
		return u.Home
	case !path.IsAbs(cwd):
		return path.Join(u.Home, cwd)
	}
	return cwd
}

// checkArgv has nothing to check on Linux: execve passes argv as is.
func (m *Manager) checkArgv(*User, *agentv1.CommandSpec) error {
	return nil
}
