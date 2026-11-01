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
	_ = os.WriteFile(filepath.Join(bin, "turnserver"), []byte("#!/bin/sh\ncp \"$2\" \"$SBX_TURN_CAPTURE\"\n"), 0700)
	// Root-only steps of the entrypoint, recorded instead of run.
	_ = os.WriteFile(filepath.Join(bin, "nft"), []byte("#!/bin/sh\ncat >\"$SBX_TURN_CAPTURE.nft\"\n"), 0700)
	_ = os.WriteFile(filepath.Join(bin, "chown"), []byte("#!/bin/sh\nexit 0\n"), 0700)
	_ = os.WriteFile(filepath.Join(bin, "install"), []byte("#!/bin/sh\nfor a; do last=$a; done\ncase \"$1\" in -d) mkdir -p \"$last\";; *) eval src=\\${$(($#-1))}; cp \"$src\" \"$last\";; esac\n"), 0700)
	_ = os.WriteFile(filepath.Join(bin, "setpriv"), []byte("#!/bin/sh\necho \"$@\" >\"$SBX_TURN_CAPTURE.setpriv\"\nwhile [ \"$1\" != turnserver ]; do shift; done\nexec \"$@\"\n"), 0700)
	for _, name := range []string{"tls.crt", "tls.key"} {
		_ = os.WriteFile(filepath.Join(secrets, "turn", name), []byte("fixture"), 0600)
	}
	for _, ip := range []string{"203.0.113.9", "999.0.0.1"} {
		cmd := exec.CommandContext(t.Context(), "sh", filepath.Join(root, "deploy/compose/turn/entrypoint.sh"))
		cmd.Env = append(os.Environ(), "PATH="+bin+string(os.PathListSeparator)+os.Getenv("PATH"), "SBX_TURN_SECRETS_DIR="+filepath.Join(secrets, "turn"), "SBX_TURN_RUN_DIR="+dir, "SBX_TURN_IP="+ip, "SBX_TURN_REALM=turn.example", "SBX_TURN_CAPTURE="+filepath.Join(dir, "config"), "SBX_TURN_TLS_PORT=23844", "SBX_TURN_RELAY_MIN=55000", "SBX_TURN_RELAY_MAX=55040")
		out, e := cmd.CombinedOutput()
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
		for _, required := range []string{"use-auth-secret\n", "stale-nonce=0\n", "static-auth-secret=" + string(secret) + "\n", "allowed-peer-ip=203.0.113.9\n", "denied-peer-ip=0.0.0.0-255.255.255.255\n", "user-quota=16\n", "max-allocate-lifetime=60\n", "no-tcp-relay\n", "no-software-attribute\n", "tls-listening-port=23844\n", "min-port=55000\n", "max-port=55040\n", "pidfile=" + filepath.Join(dir, "state/turnserver.pid") + "\n"} {
			if !strings.Contains(config, required) {
				t.Fatalf("missing TURN restriction %q", required)
			}
		}
		rules, _ := os.ReadFile(filepath.Join(dir, "config.nft"))
		for _, required := range []string{
			"delete table inet sbx_turn\n",
			"meta skuid 3478 ip saddr 203.0.113.9 udp sport 55000-55040 ip daddr 203.0.113.9 udp dport 55000-55040 accept\n",
			"meta skuid 3478 ip saddr 203.0.113.9 udp sport 55000-55040 counter drop",
		} {
			if !strings.Contains(string(rules), required) {
				t.Fatalf("relay egress rule missing %q in %s", required, rules)
			}
		}
		drop, _ := os.ReadFile(filepath.Join(dir, "config.setpriv"))
		if !strings.Contains(string(drop), "--reuid=3478 --regid=3478 --clear-groups") || !strings.Contains(string(drop), "--bounding-set=-all,+net_bind_service turnserver") {
			t.Fatalf("turnserver keeps root: %s", drop)
		}
		if bytes.Contains(out, secret) {
			t.Fatal("TURN secret printed")
		}
	}
}
