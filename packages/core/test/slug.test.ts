import { describe, expect, it } from "vitest";
import {
	generateSlug,
	isValidSlug,
	RESERVED_SLUG_SUFFIXES,
	RESERVED_SLUGS,
	SbxError,
	SLUG_WORDS,
	validateSlug,
} from "../src/index.ts";

function expectInvalid(s: string) {
	let err: unknown;
	try {
		validateSlug(s);
	} catch (e) {
		err = e;
	}
	expect(err, s).toBeInstanceOf(SbxError);
	expect((err as SbxError).code).toBe("validation");
	expect((err as SbxError).details.issues).toEqual([
		{ path: "slug", message: expect.any(String) },
	]);
	expect(isValidSlug(s)).toBe(false);
}

describe("validateSlug", () => {
	it("accepts valid slugs", () => {
		for (const s of [
			"quiet-otter-lamp",
			"abc",
			"my-box",
			"a1b",
			"x".repeat(40),
			"box-v2",
		]) {
			expect(() => validateSlug(s), s).not.toThrow();
			expect(isValidSlug(s)).toBe(true);
		}
	});

	it("rejects invalid slugs", () => {
		for (const s of [
			"ab",
			"a--b",
			"box-123",
			"x-desktop",
			"api",
			"x".repeat(41),
			"-abc",
			"abc-",
			"Abc",
			"ab_c",
			"",
			"my box",
		]) {
			expectInvalid(s);
		}
		for (const s of RESERVED_SLUGS) expectInvalid(s);
	});

	it("exports the reserved lists", () => {
		expect(RESERVED_SLUG_SUFFIXES).toEqual(["-desktop"]);
		expect([...RESERVED_SLUGS].sort()).toEqual(
			["admin", "api", "app", "sbx", "ssh", "static", "tunnel", "www"].sort(),
		);
	});
});

describe("SLUG_WORDS", () => {
	it("are ~300 unique short lowercase words", () => {
		expect(SLUG_WORDS.length).toBeGreaterThanOrEqual(280);
		expect(new Set(SLUG_WORDS).size).toBe(SLUG_WORDS.length);
		for (const w of SLUG_WORDS) {
			expect(w).toMatch(/^[a-z]{3,7}$/);
			expect(RESERVED_SLUGS).not.toContain(w);
			expect(`-${w}`).not.toBe("-desktop");
		}
	});
});

describe("generateSlug", () => {
	it("always passes validateSlug", () => {
		for (let i = 0; i < 1000; i++) {
			expect(() => validateSlug(generateSlug())).not.toThrow();
			expect(() => validateSlug(generateSlug(4))).not.toThrow();
		}
	});

	it("uses the given number of words and the injected random source", () => {
		expect(generateSlug().split("-")).toHaveLength(3);
		expect(generateSlug(4).split("-")).toHaveLength(4);
		const seq = [0, 1, 2];
		let i = 0;
		const rnd = (n: number) => {
			expect(n).toBe(SLUG_WORDS.length);
			return seq[i++] ?? 0;
		};
		expect(generateSlug(3, rnd)).toBe(SLUG_WORDS.slice(0, 3).join("-"));
	});

	it("rejects a bad word count", () => {
		expect(() => generateSlug(0)).toThrow();
		expect(() => generateSlug(7)).toThrow();
	});
});
