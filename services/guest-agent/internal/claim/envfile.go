package claim

import (
	"maps"
	"regexp"
	"slices"
	"strings"

	"connectrpc.com/connect"

	agentv1 "github.com/belov38/boat-dev-clone/libs/proto/sbx/agent/v1"

	"github.com/belov38/boat-dev-clone/services/guest-agent/internal/errs"
	"github.com/belov38/boat-dev-clone/services/guest-agent/internal/fsutil"
	"github.com/belov38/boat-dev-clone/services/guest-agent/internal/ident"
)

// envFileKey is a key pam_env accepts.
var envFileKey = regexp.MustCompile(`^[A-Za-z_][A-Za-z0-9_]*$`)

// FormatEnvFile renders env for pam_env (readenv=1, spec 8.2): one
// KEY="VALUE" line per entry sorted by key, with `\` and `"` escaped by a
// backslash. Keys that are not shell identifiers and values containing a
// newline, a carriage return or NUL are skipped: commands of the agent still
// see them, SSH sessions do not.
func FormatEnvFile(env map[string]string) []byte {
	var sb strings.Builder
	for _, k := range slices.Sorted(maps.Keys(env)) {
		v := env[k]
		if !envFileKey.MatchString(k) || strings.ContainsAny(v, "\n\r\x00") {
			continue
		}
		sb.WriteString(k)
		sb.WriteString(`="`)
		for i := 0; i < len(v); i++ {
			if v[i] == '\\' || v[i] == '"' {
				sb.WriteByte('\\')
			}
			sb.WriteByte(v[i])
		}
		sb.WriteString("\"\n")
	}
	return []byte(sb.String())
}

// platformEnv returns the platform defaults (spec 8.2, step 2) plus the
// extensions' env. Keys without a value are left out before the claim.
func (m *Manager) platformEnv(sandboxID, portDomain string) map[string]string {
	env := map[string]string{"SBX": "1"}
	if sandboxID != "" {
		env["SBX_SANDBOX_ID"] = sandboxID
	}
	if portDomain != "" {
		env["SBX_PORT_DOMAIN"] = portDomain
		env["__VITE_ADDITIONAL_SERVER_ALLOWED_HOSTS"] = "." + portDomain
	}
	for _, e := range m.opts.Extensions {
		maps.Copy(env, e.PlatformEnv())
	}
	return env
}

// writeSbxEnv writes /etc/sbx/env: platform env, then the claim env.
func (m *Manager) writeSbxEnv(sandboxID, portDomain string, env map[string]string) error {
	all := m.platformEnv(sandboxID, portDomain)
	maps.Copy(all, env)
	if err := fsutil.WriteFileAtomic(m.l.SbxEnvFile, FormatEnvFile(all), 0o644); err != nil {
		return internal("write sbx env", err)
	}
	return nil
}

// validateClaim checks a claim request before anything is applied.
func validateClaim(req *agentv1.ClaimRequest) error {
	if req.GetSandboxId() == "" {
		return invalid("sandbox_id is required")
	}
	if !ident.ValidHostname(req.GetHostname()) {
		return invalid("hostname must be an RFC 1123 label of at most 63 characters")
	}
	if err := validateEnv("env", req.GetEnv()); err != nil {
		return err
	}
	if err := validateSecrets(req.GetSecretEnv(), req.GetSecretFiles()); err != nil {
		return err
	}
	return validateCAKeys(req.GetSshUserCaKeys())
}

// validateEnv refuses entries that cannot form a KEY=VALUE environment
// entry. The public API enforces stricter limits.
func validateEnv(field string, env map[string]string) error {
	for k, v := range env {
		if k == "" || strings.ContainsAny(k, "=\x00") {
			return invalid(field + ": invalid key")
		}
		if strings.ContainsRune(v, 0) {
			return invalid(field + ": value of " + k + " contains NUL")
		}
	}
	return nil
}

// validateCAKeys refuses keys that would break the one-key-per-line file.
func validateCAKeys(keys []string) error {
	for _, k := range keys {
		if strings.ContainsAny(k, "\n\r\x00") {
			return invalid("ssh_user_ca_keys: a key spans several lines")
		}
		if strings.TrimSpace(k) == "" {
			return invalid("ssh_user_ca_keys: empty key")
		}
	}
	return nil
}

func invalid(msg string) error {
	return errs.New(connect.CodeInvalidArgument, errs.InvalidArgument, msg)
}
