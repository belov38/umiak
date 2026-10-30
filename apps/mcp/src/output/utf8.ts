export interface Utf8Chunk {
	text: string;
	/** Leading continuation bytes that were skipped (only when not at start). */
	startSkip: number;
	/** Trailing bytes of an incomplete sequence that were held back. */
	endHold: number;
}

function isContinuation(b: number): boolean {
	return (b & 0xc0) === 0x80;
}

function sequenceLength(lead: number): number {
	if (lead >= 0xc2 && lead <= 0xdf) return 2;
	if (lead >= 0xe0 && lead <= 0xef) return 3;
	if (lead >= 0xf0 && lead <= 0xf4) return 4;
	return 1;
}

/** Number of trailing bytes (at most 3) that start a valid but unfinished sequence. */
function incompleteTail(bytes: Uint8Array, from: number): number {
	const len = bytes.length;
	for (let i = len - 1; i >= Math.max(from, len - 3); i--) {
		const b = bytes[i] as number;
		if (isContinuation(b)) continue;
		const need = sequenceLength(b);
		return need > len - i ? len - i : 0;
	}
	return 0;
}

const decoder = new TextDecoder("utf-8", { fatal: false, ignoreBOM: true });

/**
 * Decodes one window of a byte stream. A window that starts in the middle of
 * a character (`atStart: false`) drops the stray continuation bytes; a window
 * that ends in the middle of a character (`final: false`) leaves those bytes
 * for the next read, so the caller's offset stays on a character boundary.
 * Invalid bytes become U+FFFD.
 */
export function decodeUtf8Chunk(
	bytes: Uint8Array,
	opts: { atStart: boolean; final: boolean },
): Utf8Chunk {
	let start = 0;
	if (!opts.atStart) {
		while (
			start < 3 &&
			start < bytes.length &&
			isContinuation(bytes[start] as number)
		) {
			start++;
		}
	}
	const endHold = opts.final ? 0 : incompleteTail(bytes, start);
	const text = decoder.decode(bytes.subarray(start, bytes.length - endHold));
	return { text, startSkip: start, endHold };
}
