import { describe, expect, it } from "vitest";
import { decodeUtf8Chunk } from "../src/output/utf8.ts";

const enc = new TextEncoder();

describe("decodeUtf8Chunk", () => {
	for (const ch of ["é", "€", "😀"]) {
		const bytes = enc.encode(ch);

		it(`holds an incomplete tail of ${JSON.stringify(ch)} at every cut`, () => {
			for (let k = 1; k < bytes.length; k++) {
				const r = decodeUtf8Chunk(bytes.subarray(0, k), {
					atStart: true,
					final: false,
				});
				expect(r).toEqual({ text: "", startSkip: 0, endHold: k });
			}
			const whole = decodeUtf8Chunk(bytes, { atStart: true, final: false });
			expect(whole).toEqual({ text: ch, startSkip: 0, endHold: 0 });
		});

		it(`skips leading continuation bytes of ${JSON.stringify(ch)} when not at start`, () => {
			for (let k = 1; k < bytes.length; k++) {
				const r = decodeUtf8Chunk(bytes.subarray(k), {
					atStart: false,
					final: false,
				});
				expect(r).toEqual({
					text: "",
					startSkip: bytes.length - k,
					endHold: 0,
				});
			}
		});

		it(`decodes a lone partial ${JSON.stringify(ch)} at the end of input when final`, () => {
			for (let k = 1; k < bytes.length; k++) {
				const r = decodeUtf8Chunk(bytes.subarray(0, k), {
					atStart: true,
					final: true,
				});
				expect(r.endHold).toBe(0);
				expect(r.text).toBe("�");
			}
		});
	}

	it("keeps the offset on a character boundary when windows are re-read", () => {
		const text = "a é € 😀 z\n".repeat(5);
		const bytes = enc.encode(text);
		for (let size = 4; size <= 11; size++) {
			let off = 0;
			let out = "";
			while (off < bytes.length) {
				const end = Math.min(off + size, bytes.length);
				const r = decodeUtf8Chunk(bytes.subarray(off, end), {
					atStart: off === 0,
					final: end === bytes.length,
				});
				expect(r.startSkip).toBe(0);
				out += r.text;
				off = end - r.endHold;
			}
			expect(out).toBe(text);
		}
	});

	it("replaces invalid bytes with U+FFFD", () => {
		const r = decodeUtf8Chunk(new Uint8Array([0x61, 0xff, 0x62]), {
			atStart: true,
			final: true,
		});
		expect(r).toEqual({ text: "a�b", startSkip: 0, endHold: 0 });
	});

	it("does not hold a tail that cannot be completed", () => {
		// A lead byte followed by an ASCII byte is already invalid.
		const r = decodeUtf8Chunk(new Uint8Array([0xe2, 0x41]), {
			atStart: true,
			final: false,
		});
		expect(r).toEqual({ text: "�A", startSkip: 0, endHold: 0 });
	});

	it("skips at most three leading continuation bytes", () => {
		const r = decodeUtf8Chunk(new Uint8Array([0x80, 0x80, 0x80, 0x80, 0x61]), {
			atStart: false,
			final: true,
		});
		expect(r.startSkip).toBe(3);
		expect(r.text).toBe("�a");
	});

	it("keeps a leading BOM as a character", () => {
		const r = decodeUtf8Chunk(new Uint8Array([0xef, 0xbb, 0xbf, 0x61]), {
			atStart: true,
			final: true,
		});
		expect(r.text).toBe("﻿a");
	});

	it("handles empty input", () => {
		expect(
			decodeUtf8Chunk(new Uint8Array(), { atStart: false, final: false }),
		).toEqual({ text: "", startSkip: 0, endHold: 0 });
	});
});
