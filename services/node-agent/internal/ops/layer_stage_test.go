package ops

import (
	"archive/tar"
	"bytes"
	"context"
	"crypto/ed25519"
	"crypto/rand"
	"crypto/sha256"
	"crypto/x509"
	"encoding/hex"
	"encoding/json"
	"encoding/pem"
	"net/http"
	"net/http/httptest"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"testing"
	"testing/fstest"
)

func layerArgs(t *testing.T) map[string]any {
	t.Helper()
	dir := "../../../../infra/templates/testdata/layers/"
	data, e := os.ReadFile(dir + "manifest.fixture")
	if e != nil {
		t.Fatal(e)
	}
	sig, e := os.ReadFile(dir + "manifest.sig")
	if e != nil {
		t.Fatal(e)
	}
	return map[string]any{"jobId": "0123456789abcdef01234567", "vmid": 598, "manifest": json.RawMessage(data), "signature": sig, "platform": "0.1.0", "agent": "0.1.0", "channel": "stable", "slug": "linux"}
}
func TestLayerPrepareVerifiesBeforeCreatingState(t *testing.T) {
	h := newHarness(nil)
	h.srv.Cfg.StateDir = filepath.Join(t.TempDir(), "state")
	h.srv.Cfg.LayerKeysFile = "../../../../infra/templates/testdata/layers/publisher.pub"
	a := layerArgs(t)
	a["signature"] = make([]byte, 64)
	if h.call(t, "layer.prepare", a).OK {
		t.Fatal("accepted bad signature")
	}
	if _, e := os.Stat(h.srv.Cfg.StateDir); !os.IsNotExist(e) {
		t.Fatal("mutated state before signature check")
	}
	a = layerArgs(t)
	reply := h.call(t, "layer.prepare", a)
	if !reply.OK {
		t.Fatal(reply.Error)
	}
	if len(h.run.calls) > 0 {
		t.Fatal("prepare ran a host command")
	}
	a["vmid"] = 590
	if h.call(t, "layer.prepare", a).OK {
		t.Fatal("accepted infrastructure VMID")
	}
}
func TestLayerPrepareRefusesOccupiedVMID(t *testing.T) {
	h := newHarness(fstest.MapFS{"etc/pve/qemu-server/598.conf": {Data: []byte("name: foreign\n")}})
	h.srv.Cfg.StateDir = t.TempDir()
	h.srv.Cfg.LayerKeysFile = "../../../../infra/templates/testdata/layers/publisher.pub"
	if h.call(t, "layer.prepare", layerArgs(t)).OK {
		t.Fatal("accepted occupied VMID")
	}
}

func TestLayerPublisherKeyMatchesPlatformRoot(t *testing.T) {
	b, e := os.ReadFile("../../../../infra/templates/keys/recipe-publisher.pub")
	if e != nil || string(b) != layerPublisherKey {
		t.Fatal("node publisher root drift", e)
	}
}

func TestLayerStageRejectsMalformedZstdBeforeCreatingMedia(t *testing.T) {
	h := newHarness(nil)
	h.srv.Cfg.StateDir = t.TempDir()
	h.srv.Cfg.ImportDir = t.TempDir()
	h.srv.Cfg.LayerKeysFile = "../../../../infra/templates/testdata/layers/publisher.pub"
	server := httptest.NewTLSServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) { _, _ = w.Write([]byte("fixture")) }))
	defer server.Close()
	h.srv.LayerHTTP = server.Client()
	h.srv.Cfg.LayerBaseURL = server.URL
	response := h.call(t, "layer.stage", layerArgs(t))
	if response.OK {
		t.Fatal("accepted malformed compressed layer")
	}
	if len(h.run.calls) != 0 {
		t.Fatal("ran media formatter before authenticating archive")
	}
	entries, e := os.ReadDir(h.srv.Cfg.ImportDir)
	if e != nil || len(entries) > 0 {
		t.Fatal("published invalid media", e)
	}
}

