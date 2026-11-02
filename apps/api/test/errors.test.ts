import { createRoute, z } from "@hono/zod-openapi";
import { UmiakError } from "@umiak/core";
import { HTTPException } from "hono/http-exception";
import { describe, expect, it } from "vitest";
import {
	ApiError,
	ERROR_RESPONSES,
	jsonBody,
	ServiceTokens,
	toHttpError,
} from "../src/index.ts";
import { TEST_API_KEY } from "../src/testing/index.ts";
import {
	createHarness,
	type Harness,
	type Listener,
} from "./helpers/harness.ts";

// S7 §5.5: core codes and their HTTP status and retryable flag.
const TABLE: [
	code: string,
	status: number,
	retryable: boolean,
	http: string,
][] = [
	["not_found", 404, false, "not_found"],
	["invalid_state", 409, false, "invalid_state"],
	["operation_in_progress", 409, true, "operation_in_progress"],
	["out_of_capacity", 503, true, "out_of_capacity"],
	["quota_exceeded", 403, false, "quota_exceeded"],
	["idempotency_key_reused", 409, false, "idempotency_key_reused"],
	["template_unavailable", 422, false, "template_unavailable"],
	["snapshot_not_found", 404, false, "snapshot_not_found"],
	["sandbox_not_ready", 409, false, "sandbox_not_ready"],
	["recover_rate_limited", 429, true, "recover_rate_limited"],
	["validation", 400, false, "validation"],
	["slug_taken", 409, false, "slug_taken"],
	["snapshot_name_taken", 409, false, "snapshot_name_taken"],
	["agent_unavailable", 503, true, "agent_unavailable"],
];

function expectEnvelope(
	body: unknown,
	headers: Headers,
): {
	code: string;
	message: string;
	retryable: boolean;
	details: object;
	requestId: string;
} {
	const err = (body as { error: Record<string, unknown> }).error;
	expect(err).toBeDefined();
	expect(typeof err.code).toBe("string");
	expect(typeof err.message).toBe("string");
	expect((err.message as string).length).toBeGreaterThan(0);
	expect(typeof err.retryable).toBe("boolean");
	expect(err.details).toBeTypeOf("object");
	expect(err.details).not.toBeNull();
	expect(err.requestId).toMatch(/^req_[0-9a-z]{26}$/);
	expect(headers.get("request-id")).toBe(err.requestId);
	return err as never;
}

const echoRoute = createRoute({
	method: "post",
	path: "/v1/__test/echo",
	request: {
		body: jsonBody(
			z.strictObject({ s: z.string(), n: z.int().optional() }),
			"echo body",
		),
	},
	responses: { 204: { description: "accepted" }, ...ERROR_RESPONSES },
});

/**
 * A harness with test routes: `/v1/__test/throw` throws `make()`,
 * `/v1/__test/echo` validates a strict JSON body and answers 204.
 */
const SERVICE_TOKEN = "internal-test-token";

/** A harness with an authenticated caller (test key, or a service token on internal). */
function throwing(make: () => unknown, listener: Listener = "public"): Harness {
	const h =
		listener === "internal"
			? createHarness({
					listener,
					deps: {
						serviceTokens: new ServiceTokens({ gateway: [SERVICE_TOKEN] }),
					},
					bearer: SERVICE_TOKEN,
				})
			: createHarness({ listener, bearer: TEST_API_KEY });
	h.app.get("/v1/__test/throw", () => {
		throw make();
	});
	h.app.openapi(echoRoute, (c) => c.body(null, 204));
	return h;
}

