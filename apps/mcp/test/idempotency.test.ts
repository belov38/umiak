import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import { apiIdempotencyKey, IDEMPOTENCY_KEY_RE } from "../src/idempotency.ts";

describe("apiIdempotencyKey", () => {
	it("joins tool, sandbox id and model key", () => {
		expect(apiIdempotencyKey("exec_run", "k1", "sb_1")).toBe(
			"mcp:exec_run:sb_1:k1",
		);
	});

	it("omits the sandbox for sandbox_create and snapshot_save", () => {
		expect(apiIdempotencyKey("sandbox_create", "k1")).toBe(
			"mcp:sandbox_create:k1",
		);
	});

	it("keeps the same model key apart across tools and sandboxes", () => {
		const a = apiIdempotencyKey("exec_run", "k", "sb_1");
		expect(apiIdempotencyKey("exec_start", "k", "sb_1")).not.toBe(a);
		expect(apiIdempotencyKey("exec_run", "k", "sb_2")).not.toBe(a);
	});

	it("is exactly 255 characters at the limit and unchanged", () => {
		const prefix = "mcp:exec_run:sb_1:";
		const key = "a".repeat(255 - prefix.length);
		const out = apiIdempotencyKey("exec_run", key, "sb_1");
		expect(out).toHaveLength(255);
		expect(out).toBe(prefix + key);
	});

	it("falls back to the sha256 hex of the string above 255", () => {
		const sandbox = `sb_${"x".repeat(200)}`;
		const key = "k".repeat(128);
		const long = `mcp:exec_run:${sandbox}:${key}`;
		expect(long.length).toBeGreaterThan(255);
		const out = apiIdempotencyKey("exec_run", key, sandbox);
		expect(out).toBe(createHash("sha256").update(long).digest("hex"));
		expect(out).toMatch(/^[0-9a-f]{64}$/);
	});

	it("the hashed form is stable and distinguishes inputs", () => {
		const sandbox = `sb_${"x".repeat(250)}`;
		const a = apiIdempotencyKey("exec_run", "k1", sandbox);
		expect(apiIdempotencyKey("exec_run", "k1", sandbox)).toBe(a);
		expect(apiIdempotencyKey("exec_run", "k2", sandbox)).not.toBe(a);
	});
});

describe("IDEMPOTENCY_KEY_RE", () => {
	it("accepts 1 to 128 characters of [A-Za-z0-9._-]", () => {
		for (const k of ["a", "A-b_c.9", "x".repeat(128)]) {
			expect(IDEMPOTENCY_KEY_RE.test(k)).toBe(true);
		}
	});

	it("rejects empty, long, and other characters", () => {
		for (const k of ["", "x".repeat(129), "a b", "a:b", "a/b", "ключ", "a\n"]) {
			expect(IDEMPOTENCY_KEY_RE.test(k)).toBe(false);
		}
	});
});