func TestLayerStageReceiptIsBoundToMediaGeneration(t *testing.T) {
	h := newHarness(nil)
	h.srv.Cfg.StateDir = t.TempDir()
	h.srv.Cfg.ImportDir = t.TempDir()
	h.srv.Cfg.LayerKeysFile = "../../../../infra/templates/testdata/layers/publisher.pub"
	a := layerArgs(t)
	manifest := a["manifest"].(json.RawMessage)
	sum := sha256.Sum256(manifest)
	body := []byte("fixture")
	hash := sha256.Sum256(body)
	name := "umiak-layer-0123456789abcdef01234567.raw"
	media := filepath.Join(h.srv.Cfg.ImportDir, name)
	if e := os.WriteFile(media, body, 0600); e != nil {
		t.Fatal(e)
	}
	info, e := os.Stat(media)
	if e != nil {
		t.Fatal(e)
	}
	identity, e := fileIdentity(info)
	if e != nil {
		t.Fatal(e)
	}
	dir := filepath.Join(h.srv.Cfg.StateDir, "layer-jobs")
	if e = os.MkdirAll(dir, 0700); e != nil {
		t.Fatal(e)
	}
	receipt := layerReceipt{JobID: "0123456789abcdef01234567", VMID: 598, ManifestSHA256: hex.EncodeToString(sum[:]), MediaName: name, MediaIdentity: identity, MediaSHA256: hex.EncodeToString(hash[:]), MediaBytes: 7, Verified: true}
	if e = durableLayerReceipt(filepath.Join(dir, receipt.JobID+".json"), receipt); e != nil {
		t.Fatal(e)
	}
	if response := h.call(t, "layer.stage", a); !response.OK {
		t.Fatal(response.Error)
	}
	if len(h.run.calls) > 0 {
		t.Fatal("completed import was not reused")
	}
	replacement := filepath.Join(h.srv.Cfg.ImportDir, "replacement")
	if e = os.WriteFile(replacement, body, 0600); e != nil {
		t.Fatal(e)
	}
	if e = os.Rename(replacement, media); e != nil {
		t.Fatal(e)
	}
	if response := h.call(t, "layer.stage", a); response.OK {
		t.Fatal("reused receipt for another inode")
	}
	if _, e = os.Stat(media); e != nil {
		t.Fatal("removed foreign generation")
	}
}

func TestLayerExtractionRecoveryRequiresOwnedMarker(t *testing.T) {
	jobs := t.TempDir()
	a := layerRequest{JobID: "0123456789abcdef01234567", VMID: 598}
	digest := strings.Repeat("a", 64)
	stage := filepath.Join(jobs, a.JobID+".extract")
	if e := os.Mkdir(stage, 0700); e != nil {
		t.Fatal(e)
	}
	foreign := filepath.Join(stage, "foreign")
	if e := os.WriteFile(foreign, []byte("keep"), 0600); e != nil {
		t.Fatal(e)
	}
	if _, e := prepareLayerExtraction(jobs, a, digest); e == nil {
		t.Fatal("removed extraction without ownership proof")
	}
	if _, e := os.Stat(foreign); e != nil {
		t.Fatal("foreign data removed")
	}
	if e := durableLayerReceipt(filepath.Join(stage, ".owner.json"), layerReceipt{JobID: a.JobID, VMID: a.VMID, ManifestSHA256: digest}); e != nil {
		t.Fatal(e)
	}
	if _, e := prepareLayerExtraction(jobs, a, digest); e != nil {
		t.Fatal(e)
	}
	if _, e := os.Stat(foreign); !os.IsNotExist(e) {
		t.Fatal("owned interrupted extraction was not cleaned")
	}
}

