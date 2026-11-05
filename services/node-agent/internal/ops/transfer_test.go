package ops

import (
	"bytes"
	"crypto/sha256"
	"encoding/base64"
	"encoding/hex"
	"os"
	"path/filepath"
	"strings"
	"testing"

	"github.com/belov38/umiak/services/node-agent/internal/lvm"
)

func TestTransferReadImmutableOwnedOnly(t *testing.T) {
	h, opened := transferReadHarness(t, []byte("abcd"))
	h.lvm.lvs[1].SizeBytes = 4
	r := resultMap(t, h.call(t, "lv.transferRead", map[string]any{"name": "base-599-disk-0", "offset": 0, "length": 4}))
	if r["data"] != base64.StdEncoding.EncodeToString([]byte("abcd")) || r["sha256"] != "88d4266fd4e6338d13b845fcf289579d209c897823b9217da3e161936f031589" {
		t.Fatalf("block: %v", r)
	}
	for _, name := range []string{"vm-500-disk-0", "vm-108-disk-1", "base-9000-disk-0", "../etc/passwd"} {
		if h.call(t, "lv.transferRead", map[string]any{"name": name, "length": 4}).OK {
			t.Fatalf("allowed %s", name)
		}
	}
	if len(*opened) != 1 {
		t.Fatalf("opened: %v", *opened)
	}
}

func TestTransferBoundsAndHashOnly(t *testing.T) {
	h, opened := transferReadHarness(t, bytes.Repeat([]byte{0}, 100))
	h.lvm.lvs[1].SizeBytes = 100
	for _, args := range []map[string]any{
		{"name": "base-599-disk-0", "offset": -1, "length": 1},
		{"name": "base-599-disk-0", "offset": 0, "length": 0},
		{"name": "base-599-disk-0", "offset": 0, "length": 524289},
		{"name": "base-599-disk-0", "offset": 99, "length": 2},
	} {
		if h.call(t, "lv.transferRead", args).OK {
			t.Fatalf("allowed: %v", args)
		}
	}
	if len(*opened) != 0 {
		t.Fatal("opened invalid range")
	}
	r := resultMap(t, h.call(t, "lv.transferRead", map[string]any{"name": "base-599-disk-0", "length": 100, "hashOnly": true}))
	if _, ok := r["data"]; ok || r["zero"] != true {
		t.Fatalf("hashOnly: %v", r)
	}
}

func TestTransferSnapshotRequiresOwnerAndPool(t *testing.T) {
	h, _ := transferReadHarness(t, []byte("abcd"))
	lv := lvm.LV{Name: "umiak-snap-abcd-scsi0", SizeBytes: 4, PoolLV: "data", Attr: "Vwi-a-tz--", Tags: []string{"umiak", "umiak-snap-abcd"}}
	h.lvm.lvs = append(h.lvm.lvs, lv)
	if !h.call(t, "lv.transferRead", map[string]any{"name": lv.Name, "length": 4}).OK {
		t.Fatal("owned snapshot refused")
	}
	h.lvm.lvs[len(h.lvm.lvs)-1].PoolLV = "foreign"
	if h.call(t, "lv.transferRead", map[string]any{"name": lv.Name, "length": 4}).OK {
		t.Fatal("foreign pool accepted")
	}
	h.lvm.lvs[len(h.lvm.lvs)-1].PoolLV = "data"
	h.lvm.lvs[len(h.lvm.lvs)-1].Tags = []string{"umiak"}
	if h.call(t, "lv.transferRead", map[string]any{"name": lv.Name, "length": 4}).OK {
		t.Fatal("missing owner accepted")
	}
}

func TestTransferWriteRedactsPayloadAndRejectsPublishedLV(t *testing.T) {
	h := newHarness(nil)
	r := h.call(t, "lv.transferWrite", map[string]any{"name": "vm-500-disk-0", "offset": 0, "data": "guest-secret"})
	if r.OK {
		t.Fatal("published write allowed")
	}
	for _, line := range h.logs {
		if strings.Contains(line, "guest-secret") {
			t.Fatal("payload logged")
		}
	}
}

