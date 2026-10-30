import { SbxError } from "@sbx/sdk";
import { describe, expect, it } from "vitest";
import { errorResult, hintFor, ToolError } from "../src/errors.ts";

function textOf(r: { content: { type: string; text?: string }[] }): string {
	expect(r.content).toHaveLength(1);
	return r.content[0]?.text ?? "";
}

function apiError(
	code: string,
	over: Partial<ConstructorParameters<typeof SbxError>[0]> = {},
) {
	return new SbxError({
		status: 409,
		code,
		message: `message of ${code}`,
		retryable: false,
		requestId: "req_1",
		...over,
	});
}

const SB = "sb_01jbx";

describe("errorResult format", () => {
	it("writes key: value lines in the S11 7.6 order", () => {
		const r = errorResult(
			apiError("sandbox_not_ready", {
				retryable: true,
				retryAfterMs: 2000,
				details: { state: "stopped" },
			}),
			{ idempotencyKey: "k-1" },
		);
		expect(r.isError).toBe(true);
		const lines = textOf(r).split("\n");
		expect(lines.map((l) => l.slice(0, l.indexOf(":")))).toEqual([
			"error",
			"message",
			"retryable",
			"retry_after",
			"hint",
			"idempotency_key",
			"request_id",
		]);
		expect(lines).toContain("error: sandbox_not_ready");
		expect(lines).toContain("message: message of sandbox_not_ready");
		expect(lines).toContain("retryable: true");
		expect(lines).toContain("retry_after: 2");
		expect(lines).toContain("idempotency_key: k-1");
		expect(lines).toContain("request_id: req_1");
	});

	it("omits absent lines", () => {
		const r = errorResult(
			new SbxError({
				status: 400,
				code: "invalid_json",
				message: "bad body",
				retryable: false,
			}),
		);
		expect(textOf(r)).toBe(
			"error: invalid_json\nmessage: bad body\nretryable: false",
		);
	});

	it("rounds retry_after up to whole seconds", () => {
		const r = errorResult(apiError("rate_limited", { retryAfterMs: 1200 }));
		expect(textOf(r)).toContain("retry_after: 2");
	});

	it("keeps a multi-line message on one logical line", () => {
		const r = errorResult(apiError("validation", { message: "a\nb\r\nc" }));
		const lines = textOf(r).split("\n");
		expect(lines[1]).toBe("message: a b c");
	});

	it("takes the sandbox id for hints from extra.sandbox", () => {
		const r = errorResult(
			apiError("sandbox_not_ready", { details: { state: "stopped" } }),
			{ sandbox: SB },
		);
		expect(textOf(r)).toContain(
			`hint: call sandbox_resume with sandbox="${SB}" and retry.`,
		);
	});
});

describe("errorResult sources", () => {
	it("ToolError: own code, retryable, explicit hint wins, idempotency key", () => {
		const r = errorResult(
			new ToolError({
				code: "deadline_exceeded",
				message: "too slow",
				retryable: true,
				hint: "custom hint",
				idempotencyKey: "own-key",
			}),
		);
		const t = textOf(r);
		expect(r.isError).toBe(true);
		expect(t).toContain("error: deadline_exceeded");
		expect(t).toContain("retryable: true");
		expect(t).toContain("hint: custom hint");
		expect(t).toContain("idempotency_key: own-key");
	});

	it("ToolError: extra.idempotencyKey fills a missing key only", () => {
		const e = new ToolError({ code: "x", message: "m" });
		expect(textOf(errorResult(e, { idempotencyKey: "from-extra" }))).toContain(
			"idempotency_key: from-extra",
		);
		const e2 = new ToolError({
			code: "x",
			message: "m",
			idempotencyKey: "own",
		});
		expect(textOf(errorResult(e2, { idempotencyKey: "from-extra" }))).toContain(
			"idempotency_key: own",
		);
	});

	it("AbortError and TimeoutError become deadline_exceeded", () => {
		for (const name of ["AbortError", "TimeoutError"]) {
			const e = new DOMException("aborted", name);
			const t = textOf(errorResult(e, { idempotencyKey: "k" }));
			expect(t).toContain("error: deadline_exceeded");
			expect(t).toContain("retryable: true");
			expect(t).toContain("idempotency_key: k");
		}
	});

	it("unknown errors are internal, with no stack or original text", () => {
		const e = new Error("secret detail at /srv/app.ts:12");
		const t = textOf(errorResult(e));
		expect(t).toBe(
			"error: internal\nmessage: internal error\nretryable: false",
		);
		expect(t).not.toContain("secret");
		expect(t).not.toContain("app.ts");
		expect(textOf(errorResult("boom"))).toContain("error: internal");
		expect(textOf(errorResult(undefined))).toContain("error: internal");
	});
});

