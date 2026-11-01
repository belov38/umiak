// API error codes → the text the dashboard shows (S8 §9.5, S7 §5.5).
import { NETWORK_ERROR, UmiakError, UNEXPECTED_RESPONSE } from "@umiak/sdk";
import { describe, expect, it } from "vitest";
import {
	CREATE_ERROR_CODES,
	describeError,
	isApiUnavailable,
	isSnapshotRequiresStop,
} from "../src/lib/errors.ts";

const err = (
	code: string,
	init: Partial<{
		status: number;
		message: string;
		retryable: boolean;
		details: Record<string, unknown>;
	}> = {},
) =>
	new UmiakError({
		status: init.status ?? 400,
		code,
		message: init.message ?? `server message of ${code}`,
		retryable: init.retryable ?? false,
		details: init.details ?? {},
	});

describe("describeError", () => {
	it("gives every create error of §9.5 its own text, not the raw message", () => {
		const texts = CREATE_ERROR_CODES.map((c) => describeError(err(c)).message);
		expect(new Set(texts).size).toBe(CREATE_ERROR_CODES.length);
		for (const [i, c] of CREATE_ERROR_CODES.entries()) {
			const t = texts[i] ?? "";
			expect(t.length).toBeGreaterThan(20);
			expect(t).not.toContain(`server message of ${c}`);
			expect(t).not.toContain(c);
		}
	});

	it("offers a retry for out_of_capacity only among the create errors", () => {
		expect(
			describeError(err("out_of_capacity", { status: 503, retryable: true })),
		).toMatchObject({ retry: true, apiUnavailable: false });
		for (const c of ["quota_exceeded", "slug_taken", "template_unavailable"]) {
			expect(describeError(err(c)).retry).toBe(false);
		}
		expect(describeError(err("out_of_capacity")).message).toMatch(/again/i);
	});

	it("names the exhausted quota", () => {
		const t = describeError(
			err("quota_exceeded", {
				status: 403,
				details: { quota: "ram_mb", limit: 6144, current: 4096 },
			}),
		).message;
		expect(t).toMatch(/RAM/);
		expect(t).toContain("6144");
	});

	it("explains a blocked sandbox and a missing role", () => {
		expect(
			describeError(
				err("forbidden", {
					status: 403,
					details: { reason: "sandbox_blocked" },
				}),
			).message,
		).toMatch(/blocked/i);
		expect(
			describeError(
				err("forbidden", { status: 403, details: { reason: "role" } }),
			).message,
		).toMatch(/owner/i);
	});

	it("lists validation issues", () => {
		const t = describeError(
			err("validation", {
				details: { issues: [{ path: "slug", message: "is reserved" }] },
			}),
		).message;
		expect(t).toContain("slug: is reserved");
	});

	it("falls back to the API message for other codes", () => {
		expect(describeError(err("some_new_code")).message).toBe(
			"server message of some_new_code",
		);
	});

	it("has a generic text for anything that is not an API error", () => {
		const t = describeError(new TypeError("x is undefined")).message;
		expect(t).not.toContain("undefined");
		expect(t.length).toBeGreaterThan(10);
	});
});

describe("isApiUnavailable", () => {
	it("is true without a response and for a proxy page of a missing api", () => {
		expect(isApiUnavailable(err(NETWORK_ERROR, { status: 0 }))).toBe(true);
		expect(isApiUnavailable(err(UNEXPECTED_RESPONSE, { status: 502 }))).toBe(
			true,
		);
		expect(isApiUnavailable(err(UNEXPECTED_RESPONSE, { status: 504 }))).toBe(
			true,
		);
		expect(isApiUnavailable(err("server_shutting_down", { status: 503 }))).toBe(
			true,
		);
		expect(describeError(err(NETWORK_ERROR, { status: 0 }))).toMatchObject({
			apiUnavailable: true,
			retry: true,
		});
	});

	it("is false for API errors with an envelope", () => {
		expect(isApiUnavailable(err("out_of_capacity", { status: 503 }))).toBe(
			false,
		);
		expect(isApiUnavailable(err("not_found", { status: 404 }))).toBe(false);
		expect(isApiUnavailable(new Error("boom"))).toBe(false);
	});
});

describe("snapshot_requires_stop (S9 §24.8)", () => {
	const e = err("snapshot_requires_stop", {
		status: 409,
		message:
			"Windows sandboxes are forked from a stopped VM; stop it first or retry with forceStop: true (CLI --force-stop), which stops the sandbox, takes the snapshot and starts it again",
		details: { reason: "windows_running", retryWith: { forceStop: true } },
	});

	it("is recognised, so the dashboard asks and retries with forceStop", () => {
		expect(isSnapshotRequiresStop(e)).toBe(true);
		expect(isSnapshotRequiresStop(err("invalid_state"))).toBe(false);
		expect(isSnapshotRequiresStop(new Error("x"))).toBe(false);
	});

	it("has dashboard words, not the CLI flag", () => {
		const t = describeError(e).message;
		expect(t).toContain("Windows");
		expect(t).not.toContain("--force-stop");
	});
});
