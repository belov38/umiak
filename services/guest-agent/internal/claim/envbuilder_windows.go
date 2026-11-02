package claim

import (
	"fmt"

	"golang.org/x/sys/windows"

	agentv1 "github.com/belov38/umiak/libs/proto/umiak/agent/v1"

	"github.com/belov38/umiak/services/guest-agent/internal/process"
	"github.com/belov38/umiak/services/guest-agent/internal/winapi"
	"github.com/belov38/umiak/services/guest-agent/internal/wincmd"
)

// Build returns the environment of a command run as u (spec 12.7). Later
// layers win, keys compare case-insensitively and keep their first
// spelling: the environment block of the user's token (system and user
// variables from the registry: Path, USERPROFILE, APPDATA, TEMP, ...), the
// platform env (with UMIAK_HOSTNAME, UMIAK_ENV_APPLIED=1 and TERM for a PTY),
// claim env, secret env, spec env.
func (b EnvBuilder) Build(u *process.User, spec *agentv1.CommandSpec) []string {
	base, err := userEnvBlock(u)
	if err != nil {
		b.m.log.Warn("claim: user environment block failed, using the system one", "user", u.Name, "err", err)
		base = b.systemEnvBlock(u)
	}
	platform, claimed, secret := b.claimEnv()
	platform["UMIAK_ENV_APPLIED"] = "1"
	if spec.GetPty() != nil {
		// ConPTY speaks xterm-256color whatever the spec's term is.
		platform["TERM"] = DefaultTerm
	}
	return wincmd.MergeEnv(base, sortedEnv(platform), sortedEnv(claimed), sortedEnv(secret), sortedEnv(spec.GetEnv()))
}

// userEnvBlock returns CreateEnvironmentBlock(token, FALSE) of u: the
// service's own token for SYSTEM, otherwise a logon of the account with the
// password from LSA and its profile loaded, so HKCU\Environment applies.
// Tests replace it.
var userEnvBlock = func(u *process.User) ([]string, error) {
	if u.Windows != nil && u.Windows.System {
		var t windows.Token
		if err := windows.OpenProcessToken(windows.CurrentProcess(),
			windows.TOKEN_QUERY|windows.TOKEN_DUPLICATE|windows.TOKEN_IMPERSONATE, &t); err != nil {
			return nil, fmt.Errorf("open process token: %w", err)
		}
		defer t.Close() //nolint:errcheck // read-only use
		return t.Environ(false)
	}
	account := u.Name
	if u.Windows != nil {
		account = u.Windows.Account
	}
	pw, err := winapi.LsaRetrieve(winapi.SecretUserPassword)
	if err != nil {
		return nil, err
	}
	t, err := winapi.LogonUserToken(account, pw)
	clear(pw)
	if err != nil {
		return nil, err
	}
	defer t.Close() //nolint:errcheck // nothing to do on failure
	unload, err := winapi.LoadProfile(t, account)
	if err != nil {
		return nil, err
	}
	defer unload()
	return t.Environ(false)
}

// systemEnvBlock is the fallback base env: the system variables
// (CreateEnvironmentBlock without a token) and the profile and name of u.
// Without even the system block the command gets only the claim layers and
// the profile and name.
func (b EnvBuilder) systemEnvBlock(u *process.User) []string {
	env, err := windows.Token(0).Environ(false)
	if err != nil {
		b.m.log.Error("claim: system environment block failed", "err", err)
	}
	return wincmd.MergeEnv(env, []string{"USERPROFILE=" + u.Home, "USERNAME=" + u.Name})
}
