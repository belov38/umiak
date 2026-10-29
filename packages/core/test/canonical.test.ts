import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import { canonicalJson, requestHash } from "../src/index.ts";

describe("canonicalJson", () => {
	it("sorts keys recursively", () => {
		expect(canonicalJson({ b: 1, a: { d: 1, c: 2 } })).toBe(
			'{"a":{"c":2,"d":1},"b":1}',
		);
	});

	it("drops undefined in objects and keeps array order", () => {
		expect(
			canonicalJson({ a: undefined, b: [3, 1, { z: 1, y: undefined }] }),
		).toBe('{"b":[3,1,{"z":1}]}');
		expect(canonicalJson([undefined])).toBe("[null]");
	});

	it("handles scalars, null, strings and toJSON", () => {
		expect(canonicalJson(null)).toBe("null");
		expect(canonicalJson('a"b\n')).toBe('"a\\"b\\n"');
		expect(canonicalJson(true)).toBe("true");
		expect(canonicalJson({ t: new Date(0) })).toBe(
			'{"t":"1970-01-01T00:00:00.000Z"}',
		);
		expect(canonicalJson({})).toBe("{}");
	});

	it("rejects values JSON cannot represent", () => {
		expect(() => canonicalJson(Number.NaN)).toThrow();
		expect(() => canonicalJson({ a: Number.POSITIVE_INFINITY })).toThrow();
		expect(() => canonicalJson(1n)).toThrow();
		expect(() => canonicalJson(undefined)).toThrow();
	});

	it("is independent of insertion order", () => {
		expect(canonicalJson({ x: 1, y: { b: 2, a: 1 } })).toBe(
			canonicalJson({ y: { a: 1, b: 2 }, x: 1 }),
		);
	});
});

describe("requestHash", () => {
	it("is sha256 of scope, newline and canonical body", () => {
		const body = { b: 1, a: 2 };
		const expected = createHash("sha256")
			.update(`sandboxes.create\n${canonicalJson(body)}`)
			.digest();
		const h = requestHash("sandboxes.create", body);
		expect(Buffer.isBuffer(h)).toBe(true);
		expect(h.length).toBe(32);
		expect(h.equals(expected)).toBe(true);
		expect(requestHash("sandboxes.create", { a: 2, b: 1 }).equals(h)).toBe(
			true,
		);
		expect(requestHash("sandboxes.fork", body).equals(h)).toBe(false);
	});
});
