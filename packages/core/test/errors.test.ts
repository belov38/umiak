import { describe, expect, it } from "vitest";
import {
	ERROR_CODES,
	invalidState,
	isUmiakError,
	notFound,
	operationInProgress,
	outOfCapacity,
	quotaExceeded,
	UmiakError,
	validation,
} from "../src/index.ts";

describe("UmiakError", () => {
	it("contains the S6 §14.1 codes and the executor additions", () => {
		for (const code of [
			"not_found",
			"invalid_state",
			"operation_in_progress",
			"out_of_capacity",
			"pool_exhausted",
			"quota_exceeded",
			"idempotency_key_reused",
			"template_unavailable",
			"snapshot_not_found",
			"sandbox_not_ready",
			"recover_rate_limited",
			"validation",
			"slug_taken",
			"snapshot_name_taken",
			"agent_unavailable",
			"retries_exhausted",
		]) {
			expect(ERROR_CODES).toContain(code);
		}
	});

	it("is an Error with code, retryable and details", () => {
		const e = new UmiakError("slug_taken", "taken", { details: { slug: "x" } });
		expect(e).toBeInstanceOf(Error);
		expect(e.name).toBe("UmiakError");
		expect(e.code).toBe("slug_taken");
		expect(e.retryable).toBe(false);
		expect(e.details).toEqual({ slug: "x" });
		expect(isUmiakError(e)).toBe(true);
		expect(isUmiakError(e, "slug_taken")).toBe(true);
		expect(isUmiakError(e, "not_found")).toBe(false);
		expect(isUmiakError(new Error("x"))).toBe(false);
	});

	it("defaults retryable by code", () => {
		expect(new UmiakError("agent_unavailable", "x").retryable).toBe(true);
		expect(new UmiakError("recover_rate_limited", "x").retryable).toBe(true);
		expect(new UmiakError("validation", "x").retryable).toBe(false);
		expect(
			new UmiakError("not_found", "x", { retryable: true }).retryable,
		).toBe(true);
	});

	it("factories fill code, retryable and details", () => {
		expect(notFound()).toMatchObject({ code: "not_found", retryable: false });
		expect(invalidState("stopped")).toMatchObject({
			code: "invalid_state",
			retryable: false,
			details: { state: "stopped" },
		});
		expect(operationInProgress({ id: "op1", kind: "resume" })).toMatchObject({
			code: "operation_in_progress",
			retryable: true,
			details: { operationId: "op1", kind: "resume" },
		});
		expect(outOfCapacity(30)).toMatchObject({
			code: "out_of_capacity",
			retryable: true,
			details: { retryAfterSeconds: 30 },
		});
		expect(quotaExceeded("sandboxes", 5, 5)).toMatchObject({
			code: "quota_exceeded",
			retryable: false,
			details: { quota: "sandboxes", limit: 5, current: 5 },
		});
		const v = validation([{ path: "slug", message: "bad" }]);
		expect(v).toMatchObject({
			code: "validation",
			retryable: false,
			details: { issues: [{ path: "slug", message: "bad" }] },
		});
	});
});
