// Idempotency-Key policy of create and fork retries in the dashboard.
import { NETWORK_ERROR, SbxError, UNEXPECTED_RESPONSE } from "@sbx/sdk";
import { describe, expect, it } from "vitest";
import { describeError } from "../src/lib/errors.ts";
import {
	bodyHash,
	outcomeUnknown,
	slotAfter,
	slotFor,
} from "../src/lib/idempotency.ts";

const err = (
	code: string,
	status: number,
	details: Record<string, unknown> = {},
) =>
	new SbxError({
		status,
		code,
		message: code,
		retryable: false,
		details,
	});

let n = 0;
const newKey = () => `k${++n}`;

describe("slotFor", () => {
	it("keeps the key for the same body, a new one for another body", () => {
		const a = slotFor(null, { slug: "x", labels: { a: "1", b: "2" } }, newKey);
		const same = slotFor(a, { labels: { b: "2", a: "1" }, slug: "x" }, newKey);
		expect(same.key).toBe(a.key);
		const other = slotFor(a, { slug: "y", labels: { a: "1", b: "2" } }, newKey);
		expect(other.key).not.toBe(a.key);
	});

	it("a changed secret changes the hash; the hash does not contain it", () => {
		const h1 = bodyHash({ secrets: { TOKEN: "s3cr3t-one" } });
		const h2 = bodyHash({ secrets: { TOKEN: "s3cr3t-two" } });
		expect(h1).not.toBe(h2);
		expect(h1).toMatch(/^[0-9a-f]{16}$/);
		expect(bodyHash({ a: undefined, b: 1 })).toBe(bodyHash({ b: 1 }));
	});
});

describe("slotAfter", () => {
	const slot = { key: "k", bodyHash: "h" };

	it("rotates after a success", () => {
		expect(slotAfter(slot, undefined)).toBeNull();
	});

	it("keeps the key when the outcome is unknown", () => {
		for (const e of [
			err(NETWORK_ERROR, 0),
			err(UNEXPECTED_RESPONSE, 502),
			err(UNEXPECTED_RESPONSE, 504),
			err("server_shutting_down", 503),
			err("internal", 500, { outcome: "unknown" }),
			new TypeError("Failed to fetch"),
		]) {
			expect(outcomeUnknown(e)).toBe(true);
			expect(slotAfter(slot, e)).toBe(slot);
		}
	});

	it("rotates after a definitive API error", () => {
		for (const e of [
			err("out_of_capacity", 503),
			err("quota_exceeded", 403),
			err("slug_taken", 409),
			err("validation", 400),
			err("idempotency_key_reused", 409),
		]) {
			expect(outcomeUnknown(e)).toBe(false);
			expect(slotAfter(slot, e)).toBeNull();
		}
	});
});

describe("idempotency_key_reused", () => {
	it("has a readable text", () => {
		const t = describeError(err("idempotency_key_reused", 409)).message;
		expect(t).not.toContain("idempotency_key_reused");
		expect(t).toMatch(/again/i);
	});
});
