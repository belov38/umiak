package ident

import (
	"context"
	"errors"
	"path/filepath"
	"testing"
)

func TestSealWindows(t *testing.T) {
	l := winLayout(t)
	mustWrite(t, l.IdentityFile, "{}")
	mustWrite(t, l.StateDB, "db")
	mustWrite(t, l.StatusFile, "{}")
	mustWrite(t, filepath.Join(l.SecretFilesDir, "token"), "secret")
	mustWrite(t, l.SecretsStateFile, "{}")
	mustWrite(t, filepath.Join(l.SSHDir, "ssh_host_ed25519_key"), "k")
	mustWrite(t, filepath.Join(l.SSHDir, "ssh_host_ed25519_key.pub"), "k")
	mustWrite(t, filepath.Join(l.SSHDir, "sshd_config"), "cfg")
	mustWrite(t, l.TemplateSSHCA, "template-ca\n")
	mustWrite(t, l.SSHUserCA, "claimed-ca\n")
	mustWrite(t, filepath.Join(l.VersionsDir, "1.0.0", "sbx-agent.exe"), "bin")

	var order []string
	stop := func() error { order = append(order, "stop"); return nil }
	wipe := func() error { order = append(order, "wipe"); return nil }
	if err := SealWindows(context.Background(), l, stop, wipe); err != nil {
		t.Fatal(err)
	}
	if len(order) != 2 || order[0] != "stop" || order[1] != "wipe" {
		t.Errorf("order = %v, want stop then wipe", order)
	}
	mustNotExist(t, l.StateDir)
	mustNotExist(t, l.RunDir)
	mustNotExist(t, l.SecretsDir)
	mustNotExist(t, l.SecretsStateFile)
	mustNotExist(t, filepath.Join(l.SSHDir, "ssh_host_ed25519_key"))
	mustNotExist(t, filepath.Join(l.SSHDir, "ssh_host_ed25519_key.pub"))
	mustRead(t, filepath.Join(l.SSHDir, "sshd_config"))
	mustRead(t, filepath.Join(l.VersionsDir, "1.0.0", "sbx-agent.exe"))
	if got := mustRead(t, l.SSHUserCA); got != "template-ca\n" {
		t.Errorf("sbx_user_ca.pub = %q", got)
	}
}

func TestSealWindowsStopFailureKeepsState(t *testing.T) {
	l := winLayout(t)
	mustWrite(t, l.IdentityFile, "{}")
	err := SealWindows(context.Background(), l, func() error { return errors.New("busy") }, nil)
	if err == nil {
		t.Fatal("seal succeeded although the services did not stop")
	}
	mustRead(t, l.IdentityFile)
}
