package ops

import (
	"bytes"
	"io"
	"slices"
	"strings"
	"testing"
)

func TestCountPatternsAcrossChunksAndZeros(t *testing.T) {
	secret := []byte("s3cr3t-signing-key-line")
	disk := make([]byte, 3*scanChunk)
	// One copy straddles the first chunk border, one sits in the middle of the last chunk.
	copy(disk[scanChunk-5:], secret)
	copy(disk[2*scanChunk+100:], secret)
	m, scanned, err := countPatterns(bytes.NewReader(disk), [][]byte{secret, []byte("not-there-at-all")})
	if err != nil {
		t.Fatal(err)
	}
	if m != 2 || scanned != int64(len(disk)) {
		t.Fatalf("matches %d scanned %d, want 2 and %d", m, scanned, len(disk))
	}
}

func TestCountPatternsZeroDiskIsClean(t *testing.T) {
	m, scanned, err := countPatterns(bytes.NewReader(make([]byte, 2*scanChunk+7)), [][]byte{[]byte("abcdefgh")})
	if err != nil || m != 0 || scanned != 2*scanChunk+7 {
		t.Fatalf("got %d %d %v", m, scanned, err)
	}
}

func TestCountPatternsOverlappingAndRepeated(t *testing.T) {
	m, _, err := countPatterns(strings.NewReader("xxaaaaaaaaayy"), [][]byte{[]byte("aaaaaaaa")})
	if err != nil || m != 2 {
		t.Fatalf("matches %d, want 2 (overlapping)", m)
	}
}

func scanHarness(t *testing.T, disk []byte) (*harness, *[]string) {
	t.Helper()
	h := newHarness(nil)
	opened := []string{}
	h.srv.ScanOpen = func(path string) (io.ReadCloser, error) {
		opened = append(opened, path)
		return io.NopCloser(bytes.NewReader(disk)), nil
	}
	return h, &opened
}

func TestLvScanTemplateActivatesAndRestores(t *testing.T) {
	disk := []byte("....the-update-signing-key....")
	h, opened := scanHarness(t, disk)
	r := h.call(t, "lv.scan", map[string]any{"name": "base-599-disk-0", "patterns": []string{"update-signing-key", "pve-token-secret"}})
	m := resultMap(t, r)
	if m["matches"].(float64) != 1 || m["scannedBytes"].(float64) != float64(len(disk)) {
		t.Fatalf("result %v", m)
	}
	if !slices.Equal(*opened, []string{"/dev/pve/base-599-disk-0"}) {
		t.Fatalf("opened %v", *opened)
	}
	want := [][]string{{"lvchange", "-ay", "-K", "pve/base-599-disk-0"}, {"lvchange", "-an", "pve/base-599-disk-0"}}
	if len(h.run.calls) != 2 || !slices.Equal(h.run.calls[0], want[0]) || !slices.Equal(h.run.calls[1], want[1]) {
		t.Fatalf("calls %v", h.run.calls)
	}
	for _, l := range h.logs {
		if strings.Contains(l, "update-signing-key") || strings.Contains(l, "pve-token-secret") {
			t.Fatalf("pattern in log: %s", l)
		}
	}
}

func TestLvScanActiveVMDiskIsNotToggled(t *testing.T) {
	h, _ := scanHarness(t, []byte("clean"))
	for i := range h.lvm.lvs {
		if h.lvm.lvs[i].Name == "vm-500-disk-0" {
			h.lvm.lvs[i].Attr = "Vwi-aotz--"
		}
	}
	m := resultMap(t, h.call(t, "lv.scan", map[string]any{"name": "vm-500-disk-0", "patterns": []string{"12345678"}}))
	if m["matches"].(float64) != 0 || len(h.run.calls) != 0 {
		t.Fatalf("result %v calls %v", m, h.run.calls)
	}
}

func TestLvScanRefusesForeignAndBadInput(t *testing.T) {
	h, opened := scanHarness(t, nil)
	cases := []map[string]any{
		{"name": "vm-108-disk-1", "patterns": []string{"12345678"}},    // outside the range
		{"name": "data", "patterns": []string{"12345678"}},             // the thin pool
		{"name": "base-9000-disk-0", "patterns": []string{"12345678"}}, // a foreign template
		{"name": "../root", "patterns": []string{"12345678"}},          // not an LV name
		{"name": "base-599-disk-0", "patterns": []string{"short"}},     // too short a pattern
		{"name": "base-599-disk-0", "patterns": []string{}},            // no patterns
		{"name": "base-598-disk-0", "patterns": []string{"12345678"}},  // absent LV
		{"name": "vm-500-cloudinit", "patterns": []string{"12345678"}}, // not a disk name
	}
	for _, c := range cases {
		if r := h.call(t, "lv.scan", c); r.OK {
			t.Errorf("%v: accepted", c)
		}
	}
	if len(*opened) != 0 || len(h.run.calls) != 0 {
		t.Fatalf("opened %v calls %v", *opened, h.run.calls)
	}
}

func TestLvUsageActivatesTemplateForTheReading(t *testing.T) {
	h := newHarness(nil)
	for i := range h.lvm.lvs {
		if h.lvm.lvs[i].Name == "base-599-disk-0" {
			h.lvm.lvs[i].SizeBytes = 64 << 30
			h.lvm.lvs[i].DataPercent = 11.4
		}
	}
	m := resultMap(t, h.call(t, "lv.usage", map[string]any{"name": "base-599-disk-0"}))
	if m["dataPercent"].(float64) != 11.4 || m["sizeBytes"].(float64) != float64(64<<30) {
		t.Fatalf("result %v", m)
	}
	if len(h.run.calls) != 2 || h.run.calls[0][1] != "-ay" || h.run.calls[1][1] != "-an" {
		t.Fatalf("calls %v", h.run.calls)
	}
	if r := h.call(t, "lv.usage", map[string]any{"name": "vm-108-disk-1"}); r.OK {
		t.Fatal("foreign LV accepted")
	}
}
