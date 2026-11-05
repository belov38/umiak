package ops

import (
	"encoding/json"
	"github.com/belov38/umiak/services/node-agent/internal/lvm"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"testing/fstest"
)

func TestVolumeSendRejectsForeignAndUntrustedDestinations(t *testing.T) {
	h := newHarness(fstest.MapFS{"etc/pve/storage.cfg": {Data: []byte("lvmthin: local-lvm\n\tvgname pve\n\tthinpool data\n")}, "etc/pve/.members": {Data: []byte(`{"nodelist":{"pve":{"online":1,"ip":"192.168.1.1"},"pve2":{"online":1,"ip":"192.168.1.2"},"offline":{"online":0,"ip":"192.168.1.3"}}}`)}})
	h.lvm.lvs[1].UUID = "source-uuid"
	h.lvm.lvs[1].Attr = "Vri---tz-k"
	for _, a := range []map[string]any{
		{"volume": "local-lvm:vm-108-disk-0", "targetNode": "pve2", "targetName": "umiak-snap-" + strings.Repeat("a", 32) + "-scsi0", "targetVmid": 598},
		{"volume": "local-lvm:base-599-disk-0", "targetNode": "offline", "targetName": "umiak-snap-" + strings.Repeat("a", 32) + "-scsi0", "targetVmid": 598},
		{"volume": "local-lvm:base-599-disk-0", "targetNode": "pve2;id", "targetName": "umiak-snap-" + strings.Repeat("a", 32) + "-scsi0", "targetVmid": 598},
		{"volume": "local-lvm:base-599-disk-0", "targetNode": "pve2", "targetName": "vm-108-disk-0", "targetVmid": 598},
	} {
		if h.call(t, "volume.sendTo", a).OK {
			t.Fatalf("accepted %#v", a)
		}
	}
}

func TestVolumeReceiveRejectsForeignNamesBeforeStartingCommands(t *testing.T) {
	h := newHarness(nil)
	for _, name := range []string{"vm-108-disk-0", "umiak-snap-../bad-scsi0", "base-599-disk-0"} {
		raw, _ := json.Marshal(VolumeReceiveArgs{TargetName: name, TargetVmid: 598, SourceNode: "pve2", SourceUUID: "source-uuid", SizeBytes: 512})
		if _, err := h.srv.ReceiveVolume(t.Context(), raw, strings.NewReader("bad")); err == nil {
			t.Fatal("accepted", name)
		}
	}
	if len(h.run.calls) != 0 {
		t.Fatal("ran a command before validation")
	}
}

func TestVerifiedImportReceiptIsBoundToSourceAndLVGeneration(t *testing.T) {
	id := strings.Repeat("a", 32)
	name := "umiak-snap-" + id + "-scsi0"
	h := newHarness(fstest.MapFS{"etc/pve/storage.cfg": {Data: []byte("lvmthin: local-lvm\n\tvgname pve\n\tthinpool data\n")}, "etc/pve/.members": {Data: []byte(`{"nodelist":{"pve2":{"online":1,"ip":"192.168.1.2"}}}`)}})
	h.srv.Cfg.StateDir = t.TempDir()
	a := VolumeReceiveArgs{TargetName: name, TargetVmid: 598, SourceNode: "pve2", SourceUUID: "source-uuid", SizeBytes: 512, Probe: true}
	r := VolumeReceipt{Name: name, SourceUUID: a.SourceUUID, UUID: "target-uuid", SHA256: strings.Repeat("b", 64), SizeBytes: 512, Verified: true}
	dir := filepath.Join(h.srv.Cfg.StateDir, "volume-imports")
	if err := os.MkdirAll(dir, 0700); err != nil {
		t.Fatal(err)
	}
	record := importRecord{Args: a, Receipt: r}
	b, _ := json.Marshal(record)
	if err := os.WriteFile(filepath.Join(dir, id+"-scsi0.json"), b, 0600); err != nil {
		t.Fatal(err)
	}
	h.lvm.lvs = append(h.lvm.lvs, lvm.LV{Name: name, UUID: r.UUID, SizeBytes: 512, PoolLV: "data", Attr: "Vwi-a-tz--", Tags: []string{"umiak", "umiak-snap-" + id, "umiak-transfer-" + id}})
	raw, _ := json.Marshal(a)
	got, err := h.srv.ReceiveVolume(t.Context(), raw, strings.NewReader(""))
	if err != nil || !got.Verified {
		t.Fatalf("receipt: %#v %v", got, err)
	}
	h.lvm.lvs[len(h.lvm.lvs)-1].UUID = "another-uuid"
	got, err = h.srv.ReceiveVolume(t.Context(), raw, strings.NewReader(""))
	if err != nil || got.Verified {
		t.Fatalf("reused receipt for another generation: %#v %v", got, err)
	}
	a.SourceUUID = "different-source"
	raw, _ = json.Marshal(a)
	if _, err = h.srv.ReceiveVolume(t.Context(), raw, strings.NewReader("")); err == nil {
		t.Fatal("allowed source generation collision")
	}
}

func TestSnapshotExportsFreezeTheirSource(t *testing.T) {
	h := newHarness(nil)
	lv := lvm.LV{Name: "umiak-snap-" + strings.Repeat("a", 32) + "-scsi0", Attr: "Vwi-a-tz--"}
	if err := h.srv.freezeTransferSource(t.Context(), lv); err != nil {
		t.Fatal(err)
	}
	if len(h.run.calls) != 1 || strings.Join(h.run.calls[0], " ") != "lvchange -pr pve/"+lv.Name {
		t.Fatal(h.run.calls)
	}
	if err := h.srv.freezeTransferSource(t.Context(), lvm.LV{Name: "base-599-disk-0", Attr: "Vwi-a-tz--"}); err == nil {
		t.Fatal("writable template accepted as immutable")
	}
}

func TestFullCopyRejectsStorageAliasesToOtherPools(t *testing.T) {
	for _, config := range []string{"dir: local-lvm\n\tpath /foreign\n", "lvmthin: local-lvm\n\tvgname foreign\n\tthinpool data\n", "lvmthin: local-lvm\n\tvgname pve\n\tthinpool foreign\n"} {
		h := newHarness(fstest.MapFS{"etc/pve/storage.cfg": {Data: []byte(config)}})
		if err := h.srv.validateTransferStorage(); err == nil {
			t.Fatal("accepted", config)
		}
	}
}
