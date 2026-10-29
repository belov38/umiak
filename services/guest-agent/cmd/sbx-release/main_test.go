package main

import (
	"bytes"
	"os"
	"path/filepath"
	"strings"
	"testing"

	"github.com/belov38/boat-dev-clone/services/guest-agent/internal/update"
)

func TestKeygenPackVerify(t *testing.T) {
	dir := t.TempDir()
	keyDir := filepath.Join(dir, "signing")

	var out, errOut bytes.Buffer
	if code := run([]string{"keygen", "--out", keyDir, "--comment", "poc"}, &out, &errOut); code != 0 {
		t.Fatalf("keygen exit = %d: %s", code, errOut.String())
	}
	line := strings.TrimSpace(out.String())
	keys, err := update.ParseKeys([]byte(line))
	if err != nil || len(keys) != 1 || !strings.HasSuffix(line, " poc") {
		t.Fatalf("public line %q: %v", line, err)
	}
	keyFile := filepath.Join(keyDir, "ed25519.key")
	fi, err := os.Stat(keyFile)
	if err != nil || fi.Mode().Perm() != 0o600 {
		t.Fatalf("key file: %v %v", fi, err)
	}
	if di, err := os.Stat(keyDir); err != nil || di.Mode().Perm() != 0o700 {
		t.Errorf("key dir: %v %v", di, err)
	}

	// keygen never overwrites a key.
	if code := run([]string{"keygen", "--out", keyDir}, &out, &errOut); code == 0 {
		t.Error("keygen overwrote an existing key")
	}

	pubFile := filepath.Join(dir, "update-keys.pub")
	if err := os.WriteFile(pubFile, []byte("# keys\n"+line+"\n"), 0o644); err != nil {
		t.Fatal(err)
	}
	bin := filepath.Join(dir, "sbx-agent")
	ca := filepath.Join(dir, "ca.pem")
	for p, data := range map[string]string{bin: "binary", ca: "ca"} {
		if err := os.WriteFile(p, []byte(data), 0o644); err != nil {
			t.Fatal(err)
		}
	}
	tarPath := filepath.Join(dir, "sbx-agent-1.0.0-linux-amd64.tar")
	out.Reset()
	errOut.Reset()
	code := run([]string{
		"pack", "--version", "1.0.0", "--os", "linux", "--arch", "amd64",
		"--binary", bin, "--tunnel-ca", ca, "--update-keys", pubFile,
		"--key", keyFile, "--out", tarPath,
	}, &out, &errOut)
	if code != 0 {
		t.Fatalf("pack exit = %d: %s", code, errOut.String())
	}

	out.Reset()
	if code := run([]string{"verify", "--keys", pubFile, tarPath}, &out, &errOut); code != 0 {
		t.Fatalf("verify exit = %d: %s", code, errOut.String())
	}
	if !strings.Contains(out.String(), "1.0.0 linux/amd64") {
		t.Errorf("verify output = %q", out.String())
	}

	// A foreign key list fails.
	other := filepath.Join(dir, "other")
	if code := run([]string{"keygen", "--out", other}, &out, &errOut); code != 0 {
		t.Fatal("second keygen failed")
	}
	otherPub := filepath.Join(dir, "other.pub")
	lines := strings.Split(strings.TrimSpace(out.String()), "\n")
	if err := os.WriteFile(otherPub, []byte(lines[len(lines)-1]+"\n"), 0o644); err != nil {
		t.Fatal(err)
	}
	errOut.Reset()
	if code := run([]string{"verify", "--keys", otherPub, tarPath}, &out, &errOut); code == 0 {
		t.Error("verify with a foreign key succeeded")
	}

	if code := run(nil, &out, &errOut); code != 2 {
		t.Errorf("no args exit = %d", code)
	}
}