describe("hints for S7 5.5 codes", () => {
	const details = (d: Record<string, unknown> = {}) => ({
		sandbox: SB,
		details: d,
	});

	it("sandbox_not_ready: resume", () => {
		expect(hintFor("sandbox_not_ready", details())).toBe(
			`call sandbox_resume with sandbox="${SB}" and retry.`,
		);
	});

	it("sandbox_not_ready without a sandbox id uses a placeholder", () => {
		expect(hintFor("sandbox_not_ready", { details: {} })).toBe(
			'call sandbox_resume with sandbox="sb_..." and retry.',
		);
	});

	it.each([
		"sandbox_starting",
		"agent_unavailable",
		"operation_in_progress",
		"desktop_not_ready",
	])("%s: retry after retry_after", (code) => {
		const h = hintFor(code, details({ retryAfterSeconds: 7 }));
		expect(h).toContain("retry");
		expect(h).toContain("7 seconds");
		expect(hintFor(code, details())).toContain("retry");
	});

	it("operation_in_progress names the running operation", () => {
		const h = hintFor(
			"operation_in_progress",
			details({ operationId: "op_1" }),
		);
		expect(h).toContain("op_1");
	});

	it("forbidden with requiredScope names the scope", () => {
		const h = hintFor("forbidden", details({ requiredScope: "files:write" }));
		expect(h).toContain("files:write");
		expect(h).toContain("ask");
	});

	it("forbidden without requiredScope has no hint", () => {
		expect(hintFor("forbidden", details({ reason: "role" }))).toBeUndefined();
	});

	it("confirmation_required: how to set confirm", () => {
		const h = hintFor("confirmation_required", details());
		expect(h).toContain("confirm");
		expect(h).toContain(SB);
	});

	it("quota_exceeded: limits_get and sandbox_stop", () => {
		const h = hintFor("quota_exceeded", details());
		expect(h).toContain("limits_get");
		expect(h).toContain("sandbox_stop");
	});

	it("path_not_found: files_list of the parent", () => {
		expect(hintFor("path_not_found", details())).toContain("files_list");
	});

	it("not_found: sandbox_list", () => {
		expect(hintFor("not_found", details())).toContain("sandbox_list");
	});

	it("validation: lists the issues", () => {
		const h = hintFor(
			"validation",
			details({
				issues: [
					{ path: "name", message: "too long" },
					{ path: "size", message: "unknown" },
				],
			}),
		);
		expect(h).toContain("name: too long");
		expect(h).toContain("size: unknown");
	});

	it("validation without issues has a generic hint", () => {
		expect(hintFor("validation", details())).toContain("arguments");
	});

	it("rate_limited: wait", () => {
		const h = hintFor("rate_limited", details({ retryAfterSeconds: 3 }));
		expect(h).toContain("3 seconds");
	});

	it("idempotency_key_reused: use a new key", () => {
		expect(hintFor("idempotency_key_reused", details())).toContain(
			"use a new idempotency_key",
		);
	});
});

describe("hints for S10 13.2 codes and mcp codes", () => {
	const ctx = { sandbox: SB, details: {} };

	it("desktop_unsupported", () => {
		expect(hintFor("desktop_unsupported", ctx)).toContain("desktop");
	});

	it("desktop_busy", () => {
		expect(hintFor("desktop_busy", ctx)).toContain("retry");
	});

	it("invalid_action", () => {
		const h = hintFor("invalid_action", {
			sandbox: SB,
			details: { index: 2, reason: "x out of screen" },
		});
		expect(h).toContain("2");
		expect(h).toContain("x out of screen");
	});

	it("action_failed: earlier actions are not rolled back", () => {
		const h = hintFor("action_failed", {
			sandbox: SB,
			details: { index: 1, completed: 1 },
		});
		expect(h).toContain("computer_screenshot");
	});

	it("streamer_unavailable", () => {
		expect(hintFor("streamer_unavailable", ctx)).toContain("retry");
	});

	it("not_logged_in", () => {
		expect(hintFor("not_logged_in", ctx)).toBe(
			"run `sbx login` in a terminal, then retry.",
		);
	});

	it("deadline_exceeded", () => {
		expect(hintFor("deadline_exceeded", ctx)).toContain("call again");
	});

	it("token_provider_failed", () => {
		expect(hintFor("token_provider_failed", ctx)).toContain("sbx login");
	});

	it("unknown code has no hint", () => {
		expect(hintFor("something_new", ctx)).toBeUndefined();
	});
});

describe("every table row appears in the result text", () => {
	const rows: [string, Record<string, unknown>][] = [
		["sandbox_not_ready", {}],
		["sandbox_starting", {}],
		["agent_unavailable", {}],
		["operation_in_progress", {}],
		["forbidden", { requiredScope: "files:write" }],
		["confirmation_required", {}],
		["quota_exceeded", {}],
		["path_not_found", {}],
		["not_found", {}],
		["validation", {}],
		["rate_limited", {}],
		["idempotency_key_reused", {}],
		["desktop_unsupported", {}],
		["desktop_not_ready", {}],
		["desktop_busy", {}],
		["invalid_action", {}],
		["action_failed", {}],
		["streamer_unavailable", {}],
	];
	it.each(rows)("%s", (code, details) => {
		const t = textOf(
			errorResult(new ToolError({ code, message: "m", details }), {
				sandbox: SB,
			}),
		);
		expect(t).toContain(`error: ${code}`);
		expect(t).toContain("\nhint: ");
	});

	it("forbidden carries files:write", () => {
		const t = textOf(
			errorResult(
				apiError("forbidden", {
					status: 403,
					details: { requiredScope: "files:write" },
				}),
				{},
			),
		);
		expect(t).toContain("files:write");
	});
});

describe("hints in pinned mode", () => {
	it("name no hidden tool and no sandbox argument", () => {
		expect(
			hintFor("sandbox_not_ready", {
				sandbox: "sb_1",
				pinned: true,
				details: {},
			}),
		).toBe("call sandbox_resume and retry.");
		for (const code of ["not_found", "quota_exceeded"]) {
			const h = hintFor(code, { pinned: true, details: {} }) ?? "";
			expect(h).not.toMatch(
				/sandbox_(list|create|fork|delete)|snapshot_delete|sandbox=/,
			);
		}
		expect(
			errorResult(
				new SbxError({
					status: 404,
					code: "not_found",
					message: "no such sandbox",
					retryable: false,
				}),
				{ sandbox: "sb_1", pinned: true },
			).content[0],
		).toMatchObject({ text: expect.not.stringContaining("sandbox_list") });
	});
});