func TestLayerStageCreatesAndReusesVerifiedMedia(t *testing.T) {
	if _, e := exec.LookPath("zstd"); e != nil {
		t.Skip("zstd unavailable")
	}
	h := newHarness(nil)
	h.srv.Cfg.StateDir = t.TempDir()
	h.srv.Cfg.ImportDir = t.TempDir()
	a := layerArgs(t)
	var m layerManifest
	if e := json.Unmarshal(a["manifest"].(json.RawMessage), &m); e != nil {
		t.Fatal(e)
	}
	body := []byte("fixture data")
	sum := sha256.Sum256(body)
	var raw bytes.Buffer
	tw := tar.NewWriter(&raw)
	for i := range m.Files {
		m.Files[i].SizeBytes = int64(len(body))
		m.Files[i].SHA256 = hex.EncodeToString(sum[:])
		if e := tw.WriteHeader(&tar.Header{Name: m.Files[i].Path, Mode: 0644, Size: int64(len(body)), Typeflag: tar.TypeReg}); e != nil {
			t.Fatal(e)
		}
		if _, e := tw.Write(body); e != nil {
			t.Fatal(e)
		}
	}
	if e := tw.Close(); e != nil {
		t.Fatal(e)
	}
	m.Inventory = layerBlob{SHA256: hex.EncodeToString(sum[:]), SizeBytes: int64(len(body))}
	hash := sha256.Sum256(raw.Bytes())
	m.Archive.RawSHA256 = hex.EncodeToString(hash[:])
	m.Archive.SizeBytes = int64(raw.Len())
	command := exec.CommandContext(t.Context(), "zstd", "-q", "-c")
	command.Stdin = &raw
	compressed, e := command.Output()
	if e != nil {
		t.Fatal(e)
	}
	hash = sha256.Sum256(compressed)
	m.Archive.SHA256 = hex.EncodeToString(hash[:])
	m.Archive.CompressedBytes = int64(len(compressed))
	m.Archive.Chunks = []layerBlob{{SHA256: m.Archive.SHA256, SizeBytes: int64(len(compressed))}}
	metadata, e := json.Marshal(m)
	if e != nil {
		t.Fatal(e)
	}
	pub, private, e := ed25519.GenerateKey(rand.Reader)
	if e != nil {
		t.Fatal(e)
	}
	der, e := x509.MarshalPKIXPublicKey(pub)
	if e != nil {
		t.Fatal(e)
	}
	key := filepath.Join(t.TempDir(), "publisher.pub")
	if e = os.WriteFile(key, pem.EncodeToMemory(&pem.Block{Type: "PUBLIC KEY", Bytes: der}), 0600); e != nil {
		t.Fatal(e)
	}
	h.srv.Cfg.LayerKeysFile = key
	a["manifest"] = json.RawMessage(metadata)
	a["signature"] = ed25519.Sign(private, metadata)
	requests, formats := 0, 0
	server := httptest.NewTLSServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		requests++
		if r.URL.Path != "/blobs/sha256/"+m.Archive.SHA256 {
			t.Error("unexpected blob path", r.URL.Path)
		}
		_, _ = w.Write(compressed)
	}))
	defer server.Close()
	h.srv.LayerHTTP = server.Client()
	h.srv.Cfg.LayerBaseURL = server.URL
	h.srv.Host.Run = func(_ context.Context, name string, args ...string) ([]byte, error) {
		formats++
		if name != "mke2fs" {
			t.Fatal("unexpected host command", name)
		}
		if data, e := os.ReadFile(filepath.Join(args[len(args)-2], "build/recipe.sh")); e != nil || !bytes.Equal(data, body) {
			t.Fatal("missing authenticated input", e)
		}
		f, e := os.OpenFile(args[len(args)-1], os.O_RDWR, 0)
		if e != nil {
			return nil, e
		}
		defer func() { _ = f.Close() }()
		_, e = f.WriteAt([]byte{0x53, 0xef}, 1080)
		return nil, e
	}
	for range 2 {
		reply := h.call(t, "layer.stage", a)
		if !reply.OK {
			t.Fatal(reply.Error)
		}
		var receipt layerReceipt
		data, _ := json.Marshal(reply.Result)
		if e := json.Unmarshal(data, &receipt); e != nil || !receipt.Verified || receipt.MediaBytes < 64<<20 {
			t.Fatal("invalid receipt", e, string(data))
		}
	}
	if requests != 1 || formats != 1 {
		t.Fatal("did not reuse verified staging", requests, formats)
	}
}

