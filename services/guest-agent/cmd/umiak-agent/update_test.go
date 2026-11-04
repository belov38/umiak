package main

import (
	"bytes"
	"context"
	"crypto/ed25519"
	"crypto/rand"
	"io"
	"os"
	"path/filepath"
	"runtime"
	"slices"
	"strings"
	"testing"
	"testing/fstest"
	"time"

	"github.com/belov38/umiak/services/guest-agent/internal/paths"
	"github.com/belov38/umiak/services/guest-agent/internal/update"
)

// cliPack builds a package of version signed by priv that pins pinned.
func cliPack(t *testing.T, version string, priv ed25519.PrivateKey, pinned ed25519.PublicKey) string {
	t.Helper()
	dir := t.TempDir()
	files := map[string]string{
		"bin":  "#!/bin/sh\n",
		"ca":   "ca",
		"keys": update.FormatKey(pinned, "test") + "\n",
	}
	for name, data := range files {
		if err := os.WriteFile(filepath.Join(dir, name), []byte(data), 0o644); err != nil {
			t.Fatal(err)
		}
	}
	out := filepath.Join(dir, "pkg.tar")
	if _, err := update.Pack(update.PackOptions{
		Version: version, OS: runtime.GOOS, Arch: runtime.GOARCH,
		Binary: filepath.Join(dir, "bin"), TunnelCA: filepath.Join(dir, "ca"), UpdateKeys: filepath.Join(dir, "keys"),
		Key: priv, Out: out,
	}); err != nil {
		t.Fatal(err)
	}
	return out
}

func genKey(t *testing.T) (ed25519.PublicKey, ed25519.PrivateKey) {
	t.Helper()
	pub, priv, err := ed25519.GenerateKey(rand.Reader)
	if err != nil {
		t.Fatal(err)
	}
	return pub, priv
}

type cliSystemctl struct{ calls [][]string }

func (c *cliSystemctl) run(args ...string) error {
	c.calls = append(c.calls, slices.Clone(args))
	return nil
}

func updateDeps(t *testing.T, embedded ed25519.PublicKey) (deps, *cliSystemctl) {
	t.Helper()
	sc := &cliSystemctl{}
	return deps{
		layout:         paths.ForRoot(t.TempDir()),
		services:       update.SystemctlManager{Systemctl: sc.run},
		systemctl:      sc.run,
		sleep:          func(time.Duration) {},
		executable:     os.Executable,
		embeddedKeys:   []byte(update.FormatKey(embedded, "embedded") + "\n"),
		units:          fstest.MapFS{"umiak-agent.service": {Data: []byte("[Unit]\n")}},
		configTemplate: []byte("[user]\n"),
	}, sc
}

func TestInstallPackageCLI(t *testing.T) {
	if runtime.GOOS == "windows" {
		t.Skip("installs systemd units; the Windows service install is covered by update.TestInstallCreatesServiceConfig")
	}
	pubA, privA := genKey(t)
	pubB, privB := genKey(t)
	d, sc := updateDeps(t, pubA)
	ctx := context.Background()

	// First install: embedded keys. The package rotates trust to key B.
	var out, errOut bytes.Buffer
	if code := runWith(ctx, d, []string{"install-package", "--write-config", cliPack(t, "v1", privA, pubB)}, &out, &errOut); code != 0 {
		t.Fatalf("exit = %d: %s", code, errOut.String())
	}
	if !strings.Contains(out.String(), "installed v1") || !strings.Contains(out.String(), "embedded keys") {
		t.Errorf("stdout = %q", out.String())
	}
	if v, _ := update.LinkVersion(d.layout.CurrentLink); v != "v1" {
		t.Errorf("current = %q", v)
	}
	if _, err := os.Stat(filepath.Join(d.layout.SystemdUnitDir, "umiak-agent.service")); err != nil {
		t.Error(err)
	}
	if _, err := os.Stat(d.layout.ConfigFile); err != nil {
		t.Error(err)
	}
	if len(sc.calls) != 2 {
		t.Errorf("systemctl = %v", sc.calls)
	}

	// An update must be signed by a key of current/trust (B), not the
	// embedded key A.
	errOut.Reset()
	if code := runWith(ctx, d, []string{"install-package", cliPack(t, "v2", privA, pubB)}, &out, &errOut); code != 1 || !strings.Contains(errOut.String(), "signature") {
		t.Errorf("update signed by the embedded key: exit = %d, stderr = %q", code, errOut.String())
	}
	out.Reset()
	if code := runWith(ctx, d, []string{"install-package", "--no-units", cliPack(t, "v2", privB, pubB)}, &out, &errOut); code != 0 {
		t.Fatalf("update exit = %d: %s", code, errOut.String())
	}
	if cur, _ := update.LinkVersion(d.layout.CurrentLink); cur != "v2" {
		t.Errorf("current = %q", cur)
	}
	if prev, _ := update.LinkVersion(d.layout.PreviousLink); prev != "v1" {
		t.Errorf("previous = %q", prev)
	}
}

