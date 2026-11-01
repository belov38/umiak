package desktop

import "testing"

func TestTextMappingsStayStableForQueuedEvents(t *testing.T) {
	text := "printf '%s' 'Привет 世界' > /tmp/input"
	batches := planTextBatches(text, 64)
	if len(batches) != 1 {
		t.Fatal(len(batches))
	}
	var actual []uint32
	for _, batch := range batches {
		for _, code := range batch.Codes {
			actual = append(actual, batch.Symbols[code])
		}
	}
	expected := []rune(text)
	for i, ch := range expected {
		if actual[i] != keySymbol(string(ch)) {
			t.Fatalf("symbol %d", i)
		}
	}
	// A tiny mapping table still preserves every character across batch changes.
	batches = planTextBatches("abcdab", 2)
	if len(batches) != 3 {
		t.Fatal(batches)
	}
}
