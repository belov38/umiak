package claim

import (
	"log/slog"
	"maps"
	"regexp"
	"slices"
	"strings"

	"connectrpc.com/connect"

	agentv1 "github.com/belov38/boat-dev-clone/libs/proto/sbx/agent/v1"

	"github.com/belov38/boat-dev-clone/services/guest-agent/internal/errs"
	"github.com/belov38/boat-dev-clone/services/guest-agent/internal/ident"
)

// envFileKey is a key pam_env accepts.
var envFileKey = regexp.MustCompile(`^[A-Za-z_][A-Za-z0-9_]*$`)

// maxEnvFileLine is the longest line FormatEnvFile writes, newline
// included: pam_env reads a line into an 8 KiB buffer that also holds the
// terminating NUL.
const maxEnvFileLine = 8<<10 - 1

// FormatEnvFile renders env for pam_env (readenv=1, spec 8.2): one
// KEY="VALUE" line per entry sorted by key, the value written raw. pam_env
// does not unescape: it removes the opening quote and a final quote, keeps
// backslashes and inner quotes, and ends the value at the first '#'. So
// entries are skipped when the key is not a shell identifier, the value
// contains '#', a newline, a carriage return or NUL, or the line exceeds
// the pam_env buffer. Commands of the agent still see skipped entries, SSH
// sessions do not.
func FormatEnvFile(env map[string]string) []byte {
	var sb strings.Builder
	for _, k := range slices.Sorted(maps.Keys(env)) {
		v := env[k]
		if !envFileKey.MatchString(k) || strings.ContainsAny(v, "#\n\r\x00") {
			continue
		}
		line := k + `="` + v + "\"\n"
		if len(line) > maxEnvFileLine {
			slog.Warn("env entry too long for the PAM env file, skipped", "key", k)
			continue
		}
		sb.WriteString(line)
	}
	return []byte(sb.String())
}

// platformEnv returns the platform defaults of the claim req (spec 8.2,
// step 2; on Windows with SBX_HOSTNAME, S9 spec 12.7) plus the extensions'
// env. Keys without a value are left out before the claim.
func (m *Manager) platformEnv(req *agentv1.ClaimRequest) map[string]string {
	env := map[string]string{"SBX": "1"}
	if id := req.GetSandboxId(); id != "" {
		env["SBX_SANDBOX_ID"] = id
	}
	if pd := req.GetPortDomain(); pd != "" {
		env["SBX_PORT_DOMAIN"] = pd
		env["__VITE_ADDITIONAL_SERVER_ALLOWED_HOSTS"] = "." + pd
	}
	if h := req.GetHostname(); h != "" && !appliesHostname {
		// The system keeps its own name; the claimed one is only env.
		env["SBX_HOSTNAME"] = h
	}
	for _, e := range m.opts.Extensions {
		maps.Copy(env, e.PlatformEnv())
	}
	return env
}

// writeSbxEnv writes /etc/sbx/env: platform env of req, then env. Windows
// has no such file (the layout leaves it empty); SSH sessions get the env
// from the agent.
func (m *Manager) writeSbxEnv(req *agentv1.ClaimRequest, env map[string]string) error {
	if m.l.SbxEnvFile == "" {
		return nil
	}
	all := m.platformEnv(req)
	maps.Copy(all, env)
	if err := m.writeFile(m.l.SbxEnvFile, FormatEnvFile(all), 0o644); err != nil {
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
