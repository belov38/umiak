import { createHash, createHmac, hkdfSync, randomBytes } from "node:crypto";
import { describe, expect, it } from "vitest";
import {
	canonicalJson,
	KeyRing,
	REQUEST_HASH_PURPOSE,
	requestHash,
} from "../src/index.ts";

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
	const k1 = randomBytes(32);
	const k2 = randomBytes(32);
	const ring1 = KeyRing.fromObject({
		current: 1,
		keys: { "1": k1.toString("base64") },
	});
	// The same ring after a rotation: 2 is current, 1 still decrypts.
	const ring12 = KeyRing.fromObject({
		current: 2,
		keys: { "1": k1.toString("base64"), "2": k2.toString("base64") },
	});
	const ring2 = KeyRing.fromObject({
		current: 2,
		keys: { "2": k2.toString("base64") },
	});
	const body = { env: { A: "1" }, secrets: { TOKEN: "hunter2" } };

	it("is version || HMAC-SHA256 under an HKDF subkey of the data key, not a plain sha256", () => {
		const data = `sandboxes.create\n${canonicalJson(body)}`;
		const sub = Buffer.from(
			hkdfSync("sha256", k1, Buffer.alloc(0), REQUEST_HASH_PURPOSE, 32),
		);
		const mac = createHmac("sha256", sub).update(data).digest();
		const h = requestHash(ring1, "sandboxes.create", body);
		expect(h.value.length).toBe(36);
		expect(h.value.readUInt32BE(0)).toBe(1);
		expect(h.value.subarray(4).equals(mac)).toBe(true);
		const plain = createHash("sha256").update(data).digest();
		expect(h.value.includes(plain)).toBe(false);
		// Neither the data key nor the bare HMAC over the data key is used.
		expect(
			h.value
				.subarray(4)
				.equals(createHmac("sha256", k1).update(data).digest()),
		).toBe(false);
	});

	it("is canonical and bound to the scope and the ring", () => {
		const h = requestHash(ring1, "sandboxes.create", { b: 1, a: 2 });
		expect(
			h.matches(requestHash(ring1, "sandboxes.create", { a: 2, b: 1 }).value),
		).toBe(true);
		expect(
			h.matches(requestHash(ring1, "sandboxes.fork", { a: 2, b: 1 }).value),
		).toBe(false);
		expect(
			h.matches(requestHash(ring1, "sandboxes.create", { a: 3, b: 1 }).value),
		).toBe(false);
		const other = KeyRing.fromObject({
			current: 1,
			keys: { "1": randomBytes(32).toString("base64") },
		});
		expect(
			h.matches(requestHash(other, "sandboxes.create", { a: 2, b: 1 }).value),
		).toBe(false);
	});

	it("a hash made before a key rotation still matches the same body; not after the key is gone", () => {
		const before = requestHash(ring1, "sandboxes.create", body).value;
		const after = requestHash(ring12, "sandboxes.create", body);
		expect(after.value.readUInt32BE(0)).toBe(2);
		expect(after.value.equals(before)).toBe(false);
		expect(after.matches(before)).toBe(true);
		expect(
			requestHash(ring12, "sandboxes.create", { ...body, env: {} }).matches(
				before,
			),
		).toBe(false);
		// Key 1 removed: the old hash can no longer be checked, so no match.
		expect(requestHash(ring2, "sandboxes.create", body).matches(before)).toBe(
			false,
		);
	});

	it("rejects malformed stored values", () => {
		const h = requestHash(ring1, "sandboxes.create", body);
		expect(h.matches(Buffer.alloc(0))).toBe(false);
		expect(h.matches(h.value.subarray(4))).toBe(false);
		expect(h.matches(createHash("sha256").update("x").digest())).toBe(false);
	});
});
