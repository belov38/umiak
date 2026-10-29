// Streaming UTF-8 decoder of the NDJSON frames (S7 §9.5, Review Focus 3):
// a character cut between agent chunks is held back, `consumed` keeps
// `nextOffset` on a character boundary, and a reattach from any such
// offset decodes to the same text as one pass.
import fc from "fast-check";
import { describe, expect, it } from "vitest";
import { Utf8StreamDecoder } from "../src/commands/utf8.ts";

const enc = new TextEncoder();
const reference = (b: Uint8Array) => new TextDecoder().decode(b);

/** Decodes `bytes` pushed in pieces cut at `cuts`; returns text and boundaries. */
function decodeInPieces(
	bytes: Uint8Array,
	cuts: number[],
): { text: string; boundaries: number[]; consumed: number } {
	const d = new Utf8StreamDecoder();
	const points = [...new Set(cuts.map((c) => c % (bytes.length + 1)))].sort(
		(a, b) => a - b,
	);
	let text = "";
	let consumed = 0;
	const boundaries: number[] = [];
	let at = 0;
	for (const p of [...points, bytes.length]) {
		if (p < at) continue;
		const r = d.push(bytes.subarray(at, p));
		text += r.text;
		consumed += r.consumed;
		boundaries.push(consumed);
		at = p;
	}
	const tail = d.flush();
	return { text: text + tail, boundaries, consumed };
}

describe("Utf8StreamDecoder", () => {
	const samples = ["a", "é", "€", "😀", "a€😀é z"];

	for (const s of samples) {
		it(`every cut of ${JSON.stringify(s)} gives the same text and boundary offsets`, () => {
			const bytes = enc.encode(s);
			for (let cut = 0; cut <= bytes.length; cut++) {
				const d = new Utf8StreamDecoder();
				const a = d.push(bytes.subarray(0, cut));
				const b = d.push(bytes.subarray(cut));
				expect(a.text + b.text + d.flush()).toBe(s);
				expect(a.consumed + b.consumed).toBe(bytes.length);
				// The first part ends on a character boundary.
				expect(reference(bytes.subarray(0, a.consumed))).toBe(a.text);
				expect(a.text.includes("�")).toBe(false);
			}
		});
	}

	it("one byte at a time: each character comes out whole", () => {
		const bytes = enc.encode("x😀y€");
		const d = new Utf8StreamDecoder();
		const out: { text: string; consumed: number }[] = [];
		for (const b of bytes) out.push(d.push(Uint8Array.of(b)));
		expect(out.map((o) => o.text)).toEqual([
			"x",
			"",
			"",
			"",
			"😀",
			"y",
			"",
			"",
			"€",
		]);
		expect(out.map((o) => o.consumed)).toEqual([1, 0, 0, 0, 4, 1, 0, 0, 3]);
		expect(d.flush()).toBe("");
	});

	it("invalid bytes become U+FFFD like TextDecoder, offsets count source bytes", () => {
		const cases: number[][] = [
			[0xff],
			[0x80, 0x41],
			[0xc0, 0xaf],
			[0xe0, 0x80, 0x80],
			[0xed, 0xa0, 0x80],
			[0xf4, 0x90, 0x80, 0x80],
			[0xe2, 0x82, 0x41],
			[0xf0, 0x9f, 0x98],
			[0xe2, 0x82, 0xe2, 0x82, 0xac],
		];
		for (const c of cases) {
			const bytes = Uint8Array.from(c);
			const r = decodeInPieces(bytes, [1, 2]);
			expect(r.text).toBe(reference(bytes));
			expect(r.text).toContain("�");
		}
	});

	it("flush emits a held incomplete sequence as one U+FFFD", () => {
		const d = new Utf8StreamDecoder();
		expect(d.push(Uint8Array.of(0x41, 0xf0, 0x9f))).toEqual({
			text: "A",
			consumed: 1,
		});
		expect(d.pending).toBe(2);
		expect(d.flush()).toBe("�");
		expect(d.pending).toBe(0);
		expect(d.flush()).toBe("");
	});

	it("property: any bytes, any cuts: same text as TextDecoder, consumed == length", () => {
		fc.assert(
			fc.property(
				fc.oneof(
					fc.uint8Array({ maxLength: 64 }),
					fc
						.string({ unit: "binary", maxLength: 32 })
						.map((s) => enc.encode(s)),
				),
				fc.array(fc.nat(), { maxLength: 8 }),
				(bytes, cuts) => {
					const r = decodeInPieces(bytes, cuts);
					expect(r.text).toBe(reference(bytes));
					// Held bytes are flushed at the end and counted there.
					expect(r.consumed).toBeLessThanOrEqual(bytes.length);
					expect(bytes.length - r.consumed).toBeLessThanOrEqual(3);
				},
			),
			{ numRuns: 2000 },
		);
	});

	it("property: reattach from any nextOffset decodes to the same text", () => {
		fc.assert(
			fc.property(
				fc.string({ unit: "binary", maxLength: 40 }).map((s) => enc.encode(s)),
				fc.array(fc.nat(), { maxLength: 6 }),
				fc.nat(),
				(bytes, cuts, pick) => {
					const first = decodeInPieces(bytes, cuts);
					const b = first.boundaries[pick % first.boundaries.length] ?? 0;
					// A client that read up to boundary b reattaches from b with a
					// fresh decoder: the two halves join to the whole text.
					const head = decodeInPieces(bytes.subarray(0, b), []);
					const tail = decodeInPieces(bytes.subarray(b), cuts);
					expect(head.text + tail.text).toBe(reference(bytes));
					expect(head.text).toBe(reference(bytes.subarray(0, b)));
				},
			),
			{ numRuns: 2000 },
		);
	});
});
