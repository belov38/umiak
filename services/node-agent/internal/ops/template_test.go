package ops

import (
	"slices"
	"testing"
	"testing/fstest"

	"github.com/belov38/boat-dev-clone/services/node-agent/internal/lvm"
)

const tplConf = "boot: order=scsi0\nname: sbx-tpl-linux-20261030-15\nscsi0: local-lvm:base-598-disk-0,discard=on,size=64G\ntags: sbx-tpl\ntemplate: 1\n"

func TestLvTagTemplateTagsTheDisksOfAnSbxTemplate(t *testing.T) {
	h := newHarness(fstest.MapFS{"etc/pve/qemu-server/598.conf": {Data: []byte(tplConf)}})
	h.lvm.lvs = append(h.lvm.lvs, lvm.LV{Name: "base-598-disk-0", Tags: []string{}}, lvm.LV{Name: "vm-598-disk-1", Tags: []string{}})
	m := resultMap(t, h.call(t, "lv.tagTemplate", map[string]any{"vmid": 598}))
	if !slices.Equal(namesList(m["tagged"]), []string{"base-598-disk-0"}) {
		t.Fatalf("result %v", m)
	}
	want := []string{"lvchange", "--addtag", "sbx-tpl", "pve/base-598-disk-0"}
	if len(h.run.calls) != 1 || !slices.Equal(h.run.calls[0], want) {
		t.Fatalf("calls %v", h.run.calls)
	}
}

func TestLvTagTemplateRefusesOthers(t *testing.T) {
	notTemplate := "name: x\ntags: sbx-tpl\n"
	notTagged := "name: x\ntags: sbx\ntemplate: 1\n"
	// The marker only in a snapshot section does not count.
	inSnapshot := "name: x\n\n[snap1]\ntags: sbx-tpl\ntemplate: 1\n"
	files := fstest.MapFS{
		"etc/pve/qemu-server/597.conf": {Data: []byte(notTemplate)},
		"etc/pve/qemu-server/599.conf": {Data: []byte(notTagged)},
		"etc/pve/qemu-server/598.conf": {Data: []byte(inSnapshot)},
		"etc/pve/qemu-server/590.conf": {Data: []byte(tplConf)},
	}
	h := newHarness(files)
	h.lvm.lvs = append(h.lvm.lvs, lvm.LV{Name: "base-597-disk-0"}, lvm.LV{Name: "base-598-disk-0"}, lvm.LV{Name: "base-590-disk-0"})
	for _, id := range []int{597, 599, 598, 590, 500, 596} {
		if r := h.call(t, "lv.tagTemplate", map[string]any{"vmid": id}); r.OK {
			t.Errorf("vmid %d: accepted", id)
		}
	}
	if len(h.run.calls) != 0 {
		t.Fatalf("calls %v", h.run.calls)
	}
}

func TestLvScanAndUsageRefuseUntaggedAndDevInfra(t *testing.T) {
	h, opened := scanHarness(t, []byte("anything"))
	h.lvm.lvs = append(h.lvm.lvs,
		lvm.LV{Name: "vm-590-disk-0", Tags: []string{}},                    // dev control plane CT
		lvm.LV{Name: "vm-501-disk-0", Tags: []string{}},                    // a guest in our range, not ours
		lvm.LV{Name: "vm-502-disk-0", Tags: []string{"sbx", "sbx-vm-501"}}, // wrong owner tag
		lvm.LV{Name: "base-598-disk-0", Tags: []string{}},                  // template slot, untagged
	)
	for _, name := range []string{"vm-590-disk-0", "vm-501-disk-0", "vm-502-disk-0", "base-598-disk-0"} {
		if r := h.call(t, "lv.scan", map[string]any{"name": name, "patterns": []string{"12345678"}}); r.OK {
			t.Errorf("lv.scan %s: accepted", name)
		}
		if r := h.call(t, "lv.usage", map[string]any{"name": name}); r.OK {
			t.Errorf("lv.usage %s: accepted", name)
		}
	}
	if len(*opened) != 0 || len(h.run.calls) != 0 {
		t.Fatalf("opened %v, activations %v", *opened, h.run.calls)
	}
}

func TestSnapshotRefusesAnUntaggedTemplateOrigin(t *testing.T) {
	h := newHarness(nil)
	h.lvm.lvs = append(h.lvm.lvs, lvm.LV{Name: "base-598-disk-0", Tags: []string{}})
	r := h.call(t, "lv.snapshot", map[string]any{"items": []map[string]any{
		{"origin": "base-598-disk-0", "name": "vm-501-disk-0", "tags": []string{"sbx", "sbx-vm-501"}},
	}})
	if r.OK || len(h.lvm.created) != 0 {
		t.Fatalf("untagged template origin accepted: %+v", r)
	}
}

func namesList(v any) []string {
	out := []string{}
	for _, e := range v.([]any) {
		out = append(out, e.(string))
	}
	return out
}
