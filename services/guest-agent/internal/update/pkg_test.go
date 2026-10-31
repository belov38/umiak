package update

import (
	"archive/tar"
	"bytes"
	"crypto/ed25519"
	"encoding/base64"
	"fmt"
	"os"
	"path/filepath"
	"runtime"
	"strings"
	"testing"
)

func unpacked(t *testing.T, tarPath string) string {
	t.Helper()
	dst := filepath.Join(t.TempDir(), "pkg")
	if err := Unpack(tarPath, dst); err != nil {
		t.Fatal(err)
	}
	return dst
}

func TestPackVerifyRoundTrip(t *testing.T) {
	pub, priv := testKey(t)
	dir := unpacked(t, packTest(t, "1.2.3", priv))

	m, err := Verify(dir, []ed25519.PublicKey{pub})
	if err != nil {
		t.Fatal(err)
	}
	if m.Format != ManifestFormat || m.Version != "1.2.3" || m.OS != runtime.GOOS || m.Arch != runtime.GOARCH {
		t.Errorf("manifest = %+v", m)
	}
	for _, name := range []string{BinaryName, TunnelCAName, UpdateKeysName} {
		if _, ok := m.Files[name]; !ok {
			t.Errorf("manifest misses %s", name)
		}
	}
	if m.CreatedAt.IsZero() {
		t.Error("created_at is zero")
	}
	// Windows has no executable bit (an .exe runs by its extension).
	fi, err := os.Stat(filepath.Join(dir, BinaryName))
	if err != nil || (runtime.GOOS != "windows" && fi.Mode().Perm()&0o100 == 0) {
		t.Errorf("binary mode = %v, %v", fi.Mode(), err)
	}

	// A second key (rotation) verifies too.
	other, _ := testKey(t)
	if _, err := Verify(dir, []ed25519.PublicKey{other, pub}); err != nil {
		t.Errorf("verify with key list: %v", err)
	}
}

func TestVerifyRejects(t *testing.T) {
	pub, priv := testKey(t)
	foreign, _ := testKey(t)
	tarPath := packTest(t, "1.0.0", priv)

	tests := []struct {
		name   string
		mutate func(t *testing.T, dir string)
		keys   []ed25519.PublicKey
	}{
		{
			name: "flipped byte in binary",
			mutate: func(t *testing.T, dir string) {
				p := filepath.Join(dir, BinaryName)
				b, err := os.ReadFile(p)
				if err != nil {
					t.Fatal(err)
				}
				b[0] ^= 0xff
				if err := os.WriteFile(p, b, 0o755); err != nil {
					t.Fatal(err)
				}
			},
		},
		{name: "foreign key", keys: []ed25519.PublicKey{foreign}},
		{name: "no keys", keys: []ed25519.PublicKey{}},
		{
			name:   "extra file",
			mutate: func(t *testing.T, dir string) { writeFile(t, dir, "trust/extra.pem", "x") },
		},
		{
			name: "missing trust file",
			mutate: func(t *testing.T, dir string) {
				if err := os.Remove(filepath.Join(dir, TunnelCAName)); err != nil {
					t.Fatal(err)
				}
			},
		},
		{
			name: "edited manifest",
			mutate: func(t *testing.T, dir string) {
				p := filepath.Join(dir, ManifestName)
				b, err := os.ReadFile(p)
				if err != nil {
					t.Fatal(err)
				}
				if err := os.WriteFile(p, bytes.Replace(b, []byte("1.0.0"), []byte("1.0.1"), 1), 0o644); err != nil {
					t.Fatal(err)
				}
			},
		},
		{
			name: "symlink",
			mutate: func(t *testing.T, dir string) {
				if err := os.Symlink("/etc/passwd", filepath.Join(dir, "trust", "link")); err != nil {
					t.Fatal(err)
				}
			},
		},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			dir := unpacked(t, tarPath)
			if tt.mutate != nil {
				tt.mutate(t, dir)
			}
			keys := tt.keys
			if keys == nil {
				keys = []ed25519.PublicKey{pub}
			}
			_, err := Verify(dir, keys)
			if err == nil {
				t.Fatal("verify succeeded")
			}
			if got := detailCode(err); got != "signature_invalid" {
				t.Errorf("detail = %q, want signature_invalid (err %v)", got, err)
			}
		})
	}
}

func TestVerifyRejectsMissingRequiredEntry(t *testing.T) {
	_, priv := testKey(t)
	src := t.TempDir()
	_, err := Pack(PackOptions{
		Version: "1.0.0", OS: "linux", Arch: "amd64",
		Binary:     writeFile(t, src, "sbx-agent", "bin"),
		UpdateKeys: writeFile(t, src, "keys.pub", "k"),
		Key:        priv,
		Out:        filepath.Join(src, "out.tar"),
	})
	if err == nil {
		t.Fatal("pack without tunnel CA succeeded")
	}
}

// tarOf builds a tar archive with the given headers and bodies.
func tarOf(t *testing.T, entries ...struct {
	hdr  tar.Header
	body string
},
) string {
	t.Helper()
	var buf bytes.Buffer
	tw := tar.NewWriter(&buf)
	for _, e := range entries {
		h := e.hdr
		h.Size = int64(len(e.body))
		if h.Typeflag != tar.TypeReg {
			h.Size = 0
		}
		if err := tw.WriteHeader(&h); err != nil {
			t.Fatal(err)
		}
		if h.Typeflag == tar.TypeReg {
			if _, err := tw.Write([]byte(e.body)); err != nil {
				t.Fatal(err)
			}
		}
	}
	if err := tw.Close(); err != nil {
		t.Fatal(err)
	}
	p := filepath.Join(t.TempDir(), "x.tar")
	if err := os.WriteFile(p, buf.Bytes(), 0o644); err != nil {
		t.Fatal(err)
	}
	return p
}

