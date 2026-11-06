package ops

import (
	"bytes"
	"crypto/ed25519"
	"crypto/x509"
	"encoding/json"
	"encoding/pem"
	"errors"
	"fmt"
	"io"
	"regexp"
	"strconv"
	"strings"
	"unicode/utf8"
)

const layerMaxArchive int64 = 32 << 30
const layerMaxChunk int64 = 512 << 20
const layerMaxMetadata = 1 << 20

var layerDigestRE = regexp.MustCompile(`^[a-f0-9]{64}$`)
var layerVersionRE = regexp.MustCompile(`^\d{8}\.\d+(-edge\.\d{8}\.\d+)?$`)
var layerSemverRE = regexp.MustCompile(`^\d+\.\d+\.\d+(-edge\.\d{8}\.\d+)?(\+[\w.-]+)?$`)
var layerPathRE = regexp.MustCompile(`^(apt|inputs|build|licenses|recipes)/[A-Za-z0-9_@+.,=~:/-]+$`)
var layerDiskRE = regexp.MustCompile(`(?i)\.(qcow2?|raw|img|vmdk|vdi|iso)$`)

type layerBlob struct {
	SHA256    string `json:"sha256"`
	SizeBytes int64  `json:"sizeBytes"`
}
type layerFile struct {
	Path      string `json:"path"`
	SizeBytes int64  `json:"sizeBytes"`
	SHA256    string `json:"sha256"`
	Mode      int64  `json:"mode"`
}
type layerManifest struct {
	Format       string `json:"format"`
	Version      string `json:"version"`
	Slug         string `json:"slug"`
	Channel      string `json:"channel"`
	Arch         string `json:"arch"`
	Distro       string `json:"distro"`
	Release      string `json:"release"`
	SourceCommit string `json:"sourceCommit"`
	RecipeSHA256 string `json:"recipeSha256"`
	Base         struct {
		URL    string `json:"url"`
		Serial string `json:"serial"`
		SHA256 string `json:"sha256"`
	} `json:"base"`
	AptSnapshot string `json:"aptSnapshot"`
	Agent       struct {
		Version string `json:"version"`
		SHA256  string `json:"sha256"`
	} `json:"agent"`
	BuilderAPI  int    `json:"builderApi"`
	MinPlatform string `json:"minPlatform"`
	MaxPlatform string `json:"maxPlatform"`
	MinAgent    string `json:"minAgent"`
	BootTrust   string `json:"bootTrust"`
	Archive     struct {
		SizeBytes       int64       `json:"sizeBytes"`
		CompressedBytes int64       `json:"compressedBytes"`
		SHA256          string      `json:"sha256"`
		RawSHA256       string      `json:"rawSha256"`
		Chunks          []layerBlob `json:"chunks"`
	} `json:"archive"`
	Files     []layerFile `json:"files"`
	Inventory layerBlob   `json:"inventory"`
	Sources   struct {
		Repository string `json:"repository"`
		Digest     string `json:"digest"`
	} `json:"sources"`
	Verification struct {
		OK            bool `json:"ok"`
		OfflineReplay bool `json:"offlineReplay"`
	} `json:"verification"`
}

func layerPathValid(path string) bool {
	if len(path) > 512 || !layerPathRE.MatchString(path) || layerDiskRE.MatchString(path) {
		return false
	}
	for _, p := range strings.Split(path, "/") {
		if p == "" || p == "." || p == ".." {
			return false
		}
	}
	return true
}