func TestTransferPrepareGuardsAndIdempotency(t *testing.T) {
	h := newHarness(nil)
	id := strings.Repeat("a", 32)
	args := map[string]any{"id": id, "slot": "scsi0", "sizeBytes": 512, "base": "base-599-disk-0"}
	h.lvm.lvs[1].SizeBytes = 512
	h.lvm.lvs[1].Attr = "Vri---tz-k"
	r := resultMap(t, h.call(t, "lv.transferPrepare", args))
	name := "umiak-snap-" + id + "-scsi0"
	if r["name"] != name {
		t.Fatalf("name: %v", r)
	}
	h.lvm.lvs[len(h.lvm.lvs)-1].SizeBytes = 512
	h.lvm.lvs[len(h.lvm.lvs)-1].PoolLV = "data"
	if !h.call(t, "lv.transferPrepare", args).OK {
		t.Fatal("retry refused")
	}
	for _, a := range []map[string]any{
		{"id": "../x", "slot": "scsi0", "sizeBytes": 512},
		{"id": id, "slot": "../../x", "sizeBytes": 512},
		{"id": id, "slot": "scsi0", "sizeBytes": 513},
		{"id": id, "slot": "scsi0", "sizeBytes": 1024, "base": "base-599-disk-0"},
		{"id": id, "slot": "scsi0", "sizeBytes": 512, "base": "vm-500-disk-0"},
	} {
		if h.call(t, "lv.transferPrepare", a).OK {
			t.Fatalf("accepted %v", a)
		}
	}
	// A same-named foreign volume is never adopted or overwritten.
	h.lvm.lvs[len(h.lvm.lvs)-1].Tags = []string{"umiak"}
	if h.call(t, "lv.transferPrepare", args).OK {
		t.Fatal("collision accepted")
	}
}

func TestTransferWriteChecksumsReplayAndReadback(t *testing.T) {
	h := newHarness(nil)
	id := strings.Repeat("b", 32)
	name := "umiak-snap-" + id + "-scsi0"
	h.lvm.lvs = append(h.lvm.lvs, lvm.LV{Name: name, SizeBytes: 512, PoolLV: "data", Attr: "Vwi-a-tz--", Tags: []string{"umiak", "umiak-snap-" + id, "umiak-transfer-" + id}})
	path := filepath.Join(t.TempDir(), "disk")
	if err := os.WriteFile(path, make([]byte, 512), 0600); err != nil {
		t.Fatal(err)
	}
	opens := 0
	h.srv.TransferOpen = func(got string) (*os.File, error) {
		if got != "/dev/pve/"+name {
			t.Fatalf("path %s", got)
		}
		opens++
		return os.OpenFile(path, os.O_RDWR, 0) //nolint:gosec // test-owned temporary file
	}
	data := []byte("guest-secret")
	hash := sha256.Sum256(data)
	args := map[string]any{"name": name, "offset": 10, "data": base64.StdEncoding.EncodeToString(data), "sha256": hex.EncodeToString(hash[:])}
	for range 2 {
		if !h.call(t, "lv.transferWrite", args).OK {
			t.Fatal("write failed")
		}
	}
	got, err := os.ReadFile(path) //nolint:gosec // test-owned temporary file
	if err != nil {
		t.Fatal(err)
	}
	if !bytes.Equal(got[10:10+len(data)], data) || opens != 2 {
		t.Fatal("bad write")
	}
	args["sha256"] = "bad"
	if h.call(t, "lv.transferWrite", args).OK || opens != 2 {
		t.Fatal("corrupt block opened device")
	}
	args["sha256"] = hex.EncodeToString(hash[:])
	h.lvm.lvs[len(h.lvm.lvs)-1].Attr = "Vwi-aotz--"
	if h.call(t, "lv.transferWrite", args).OK || opens != 2 {
		t.Fatal("open LV written")
	}
	for _, line := range h.logs {
		if strings.Contains(line, args["data"].(string)) {
			t.Fatal("base64 payload logged")
		}
	}
}

func TestTransferDigestRunsOnNode(t *testing.T) {
	h, _ := transferReadHarness(t, []byte("abcd"))
	h.lvm.lvs[1].SizeBytes = 4
	r := resultMap(t, h.call(t, "lv.transferDigest", map[string]any{"name": "base-599-disk-0"}))
	if r["sha256"] != "88d4266fd4e6338d13b845fcf289579d209c897823b9217da3e161936f031589" {
		t.Fatalf("digest: %v", r)
	}
	if h.call(t, "lv.transferDigest", map[string]any{"name": "vm-500-disk-0"}).OK {
		t.Fatal("mutable disk allowed")
	}
}

func TestTransferReadRejectsOpenAndUnknownDeviceState(t *testing.T) {
	h, _ := transferReadHarness(t, []byte("abcd"))
	h.lvm.lvs[1].SizeBytes = 4
	for _, attr := range []string{"Vwi-aotz--", ""} {
		h.lvm.lvs[1].Attr = attr
		if h.call(t, "lv.transferRead", map[string]any{"name": "base-599-disk-0", "length": 4}).OK {
			t.Fatalf("allowed device state %q", attr)
		}
	}
}

func transferReadHarness(t *testing.T, data []byte) (*harness, *[]string) {
	t.Helper()
	h, opened := scanHarness(t, data)
	h.lvm.lvs[1].Attr = "Vri---tz-k"
	return h, opened
}
