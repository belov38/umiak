// Streaming UTF-8 decoder of one output stream (S7 §9.5). An incomplete
// multi-byte sequence at the end of a chunk (up to 3 bytes) is held until
// the next chunk, so every `nextOffset` sits on a character boundary and a
// reattach from it never splits a character. Invalid bytes become U+FFFD
// exactly as WHATWG TextDecoder does; offsets count the source bytes.

/** Bytes a sequence starting with `lead` needs; 0 for a byte that starts none. */
function sequenceLength(lead: number): number {
	if (lead >= 0xc2 && lead <= 0xdf) return 2;
	if (lead >= 0xe0 && lead <= 0xef) return 3;
	if (lead >= 0xf0 && lead <= 0xf4) return 4;
	return 0;
}

/** Allowed range of the second byte after `lead` (WHATWG UTF-8 decoder). */
function secondByteOk(lead: number, b: number): boolean {
	switch (lead) {
		case 0xe0:
			return b >= 0xa0 && b <= 0xbf;
		case 0xed:
			return b >= 0x80 && b <= 0x9f;
		case 0xf0:
			return b >= 0x90 && b <= 0xbf;
		case 0xf4:
			return b >= 0x80 && b <= 0x8f;
		default:
			return b >= 0x80 && b <= 0xbf;
	}
}

const isContinuation = (b: number) => (b & 0xc0) === 0x80;

/**
 * Length of the incomplete but still valid sequence at the end of `b`
 * (0-3): the bytes a streaming decoder would keep waiting for more.
 */
function heldSuffix(b: Uint8Array): number {
	const n = b.length;
	for (let back = 1; back <= Math.min(3, n); back++) {
		const i = n - back;
		const lead = b[i] as number;
		if (isContinuation(lead)) continue;
		const need = sequenceLength(lead);
		if (need <= back) return 0;
		for (let j = i + 1; j < n; j++) {
			const c = b[j] as number;
			const ok = j === i + 1 ? secondByteOk(lead, c) : isContinuation(c);
			if (!ok) return 0;
		}
		return back;
	}
	return 0;
}

export class Utf8StreamDecoder {
	readonly #decoder = new TextDecoder("utf-8");
	#held: Uint8Array = new Uint8Array(0);

	/** Bytes held back from the last push. */
	get pending(): number {
		return this.#held.length;
	}

	/**
	 * Decodes the held bytes plus `chunk`. `consumed` is how many bytes the
	 * returned text covers (held bytes of the previous push included).
	 */
	push(chunk: Uint8Array): { text: string; consumed: number } {
		let all = chunk;
		if (this.#held.length > 0) {
			all = new Uint8Array(this.#held.length + chunk.length);
			all.set(this.#held, 0);
			all.set(chunk, this.#held.length);
		}
		const keep = heldSuffix(all);
		const cut = all.length - keep;
		this.#held = all.slice(cut);
		// [0, cut) never ends inside a valid incomplete sequence, so a
		// one-shot decode equals what a streaming decoder emits for it.
		return {
			text: cut === 0 ? "" : this.#decoder.decode(all.subarray(0, cut)),
			consumed: cut,
		};
	}

	/** The held bytes at the end of the stream: one U+FFFD, or "". */
	flush(): string {
		const held = this.#held;
		this.#held = new Uint8Array(0);
		return held.length === 0 ? "" : this.#decoder.decode(held);
	}

	/** Drops held bytes (after `truncated`). */
	reset(): void {
		this.#held = new Uint8Array(0);
	}
}
