package ops

import (
	"archive/tar"
	"bytes"
	"crypto/sha256"
	"encoding/hex"
	"os"
	"path/filepath"
	"testing"
)

func layerTar(t *testing.T, headers []*tar.Header, payload []byte) ([]byte, layerManifest) {
	t.Helper()
	var b bytes.Buffer
	w := tar.NewWriter(&b)
	for _, h := range headers {
		if e := w.WriteHeader(h); e != nil {
			t.Fatal(e)
		}
		if h.Typeflag == tar.TypeReg {
			if _, e := w.Write(payload); e != nil {
				t.Fatal(e)
			}
		}
	}
	if e := w.Close(); e != nil {
		t.Fatal(e)
	}
	sum := sha256.Sum256(payload)
	raw := sha256.Sum256(b.Bytes())
	var m layerManifest
	m.Files = []layerFile{{Path: "build/run.sh", Mode: 0644, SHA256: hex.EncodeToString(sum[:]), SizeBytes: int64(len(payload))}}
	m.Archive.SizeBytes = int64(b.Len())
	m.Archive.RawSHA256 = hex.EncodeToString(raw[:])
	return b.Bytes(), m
}
func TestLayerExtractAuthenticatesEveryFile(t *testing.T) {
	body := []byte("echo fixture\n")
	raw, m := layerTar(t, []*tar.Header{{Name: "build/run.sh", Mode: 0644, Typeflag: tar.TypeReg, Size: int64(len(body))}}, body)
	dir := t.TempDir()
	if e := extractLayerTar(bytes.NewReader(raw), m, dir); e != nil {
		t.Fatal(e)
	}
	data, e := os.ReadFile(filepath.Join(dir, "build/run.sh")) //nolint:gosec // test-generated root and fixed relative path
	if e != nil || !bytes.Equal(data, body) {
		t.Fatal(e)
	}
	raw[len(raw)-1] = 1
	if e := extractLayerTar(bytes.NewReader(raw), m, t.TempDir()); e == nil {
		t.Fatal("accepted altered archive padding")
	}
}
func TestLayerExtractRejectsEscapesLinksDuplicatesAndMissing(t *testing.T) {
	body := []byte("fixture")
	for _, h := range []*tar.Header{{Name: "../escape", Typeflag: tar.TypeReg, Size: 7, Mode: 0644}, {Name: "/escape", Typeflag: tar.TypeReg, Size: 7, Mode: 0644}, {Name: "build/run.sh", Typeflag: tar.TypeSymlink, Linkname: "/etc/passwd", Mode: 0644}, {Name: "build/run.sh", Typeflag: tar.TypeLink, Linkname: "outside", Mode: 0644}, {Name: "build/run.sh", Typeflag: tar.TypeFifo, Mode: 0644}, {Name: "build/other.sh", Typeflag: tar.TypeReg, Size: 7, Mode: 0644}} {
		raw, m := layerTar(t, []*tar.Header{h}, body)
		if e := extractLayerTar(bytes.NewReader(raw), m, t.TempDir()); e == nil {
			t.Fatalf("accepted %s type %d", h.Name, h.Typeflag)
		}
	}
	h := &tar.Header{Name: "build/run.sh", Typeflag: tar.TypeReg, Size: 7, Mode: 0644}
	raw, m := layerTar(t, []*tar.Header{h, h}, body)
	if extractLayerTar(bytes.NewReader(raw), m, t.TempDir()) == nil {
		t.Fatal("accepted duplicate")
	}
	raw, m = layerTar(t, nil, body)
	if extractLayerTar(bytes.NewReader(raw), m, t.TempDir()) == nil {
		t.Fatal("accepted missing file")
	}
}
