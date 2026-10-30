package claim

import (
	agentv1 "github.com/belov38/boat-dev-clone/libs/proto/sbx/agent/v1"

	"github.com/belov38/boat-dev-clone/services/guest-agent/internal/process"
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
func (b EnvBuilder) claimEnv() (platform, claimed, secret map[string]string, req *agentv1.ClaimRequest) {
	m := b.m
	m.mu.RLock()
	req, secret = m.req, m.secretEnv
	m.mu.RUnlock()
	return m.platformEnv(req.GetSandboxId(), req.GetPortDomain()), req.GetEnv(), secret, req
}