// uniqueJSON rejects duplicate fields at every nesting level before struct decoding.
func uniqueJSON(dec *json.Decoder) error {
	token, err := dec.Token()
	if err != nil {
		return err
	}
	delimiter, ok := token.(json.Delim)
	if !ok {
		return nil
	}
	switch delimiter {
	case '{':
		seen := map[string]bool{}
		for dec.More() {
			key, e := dec.Token()
			if e != nil {
				return e
			}
			k, ok := key.(string)
			if !ok || seen[k] {
				return errors.New("duplicate JSON field")
			}
			seen[k] = true
			if e = uniqueJSON(dec); e != nil {
				return e
			}
		}
	case '[':
		for dec.More() {
			if e := uniqueJSON(dec); e != nil {
				return e
			}
		}
	default:
		return errors.New("invalid JSON delimiter")
	}
	_, err = dec.Token()
	return err
}
func layerCompare(a, b string) (int, error) {
	if !layerSemverRE.MatchString(a) || !layerSemverRE.MatchString(b) {
		return 0, errors.New("invalid capability version")
	}
	numbers := func(s string) []string { return strings.Split(strings.Split(strings.Split(s, "+")[0], "-")[0], ".") }
	x, y := numbers(a), numbers(b)
	for i := range x {
		n, e := strconv.ParseUint(x[i], 10, 53)
		if e != nil {
			return 0, e
		}
		m, e := strconv.ParseUint(y[i], 10, 53)
		if e != nil {
			return 0, e
		}
		if n < m {
			return -1, nil
		}
		if n > m {
			return 1, nil
		}
	}
	return 0, nil
}
func verifyLayerManifest(data, sig []byte, keys []string, platform, agent, channel, slug string) (layerManifest, error) {
	var m layerManifest
	fail := func() (layerManifest, error) { return m, errors.New("invalid or incompatible signed offline layer") }
	if !utf8.Valid(data) || len(data) > layerMaxMetadata || len(sig) != ed25519.SignatureSize {
		return fail()
	}
	trusted := false
	for _, key := range keys {
		block, _ := pem.Decode([]byte(key))
		if block == nil {
			continue
		}
		k, e := x509.ParsePKIXPublicKey(block.Bytes)
		if e != nil {
			continue
		}
		pub, ok := k.(ed25519.PublicKey)
		if ok && ed25519.Verify(pub, data, sig) {
			trusted = true
			break
		}
	}
	if !trusted {
		return m, errors.New("layer publisher signature verification failed")
	}
	var compact bytes.Buffer
	if json.Compact(&compact, data) != nil || !bytes.Equal(compact.Bytes(), data) {
		return fail()
	}
	dec := json.NewDecoder(bytes.NewReader(data))
	if uniqueJSON(dec) != nil {
		return fail()
	}
	if _, e := dec.Token(); e != io.EOF {
		return fail()
	}
	dec = json.NewDecoder(bytes.NewReader(data))
	dec.DisallowUnknownFields()
	if dec.Decode(&m) != nil {
		return fail()
	}
	if m.Format != "umiak-linux-layer/v1" || m.Arch != "amd64" || m.Distro != "ubuntu" || m.Release != "26.04" || m.BuilderAPI != 1 || m.BootTrust != "smbios-ca-sha256-v1" || !m.Verification.OK || !m.Verification.OfflineReplay {
		return fail()
	}
	if channel != "stable" && channel != "edge" || m.Channel != channel || m.Slug != slug || slug != "linux" && slug != "linux-desktop" || !layerVersionRE.MatchString(m.Version) || (channel == "edge") != strings.Contains(m.Version, "-edge.") {
		return fail()
	}
	if !layerRepoRE.MatchString(m.Sources.Repository) || len(m.Sources.Repository) > 255 || !strings.HasPrefix(m.Sources.Digest, "sha256:") || !layerDigestRE.MatchString(strings.TrimPrefix(m.Sources.Digest, "sha256:")) {
		return fail()
	}
	if !regexp.MustCompile(`^[a-f0-9]{40,64}$`).MatchString(m.SourceCommit) || !layerDigestRE.MatchString(m.RecipeSHA256) || !regexp.MustCompile(`^\d{8}T\d{6}Z$`).MatchString(m.AptSnapshot) {
		return fail()
	}
	if !regexp.MustCompile(`^\d{8}$`).MatchString(m.Base.Serial) || m.Base.URL != fmt.Sprintf("https://cloud-images.ubuntu.com/minimal/releases/resolute/release-%s/ubuntu-26.04-minimal-cloudimg-amd64.img", m.Base.Serial) || !layerDigestRE.MatchString(m.Base.SHA256) || m.Agent.Version == "" || len(m.Agent.Version) > 2048 || !layerDigestRE.MatchString(m.Agent.SHA256) {
		return fail()
	}
	for _, pair := range []struct {
		a, b  string
		lower bool
	}{{platform, m.MinPlatform, true}, {platform, m.MaxPlatform, false}, {agent, m.MinAgent, true}} {
		v, e := layerCompare(pair.a, pair.b)
		if e != nil || pair.lower && v < 0 || !pair.lower && v >= 0 {
			return fail()
		}
	}
	a := m.Archive
	if a.SizeBytes <= 0 || a.SizeBytes > layerMaxArchive || a.CompressedBytes <= 0 || a.CompressedBytes > layerMaxArchive || !layerDigestRE.MatchString(a.SHA256) || !layerDigestRE.MatchString(a.RawSHA256) || len(a.Chunks) == 0 || len(a.Chunks) > 512 {
		return fail()
	}
	var total int64
	for _, c := range a.Chunks {
		if c.SizeBytes <= 0 || c.SizeBytes > layerMaxChunk || !layerDigestRE.MatchString(c.SHA256) {
			return fail()
		}
		total += c.SizeBytes
	}
	if total != a.CompressedBytes {
		return fail()
	}
	if len(m.Files) == 0 || len(m.Files) > 4096 {
		return fail()
	}
	seen := map[string]bool{}
	total = 0
	for _, f := range m.Files {
		if !layerPathValid(f.Path) || seen[f.Path] || f.SizeBytes < 0 || f.SizeBytes > 4<<30 || !layerDigestRE.MatchString(f.SHA256) || f.Mode != 0644 && f.Mode != 0755 {
			return fail()
		}
		seen[f.Path] = true
		total += f.SizeBytes
	}
	if total > a.SizeBytes || m.Inventory.SizeBytes <= 0 || m.Inventory.SizeBytes > 32<<20 || !layerDigestRE.MatchString(m.Inventory.SHA256) {
		return fail()
	}
	inventoryFound := false
	for _, f := range m.Files {
		if f.Path == "licenses/inventory.json" && f.SHA256 == m.Inventory.SHA256 && f.SizeBytes == m.Inventory.SizeBytes {
			inventoryFound = true
		}
	}
	if !inventoryFound {
		return fail()
	}
	return m, nil
}
