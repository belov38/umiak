package ops

import (
	"github.com/belov38/umiak/services/node-agent/internal/lvm"
	"strings"
	"testing"
	"testing/fstest"
)

func TestTransferPublishRejectsUnownedAndAllowsOwnedTemplate(t *testing.T) {
	id := strings.Repeat("a", 32)
	name := "umiak-snap-" + id + "-scsi0"
	h := newHarness(fstest.MapFS{"etc/pve/qemu-server/598.conf": {Data: []byte("tags: umiak-tpl\n")}})
	h.lvm.lvs = append(h.lvm.lvs, lvm.LV{Name: name, SizeBytes: 512, PoolLV: "data", Attr: "Vwi-a-tz--", Tags: []string{"umiak", "umiak-snap-" + id, "umiak-transfer-" + id}})
	args := map[string]any{"name": name, "target": "vm-598-disk-0"}
	if !h.call(t, "lv.transferPublish", args).OK {
		t.Fatal("owned publish refused")
	}
	if !h.call(t, "lv.transferPublish", args).OK {
		t.Fatal("replay refused")
	}
	for _, target := range []string{"vm-108-disk-0", "base-598-disk-0", "vm-597-disk-0", "../../x"} {
		args["target"] = target
		if h.call(t, "lv.transferPublish", args).OK {
			t.Fatalf("allowed %s", target)
		}
	}
}
