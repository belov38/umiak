package desktop

// textBatch keeps one stable mapping for all queued events. Reusing one
// remapped keycode per character lets GUI toolkits coalesce MappingNotify and
// translate already-queued key events using the next character's mapping.
type textBatch struct {
	Symbols []uint32
	Codes   []int
}

func planTextBatches(text string, capacity int) []textBatch {
	var out []textBatch
	batch := textBatch{}
	symbols := map[rune]int{}
	for _, ch := range text {
		index, exists := symbols[ch]
		if !exists && len(symbols) == capacity {
			out = append(out, batch)
			batch = textBatch{}
			symbols = map[rune]int{}
		}
		if !exists {
			index = len(symbols)
			symbols[ch] = index
			batch.Symbols = append(batch.Symbols, keySymbol(string(ch)))
		}
		batch.Codes = append(batch.Codes, index)
	}
	if len(batch.Codes) > 0 {
		out = append(out, batch)
	}
	return out
}
