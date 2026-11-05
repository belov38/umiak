package ops

import (
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
