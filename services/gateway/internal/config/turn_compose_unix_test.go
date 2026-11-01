//go:build !windows

package config

import (
	"bytes"
	"encoding/base64"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"testing"
	"time"
)

func TestDesktopTURNSecretInitAndRestrictedConfig(t *testing.T) {
	root, _ := filepath.Abs("../../../..")
	secrets := filepath.Join(t.TempDir(), "secrets")
	init := exec.CommandContext(t.Context(), "sh", filepath.Join(root, "deploy/compose/secrets-init/init.sh"))
	init.Env = append(os.Environ(), "SBX_SECRETS_ROOT="+secrets)
	if out, e := init.CombinedOutput(); e != nil {
		t.Fatalf("secrets init: %v %s", e, out)
	}
	secret, e := os.ReadFile(filepath.Join(secrets, "turn/auth-secret"))
	if e != nil || len(secret) != 44 {
		t.Fatalf("TURN REST key missing: %v", e)
	}
	decoded, e := base64.StdEncoding.DecodeString(string(secret))
	if e != nil || len(decoded) != 32 {
		t.Fatal("TURN key is not 256 random bits")
	}
	init = exec.CommandContext(t.Context(), "sh", filepath.Join(root, "deploy/compose/secrets-init/init.sh"))
	init.Env = append(os.Environ(), "SBX_SECRETS_ROOT="+secrets)
	if out, e := init.CombinedOutput(); e != nil || bytes.Contains(out, secret) {
		t.Fatalf("secrets repeat leaked/failed: %v", e)
	}
	second, _ := os.ReadFile(filepath.Join(secrets, "turn/auth-secret"))
	if !bytes.Equal(secret, second) {
		t.Fatal("restart rotated TURN key")
	}
	info, _ := os.Stat(filepath.Join(secrets, "turn/auth-secret"))
	if info.Mode().Perm() != 0600 {
		t.Fatal("public TURN key")
	}
	dir := t.TempDir()
	bin := filepath.Join(dir, "bin")
	_ = os.Mkdir(bin, 0700)
	// SBX_TURN_FAKE_HOLD keeps the fake server running, as the real one does.
	_ = os.WriteFile(filepath.Join(bin, "turnserver"), []byte("#!/bin/sh\ncp \"$2\" \"$SBX_TURN_CAPTURE\"\n[ -z \"${SBX_TURN_FAKE_HOLD:-}\" ] || exec sleep 30\n"), 0700)
	// Root-only steps of the entrypoint, recorded instead of run. The fake table lists
	// as the applied rules until the test deletes or edits that file.
	_ = os.WriteFile(filepath.Join(bin, "nft"), []byte("#!/bin/sh\nif [ \"$1\" = -f ]; then cat >\"$SBX_TURN_CAPTURE.nft\"; exit 0; fi\n[ \"$*\" = '-s list table inet sbx_turn' ] && [ -f \"$SBX_TURN_CAPTURE.nft\" ] || exit 1\ncat \"$SBX_TURN_CAPTURE.nft\"\n"), 0700)
	// The namespace: a container interface, or the TURN address itself on the host network.
	_ = os.WriteFile(filepath.Join(bin, "ip"), []byte("#!/bin/sh\ncase \"$*\" in\n'-4 -o addr show dev lo') printf '1: lo    inet 127.0.0.1/8 scope host lo\\n'; [ -f \"$SBX_TURN_CAPTURE.nolo\" ] || sed -n 's|^-4 addr replace \\([0-9.]*/32\\) dev lo$|1: lo    inet \\1 scope global lo|p' \"$SBX_TURN_CAPTURE.ip\" 2>/dev/null;;\n'-4 -o addr show'*) printf '1: lo    inet 127.0.0.1/8 scope host lo\\n2: eth0    inet %s/16 brd 172.30.255.255 scope global eth0\\n' \"${SBX_TURN_FAKE_ETH0:-172.30.0.2}\";;\n*) echo \"$*\" >>\"$SBX_TURN_CAPTURE.ip\";;\nesac\n"), 0700)
	sysctl := filepath.Join(dir, "sysctl")
	_ = os.Mkdir(sysctl, 0700)
	_ = os.WriteFile(filepath.Join(sysctl, "ip_local_port_range"), []byte("32768\t60999\n"), 0600)
	_ = os.WriteFile(filepath.Join(bin, "chown"), []byte("#!/bin/sh\nexit 0\n"), 0700)
	_ = os.WriteFile(filepath.Join(bin, "install"), []byte("#!/bin/sh\nfor a; do last=$a; done\ncase \"$1\" in -d) mkdir -p \"$last\";; *) eval src=\\${$(($#-1))}; cp \"$src\" \"$last\";; esac\n"), 0700)
	_ = os.WriteFile(filepath.Join(bin, "setpriv"), []byte("#!/bin/sh\necho \"$@\" >\"$SBX_TURN_CAPTURE.setpriv\"\nwhile [ \"$1\" != turnserver ]; do shift; done\nexec \"$@\"\n"), 0700)
	for _, name := range []string{"tls.crt", "tls.key"} {
		_ = os.WriteFile(filepath.Join(secrets, "turn", name), []byte("fixture"), 0600)
	}
	entrypoint := func(env ...string) *exec.Cmd {
		cmd := exec.CommandContext(t.Context(), "sh", append([]string{filepath.Join(root, "deploy/compose/turn/entrypoint.sh")}, env[len(env)-1:]...)...)
		cmd.Env = append(os.Environ(), "PATH="+bin+string(os.PathListSeparator)+os.Getenv("PATH"), "SBX_TURN_SECRETS_DIR="+filepath.Join(secrets, "turn"), "SBX_TURN_RUN_DIR="+dir, "SBX_TURN_SYSCTL_DIR="+sysctl, "SBX_TURN_REALM=turn.example", "SBX_TURN_CAPTURE="+filepath.Join(dir, "config"), "SBX_TURN_TLS_PORT=23844", "SBX_TURN_RELAY_MIN=61000", "SBX_TURN_RELAY_MAX=61040", "SBX_TURN_GUARD_INTERVAL=0.2")
		cmd.Env = append(cmd.Env, env[:len(env)-1]...)
		return cmd
	}
	for _, ip := range []string{"203.0.113.9", "999.0.0.1"} {
		out, e := entrypoint("SBX_TURN_IP="+ip, "").CombinedOutput()
		if ip != "203.0.113.9" {
			if e == nil {
				t.Fatal("invalid TURN IP accepted")
			}
			continue
		}
		if e != nil {
			t.Fatalf("entrypoint: %v %s", e, out)
		}
		b, e := os.ReadFile(filepath.Join(dir, "config"))
		if e != nil {
			t.Fatal(e)
		}
		config := string(b)
		for _, required := range []string{"use-auth-secret\n", "stale-nonce=0\n", "static-auth-secret=" + string(secret) + "\n", "allowed-peer-ip=203.0.113.9\n", "denied-peer-ip=0.0.0.0-255.255.255.255\n", "user-quota=16\n", "max-allocate-lifetime=60\n", "no-tcp-relay\n", "no-software-attribute\n", "tls-listening-port=23844\n", "min-port=61000\n", "max-port=61040\n", "listening-ip=172.30.0.2\n", "relay-ip=203.0.113.9\n", "external-ip=203.0.113.9\n", "pidfile=" + filepath.Join(dir, "state/turnserver.pid") + "\n"} {
			if !strings.Contains(config, required) {
				t.Fatalf("missing TURN restriction %q", required)
			}
		}
		rules, _ := os.ReadFile(filepath.Join(dir, "config.nft"))
		for _, required := range []string{
			"delete table inet sbx_turn\n",
			"meta skuid 3478 ip saddr 203.0.113.9 udp sport 61000-61040 ip daddr 203.0.113.9 udp dport 61000-61040 accept\n",
			"meta skuid 3478 ip saddr 203.0.113.9 udp sport 61000-61040 counter drop",
		} {
			if !strings.Contains(string(rules), required) {
				t.Fatalf("relay egress rule missing %q in %s", required, rules)
			}
		}
		drop, _ := os.ReadFile(filepath.Join(dir, "config.setpriv"))
		if !strings.Contains(string(drop), "--reuid=3478 --regid=3478 --clear-groups") || !strings.Contains(string(drop), "--ambient-caps=-all,+net_bind_service turnserver") {
			t.Fatalf("turnserver keeps root: %s", drop)
		}
		if bytes.Contains(out, secret) {
			t.Fatal("TURN secret printed")
		}
		if ipLog, _ := os.ReadFile(filepath.Join(dir, "config.ip")); string(ipLog) != "-4 addr replace 203.0.113.9/32 dev lo\n" {
			t.Fatalf("TURN address not on lo of its namespace: %q", ipLog)
		}
	}

	// Refused before any address, table or server: the host network (the TURN address
	// is already on an interface) and relay ports among the ephemeral ports.
	for _, c := range []struct{ env, want string }{
		{"SBX_TURN_FAKE_ETH0=203.0.113.9", "own network namespace"},
		{"SBX_TURN_RELAY_MAX=61040 SBX_TURN_RELAY_MIN=60990", "overlaps the ephemeral ports"},
	} {
		_ = os.Remove(filepath.Join(dir, "config.nft"))
		out, e := entrypoint(append(strings.Fields(c.env), "SBX_TURN_IP=203.0.113.9", "")...).CombinedOutput()
		if e == nil || !strings.Contains(string(out), c.want) {
			t.Fatalf("%s: want refusal %q, got %v %s", c.env, c.want, e, out)
		}
		if _, e := os.Stat(filepath.Join(dir, "config.nft")); e == nil {
			t.Fatalf("%s: table installed before the refusal", c.env)
		}
	}

	// The watchdog stops the server within the interval once the table is gone or
	// changed or the TURN address left lo; the healthcheck reports the same.
	nolo := filepath.Join(dir, "config.nolo")
	for _, tamper := range []func(string) error{
		os.Remove,
		func(p string) error { return os.WriteFile(p, []byte("table inet sbx_turn {}\n"), 0600) },
		func(string) error { return os.WriteFile(nolo, nil, 0600) },
	} {
		_ = os.Remove(nolo)
		_ = os.Remove(filepath.Join(dir, "config.ip"))
		// A fresh tmpfs in the container: the previous start left 0400 files.
		for _, f := range []string{"tls.crt", "tls.key", "turnserver.conf"} {
			_ = os.Remove(filepath.Join(dir, f))
		}
		cmd := entrypoint("SBX_TURN_IP=203.0.113.9", "SBX_TURN_FAKE_HOLD=1", "")
		var out bytes.Buffer
		cmd.Stdout, cmd.Stderr = &out, &out
		if e := cmd.Start(); e != nil {
			t.Fatal(e)
		}
		health := func() error { return entrypoint("SBX_TURN_IP=203.0.113.9", "health").Run() }
		deadline := time.Now().Add(5 * time.Second)
		for health() != nil {
			if time.Now().After(deadline) {
				t.Fatalf("healthcheck never passed: %s", out.String())
			}
			time.Sleep(50 * time.Millisecond)
		}
		if e := tamper(filepath.Join(dir, "config.nft")); e != nil {
			t.Fatal(e)
		}
		if health() == nil {
			t.Fatal("healthcheck passed without the installed table or address")
		}
		exited := make(chan error, 1)
		go func() { exited <- cmd.Wait() }()
		select {
		case e := <-exited:
			if e == nil || !strings.Contains(out.String(), "relay egress table or TURN address on lo removed or changed") {
				t.Fatalf("watchdog exit: %v %s", e, out.String())
			}
		case <-time.After(5 * time.Second):
			_ = cmd.Process.Kill()
			t.Fatalf("turnserver kept running without its table: %s", out.String())
		}
	}
}
