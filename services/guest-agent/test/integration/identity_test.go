//go:build integration && linux

package integration

import (
	"bytes"
	"crypto/rand"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"github.com/google/uuid"

	agentv1 "github.com/belov38/boat-dev-clone/libs/proto/sbx/agent/v1"
	"github.com/belov38/boat-dev-clone/libs/tunnel/wire"
	"github.com/belov38/boat-dev-clone/services/guest-agent/internal/events"
)

// writeSmbios writes a new fake smbios identity (spec 7.1) and returns its
// machine id.
func writeSmbios(t *testing.T) string {
	t.Helper()
	id := uuid.Must(uuid.NewV7()).String()
	bs := make([]byte, wire.SecretLen)
	_, _ = rand.Read(bs)
	if err := os.WriteFile(filepath.Join(dmiDir, "product_serial"), []byte(wire.SMBIOSSerial(id, bs)+"\n"), 0o644); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(dmiDir, "product_uuid"), []byte(id+"\n"), 0o644); err != nil {
		t.Fatal(err)
	}
	return id
}

// hostKeys returns the public SSH host keys.
func hostKeys(t *testing.T) []byte {
	t.Helper()
	matches, _ := filepath.Glob("/etc/ssh/ssh_host_*_key.pub")
	if len(matches) == 0 {
		t.Fatal("no ssh host keys")
	}
	var out []byte
	for _, m := range matches {
		out = append(out, readFileT(t, m)...)
	}
	return out
}

// Spec 21 item 12 (container part): a new smbios identity and a restart of
// sbx-identity and sbx-agent give a new machine-id, new SSH host keys, the
// default hostname of the new machine and a fresh journal that starts with
// identity.reset at seq 1. /etc/hostname and /etc/hosts are bind mounts here
// (run.sh), so their rewrite takes the in-place path. The fork itself, the
// untouched source VM and the new IP belong to the pve stand.
func TestIdentityApply(t *testing.T) {
	c := newClient()
	oldMachineID := strings.TrimSpace(string(readFileT(t, "/etc/machine-id")))
	oldKeys := hostKeys(t)
	start(t, c, newID("before-reset"), shellSpec("true", ""))

	id := writeSmbios(t)
	hexID := strings.ReplaceAll(id, "-", "")
	// The boot order of a fork: sbx-identity runs before ssh and the agent.
	sh(t, "systemctl restart sbx-identity.service ssh.service sbx-agent.service")
	info := waitAgent(t)

	if info.GetMachineId() != id {
		t.Errorf("System/Info machine_id = %q, want %q", info.GetMachineId(), id)
	}
	if got := strings.TrimSpace(string(readFileT(t, "/etc/machine-id"))); got != hexID || got == oldMachineID {
		t.Errorf("/etc/machine-id = %q (was %q), want %q", got, oldMachineID, hexID)
	}
	if bytes.Equal(hostKeys(t), oldKeys) {
		t.Error("the SSH host keys did not change")
	}
	wantHost := "sbx-" + hexID[len(hexID)-12:]
	if got := strings.TrimSpace(sh(t, "hostname")); got != wantHost {
		t.Errorf("hostname = %q, want %q", got, wantHost)
	}
	if got := strings.TrimSpace(string(readFileT(t, "/etc/hostname"))); got != wantHost {
		t.Errorf("/etc/hostname = %q, want %q", got, wantHost)
	}
	if !strings.Contains(string(readFileT(t, "/etc/hosts")), "127.0.1.1 "+wantHost) {
		t.Errorf("/etc/hosts has no entry for %s:\n%s", wantHost, readFileT(t, "/etc/hosts"))
	}
	assertBindMounts(t)

	evs := journal(t, 0, 500*time.Millisecond)
	if len(evs) == 0 {
		t.Fatal("empty journal after the identity reset")
	}
	if evs[0].GetSeq() != 1 || evs[0].GetType() != events.TypeIdentityReset {
		t.Fatalf("first event = seq %d %s, want identity.reset at seq 1", evs[0].GetSeq(), evs[0].GetType())
	}
	var reset agentv1.IdentityReset
	if err := evs[0].GetPayload().UnmarshalTo(&reset); err != nil || reset.GetMachineId() != id {
		t.Errorf("identity.reset = %v (%v), want machine %s", &reset, err, id)
	}
	list := sh(t, "ls "+stateDir+"/commands 2>/dev/null || true")
	if strings.TrimSpace(list) != "" {
		t.Errorf("command state survived the reset: %s", list)
	}
	if got := strings.TrimSpace(sh(t, "systemctl is-active ssh.service || true")); got != "active" {
		t.Errorf("ssh.service is %s after the identity reset", got)
	}
	// sshd serves the new host key.
	served := sh(t, "ssh-keyscan -t ed25519 127.0.0.1 2>/dev/null | awk '$1 !~ /^#/ && NF >= 3 {print $3}'")
	if f := strings.Fields(string(readFileT(t, "/etc/ssh/ssh_host_ed25519_key.pub"))); len(f) < 2 || strings.TrimSpace(served) != f[1] {
		t.Errorf("sshd serves host key %q, want the regenerated %v", strings.TrimSpace(served), f)
	}
}

// assertBindMounts checks that /etc/hostname and /etc/hosts are still the
// bind mounts run.sh made, so their rewrite took the in-place (EBUSY) path.
// Outside the container (the pve stand VM: run.sh's /run/sbx-it/hostname is
// absent) they are plain files and the check is skipped.
func assertBindMounts(t *testing.T) {
	t.Helper()
	if _, err := os.Stat("/run/sbx-it/hostname"); err != nil {
		t.Log("no run.sh bind mounts (not the container): bind mount check skipped")
		return
	}
	for _, f := range []string{"/etc/hostname", "/etc/hosts"} {
		if !strings.Contains(sh(t, "findmnt -no TARGET "+f+" || true"), f) {
			t.Errorf("%s is no longer a bind mount; the in-place path was not exercised", f)
		}
	}
}