describe("toHttpError: core codes (S7 §5.5)", () => {
	for (const [code, status, retryable, http] of TABLE) {
		it(`${code} -> ${status} ${http}${retryable ? " retryable" : ""}`, () => {
			const e = toHttpError(
				new UmiakError(code as never, `core says ${code}`, {
					details: { x: 1 },
				}),
			);
			expect(e).toBeInstanceOf(ApiError);
			expect(e.status).toBe(status);
			expect(e.code).toBe(http);
			expect(e.retryable).toBe(retryable);
			expect(e.message).toBe(`core says ${code}`);
			expect(e.details).toMatchObject({ x: 1 });
		});
	}

	it("pool_exhausted is not part of the contract: 500 internal", () => {
		const e = toHttpError(new UmiakError("pool_exhausted", "no warm machine"));
		expect(e.status).toBe(500);
		expect(e.code).toBe("internal");
		expect(e.retryable).toBe(false);
		expect(e.message).not.toContain("warm");
		expect(e.details).toEqual({});
	});

	it("retries_exhausted and unknown errors: 500 internal", () => {
		expect(toHttpError(new UmiakError("retries_exhausted", "x")).code).toBe(
			"internal",
		);
		expect(toHttpError(new Error("boom")).code).toBe("internal");
		expect(toHttpError("a string").code).toBe("internal");
		expect(toHttpError(null).status).toBe(500);
		expect(toHttpError(new HTTPException(502)).code).toBe("internal");
	});

	it("Hono HTTPException by status", () => {
		const cases: [number, number, string, boolean][] = [
			[401, 401, "unauthorized", false],
			[403, 403, "forbidden", false],
			[404, 404, "not_found", false],
			[413, 413, "payload_too_large", false],
			[415, 400, "validation", false],
			[429, 429, "rate_limited", true],
		];
		for (const [from, status, code, retryable] of cases) {
			const e = toHttpError(new HTTPException(from as 401));
			expect([e.status, e.code, e.retryable]).toEqual([
				status,
				code,
				retryable,
			]);
		}
	});

	it("machine_state_conflict -> 409 invalid_state", () => {
		const err = Object.assign(new Error("machine is running"), {
			code: "machine_state_conflict",
		});
		const e = toHttpError(err);
		expect(e.status).toBe(409);
		expect(e.code).toBe("invalid_state");
		expect(e.retryable).toBe(false);
	});

	it("an ApiError passes through unchanged", () => {
		const a = new ApiError(403, "forbidden", "no", {
			details: { requiredScope: "sandboxes:read" },
		});
		expect(toHttpError(a)).toBe(a);
	});
});

