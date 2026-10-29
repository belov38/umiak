//go:build integration && linux

package integration

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"os/exec"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"connectrpc.com/connect"
	"github.com/google/uuid"

	agentv1 "github.com/belov38/boat-dev-clone/libs/proto/sbx/agent/v1"
)

// sandboxID is the sandbox the tests claim the machine for.
const sandboxID = "sbx-it-sandbox"

// portDomain is the port domain of the test claim.
const portDomain = "p.sbx.example.test"

// claim applies req for sandboxID: reason CLAIM on an unclaimed machine,
// RESUME when the machine is already claimed for it (an earlier test).
func claim(t *testing.T, c *agentClient, req *agentv1.ClaimRequest) *agentv1.ClaimResponse {
	t.Helper()
	info := waitAgent(t)
	req.SandboxId = sandboxID
	req.Reason = agentv1.ClaimReason_CLAIM_REASON_CLAIM
	if info.GetSandboxId() == sandboxID {
		req.Reason = agentv1.ClaimReason_CLAIM_REASON_RESUME
	}
	res, err := c.sys.Claim(tctx(t, 30*time.Second), connect.NewRequest(req))
	if err != nil {
		t.Fatalf("Claim (%v): %v", req.GetReason(), err)
	}
	return res.Msg
}

// sshCA is a user CA with one user key signed for principal "user".
type sshCA struct {
	dir, caPub, key, cert string
}

// newSSHCA generates a CA and a user certificate in a temporary directory.
func newSSHCA(t *testing.T, name string) sshCA {
	t.Helper()
	dir := t.TempDir()
	ca := sshCA{dir: dir, key: filepath.Join(dir, "user"), cert: filepath.Join(dir, "user-cert.pub")}
	sh(t, "ssh-keygen -q -t ed25519 -N '' -C "+name+" -f "+dir+"/ca")
	sh(t, "ssh-keygen -q -t ed25519 -N '' -C it-user -f "+ca.key)
	sh(t, "ssh-keygen -q -s "+dir+"/ca -I it-"+name+" -n user -V -5m:+1h "+ca.key+".pub")
	ca.caPub = strings.TrimSpace(string(readFileT(t, dir+"/ca.pub")))
	return ca
}

// ssh runs ssh as user@127.0.0.1 with the certificate of ca. stdin, when
// not empty, is fed to the remote side.
func (ca sshCA) ssh(stdin string, args ...string) (string, error) {
	ctx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
	defer cancel()
	base := []string{
		"-i", ca.key, "-o", "CertificateFile=" + ca.cert,
		"-o", "StrictHostKeyChecking=no", "-o", "UserKnownHostsFile=/dev/null",
		"-o", "BatchMode=yes", "-o", "LogLevel=ERROR", "-o", "IdentitiesOnly=yes",
		"user@127.0.0.1",
	}
	cmd := exec.CommandContext(ctx, "ssh", append(base, args...)...)
	if stdin != "" {
		cmd.Stdin = strings.NewReader(stdin)
	}
	out, err := cmd.CombinedOutput()
	return string(out), err
}

// envLines parses `env` output into a map.
func envLines(out string) map[string]string {
	m := map[string]string{}
	for _, line := range strings.Split(out, "\n") {
		if k, v, ok := strings.Cut(line, "="); ok {
			m[k] = v
		}
	}
	return m
}

// agentEnv runs `env -0` as user through the agent with spec env extra and
// returns the environment.
func agentEnv(t *testing.T, c *agentClient, extra map[string]string) map[string]string {
	t.Helper()
	spec := shellSpec("env -0", "user")
	spec.Env = extra
	r := run(t, c, newID("env"), spec, time.Minute)
	m := map[string]string{}
	for _, kv := range strings.Split(string(r.stdout), "\x00") {
		if k, v, ok := strings.Cut(kv, "="); ok {
			m[k] = v
		}
	}
	return m
}

// sshdPID returns the main pid of ssh.service.
func sshdPID(t *testing.T) string {
	t.Helper()
	return strings.TrimSpace(sh(t, "systemctl show -p MainPID --value ssh.service"))
}

