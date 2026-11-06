package ops

import (
	"crypto/ed25519"
	"crypto/rand"
	"crypto/x509"
	"encoding/json"
	"encoding/pem"
	"os"
	"testing"
)

func TestLayerManifestSharedFixture(t *testing.T) {
	dir := "../../../../infra/templates/testdata/layers/"
	data, e := os.ReadFile(dir + "manifest.fixture")
	if e != nil {
		t.Fatal(e)
	}
	sig, e := os.ReadFile(dir + "manifest.sig")
	if e != nil {
		t.Fatal(e)
	}
	pub, e := os.ReadFile(dir + "publisher.pub")
	if e != nil {
		t.Fatal(e)
	}
	m, e := verifyLayerManifest(data, sig, []string{string(pub)}, "0.1.0", "0.1.0", "stable", "linux")
	if e != nil || m.Slug != "linux" {
		t.Fatal("shared JS fixture rejected", e)
	}
	for _, v := range []struct{ platform, channel, slug string }{{"1.0.0", "stable", "linux"}, {"0.1.0", "edge", "linux"}, {"0.1.0", "stable", "windows"}} {
		if _, e := verifyLayerManifest(data, sig, []string{string(pub)}, v.platform, "0.1.0", v.channel, v.slug); e == nil {
			t.Fatal("accepted incompatible metadata")
		}
	}
	sig[0] ^= 1
	if _, e := verifyLayerManifest(data, sig, []string{string(pub)}, "0.1.0", "0.1.0", "stable", "linux"); e == nil {
		t.Fatal("accepted tampered signature")
	}
}

func TestLayerManifestLocalStagedProvenance(t *testing.T) {
	data, e := os.ReadFile("../../../../infra/templates/testdata/layers/manifest.fixture")
	if e != nil {
		t.Fatal(e)
	}
	var value map[string]any
	if e = json.Unmarshal(data, &value); e != nil {
		t.Fatal(e)
	}
	verification := value["verification"].(map[string]any)
	verification["buildHost"] = "local-staged"
	verification["approvedSha"] = value["sourceCommit"]
	public, private, e := ed25519.GenerateKey(rand.Reader)
	if e != nil {
		t.Fatal(e)
	}
	der, e := x509.MarshalPKIXPublicKey(public)
	if e != nil {
		t.Fatal(e)
	}
	key := string(pem.EncodeToMemory(&pem.Block{Type: "PUBLIC KEY", Bytes: der}))
	for _, valid := range []bool{true, false} {
		if !valid {
			verification["approvedSha"] = "bad"
		}
		b, e := json.Marshal(value)
		if e != nil {
			t.Fatal(e)
		}
		_, e = verifyLayerManifest(b, ed25519.Sign(private, b), []string{key}, "0.1.0", "0.1.0", "stable", "linux")
		if (e == nil) != valid {
			t.Fatalf("local provenance valid=%v: %v", valid, e)
		}
	}
}
