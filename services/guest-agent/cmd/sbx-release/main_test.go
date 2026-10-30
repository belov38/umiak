package main

import (
	"bytes"
	"os"
	"os/exec"
	"path/filepath"
	"runtime"
	"runtime/debug"
	"slices"
	"strings"
	"testing"

	"github.com/belov38/boat-dev-clone/services/guest-agent/internal/update"
)

// keygenTo runs keygen into dir and returns the key file and public line.
func keygenTo(t *testing.T, dir string) (keyFile, line string) {
	t.Helper()
	var out, errOut bytes.Buffer
	if code := run([]string{"keygen", "--out", dir, "--comment", "poc"}, &out, &errOut); code != 0 {
		t.Fatalf("keygen exit = %d: %s", code, errOut.String())
	}
	return filepath.Join(dir, "ed25519.key"), strings.TrimSpace(out.String())
}

func writeTestFile(t *testing.T, p, data string, perm os.FileMode) string {
	t.Helper()
	if err := os.WriteFile(p, []byte(data), perm); err != nil {
		t.Fatal(err)
	}
	return p
}

func TestKeygenPackVerify(t *testing.T) {
	if runtime.GOOS == "windows" {
		t.Skip("the fake binary is a shell script")
	}
	dir := t.TempDir()
	keyDir := filepath.Join(dir, "signing")
	keyFile, line := keygenTo(t, keyDir)

	keys, err := update.ParseKeys([]byte(line))
	if err != nil || len(keys) != 1 || !strings.HasSuffix(line, " poc") {
		t.Fatalf("public line %q: %v", line, err)
	}
	fi, err := os.Stat(keyFile)
	if err != nil || fi.Mode().Perm() != 0o600 {
		t.Fatalf("key file: %v %v", fi, err)
	}
	if di, err := os.Stat(keyDir); err != nil || di.Mode().Perm() != 0o700 {
		t.Errorf("key dir: %v %v", di, err)
	}
	var out, errOut bytes.Buffer
	if code := run([]string{"keygen", "--out", keyDir}, &out, &errOut); code == 0 {
		t.Error("keygen overwrote an existing key")
	}

	pubFile := writeTestFile(t, filepath.Join(dir, "update-keys.pub"), "# keys\n"+line+"\n", 0o644)
	bin := writeTestFile(t, filepath.Join(dir, "sbx-agent"), "#!/bin/sh\necho 1.0.0\n", 0o755)
	ca := writeTestFile(t, filepath.Join(dir, "ca.pem"), "ca", 0o644)
	tarPath := filepath.Join(dir, "sbx-agent-1.0.0.tar")
	packArgs := func(version, goos, goarch, keys string, extra ...string) []string {
		return append([]string{
			"pack", "--version", version, "--os", goos, "--arch", goarch,
			"--binary", bin, "--tunnel-ca", ca, "--update-keys", keys,
			"--key", keyFile, "--out", tarPath,
		}, extra...)
	}

	if code := run(packArgs("1.0.0", runtime.GOOS, runtime.GOARCH, pubFile), &out, &errOut); code != 0 {
		t.Fatalf("pack exit = %d: %s", code, errOut.String())
	}
	out.Reset()
	if code := run([]string{"verify", "--keys", pubFile, tarPath}, &out, &errOut); code != 0 {
		t.Fatalf("verify exit = %d: %s", code, errOut.String())
	}
	if want := "1.0.0 " + runtime.GOOS + "/" + runtime.GOARCH; !strings.Contains(out.String(), want) {
		t.Errorf("verify output = %q, want %q", out.String(), want)
	}

	// The binary must report the package version.
	errOut.Reset()
	if code := run(packArgs("1.0.1", runtime.GOOS, runtime.GOARCH, pubFile), &out, &errOut); code != 1 || !strings.Contains(errOut.String(), `reports version "1.0.0"`) {
		t.Errorf("version mismatch: exit = %d, stderr = %q", code, errOut.String())
	}
	// A binary for another platform needs --skip-version-check.
	errOut.Reset()
	if code := run(packArgs("1.0.0", "plan9", "mips", pubFile), &out, &errOut); code != 1 || !strings.Contains(errOut.String(), "--skip-version-check") {
		t.Errorf("foreign platform: exit = %d, stderr = %q", code, errOut.String())
	}
	errOut.Reset()
	if code := run(packArgs("1.0.0", "plan9", "mips", pubFile, "--skip-version-check"), &out, &errOut); code != 0 || !strings.Contains(errOut.String(), "warning") {
		t.Errorf("foreign platform with skip: exit = %d, stderr = %q", code, errOut.String())
	}

	// The signer must be pinned in the packed keys.
	_, otherLine := keygenTo(t, filepath.Join(dir, "other"))
	otherPub := writeTestFile(t, filepath.Join(dir, "other.pub"), otherLine+"\n", 0o644)
	errOut.Reset()
	if code := run(packArgs("1.0.0", runtime.GOOS, runtime.GOARCH, otherPub), &out, &errOut); code != 1 || !strings.Contains(errOut.String(), "--allow-foreign-signer") {
		t.Errorf("foreign signer: exit = %d, stderr = %q", code, errOut.String())
	}
	if code := run(packArgs("1.0.0", runtime.GOOS, runtime.GOARCH, otherPub, "--allow-foreign-signer"), &out, &errOut); code != 0 {
		t.Errorf("foreign signer allowed: exit = %d, stderr = %q", code, errOut.String())
	}

	// That package does not verify against the other key list.
	errOut.Reset()
	if code := run([]string{"verify", "--keys", otherPub, tarPath}, &out, &errOut); code == 0 {
		t.Error("verify with a foreign key succeeded")
	}

	if code := run(nil, &out, &errOut); code != 2 {
		t.Errorf("no args exit = %d", code)
	}
}

