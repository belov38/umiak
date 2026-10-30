/**
 * The last `max` bytes of one output stream, with the stream offsets they
 * cover: `[from, to)`. Bytes come in order (`push` with the offset after
 * them); a retention gap (`truncate`) drops what is held.
 */
export class ByteTail {
	readonly max: number;
	/** Stream offset after the last byte seen. */
	to = 0;
	readonly #ring: Uint8Array;
	/** Index in the ring of the next byte to write. */
	#head = 0;
	#length = 0;

	constructor(max: number) {
		this.max = max;
		this.#ring = new Uint8Array(max);
	}

	/** Stream offset of the first byte held. */
	get from(): number {
		return this.to - this.#length;
	}

	/** `bytes` end at stream offset `nextOffset`. */
	push(bytes: Uint8Array, nextOffset: number): void {
		this.to = nextOffset;
		if (this.max === 0) return;
		const data =
			bytes.length > this.max ? bytes.subarray(bytes.length - this.max) : bytes;
		const first = Math.min(data.length, this.max - this.#head);
		this.#ring.set(data.subarray(0, first), this.#head);
		this.#ring.set(data.subarray(first), 0);
		this.#head = (this.#head + data.length) % this.max;
		this.#length = Math.min(this.max, this.#length + data.length);
	}

	/** The bytes before `availableFrom` are gone: the tail starts again there. */
	truncate(availableFrom: number): void {
		this.to = Math.max(this.to, availableFrom);
		this.#length = 0;
	}

	/** A copy of the bytes held, oldest first. */
	bytes(): Uint8Array {
		const out = new Uint8Array(this.#length);
		const start = (this.#head - this.#length + this.max) % (this.max || 1);
		const first = Math.min(this.#length, this.max - start);
		out.set(this.#ring.subarray(start, start + first), 0);
		out.set(this.#ring.subarray(0, this.#length - first), first);
		return out;
	}
}
