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

	"github.com/belov38/boat-dev-clone/services/guest-agent/internal/paths"
	"github.com/belov38/boat-dev-clone/services/guest-agent/internal/update"
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
		units:          fstest.MapFS{"sbx-agent.service": {Data: []byte("[Unit]\n")}},
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
	if _, err := os.Stat(filepath.Join(d.layout.SystemdUnitDir, "sbx-agent.service")); err != nil {
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
	// The binary runs through the CLI link.
	d.executable = func() (string, error) { return d.layout.BinLink, nil }
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
