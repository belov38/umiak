package ops

import "testing"

func TestThinRangesIncludeDiscardedBaseBlocks(t *testing.T) {
	xml := `<superblock data_block_size="128"><diff><same begin="0" length="10"/><left_only begin="10" length="2"/><right_only begin="20" length="1"/><different begin="30" length="3"/></diff></superblock>`
	r, err := thinRanges([]byte(xml), true, 64<<20)
	if err != nil || len(r) != 3 || r[0].Offset != 10*65536 || r[1].Offset != 20*65536 {
		t.Fatalf("%v %v", r, err)
	}
}
func TestThinRangesDumpAndRejectBadMetadata(t *testing.T) {
	xml := `<superblock data_block_size="128"><device><range_mapping origin_begin="2" length="3"/><single_mapping origin_block="8"/></device></superblock>`
	r, err := thinRanges([]byte(xml), false, 1<<20)
	if err != nil || len(r) != 2 || r[1].Length != 65536 {
		t.Fatalf("%v %v", r, err)
	}
	for _, x := range []string{`<superblock data_block_size="0"/>`, `<superblock data_block_size="128"><different begin="999999999" length="2"/></superblock>`, `broken`} {
		if _, err := thinRanges([]byte(x), true, 1<<20); err == nil {
			t.Fatal("invalid metadata accepted")
		}
	}
}

func TestTransferMapUsesOnlyTrustedInventoryAndReleasesReservation(t *testing.T) {
	h, _ := transferReadHarness(t, nil)
	h.lvm.lvs[1].SizeBytes = 1 << 20
	h.lvm.lvs[1].ThinID = "17"
	h.run.out["thin_dump"] = `<superblock data_block_size="128"><device><single_mapping origin_block="3"/></device></superblock>`
	r := resultMap(t, h.call(t, "lv.transferMap", map[string]any{"name": "base-599-disk-0"}))
	if r["sizeBytes"] != float64(1<<20) || len(h.run.calls) != 3 {
		t.Fatalf("%v %v", r, h.run.calls)
	}
	if h.run.calls[0][4] != "reserve_metadata_snap" || h.run.calls[2][4] != "release_metadata_snap" {
		t.Fatalf("%v", h.run.calls)
	}
	if h.call(t, "lv.transferMap", map[string]any{"name": "base-599-disk-0", "thinId": "99"}).OK {
		t.Fatal("caller device ID accepted")
	}
}
