package update

import (
	"crypto/ed25519"
	"os"
	"path/filepath"
	"runtime"
	"slices"
	"testing"
	"testing/fstest"
	"time"

	"github.com/belov38/boat-dev-clone/services/guest-agent/internal/paths"
)

func TestInstallActivate(t *testing.T) {
	if runtime.GOOS == "windows" {
		t.Skip("systemd units and the CLI link are Linux; see TestInstallCreatesServiceConfig")
	}
	pub, priv := testKey(t)
	keys := []ed25519.PublicKey{pub}
	l := paths.ForRoot(t.TempDir())
	sc := &fakeSystemctl{}
	units := fstest.MapFS{
		"sbx-agent.service":    {Data: []byte("[Unit]\n")},
		"sbx-identity.service": {Data: []byte("[Unit]\n")},
	}
	opts := InstallOptions{
		Activate:     true,
		InstallUnits: true,
		WriteConfig:  true,
		Units:        units,
		Config:       []byte("[user]\n"),
		Services:     SystemctlManager{Systemctl: sc.run},
	}

	m, err := Install(l, packTest(t, "v1", priv), keys, opts)
	if err != nil {
		t.Fatal(err)
	}
	if m.Version != "v1" {
		t.Errorf("version = %q", m.Version)
	}
	if got := linkTarget(t, l.CurrentLink); got != "v1" {
		t.Errorf("current = %q", got)
	}
	if got := linkTarget(t, l.PreviousLink); got != "" {
		t.Errorf("previous = %q, want none", got)
	}
	// The CLI link resolves through current.
	b, err := os.ReadFile(l.BinLink)
	if err != nil || string(b) != "#!/bin/sh\necho v1\n" {
		t.Errorf("bin link reads %q, %v", b, err)
	}
	for name := range units {
		fi, err := os.Stat(filepath.Join(l.SystemdUnitDir, name))
		if err != nil || fi.Mode().Perm() != 0o644 {
			t.Errorf("unit %s: %v %v", name, fi, err)
		}
	}
	want := [][]string{{"daemon-reload"}, {"enable", "sbx-identity.service", "sbx-agent.service"}}
	if !slices.EqualFunc(sc.calls, want, slices.Equal) {
		t.Errorf("systemctl calls = %v, want %v", sc.calls, want)
	}
	if b, err := os.ReadFile(l.ConfigFile); err != nil || string(b) != "[user]\n" {
		t.Errorf("config = %q, %v", b, err)
	}

	// An existing config is kept.
	if err := os.WriteFile(l.ConfigFile, []byte("custom"), 0o644); err != nil {
		t.Fatal(err)
	}
	if _, err := Install(l, packTest(t, "v2", priv), keys, opts); err != nil {
		t.Fatal(err)
	}
	if got, prev := linkTarget(t, l.CurrentLink), linkTarget(t, l.PreviousLink); got != "v2" || prev != "v1" {
		t.Errorf("current, previous = %q, %q; want v2, v1", got, prev)
	}
	if b, _ := os.ReadFile(l.ConfigFile); string(b) != "custom" {
		t.Errorf("config overwritten: %q", b)
	}

	// The same version again is a no-op: previous stays v1.
	before, err := os.Stat(filepath.Join(l.VersionsDir, "v2", BinaryName))
	if err != nil {
		t.Fatal(err)
	}
	if _, err := Install(l, packTest(t, "v2", priv), keys, opts); err != nil {
		t.Fatal(err)
	}
	after, err := os.Stat(filepath.Join(l.VersionsDir, "v2", BinaryName))
	if err != nil {
		t.Fatal(err)
	}
	if !os.SameFile(before, after) {
		t.Error("identical version was replaced")
	}
	if got, prev := linkTarget(t, l.CurrentLink), linkTarget(t, l.PreviousLink); got != "v2" || prev != "v1" {
		t.Errorf("after reinstall current, previous = %q, %q; want v2, v1", got, prev)
	}
	entries, err := os.ReadDir(l.StagingDir)
	if err != nil {
		t.Fatal(err)
	}
	if len(entries) != 0 {
		t.Errorf("staging not cleaned: %v", entries)
	}
}

func TestInstallWithoutActivate(t *testing.T) {
	pub, priv := testKey(t)
	l := paths.ForRoot(t.TempDir())
	if _, err := Install(l, packTest(t, "v1", priv), []ed25519.PublicKey{pub}, InstallOptions{}); err != nil {
		t.Fatal(err)
	}
	if _, err := os.Stat(filepath.Join(l.VersionsDir, "v1", TunnelCAName)); err != nil {
		t.Error(err)
	}
	if got := linkTarget(t, l.CurrentLink); got != "" {
		t.Errorf("current = %q, want none", got)
	}
}

func TestInstallRejects(t *testing.T) {
	pub, priv := testKey(t)
	foreign, _ := testKey(t)
	l := paths.ForRoot(t.TempDir())

	_, err := Install(l, packFor(t, "v1", "plan9", "mips", priv), []ed25519.PublicKey{pub}, InstallOptions{Activate: true})
	if got := detailCode(err); got != "invalid_argument" {
		t.Errorf("foreign platform: detail = %q (%v)", got, err)
	}
	_, err = Install(l, packTest(t, "v1", priv), []ed25519.PublicKey{foreign}, InstallOptions{Activate: true})
	if got := detailCode(err); got != "signature_invalid" {
		t.Errorf("foreign key: detail = %q (%v)", got, err)
	}
	if _, err := os.Stat(filepath.Join(l.VersionsDir, "v1")); !os.IsNotExist(err) {
		t.Errorf("rejected version installed: %v", err)
	}
}

func TestInstallActivateAbandonsPending(t *testing.T) {
	pub, priv := testKey(t)
	l := paths.ForRoot(t.TempDir())
	keys := []ed25519.PublicKey{pub}
	if _, err := Install(l, packTest(t, "v1", priv), keys, InstallOptions{Activate: true}); err != nil {
		t.Fatal(err)
	}
	if err := writePending(l, Pending{From: "v0", To: "v1", Deadline: time.Now()}); err != nil {
		t.Fatal(err)
	}
	if _, err := Install(l, packTest(t, "v2", priv), keys, InstallOptions{Activate: true}); err != nil {
		t.Fatal(err)
	}
	if _, err := os.Stat(l.PendingUpdateFile); !os.IsNotExist(err) {
		t.Error("pending kept")
	}
	var res rollbackResult
	if err := readRollbackResult(l, &res); err != nil || res.From != "v0" || res.To != "v1" {
		t.Errorf("marker = %+v, %v", res, err)
	}
}

func TestPlaceVersionForcesExecutable(t *testing.T) {
	pub, priv := testKey(t)
	l := paths.ForRoot(t.TempDir())
	keys := []ed25519.PublicKey{pub}
	pkgDir, cleanup, m, err := stage(l, packTest(t, "v1", priv), keys)
	if err != nil {
		t.Fatal(err)
	}
	defer cleanup()
	if err := os.Chmod(filepath.Join(pkgDir, BinaryName), 0o644); err != nil {
		t.Fatal(err)
	}
	p, err := placeVersion(l, pkgDir, m, keys)
	if err != nil {
		t.Fatal(err)
	}
	p.commit()
	fi, err := os.Stat(filepath.Join(l.VersionsDir, "v1", BinaryName))
	if err != nil || fi.Mode().Perm() != 0o755 {
		t.Errorf("binary mode = %v, %v", fi.Mode(), err)
	}
}
