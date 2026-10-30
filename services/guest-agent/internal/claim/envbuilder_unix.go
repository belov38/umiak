//go:build !windows

package claim

import (
	"maps"
	"slices"
	"strconv"

	agentv1 "github.com/belov38/boat-dev-clone/libs/proto/sbx/agent/v1"

	"github.com/belov38/boat-dev-clone/services/guest-agent/internal/process"
)

// Build returns the sorted KEY=VALUE environment of a command run as u.
// Later layers win: base (HOME, USER, LOGNAME, SHELL, PATH, LANG,
// XDG_RUNTIME_DIR, TERM for a PTY), platform env with the extensions, claim
// env, secret env, spec env.
func (b EnvBuilder) Build(u *process.User, spec *agentv1.CommandSpec) []string {
	env := map[string]string{
		"HOME":            u.Home,
		"USER":            u.Name,
		"LOGNAME":         u.Name,
		"SHELL":           u.Shell,
		"PATH":            DefaultPath,
		"LANG":            "C.UTF-8",
		"XDG_RUNTIME_DIR": "/run/user/" + strconv.FormatUint(uint64(u.UID), 10),
	}
	if pty := spec.GetPty(); pty != nil {
		term := pty.GetTerm()
		if term == "" {
			term = DefaultTerm
		}
		env["TERM"] = term
	}

	platform, claimed, secret, _ := b.claimEnv()
	maps.Copy(env, platform)
	maps.Copy(env, claimed)
	maps.Copy(env, secret)
	maps.Copy(env, spec.GetEnv())

	out := make([]string, 0, len(env))
	for _, k := range slices.Sorted(maps.Keys(env)) {
		out = append(out, k+"="+env[k])
	}
	return out
}
