import { describe, expect, it } from "vitest";
import { sanitizeForLlm } from "../src/output/sanitize.ts";

describe("sanitizeForLlm", () => {
	it("strips CSI sequences", () => {
		expect(sanitizeForLlm("\x1b[31mred\x1b[0m")).toBe("red");
		expect(sanitizeForLlm("a\x1b[2;3Hb\x1b[?25lc")).toBe("abc");
		expect(sanitizeForLlm("a\u009b31mb")).toBe("ab");
	});

	it("keeps only the visible text of an OSC 8 hyperlink", () => {
		const s = "\x1b]8;;https://evil.example/\x1b\\link text\x1b]8;;\x1b\\";
		expect(sanitizeForLlm(s)).toBe("link text");
		expect(sanitizeForLlm("\x1b]8;;http://x\x07t\x1b]8;;\x07")).toBe("t");
	});

	it("drops OSC 52 clipboard writes and window titles", () => {
		expect(sanitizeForLlm("a\x1b]52;c;aGVsbG8=\x07b")).toBe("ab");
		expect(sanitizeForLlm("\x1b]0;title\x1b\\x")).toBe("x");
	});

	it("drops an unterminated OSC up to the end of the line only", () => {
		expect(sanitizeForLlm("a\x1b]0;oops\nnext")).toBe("a\nnext");
	});

	it("strips other two-byte and charset ESC sequences", () => {
		expect(sanitizeForLlm("a\x1bMb\x1b=c\x1b(Bd")).toBe("abcd");
	});

	it("normalizes line endings and carriage returns", () => {
		expect(sanitizeForLlm("a\r\nb\r\n")).toBe("a\nb\n");
		expect(sanitizeForLlm("a\rb\rc\n")).toBe("c\n");
		expect(sanitizeForLlm("10%\r50%\r100%\ndone")).toBe("100%\ndone");
		expect(sanitizeForLlm("abc\r")).toBe("abc");
	});

	it("writes C0 and C1 controls visibly, keeping tab and newline", () => {
		expect(sanitizeForLlm("\x07")).toBe("\\u{07}");
		expect(sanitizeForLlm("\u0085")).toBe("\\u{85}");
		expect(sanitizeForLlm("a\tb\nc")).toBe("a\tb\nc");
		expect(sanitizeForLlm("\x00\x1b")).toBe("\\u{00}\\u{1B}");
		expect(sanitizeForLlm("\x7f")).toBe("\\u{7F}");
	});

	it("makes Unicode tag characters visible", () => {
		expect(sanitizeForLlm("\u{E0041}")).toBe("\\u{E0041}");
		expect(sanitizeForLlm("\u{E0000}\u{E007F}")).toBe("\\u{E0000}\\u{E007F}");
	});

	it("makes bidi controls visible", () => {
		expect(sanitizeForLlm("a‮b")).toBe("a\\u{202E}b");
		for (const cp of [0x202a, 0x202d, 0x2066, 0x2069, 0x200e, 0x200f, 0x061c]) {
			const hex = cp.toString(16).toUpperCase().padStart(4, "0");
			expect(sanitizeForLlm(String.fromCodePoint(cp))).toBe(`\\u{${hex}}`);
		}
	});

	it("makes zero-width and invisible formatting characters visible", () => {
		for (const cp of [0x200b, 0x2060, 0x2061, 0x2064]) {
			const hex = cp.toString(16).toUpperCase();
			expect(sanitizeForLlm(`a${String.fromCodePoint(cp)}b`)).toBe(
				`a\\u{${hex}}b`,
			);
		}
	});

	it("keeps ZWJ and ZWNJ", () => {
		expect(sanitizeForLlm("👨‍👩‍👧")).toBe("👨‍👩‍👧");
		expect(sanitizeForLlm("a‌b")).toBe("a‌b");
	});

	it("keeps a leading BOM and replaces an inner one", () => {
		expect(sanitizeForLlm("﻿abc")).toBe("﻿abc");
		expect(sanitizeForLlm("a﻿b")).toBe("a\\u{FEFF}b");
		expect(sanitizeForLlm("﻿﻿")).toBe("﻿\\u{FEFF}");
	});

	it("leaves plain text untouched", () => {
		const s = "héllo wörld €5 😀\n\tindented\n";
		expect(sanitizeForLlm(s)).toBe(s);
	});
});