// TestInstallPackageTrustKeys: the first install verifies with the keys of
// --trust-keys instead of the embedded ones (a per-install signing key of a
// homelab template build); updates refuse the flag and use current/trust.
func TestInstallPackageTrustKeys(t *testing.T) {
	embedded, embeddedPriv := genKey(t)
	pubI, privI := genKey(t)
	d, _ := updateDeps(t, embedded)
	ctx := context.Background()
	keysFile := filepath.Join(t.TempDir(), "update-keys.pub")
	if err := os.WriteFile(keysFile, []byte(update.FormatKey(pubI, "install")+"\n"), 0o644); err != nil {
		t.Fatal(err)
	}

	// Without the flag the per-install signature matches no embedded key.
	var out, errOut bytes.Buffer
	if code := runWith(ctx, d, []string{"install-package", "--no-units", cliPack(t, "v1", privI, pubI)}, &out, &errOut); code != 1 || !strings.Contains(errOut.String(), "signature") {
		t.Fatalf("without --trust-keys: exit = %d, stderr = %q", code, errOut.String())
	}
	// The file replaces the embedded keys: a package signed by an embedded
	// key is not trusted.
	errOut.Reset()
	if code := runWith(ctx, d, []string{"install-package", "--no-units", "--trust-keys", keysFile, cliPack(t, "v1", embeddedPriv, pubI)}, &out, &errOut); code != 1 || !strings.Contains(errOut.String(), "signature") {
		t.Fatalf("embedded-key package with --trust-keys: exit = %d, stderr = %q", code, errOut.String())
	}
	// A bad keys file is an error.
	bad := filepath.Join(t.TempDir(), "bad.pub")
	if err := os.WriteFile(bad, []byte("# nothing\n"), 0o644); err != nil {
		t.Fatal(err)
	}
	errOut.Reset()
	if code := runWith(ctx, d, []string{"install-package", "--no-units", "--trust-keys", bad, cliPack(t, "v1", privI, pubI)}, &out, &errOut); code != 1 || !strings.Contains(errOut.String(), "--trust-keys") {
		t.Fatalf("empty keys file: exit = %d, stderr = %q", code, errOut.String())
	}

	out.Reset()
	errOut.Reset()
	if code := runWith(ctx, d, []string{"install-package", "--no-units", "--trust-keys", keysFile, cliPack(t, "v1", privI, pubI)}, &out, &errOut); code != 0 {
		t.Fatalf("first install: exit = %d: %s", code, errOut.String())
	}
	if !strings.Contains(out.String(), "installed v1") || !strings.Contains(out.String(), "trust-keys file "+keysFile) {
		t.Errorf("stdout = %q", out.String())
	}

	// With a current version the flag is refused, even with the right keys.
	errOut.Reset()
	if code := runWith(ctx, d, []string{"install-package", "--no-units", "--trust-keys", keysFile, cliPack(t, "v2", privI, pubI)}, &out, &errOut); code != 1 || !strings.Contains(errOut.String(), "first install") {
		t.Errorf("update with --trust-keys: exit = %d, stderr = %q", code, errOut.String())
	}
	// The update verifies with current/trust (the per-install key).
	out.Reset()
	if code := runWith(ctx, d, []string{"install-package", "--no-units", cliPack(t, "v2", privI, pubI)}, &out, &errOut); code != 0 {
		t.Fatalf("update: exit = %d: %s", code, errOut.String())
	}
	if !strings.Contains(out.String(), filepath.Join(d.layout.CurrentLink, filepath.FromSlash(update.UpdateKeysName))) {
		t.Errorf("update stdout = %q", out.String())
	}
	if cur, _ := update.LinkVersion(d.layout.CurrentLink); cur != "v2" {
		t.Errorf("current = %q", cur)
	}
}

func TestRollbackCLI(t *testing.T) {
	pub, priv := genKey(t)
	d, sc := updateDeps(t, pub)
	ctx := context.Background()
	for _, v := range []string{"v1", "v2"} {
		if code := runWith(ctx, d, []string{"install-package", "--no-units", cliPack(t, v, priv, pub)}, io.Discard, io.Discard); code != 0 {
			t.Fatalf("install %s failed", v)
		}
	}
	var errOut bytes.Buffer
	if code := runWith(ctx, d, []string{"rollback", "--to", "v1"}, io.Discard, &errOut); code != 0 {
		t.Fatalf("exit = %d: %s", code, errOut.String())
	}
	if cur, _ := update.LinkVersion(d.layout.CurrentLink); cur != "v1" {
		t.Errorf("current = %q", cur)
	}
	if len(sc.calls) != 2 || sc.calls[0][0] != "reset-failed" {
		t.Errorf("systemctl = %v", sc.calls)
	}
	if code := runWith(ctx, d, []string{"rollback", "--to", "v7"}, io.Discard, &errOut); code != 1 {
		t.Errorf("rollback to a missing version: exit = %d", code)
	}
}

