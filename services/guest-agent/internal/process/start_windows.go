package process

import (
	"errors"
	"fmt"
	"os"
	"path/filepath"

	"connectrpc.com/connect"

	agentv1 "github.com/belov38/boat-dev-clone/libs/proto/sbx/agent/v1"

	"github.com/belov38/boat-dev-clone/services/guest-agent/internal/errs"
	"github.com/belov38/boat-dev-clone/services/guest-agent/internal/wincmd"
)

// shellArgv runs a shell command with pwsh and the exit-code epilogue
// (spec 12.6). A script too long for -EncodedCommand is written to
// script.ps1 in the command directory.
func (m *Manager) shellArgv(id string, u *User, script string, login bool) ([]string, error) {
	dir := m.opts.Layout.CommandDir(id)
	argv, text := wincmd.PwshArgv(u.Shell, script, login, dir)
	if text == "" {
		return argv, nil
	}
	if err := os.MkdirAll(dir, 0o700); err != nil {
		return nil, fmt.Errorf("process: shell script: %w", err)
	}
	if err := os.WriteFile(filepath.Join(dir, wincmd.ScriptFile), []byte(text), 0o600); err != nil {
		return nil, fmt.Errorf("process: shell script: %w", err)
	}
	return argv, nil
}

// resolveCwd returns the working directory of a command: the profile
// directory of u when empty, relative paths under it.
func resolveCwd(u *User, cwd string) string {
	switch {
	case cwd == "":
		return u.Home
	case !filepath.IsAbs(cwd):
		return filepath.Join(u.Home, cwd)
	}
	return cwd
}

// checkArgv rejects an argv whose program is a batch file and whose
// arguments cmd.exe would reinterpret (spec 12.6, BatBadBut). The program
// is resolved with the environment the command gets; a program that is not
// found is left to the shim, which fails the start.
func (m *Manager) checkArgv(u *User, spec *agentv1.CommandSpec) error {
	args := spec.GetArgv().GetArgs()
	if len(args) == 0 {
		return nil
	}
	prog, batch, err := wincmd.ResolveProgram(args[0], m.opts.Env.Build(u, spec), resolveCwd(u, spec.GetCwd()))
	if err != nil || !batch {
		return nil //nolint:nilerr // a missing program fails in the shim
	}
	if _, err := wincmd.BatchCommandLine(prog, args[1:]); err != nil {
		if errors.Is(err, wincmd.ErrUnsafeBatchArgs) {
			return errs.New(connect.CodeInvalidArgument, errs.UnsafeBatchArgs, err.Error())
		}
		return errs.New(connect.CodeInternal, errs.Internal, err.Error())
	}
	return nil
}
