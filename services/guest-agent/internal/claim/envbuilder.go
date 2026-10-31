package claim

import (
	"maps"
	"slices"

	"github.com/belov38/boat-dev-clone/services/guest-agent/internal/process"
	"github.com/belov38/boat-dev-clone/services/guest-agent/internal/wincmd"
)

// Defaults of the base environment.
const (
	// DefaultPath is the Ubuntu default PATH.
	DefaultPath = "/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin"
	// DefaultTerm is TERM of a PTY command whose spec names no terminal.
	DefaultTerm = "xterm-256color"
)

// EnvBuilder builds command environments from the claim state (spec 8.2;
// on Windows S9 spec 12.7). It implements process.EnvBuilder.
type EnvBuilder struct {
	m *Manager
}

var _ process.EnvBuilder = EnvBuilder{}

// EnvBuilder returns the command environment builder of m.
func (m *Manager) EnvBuilder() EnvBuilder {
	return EnvBuilder{m: m}
}

// claimEnv returns the platform env (with the extensions), the claim env
// and the secret env: the layers between the base env and the spec env.
func (b EnvBuilder) claimEnv() (platform, claimed, secret map[string]string) {
	m := b.m
	m.mu.RLock()
	req, secret := m.req, m.secretEnv
	m.mu.RUnlock()
	return m.platformEnv(req), req.GetEnv(), secret
}

// SessionEnv returns the env an SSH session takes from the agent (S9 spec
// 12.7, layers 2-4): the platform env with SBX_ENV_APPLIED=1, the claim env
// and the secret env, later layers winning, as KEY=VALUE entries. Keys
// compare case-insensitively, as on Windows, the only OS that serves it.
func (b EnvBuilder) SessionEnv() []string {
	platform, claimed, secret := b.claimEnv()
	platform["SBX_ENV_APPLIED"] = "1"
	return wincmd.MergeEnv(sortedEnv(platform), sortedEnv(claimed), sortedEnv(secret))
}

// sortedEnv returns m as KEY=VALUE entries sorted by key, so keys that
// differ only in case merge in a stable order.
func sortedEnv(m map[string]string) []string {
	out := make([]string, 0, len(m))
	for _, k := range slices.Sorted(maps.Keys(m)) {
		out = append(out, k+"="+m[k])
	}
	return out
}
