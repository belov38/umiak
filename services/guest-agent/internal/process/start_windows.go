package process

import (
	"errors"
	"path/filepath"

	"connectrpc.com/connect"

	agentv1 "github.com/belov38/umiak/libs/proto/umiak/agent/v1"

	"github.com/belov38/umiak/services/guest-agent/internal/errs"
	"github.com/belov38/umiak/services/guest-agent/internal/wincmd"
)

// shellArgv runs a shell command with pwsh and the exit-code epilogue
// (spec 12.6). A script too long for -EncodedCommand comes back as
// scriptFile: argv runs it from script.ps1 in the command directory, which
// the shim writes readable by the command's user and deletes after the
// exit.
func (m *Manager) shellArgv(id string, u *User, script string, login bool) (argv []string, scriptFile string, err error) {
	argv, scriptFile = wincmd.PwshArgv(u.Shell, script, login, m.opts.Layout.CommandDir(id))
	return argv, scriptFile, nil
}

// resolveCwd returns the working directory of a command: the profile
// directory of u when empty, relative paths under it, a path rooted without
// a drive (\x) on the drive of the profile. A drive-relative path (C:x)
// depends on the per-drive current directory and is rejected.
func resolveCwd(u *User, cwd string) (string, error) {
	switch {
	case cwd == "":
		return u.Home, nil
	case filepath.IsAbs(cwd):
		return cwd, nil
	case filepath.VolumeName(cwd) != "":
		return "", errs.Newf(connect.CodeInvalidArgument, errs.InvalidArgument,
			"cwd %q is relative to the current directory of a drive", cwd)
	case cwd[0] == '\\' || cwd[0] == '/':
		return filepath.Clean(filepath.VolumeName(u.Home) + cwd), nil
	}
	return filepath.Join(u.Home, cwd), nil
}

// prepareSpec checks spec for Windows and returns its environment, which
// the launch reuses (one logon per Start). It rejects a drive-relative
// cwd, and an argv whose program is a batch file with arguments cmd.exe
// would reinterpret (spec 12.6, BatBadBut). The program is resolved with
// the same environment and cwd the shim gets; a program that is not found
// is left to the shim, which fails the start.
func (m *Manager) prepareSpec(u *User, spec *agentv1.CommandSpec) ([]string, error) {
	cwd, err := resolveCwd(u, spec.GetCwd())
	if err != nil {
		return nil, err
	}
	env := m.opts.Env.Build(u, spec)
	args := spec.GetArgv().GetArgs()
	if len(args) == 0 {
		return env, nil
	}
	prog, batch, err := wincmd.ResolveProgram(args[0], env, cwd)
	if err != nil || !batch {
		return env, nil //nolint:nilerr // a missing program fails in the shim
	}
	if _, err := wincmd.BatchCommandLine(prog, args[1:]); err != nil {
		if errors.Is(err, wincmd.ErrUnsafeBatchArgs) {
			return nil, errs.New(connect.CodeInvalidArgument, errs.UnsafeBatchArgs, err.Error())
		}
		return nil, errs.New(connect.CodeInternal, errs.Internal, err.Error())
	}
	return env, nil
}