func TestSelftestCLI(t *testing.T) {
	pub, priv := genKey(t)
	d, _ := updateDeps(t, pub)
	ctx := context.Background()
	if code := runWith(ctx, d, []string{"install-package", "--no-units", cliPack(t, "v1", priv, pub)}, io.Discard, io.Discard); code != 0 {
		t.Fatal("install failed")
	}
	// The binary runs through the CLI link, on Windows through the current
	// junction on the system Path.
	exe := d.layout.BinLink
	if exe == "" {
		exe = filepath.Join(d.layout.CurrentLink, update.BinaryName)
	}
	d.executable = func() (string, error) { return exe, nil }
	d.version = "v1"

	var out, errOut bytes.Buffer
	if code := runWith(ctx, d, []string{"selftest", "--schema", "1", "--shim-protos", "1"}, &out, &errOut); code != 0 || strings.TrimSpace(out.String()) != "ok" {
		t.Fatalf("exit = %d, stdout = %q, stderr = %q", code, out.String(), errOut.String())
	}
	errOut.Reset()
	if code := runWith(ctx, d, []string{"selftest", "--schema", "99"}, &out, &errOut); code != 1 || !strings.Contains(errOut.String(), "schema 99") {
		t.Errorf("exit = %d, stderr = %q", code, errOut.String())
	}
	// A binary compiled with another version fails.
	d.version = "dev"
	errOut.Reset()
	if code := runWith(ctx, d, []string{"selftest", "--schema", "1"}, &out, &errOut); code != 1 || !strings.Contains(errOut.String(), `"dev"`) {
		t.Errorf("dev binary: exit = %d, stderr = %q", code, errOut.String())
	}
}

// TestRollbackLogsToFile: with a log directory (Windows) rollback, which the
// service's failure action starts without a console, logs to rollback.log.
func TestRollbackLogsToFile(t *testing.T) {
	pub, priv := genKey(t)
	d, _ := updateDeps(t, pub)
	d.layout.LogDir = filepath.Join(t.TempDir(), "logs")
	ctx := context.Background()
	for _, v := range []string{"v1", "v2"} {
		if code := runWith(ctx, d, []string{"install-package", "--no-units", cliPack(t, v, priv, pub)}, io.Discard, io.Discard); code != 0 {
			t.Fatalf("install %s failed", v)
		}
	}
	if code := runWith(ctx, d, []string{"rollback", "--to", "v1"}, io.Discard, io.Discard); code != 0 {
		t.Fatalf("exit = %d", code)
	}
	if code := runWith(ctx, d, []string{"rollback", "--to", "v7"}, io.Discard, io.Discard); code != 1 {
		t.Fatalf("rollback to a missing version: exit = %d", code)
	}
	b, err := os.ReadFile(filepath.Join(d.layout.LogDir, "rollback.log"))
	if err != nil {
		t.Fatal(err)
	}
	for _, want := range []string{"switched version", "rollback failed"} {
		if !strings.Contains(string(b), want) {
			t.Errorf("rollback.log misses %q:\n%s", want, b)
		}
	}
}

// TestRollbackRecreatesMissingCurrent runs rollback (as the failure action
// does from previous\) with current gone: current is recreated before the
// agent is started again.
func TestRollbackRecreatesMissingCurrent(t *testing.T) {
	pub, priv := genKey(t)
	d, sc := updateDeps(t, pub)
	ctx := context.Background()
	for _, v := range []string{"v1", "v2"} {
		if code := runWith(ctx, d, []string{"install-package", "--no-units", cliPack(t, v, priv, pub)}, io.Discard, io.Discard); code != 0 {
			t.Fatalf("install %s failed", v)
		}
	}
	if err := os.Remove(d.layout.CurrentLink); err != nil {
		t.Fatal(err)
	}
	var errOut bytes.Buffer
	if code := runWith(ctx, d, []string{"rollback"}, io.Discard, &errOut); code != 0 {
		t.Fatalf("exit = %d: %s", code, errOut.String())
	}
	if cur, _ := update.LinkVersion(d.layout.CurrentLink); cur != "v1" {
		t.Errorf("current = %q, want v1 (previous)", cur)
	}
	if len(sc.calls) == 0 || sc.calls[len(sc.calls)-1][0] != "start" {
		t.Errorf("systemctl = %v, want a start", sc.calls)
	}
}
