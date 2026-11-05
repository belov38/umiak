package ops

import "testing"

func TestTransferRemoveNeverDeletesReusedName(t *testing.T) {
	h := newHarness(nil)
	h.lvm.lvs[3].Attr = "Vwi-a-tz--"
	h.lvm.lvs[3].UUID = "aaaaaa-bbbbbb-cccccc-dddddd"
	if h.call(t, "lv.transferRemove", map[string]any{"name": "vm-500-disk-0", "uuid": "oldold-bbbbbb-cccccc-dddddd"}).OK {
		t.Fatal("reused name removed")
	}
	r := h.call(t, "lv.transferRemove", map[string]any{"name": "vm-500-disk-0", "uuid": "aaaaaa-bbbbbb-cccccc-dddddd"})
	if !r.OK {
		t.Fatalf("%v", r.Error)
	}
	if len(h.run.calls) != 1 || h.run.calls[0][2] != "--select" {
		t.Fatalf("must select immutable UUID: %v", h.run.calls)
	}
}
