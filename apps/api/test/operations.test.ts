import { randomUUID } from "node:crypto";
import { decodeUuid, encodeUuid } from "@sbx/auth";
import { insertOperation } from "@sbx/core/testing";
import { createTestDatabase, skipPg, type TestDatabase } from "@sbx/db/testing";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { Harness, HarnessResponse } from "./helpers/harness.ts";
import { type ApiWorld, apiWorld } from "./helpers/world.ts";

// biome-ignore lint/suspicious/noExplicitAny: response bodies are checked by the conformance harness
type Body = any;
const body = (r: HarnessResponse): Body => r.body as Body;

describe.skipIf(skipPg())("GET /v1/operations/{operation}", () => {
	let db: TestDatabase;
	let w: ApiWorld;
	let h: Harness;

	beforeAll(async () => {
		db = await createTestDatabase({ max: 20 });
		w = await apiWorld(db.pool, {
			topology: { node: { ramCapMb: 1_000_000 } },
		});
		h = w.harness();
	});
	afterAll(async () => {
		await w?.close();
		await db?.drop();
	});

	const createOp = async (): Promise<Body> => {
		const r = await h.request("POST", "/v1/sandboxes", { json: {} });
		return body(r).operation;
	};

	it("returns the operation (§8.4) without its stored request", async () => {
		const op = await createOp();
		const r = await h.request("GET", `/v1/operations/${op.id}`);
		expect(r.status).toBe(200);
		expect(body(r)).toEqual({
			id: op.id,
			sandboxId: op.sandboxId,
			kind: "create",
			state: "pending",
			step: null,
			error: null,
			createdAt: op.createdAt,
			startedAt: null,
			finishedAt: null,
		});
		expect(r.text).not.toMatch(/"request"|bodyHash/);
	});

	it("long-poll returns when the operation finishes, before waitSeconds", async () => {
		const op = await createOp();
		const t0 = Date.now();
		const pending = h.request("GET", `/v1/operations/${op.id}?waitSeconds=20`);
		await new Promise((r) => setTimeout(r, 300));
		await w.finishOperation(
			decodeUuid("operation", op.id) as string,
			"succeeded",
		);
		const r = await pending;
		expect(body(r).state).toBe("succeeded");
		expect(body(r).finishedAt).not.toBeNull();
		expect(Date.now() - t0).toBeLessThan(10_000);
	});

	it("times out with the current state; a final operation answers at once", async () => {
		const op = await createOp();
		const t0 = Date.now();
		const r = await h.request("GET", `/v1/operations/${op.id}?waitSeconds=1`);
		expect(body(r).state).toBe("pending");
		expect(Date.now() - t0).toBeGreaterThanOrEqual(900);
		await w.finishOperation(decodeUuid("operation", op.id) as string, "failed");
		await db.pool.query(
			"UPDATE runtime.operations SET error_code = 'create_failed', error_message = 'boom', retryable = false WHERE id = $1",
			[decodeUuid("operation", op.id)],
		);
		const t1 = Date.now();
		const done = await h.request(
			"GET",
			`/v1/operations/${op.id}?waitSeconds=20`,
		);
		// "At once": well below the 20 s wait, with room for a loaded machine.
		expect(Date.now() - t1).toBeLessThan(10_000);
		expect(body(done).error).toEqual({
			code: "create_failed",
			message: "boom",
			retryable: false,
		});
	});

	it("another team's, unknown, malformed and reprovision operations are 404", async () => {
		const other = await w.seed({ state: "ready", teamId: randomUUID() });
		const foreign = await insertOperation(db.pool, {
			sandboxId: other.sandboxId,
			kind: "stop",
		});
		const own = await w.seed({ state: "ready" });
		const internal = await insertOperation(db.pool, {
			sandboxId: own.sandboxId,
			kind: "reprovision",
			state: "succeeded",
		});
		for (const ref of [
			encodeUuid("operation", foreign),
			encodeUuid("operation", randomUUID()),
			encodeUuid("operation", internal),
			"op_garbage",
			foreign,
		]) {
			const r = await h.request("GET", `/v1/operations/${ref}?waitSeconds=5`);
			expect(r.status, ref).toBe(404);
			expect(body(r).error.code).toBe("not_found");
		}
	});

	it("waitSeconds over 60 is 400; needs sandboxes:read", async () => {
		const op = await createOp();
		const r = await h.request("GET", `/v1/operations/${op.id}?waitSeconds=61`);
		expect(r.status).toBe(400);
		const k = await w.key(["files:read"]);
		const denied = await w
			.harness({ bearer: k.secret })
			.request("GET", `/v1/operations/${op.id}`);
		expect(denied.status).toBe(403);
		expect(body(denied).error.details.requiredScope).toBe("sandboxes:read");
	});
});