describe("error envelope on every response", () => {
	it("unknown route: 404 not_found", async () => {
		const h = createHarness();
		const r = await h.request("GET", "/v1/no-such-thing");
		expect(r.status).toBe(404);
		const e = expectEnvelope(r.body, r.headers);
		expect(e.code).toBe("not_found");
		expect(e.retryable).toBe(false);
	});

	it("known path, wrong method: 405 with Allow", async () => {
		const h = createHarness();
		const r = await h.request("DELETE", "/v1/meta");
		expect(r.status).toBe(405);
		expect(expectEnvelope(r.body, r.headers).code).toBe("method_not_allowed");
		expect(r.headers.get("allow")).toBe("GET, HEAD");
	});

	it("a trailing slash is another path: 404, not 405", async () => {
		const h = createHarness();
		const r = await h.request("GET", "/v1/meta/");
		expect(r.status).toBe(404);
		expect(expectEnvelope(r.body, r.headers).code).toBe("not_found");
	});

	it("an HTTPException thrown by middleware keeps the envelope", async () => {
		const h = createHarness({ bearer: TEST_API_KEY });
		h.app.use("/v1/__test/limited", () => {
			throw new HTTPException(429);
		});
		h.app.get("/v1/__test/limited", (c) => c.body(null, 204));
		const r = await h.request("GET", "/v1/__test/limited");
		expect(r.status).toBe(429);
		expect(expectEnvelope(r.body, r.headers)).toMatchObject({
			code: "rate_limited",
			retryable: true,
		});
		expect(r.headers.get("retry-after")).toBe("5");
	});

	it("malformed JSON: 400 invalid_json", async () => {
		const h = throwing(() => new Error("unused"));
		const r = await h.request("POST", "/v1/__test/echo", {
			headers: { "content-type": "application/json" },
			body: "{not json",
		});
		expect(r.status).toBe(400);
		expect(expectEnvelope(r.body, r.headers).code).toBe("invalid_json");
	});

	it("unexpected error: 500 internal without the error text", async () => {
		const h = throwing(() => new Error("secret-ish internals"));
		const r = await h.request("GET", "/v1/__test/throw");
		expect(r.status).toBe(500);
		const e = expectEnvelope(r.body, r.headers);
		expect(e.code).toBe("internal");
		expect(e.retryable).toBe(false);
		expect(r.text).not.toContain("secret-ish");
	});

	it("core error through a route: status, code, details", async () => {
		const h = throwing(
			() =>
				new UmiakError("operation_in_progress", "busy", {
					details: { operationId: "op_x", kind: "resume" },
				}),
		);
		const r = await h.request("GET", "/v1/__test/throw");
		expect(r.status).toBe(409);
		const e = expectEnvelope(r.body, r.headers);
		expect(e).toMatchObject({
			code: "operation_in_progress",
			retryable: true,
			details: { operationId: "op_x", kind: "resume" },
		});
	});

	it("503 out_of_capacity: Retry-After and details.retryAfterSeconds", async () => {
		const h = throwing(
			() =>
				new UmiakError("out_of_capacity", "full", {
					details: { retryAfterSeconds: 15 },
				}),
		);
		const r = await h.request("GET", "/v1/__test/throw");
		expect(r.status).toBe(503);
		expect(r.headers.get("retry-after")).toBe("15");
		expect(expectEnvelope(r.body, r.headers).details).toMatchObject({
			retryAfterSeconds: 15,
		});
	});

	it("429/503 without a hint get a default Retry-After", async () => {
		const h = throwing(() => new UmiakError("agent_unavailable", "gone"));
		const r = await h.request("GET", "/v1/__test/throw");
		expect(r.status).toBe(503);
		const after = Number(r.headers.get("retry-after"));
		expect(after).toBeGreaterThan(0);
		expect(expectEnvelope(r.body, r.headers).details).toMatchObject({
			retryAfterSeconds: after,
		});
	});

	it("ApiError headers are sent", async () => {
		const h = throwing(
			() =>
				new ApiError(409, "upload_offset_mismatch", "offset", {
					details: { offset: 5 },
					headers: { "Umiak-Upload-Offset": "5" },
				}),
		);
		const r = await h.request("GET", "/v1/__test/throw");
		expect(r.status).toBe(409);
		expect(r.headers.get("umiak-upload-offset")).toBe("5");
	});

	it("body over the default 1 MiB: 413 payload_too_large", async () => {
		const h = throwing(() => new Error("unused"));
		const r = await h.request("POST", "/v1/__test/echo", {
			headers: { "content-type": "application/json" },
			body: JSON.stringify({ s: "x".repeat(1024 * 1024) }),
		});
		expect(r.status).toBe(413);
		expect(expectEnvelope(r.body, r.headers).code).toBe("payload_too_large");
	});

	it("body within the limit passes", async () => {
		const h = throwing(() => new Error("unused"));
		const r = await h.request("POST", "/v1/__test/echo", {
			json: { s: "ok" },
		});
		expect(r.status).toBe(204);
	});

	it("schema violations: 400 validation with details.issues[{path, message}]", async () => {
		const h = throwing(() => new Error("unused"));
		const r = await h.request("POST", "/v1/__test/echo", {
			json: { s: 1, n: 1.5, failFast: true },
		});
		expect(r.status).toBe(400);
		const e = expectEnvelope(r.body, r.headers);
		expect(e.code).toBe("validation");
		const issues = (
			e.details as { issues: { path: string; message: string }[] }
		).issues;
		expect(issues.map((i) => i.path).sort()).toEqual(["failFast", "n", "s"]);
		for (const i of issues) expect(i.message).not.toBe("");
	});

	it("a JSON body with another content type: 400 validation", async () => {
		const h = throwing(() => new Error("unused"));
		const r = await h.request("POST", "/v1/__test/echo", {
			headers: { "content-type": "text/plain" },
			body: JSON.stringify({ s: "ok" }),
		});
		expect(r.status).toBe(400);
		expect(expectEnvelope(r.body, r.headers).code).toBe("validation");
	});

	for (const listener of ["proxied", "ops"] as const) {
		it(`${listener} listener: same envelope`, async () => {
			const h = createHarness({ listener });
			const r = await h.request("GET", "/nope");
			expect(r.status).toBe(404);
			expect(expectEnvelope(r.body, r.headers).code).toBe("not_found");
		});
	}

	it("internal listener: envelope plus top-level code (gateway reads it)", async () => {
		const h = throwing(
			() => new UmiakError("not_found", "no route"),
			"internal",
		);
		const r = await h.request("GET", "/internal/v1/nope");
		expect(r.status).toBe(404);
		expect(expectEnvelope(r.body, r.headers).code).toBe("not_found");
		expect((r.body as { code: string }).code).toBe("not_found");
		const t = await h.request("GET", "/v1/__test/throw");
		expect((t.body as { code: string }).code).toBe("not_found");
	});
});

describe("Request-Id", () => {
	it("own req_<ulid> on every response, a new one per request", async () => {
		const h = createHarness();
		const a = await h.request("GET", "/v1/meta");
		const b = await h.request("GET", "/v1/meta");
		expect(a.headers.get("request-id")).toMatch(/^req_[0-9a-z]{26}$/);
		expect(a.headers.get("request-id")).not.toBe(b.headers.get("request-id"));
	});

	it("the client's Request-Id is not echoed as ours", async () => {
		const h = createHarness();
		const r = await h.request("GET", "/v1/meta", {
			headers: { "request-id": "client-123.abc_X" },
		});
		expect(r.headers.get("request-id")).toMatch(/^req_/);
	});
});