func TestTestBuildFlags(t *testing.T) {
	tests := []struct {
		name     string
		settings []debug.BuildSetting
		want     []string
	}{
		{"production", []debug.BuildSetting{{Key: "-ldflags", Value: "-X main.version=1.2.3"}}, nil},
		{"no ldflags", []debug.BuildSetting{{Key: "CGO_ENABLED", Value: "0"}}, nil},
		{"failRun", []debug.BuildSetting{{Key: "-ldflags", Value: "-X main.version=1 -X main.failRun=1"}}, []string{"main.failRun"}},
		{"both", []debug.BuildSetting{{Key: "-ldflags", Value: "-X 'main.devUpdateKey=abc' -X=main.failRun=1"}}, []string{"main.failRun", "main.devUpdateKey"}},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			if got := testBuildFlags(&debug.BuildInfo{Settings: tt.settings}); !slices.Equal(got, tt.want) {
				t.Errorf("testBuildFlags = %v, want %v", got, tt.want)
			}
		})
	}
}

// TestPackRefusesTestBuild builds a real sbx-agent with a test ldflag and
// packs it with and without --allow-test-build.
func TestPackRefusesTestBuild(t *testing.T) {
	if testing.Short() {
		t.Skip("builds a binary")
	}
	dir := t.TempDir()
	keyFile, line := keygenTo(t, filepath.Join(dir, "signing"))
	pubFile := writeTestFile(t, filepath.Join(dir, "update-keys.pub"), line+"\n", 0o644)
	ca := writeTestFile(t, filepath.Join(dir, "ca.pem"), "ca", 0o644)
	bin := filepath.Join(dir, "sbx-agent")
	build := exec.CommandContext(t.Context(), "go", "build", "-o", bin, "-ldflags", "-X main.version=1.0.0 -X main.failRun=1", "../sbx-agent")
	build.Env = append(os.Environ(), "CGO_ENABLED=0")
	if out, err := build.CombinedOutput(); err != nil {
		t.Fatalf("go build: %v\n%s", err, out)
	}
	args := []string{
		"pack", "--version", "1.0.0", "--os", runtime.GOOS, "--arch", runtime.GOARCH,
		"--binary", bin, "--tunnel-ca", ca, "--update-keys", pubFile,
		"--key", keyFile, "--out", filepath.Join(dir, "p.tar"),
	}
	var out, errOut bytes.Buffer
	if code := run(args, &out, &errOut); code != 1 || !strings.Contains(errOut.String(), "--allow-test-build") {
		t.Fatalf("pack of a test build: exit %d, stderr %q", code, errOut.String())
	}
	errOut.Reset()
	if code := run(append(args, "--allow-test-build"), &out, &errOut); code != 0 || !strings.Contains(errOut.String(), "warning") {
		t.Errorf("pack with --allow-test-build: exit %d, stderr %q", code, errOut.String())
	}
}
