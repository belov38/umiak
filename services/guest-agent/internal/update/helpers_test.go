package update

import (
	"crypto/ed25519"
	"crypto/rand"
	"errors"
	"os"
	"path/filepath"
	"runtime"
	"slices"
	"testing"
	"time"

	"github.com/belov38/umiak/libs/tunnel/rpcconv"

	"github.com/belov38/umiak/services/guest-agent/internal/paths"
)

// testKey returns a fresh signing key pair.
func testKey(t *testing.T) (ed25519.PublicKey, ed25519.PrivateKey) {
	t.Helper()
	pub, priv, err := ed25519.GenerateKey(rand.Reader)
	if err != nil {
		t.Fatal(err)
	}
	return pub, priv
}

// writeFile writes data to dir/name and returns the path.
func writeFile(t *testing.T, dir, name, data string) string {
	t.Helper()
	p := filepath.Join(dir, name)
	if err := os.MkdirAll(filepath.Dir(p), 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(p, []byte(data), 0o644); err != nil {
		t.Fatal(err)
	}
	return p
}

// packTest builds a package of version for the running OS and architecture
// signed with priv and returns its path.
func packTest(t *testing.T, version string, priv ed25519.PrivateKey) string {
	t.Helper()
	return packFor(t, version, runtime.GOOS, runtime.GOARCH, priv)
}

func packFor(t *testing.T, version, goos, goarch string, priv ed25519.PrivateKey) string {
	t.Helper()
	return packBuild(t, version, goos, goarch, priv, "#!/bin/sh\necho "+version+"\n")
}

// packBuild is packFor with an explicit binary body.
func packBuild(t *testing.T, version, goos, goarch string, priv ed25519.PrivateKey, binary string) string {
	t.Helper()
	src := t.TempDir()
	pub := priv.Public().(ed25519.PublicKey)
	out := filepath.Join(t.TempDir(), "umiak-agent-"+version+".tar")
	_, err := Pack(PackOptions{
		Version:    version,
		OS:         goos,
		Arch:       goarch,
		Binary:     writeFile(t, src, "umiak-agent", binary),
		TunnelCA:   writeFile(t, src, "ca.pem", "-----BEGIN CERTIFICATE-----\nMA==\n-----END CERTIFICATE-----\n"),
		UpdateKeys: writeFile(t, src, "keys.pub", FormatKey(pub, "test")+"\n"),
		Key:        priv,
		Out:        out,
		Now:        time.Date(2026, 10, 30, 12, 0, 0, 0, time.UTC),
	})
	if err != nil {
		t.Fatal(err)
	}
	return out
}

// installed puts a verified version into the layout without activating it.
func installed(t *testing.T, l paths.Layout, version string, priv ed25519.PrivateKey) {
	t.Helper()
	pub := priv.Public().(ed25519.PublicKey)
	if _, err := Install(l, packTest(t, version, priv), []ed25519.PublicKey{pub}, InstallOptions{}); err != nil {
		t.Fatal(err)
	}
}

// detailCode returns the ErrorDetail code of err, or "".
func detailCode(err error) string {
	if d, ok := rpcconv.Detail(err); ok {
		return d.GetCode()
	}
	return ""
}

// linkTarget returns the version a layout symlink points to, or "".
func linkTarget(t *testing.T, link string) string {
	t.Helper()
	target, err := os.Readlink(link)
	if errors.Is(err, os.ErrNotExist) {
		return ""
	}
	if err != nil {
		t.Fatal(err)
	}
	return filepath.Base(target)
}

// setLinks points current and previous at versions directly.
func setLinks(t *testing.T, l paths.Layout, current, previous string) {
	t.Helper()
	if current != "" {
		if err := pointLink(l, l.CurrentLink, current); err != nil {
			t.Fatal(err)
		}
	}
	if previous != "" {
		if err := pointLink(l, l.PreviousLink, previous); err != nil {
			t.Fatal(err)
		}
	}
}

// fakeSystemctl records systemctl invocations.
type fakeSystemctl struct {
	calls [][]string
}

func (f *fakeSystemctl) run(args ...string) error {
	f.calls = append(f.calls, slices.Clone(args))
	return nil
}

// fakeTimer is a manually fired confirmation timer.
type fakeTimer struct {
	d       time.Duration
	f       func()
	stopped bool
}

func (f *fakeTimer) Stop() bool {
	f.stopped = true
	return true
}

// fakeTimers captures the timers a Manager schedules.
type fakeTimers struct {
	all []*fakeTimer
}

func (ft *fakeTimers) afterFunc(d time.Duration, f func()) stopper {
	t := &fakeTimer{d: d, f: f}
	ft.all = append(ft.all, t)
	return t
}

// ageVersions sets the mtime of every version directory an hour back, so
// GCVersions considers them.
func ageVersions(t *testing.T, l paths.Layout) {
	t.Helper()
	entries, err := os.ReadDir(l.VersionsDir)
	if err != nil {
		t.Fatal(err)
	}
	old := time.Now().Add(-time.Hour)
	for _, e := range entries {
		if err := os.Chtimes(filepath.Join(l.VersionsDir, e.Name()), old, old); err != nil {
			t.Fatal(err)
		}
	}
}
