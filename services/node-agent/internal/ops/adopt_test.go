package ops

import (
	"slices"
	"testing"
	"testing/fstest"

	"github.com/belov38/boat-dev-clone/services/node-agent/internal/lvm"
)

// A Windows clone after S1 create: efidisk0 and scsi0 are our tagged snapshots, tpmstate0 was
// allocated by Proxmox without tags. The [snap] section and other storages do not count.
const winCloneConf = `bios: ovmf
efidisk0: local-lvm:vm-500-disk-0,efitype=4m,pre-enrolled-keys=1,size=4M
ide2: local:iso/virtio-win.iso,media=cdrom
name: sbx-500
sata1: other:vm-500-disk-7,size=1G
scsi0: local-lvm:vm-500-disk-1,discard=on,iothread=1,size=100G,ssd=1
scsi1: local-lvm:vm-501-disk-0,size=1G
tags: sbx
tpmstate0: local-lvm:vm-500-disk-2,size=4M,version=v2.0
unused0: local-lvm:vm-500-disk-5

[snap1]
virtio1: local-lvm:vm-500-disk-4,size=1G
`

func adoptHarness(conf string) *harness {
	h := newHarness(fstest.MapFS{"etc/pve/qemu-server/500.conf": {Data: []byte(conf)}})
	h.lvm.lvs = []lvm.LV{
		{Name: "vm-500-disk-0", Tags: []string{"sbx", "sbx-vm-500"}},
		{Name: "vm-500-disk-1", Tags: []string{"sbx", "sbx-vm-500"}},
		{Name: "vm-500-disk-2", Tags: []string{}},
		{Name: "vm-500-disk-4", Tags: []string{}},
		{Name: "vm-500-disk-5", Tags: []string{}},
		{Name: "vm-500-disk-7", Tags: []string{}},
		{Name: "vm-501-disk-0", Tags: []string{}},
	}
	return h
}

func TestLvAdoptTagsTheUntaggedDisksOfASandboxVM(t *testing.T) {
	h := adoptHarness(winCloneConf)
	m := resultMap(t, h.call(t, "lv.adopt", map[string]any{"vmid": 500}))
	if !slices.Equal(namesList(m["tagged"]), []string{"vm-500-disk-2"}) ||
		!slices.Equal(namesList(m["already"]), []string{"vm-500-disk-0", "vm-500-disk-1"}) {
		t.Fatalf("result %v", m)
	}
	want := [][]string{{"lvchange", "--addtag", "sbx", "--addtag", "sbx-vm-500", "pve/vm-500-disk-2"}}
	if !slices.EqualFunc(h.run.calls, want, slices.Equal) {
		t.Fatalf("calls %v", h.run.calls)
	}
}

func TestLvAdoptAddsOnlyTheMissingTag(t *testing.T) {
	h := adoptHarness(winCloneConf)
	h.lvm.lvs[2].Tags = []string{"sbx"}
	m := resultMap(t, h.call(t, "lv.adopt", map[string]any{"vmid": 500}))
	if !slices.Equal(namesList(m["tagged"]), []string{"vm-500-disk-2"}) {
		t.Fatalf("result %v", m)
	}
	want := [][]string{{"lvchange", "--addtag", "sbx-vm-500", "pve/vm-500-disk-2"}}
	if !slices.EqualFunc(h.run.calls, want, slices.Equal) {
		t.Fatalf("calls %v", h.run.calls)
	}
}

func TestLvAdoptRefusesOthers(t *testing.T) {
	files := fstest.MapFS{
		"etc/pve/qemu-server/500.conf": {Data: []byte("scsi0: local-lvm:vm-500-disk-0\ntags: sbx\ntemplate: 1\n")},
		"etc/pve/qemu-server/501.conf": {Data: []byte("scsi0: local-lvm:vm-501-disk-0\ntags: other\n")},
		"etc/pve/qemu-server/590.conf": {Data: []byte("scsi0: local-lvm:vm-590-disk-0\ntags: sbx\n")},
		"etc/pve/qemu-server/598.conf": {Data: []byte("scsi0: local-lvm:vm-598-disk-0\ntags: sbx\n")},
		"etc/pve/qemu-server/599.conf": {Data: []byte("scsi0: local-lvm:vm-599-disk-0\ntags: sbx\n")},
	}
	h := newHarness(files)
	for _, id := range []int{500, 501, 502, 590, 598, 599, 108} {
		if r := h.call(t, "lv.adopt", map[string]any{"vmid": id}); r.OK || r.Error.Code != "forbidden" {
			t.Errorf("vmid %d: %+v", id, r)
		}
	}
	for _, args := range []any{map[string]any{"vmid": 500, "extra": 1}, map[string]any{"vmid": "500"}} {
		if r := h.call(t, "lv.adopt", args); r.OK || r.Error.Code != "bad_request" {
			t.Errorf("args %v: %+v", args, r)
		}
	}
	if len(h.run.calls) != 0 {
		t.Fatalf("calls %v", h.run.calls)
	}
}

func TestLvAdoptRefusesATemplateDisk(t *testing.T) {
	h := adoptHarness(winCloneConf)
	h.lvm.lvs[2].Tags = []string{"sbx-tpl"}
	if r := h.call(t, "lv.adopt", map[string]any{"vmid": 500}); r.OK || r.Error.Code != "forbidden" {
		t.Fatalf("%+v", r)
	}
	if len(h.run.calls) != 0 {
		t.Fatalf("calls %v", h.run.calls)
	}
}

func TestSnapshotAcceptsAnAdoptedTPMDisk(t *testing.T) {
	h := adoptHarness(winCloneConf)
	item := map[string]any{"items": []map[string]any{
		{"origin": "vm-500-disk-2", "name": "sbx-snap-abc-tpmstate0", "tags": []string{"sbx", "sbx-snap-abc"}},
	}}
	if r := h.call(t, "lv.snapshot", item); r.OK {
		t.Fatalf("untagged origin accepted: %+v", r)
	}
	// The fake runner does not change tags; model what lvchange did.
	resultMap(t, h.call(t, "lv.adopt", map[string]any{"vmid": 500}))
	h.lvm.lvs[2].Tags = []string{"sbx", "sbx-vm-500"}
	resultMap(t, h.call(t, "lv.snapshot", item))
}