type entry = struct {
	hdr  tar.Header
	body string
}

func TestUnpackConfined(t *testing.T) {
	reg := func(name string) entry {
		return entry{hdr: tar.Header{Name: name, Typeflag: tar.TypeReg, Mode: 0o644}, body: "x"}
	}
	tests := []struct {
		name    string
		entries []entry
	}{
		{"dotdot", []entry{reg("../x")}},
		{"nested dotdot", []entry{reg("trust/../../x")}},
		{"absolute", []entry{reg("/x")}},
		{"symlink", []entry{{hdr: tar.Header{Name: "l", Typeflag: tar.TypeSymlink, Linkname: "/etc"}}}},
		{"hardlink", []entry{reg("a"), {hdr: tar.Header{Name: "b", Typeflag: tar.TypeLink, Linkname: "a"}}}},
		{"duplicate", []entry{reg("a"), reg("a")}},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			base := t.TempDir()
			dst := filepath.Join(base, "dst")
			if err := Unpack(tarOf(t, tt.entries...), dst); err == nil {
				t.Fatal("unpack succeeded")
			}
			if _, err := os.Stat(filepath.Join(base, "x")); !os.IsNotExist(err) {
				t.Errorf("file written outside dst: %v", err)
			}
		})
	}

	// Directories and regular files are fine.
	dst := filepath.Join(t.TempDir(), "dst")
	ok := tarOf(t, entry{hdr: tar.Header{Name: "trust/", Typeflag: tar.TypeDir, Mode: 0o755}}, reg("trust/a"), reg("b"))
	if err := Unpack(ok, dst); err != nil {
		t.Fatal(err)
	}
	if b, err := os.ReadFile(filepath.Join(dst, "trust", "a")); err != nil || string(b) != "x" {
		t.Errorf("trust/a = %q, %v", b, err)
	}
}

func TestUnpackSizeLimit(t *testing.T) {
	var buf bytes.Buffer
	tw := tar.NewWriter(&buf)
	// The header claims more than the limit; the body is never read.
	if err := tw.WriteHeader(&tar.Header{Name: "big", Typeflag: tar.TypeReg, Mode: 0o644, Size: maxUnpackBytes + 1}); err != nil {
		t.Fatal(err)
	}
	p := filepath.Join(t.TempDir(), "big.tar")
	if err := os.WriteFile(p, buf.Bytes(), 0o644); err != nil {
		t.Fatal(err)
	}
	if err := Unpack(p, filepath.Join(t.TempDir(), "dst")); err == nil {
		t.Fatal("unpack of an oversized archive succeeded")
	}
}

func TestUnpackEntryLimit(t *testing.T) {
	var many []entry
	for i := 0; i <= maxUnpackEntries; i++ {
		many = append(many, entry{hdr: tar.Header{Name: fmt.Sprintf("f%d", i), Typeflag: tar.TypeReg, Mode: 0o644}, body: "x"})
	}
	if err := Unpack(tarOf(t, many...), filepath.Join(t.TempDir(), "dst")); detailCode(err) != "invalid_argument" {
		t.Errorf("unpack of %d entries: %v", len(many), err)
	}
	if err := Unpack(tarOf(t, many[:maxUnpackEntries]...), filepath.Join(t.TempDir(), "dst")); err != nil {
		t.Errorf("unpack of %d entries: %v", maxUnpackEntries, err)
	}
}

func TestParseKeys(t *testing.T) {
	pub, _ := testKey(t)
	next, _ := testKey(t)
	good := "# comment\n\n" + FormatKey(pub, "current key") + "\n" + FormatKey(next, "next") + "\n"
	keys, err := ParseKeys([]byte(good))
	if err != nil {
		t.Fatal(err)
	}
	if len(keys) != 2 || !keys[0].Equal(pub) || !keys[1].Equal(next) {
		t.Errorf("keys = %v", keys)
	}
	if _, err := ParseKeys([]byte("ed25519 " + base64.StdEncoding.EncodeToString(pub) + "\n")); err != nil {
		t.Errorf("key without comment: %v", err)
	}

	for name, in := range map[string]string{
		"empty":       "# nothing\n",
		"wrong type":  "rsa " + base64.StdEncoding.EncodeToString(pub) + " c\n",
		"bad base64":  "ed25519 !!! c\n",
		"short key":   "ed25519 " + base64.StdEncoding.EncodeToString(pub[:16]) + " c\n",
		"no key part": "ed25519\n",
	} {
		if _, err := ParseKeys([]byte(in)); err == nil {
			t.Errorf("%s: parsed", name)
		}
	}
	if !strings.HasPrefix(FormatKey(pub, "c"), "ed25519 ") {
		t.Error("FormatKey prefix")
	}
}

func TestPrivateKeyRoundTrip(t *testing.T) {
	_, priv := testKey(t)
	pemBytes, err := MarshalPrivateKey(priv)
	if err != nil {
		t.Fatal(err)
	}
	got, err := ParsePrivateKey(pemBytes)
	if err != nil {
		t.Fatal(err)
	}
	if !got.Equal(priv) {
		t.Error("private key changed")
	}
}