// Spec 21 item 13: claim env reaches agent commands, SSH login shells and
// `ssh host env`; spec env wins over claim env; the Vite variable is set;
// UpdateSshCa takes effect without an sshd restart.
func TestClaimEnvAndSSH(t *testing.T) {
	c := newClient()
	ca := newSSHCA(t, "ca-one")
	secret := "it-secret-" + uuid.NewString()
	claim(t, c, &agentv1.ClaimRequest{
		Hostname:      "it-host",
		PortDomain:    portDomain,
		Env:           map[string]string{"IT_CLAIM": "from-claim", "IT_OVERRIDE": "from-claim"},
		SecretEnv:     map[string]string{"IT_SECRET": secret},
		SecretFiles:   []*agentv1.SecretFile{{Name: "token.txt", Content: []byte(secret + "-file"), Mode: 0o600}},
		SshUserCaKeys: []string{ca.caPub},
	})

	t.Run("agent command", func(t *testing.T) {
		env := agentEnv(t, c, map[string]string{"IT_OVERRIDE": "from-spec"})
		want := map[string]string{
			"IT_CLAIM": "from-claim", "IT_OVERRIDE": "from-spec", "IT_SECRET": secret,
			"SBX": "1", "SBX_SANDBOX_ID": sandboxID, "SBX_PORT_DOMAIN": portDomain,
			"__VITE_ADDITIONAL_SERVER_ALLOWED_HOSTS": "." + portDomain,
		}
		for k, v := range want {
			if env[k] != v {
				t.Errorf("%s = %q, want %q", k, env[k], v)
			}
		}
		if got := string(readFileT(t, "/run/sbx/secrets/files/token.txt")); got != secret+"-file" {
			t.Errorf("secret file = %q", got)
		}
	})

	t.Run("ssh host env", func(t *testing.T) {
		out, err := ca.ssh("", "env")
		if err != nil {
			t.Fatalf("ssh env: %v\n%s", err, out)
		}
		env := envLines(out)
		for k, v := range map[string]string{
			"IT_CLAIM": "from-claim", "IT_OVERRIDE": "from-claim", "IT_SECRET": secret,
			"SBX_SANDBOX_ID": sandboxID, "__VITE_ADDITIONAL_SERVER_ALLOWED_HOSTS": "." + portDomain,
		} {
			if env[k] != v {
				t.Errorf("ssh env %s = %q, want %q", k, env[k], v)
			}
		}
	})

	t.Run("ssh login shell", func(t *testing.T) {
		out, err := ca.ssh("echo SHELL0=$0\nenv\nexit\n", "-T")
		if err != nil {
			t.Fatalf("ssh login shell: %v\n%s", err, out)
		}
		env := envLines(out)
		if !strings.HasPrefix(env["SHELL0"], "-") {
			t.Errorf("$0 = %q, want a login shell", env["SHELL0"])
		}
		if env["IT_CLAIM"] != "from-claim" || env["IT_SECRET"] != secret || env["__VITE_ADDITIONAL_SERVER_ALLOWED_HOSTS"] != "."+portDomain {
			t.Errorf("login shell env = %v", env)
		}
	})

	t.Run("UpdateSshCa without an sshd restart", func(t *testing.T) {
		pid := sshdPID(t)
		ca2 := newSSHCA(t, "ca-two")
		if _, err := c.sys.UpdateSshCa(tctx(t, 30*time.Second), connect.NewRequest(&agentv1.UpdateSshCaRequest{Keys: []string{ca2.caPub}})); err != nil {
			t.Fatalf("UpdateSshCa: %v", err)
		}
		if out, err := ca2.ssh("", "echo", "via-ca-two"); err != nil || !strings.Contains(out, "via-ca-two") {
			t.Errorf("ssh with the new CA: %v\n%s", err, out)
		}
		if out, err := ca.ssh("", "true"); err == nil {
			t.Errorf("ssh with the replaced CA still works:\n%s", out)
		}
		if got := sshdPID(t); got != pid {
			t.Errorf("sshd pid %s -> %s: restarted", pid, got)
		}
		// Back to the first CA for the other tests.
		if _, err := c.sys.UpdateSshCa(tctx(t, 30*time.Second), connect.NewRequest(&agentv1.UpdateSshCaRequest{Keys: []string{ca.caPub}})); err != nil {
			t.Fatalf("UpdateSshCa: %v", err)
		}
	})
}

