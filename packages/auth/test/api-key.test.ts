import { describe, expect, it } from "vitest";
import {
	API_KEY_RE,
	apiKeyDisplay,
	apiKeyHash,
	generateApiKeySecret,
	isWellFormedApiKey,
} from "../src/index.ts";

describe("generateApiKeySecret", () => {
	it("matches API_KEY_RE and is 53 chars long, 1000 times", () => {
		const seen = new Set<string>();
		for (let i = 0; i < 1000; i++) {
			const k = generateApiKeySecret();
			expect(k).toMatch(API_KEY_RE);
			expect(k).toHaveLength(53);
			expect(isWellFormedApiKey(k)).toBe(true);
			seen.add(k);
		}
		expect(seen.size).toBe(1000);
	});

	it("API_KEY_RE is the S7 §7.2 pattern", () => {
		expect(API_KEY_RE.source).toBe("^sbx_[0-9A-Za-z]{49}$");
	});
});

describe("isWellFormedApiKey", () => {
	it("detects a changed last character of the body", () => {
		const k = generateApiKeySecret();
		// Change the last body char (just before the 6-char CRC part).
		const i = 4 + 43 - 1;
		const swapped = k[i] === "A" ? "B" : "A";
		const bad = `${k.slice(0, i)}${swapped}${k.slice(i + 1)}`;
		expect(bad).toMatch(API_KEY_RE);
		expect(isWellFormedApiKey(bad)).toBe(false);
	});

	it("detects a changed CRC character", () => {
		const k = generateApiKeySecret();
		const swapped = k.endsWith("A") ? "B" : "A";
		expect(isWellFormedApiKey(`${k.slice(0, -1)}${swapped}`)).toBe(false);
	});

	it("accepts fixed vectors computed independently (Python zlib.crc32)", () => {
		// body = base62(bytes 0x00..0x1f), CRC = base62(zlib.crc32("sbx_" + body)) padded to 6.
		expect(
			isWellFormedApiKey(
				"sbx_003aUlTJC7tjlCTQj2uNU3MFagCXG9LRKRcwGkBIDlf2fn8MG",
			),
		).toBe(true);
		expect(isWellFormedApiKey(`sbx_${"0".repeat(43)}3UvflE`)).toBe(true);
		// CRC 637950070 < 62^5: base62 is 5 chars, left-padded with "0".
		expect(isWellFormedApiKey(`sbx_${"0".repeat(42)}30hAlxG`)).toBe(true);
		expect(isWellFormedApiKey(`sbx_${"0".repeat(42)}3hAlxG0`)).toBe(false);
	});

	it("rejects wrong shape", () => {
		const k = generateApiKeySecret();
		expect(isWellFormedApiKey("")).toBe(false);
		expect(isWellFormedApiKey(k.slice(1))).toBe(false);
		expect(isWellFormedApiKey(`${k}0`)).toBe(false);
		expect(isWellFormedApiKey(`sbxs_${k.slice(4)}`)).toBe(false);
		expect(isWellFormedApiKey(`${k.slice(0, -1)}-`)).toBe(false);
	});
});

describe("apiKeyHash", () => {
	it("is sha256 hex", () => {
		expect(apiKeyHash("abc")).toBe(
			"ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad",
		);
	});
});

describe("apiKeyDisplay", () => {
	it("gives 8 prefix chars after sbx_ and the last 4", () => {
		const k = generateApiKeySecret();
		const d = apiKeyDisplay(k);
		expect(d.prefix).toHaveLength(8);
		expect(d.last4).toHaveLength(4);
		expect(d.prefix).toBe(k.slice(4, 12));
		expect(d.last4).toBe(k.slice(-4));
	});
});