func TestLayerReleaseRemovesOnlyReceiptOwnedMediaEvenAfterVMRegistration(t *testing.T) {
	h := newHarness(fstest.MapFS{"etc/pve/qemu-server/598.conf": {Data: []byte("template: 1\n")}})
	h.srv.Cfg.StateDir = t.TempDir()
	h.srv.Cfg.ImportDir = t.TempDir()
	h.srv.Cfg.LayerKeysFile = "../../../../infra/templates/testdata/layers/publisher.pub"
	a := layerArgs(t)
	sum := sha256.Sum256(a["manifest"].(json.RawMessage))
	job := a["jobId"].(string)
	name := "umiak-layer-" + job + ".raw"
	media := filepath.Join(h.srv.Cfg.ImportDir, name)
	if e := os.WriteFile(media, []byte("media"), 0600); e != nil {
		t.Fatal(e)
	}
	info, _ := os.Stat(media)
	identity, e := fileIdentity(info)
	if e != nil {
		t.Fatal(e)
	}
	jobs := filepath.Join(h.srv.Cfg.StateDir, "layer-jobs")
	if e = os.Mkdir(jobs, 0700); e != nil {
		t.Fatal(e)
	}
	receipt := layerReceipt{JobID: job, VMID: 598, ManifestSHA256: hex.EncodeToString(sum[:]), MediaName: name, MediaIdentity: identity, Verified: true}
	marker := filepath.Join(jobs, job+".json")
	if e = durableLayerReceipt(marker, receipt); e != nil {
		t.Fatal(e)
	}
	if reply := h.call(t, "layer.release", a); !reply.OK {
		t.Fatal(reply.Error)
	}
	if _, e = os.Stat(media); !os.IsNotExist(e) {
		t.Fatal("owned staging media remains")
	}
	if reply := h.call(t, "layer.release", a); !reply.OK {
		t.Fatal("release is not idempotent", reply.Error)
	}
	if e = os.WriteFile(media, []byte("foreign generation"), 0600); e != nil {
		t.Fatal(e)
	}
	if reply := h.call(t, "layer.release", a); reply.OK {
		t.Fatal("removed media without receipt")
	}
	if _, e = os.Stat(media); e != nil {
		t.Fatal("foreign generation removed")
	}
}

func TestLayerBaseAuthenticatesCachedOfficialBaseBeforeImport(t *testing.T) {
	h := newHarness(nil)
	h.srv.Cfg.StateDir = t.TempDir()
	h.srv.Cfg.ImportDir = t.TempDir()
	h.srv.Cfg.LayerKeysFile = "../../../../infra/templates/testdata/layers/publisher.pub"
	name := "umiak-ubuntu-26.04-minimal-20261024.qcow2"
	if e := os.WriteFile(filepath.Join(h.srv.Cfg.ImportDir, name), []byte("fixture"), 0600); e != nil {
		t.Fatal(e)
	}
	reply := h.call(t, "layer.base", layerArgs(t))
	if !reply.OK {
		t.Fatal(reply.Error)
	}
	if !resultMap(t, reply)["verified"].(bool) {
		t.Fatal("valid cached base rejected")
	}
	if e := os.WriteFile(filepath.Join(h.srv.Cfg.ImportDir, name), []byte("changed"), 0600); e != nil {
		t.Fatal(e)
	}
	reply = h.call(t, "layer.base", layerArgs(t))
	if !reply.OK {
		t.Fatal(reply.Error)
	}
	if resultMap(t, reply)["verified"].(bool) {
		t.Fatal("reused same-sized corrupt base")
	}
}

func TestLayerCacheEvictsOnlyVerifiedUnusedBlobs(t *testing.T) {
	cache := t.TempDir()
	old := []byte("old blob")
	needed := []byte("needed blob")
	oldHash := sha256.Sum256(old)
	needHash := sha256.Sum256(needed)
	oldName := hex.EncodeToString(oldHash[:])
	neededName := hex.EncodeToString(needHash[:])
	for name, body := range map[string][]byte{oldName: old, neededName: needed} {
		if e := os.WriteFile(filepath.Join(cache, name), body, 0600); e != nil {
			t.Fatal(e)
		}
	}
	m := layerManifest{}
	m.Archive.Chunks = []layerBlob{{SHA256: neededName, SizeBytes: int64(len(needed))}}
	if e := pruneLayerCache(cache, m, int64(len(needed))); e != nil {
		t.Fatal(e)
	}
	if _, e := os.Stat(filepath.Join(cache, oldName)); !os.IsNotExist(e) {
		t.Fatal("unused cache retained")
	}
	if _, e := os.Stat(filepath.Join(cache, neededName)); e != nil {
		t.Fatal("needed blob evicted")
	}
	foreign := strings.Repeat("f", 64)
	if e := os.WriteFile(filepath.Join(cache, foreign), old, 0600); e != nil {
		t.Fatal(e)
	}
	if e := pruneLayerCache(cache, m, int64(len(needed))); e == nil {
		t.Fatal("removed unproved cache contents")
	}
	if _, e := os.Stat(filepath.Join(cache, foreign)); e != nil {
		t.Fatal("foreign contents deleted")
	}
}