// TestPamEnvFormat checks the escaping of /etc/sbx/env against the real
// pam_env through sshd (spec 8.2): values with spaces, quotes, backslashes
// (also trailing) and `$` arrive unchanged; values with `#` or a newline are
// left out of the PAM files and reach only the agent's commands.
func TestPamEnvFormat(t *testing.T) {
	c := newClient()
	ca := newSSHCA(t, "ca-pam")
	claim(t, c, &agentv1.ClaimRequest{Hostname: "it-host", PortDomain: portDomain, SshUserCaKeys: []string{ca.caPub}})
	plain := map[string]string{
		"IT_SPACES":   "a b  c ",
		"IT_DQUOTE":   `say "hi" twice""`,
		"IT_SQUOTE":   `it's 'quoted'`,
		"IT_BSLASH":   `back\slash \n not a newline`,
		"IT_TRAIL":    `trail\`,
		"IT_DOLLAR":   `$HOME and ${USER} $(id)`,
		"IT_LEADQ":    `"starts with a quote`,
		"IT_EQUALS":   `a=b=c`,
		"IT_UNICODE":  "héllo wörld",
		"IT_EMPTYISH": " ",
	}
	agentOnly := map[string]string{
		"IT_HASH":    "has # hash",
		"IT_NEWLINE": "multi\nline",
	}
	env := map[string]string{}
	for k, v := range plain {
		env[k] = v
	}
	for k, v := range agentOnly {
		env[k] = v
	}
	if _, err := c.sys.UpdateEnv(tctx(t, 30*time.Second), connect.NewRequest(&agentv1.UpdateEnvRequest{Env: env})); err != nil {
		t.Fatalf("UpdateEnv: %v", err)
	}
	t.Logf("/etc/sbx/env:\n%s", readFileT(t, "/etc/sbx/env"))

	out, err := ca.ssh("", "env", "-0")
	if err != nil {
		t.Fatalf("ssh env: %v\n%s", err, out)
	}
	sshEnv := map[string]string{}
	for _, kv := range strings.Split(out, "\x00") {
		if k, v, ok := strings.Cut(strings.TrimLeft(kv, "\n"), "="); ok {
			sshEnv[k] = v
		}
	}
	for k, v := range plain {
		if got, ok := sshEnv[k]; !ok || got != v {
			t.Errorf("ssh %s = %q (present %v), want %q", k, got, ok, v)
		}
	}
	for k := range agentOnly {
		if got, ok := sshEnv[k]; ok {
			t.Errorf("ssh %s = %q, want it absent", k, got)
		}
	}
	cmdEnv := agentEnv(t, c, nil)
	for k, v := range env {
		if cmdEnv[k] != v {
			t.Errorf("agent command %s = %q, want %q", k, cmdEnv[k], v)
		}
	}
}

// Spec 21 item 14 (container part): a unique secret from secret_env,
// secret_files and a command's env is nowhere under /var/lib/sbx-agent or
// /etc after sync; /run/sbx is a tmpfs mounted noswap when the kernel has
// it. The block-device grep of an LV snapshot belongs to the pve stand.
func TestSecretsNotOnDisk(t *testing.T) {
	c := newClient()
	ca := newSSHCA(t, "ca-secrets")
	s1, s2, s3 := "it-sec-env-"+uuid.NewString(), "it-sec-file-"+uuid.NewString(), "it-sec-cmd-"+uuid.NewString()
	claim(t, c, &agentv1.ClaimRequest{
		Hostname:      "it-host",
		PortDomain:    portDomain,
		SecretEnv:     map[string]string{"IT_SECRET": s1},
		SecretFiles:   []*agentv1.SecretFile{{Name: "token.txt", Content: []byte(s2), Mode: 0o600}},
		SshUserCaKeys: []string{ca.caPub},
	})
	// The commands compare hashes: a secret in a script or in the output
	// would be stored by design.
	spec := shellSpec(`printf %s "$IT_CMD_SECRET" | sha256sum; printf %s "$IT_SECRET" | sha256sum`, "user")
	spec.Env = map[string]string{"IT_CMD_SECRET": s3}
	r := run(t, c, newID("secret"), spec, time.Minute)
	if want := sha256hex(s3) + "  -\n" + sha256hex(s1) + "  -\n"; string(r.stdout) != want {
		t.Fatalf("secrets in the command env: %q, want hashes %q", r.stdout, want)
	}
	if got := sha256hex(string(readFileT(t, "/run/sbx/secrets/files/token.txt"))); got != sha256hex(s2) {
		t.Fatal("secret file content differs")
	}
	sh(t, "sync")
	for _, s := range []string{s1, s2, s3} {
		out, err := shErr("grep -r -a -l -F '" + s + "' " + stateDir + " /etc")
		if err == nil || strings.TrimSpace(out) != "" {
			t.Errorf("secret %s found on disk in:\n%s", s[:12], out)
		}
	}

	opts := strings.TrimSpace(sh(t, "findmnt -no FSTYPE,OPTIONS /run/sbx"))
	t.Logf("/run/sbx: %s", opts)
	if !strings.HasPrefix(opts, "tmpfs ") {
		t.Fatalf("/run/sbx is not a tmpfs: %s", opts)
	}
	if kernelHasNoswap(t) && !strings.Contains(opts, "noswap") {
		t.Errorf("/run/sbx options %q lack noswap on a kernel that supports it", opts)
	}
}

// sha256hex returns the hex SHA-256 of s.
func sha256hex(s string) string {
	sum := sha256.Sum256([]byte(s))
	return hex.EncodeToString(sum[:])
}

// kernelHasNoswap reports whether tmpfs accepts the noswap option (Linux 6.4+).
func kernelHasNoswap(t *testing.T) bool {
	t.Helper()
	dir := t.TempDir()
	if _, err := shErr("mount -t tmpfs -o noswap,size=1M tmpfs " + dir); err != nil {
		return false
	}
	_ = exec.CommandContext(t.Context(), "umount", dir).Run()
	return true
}
