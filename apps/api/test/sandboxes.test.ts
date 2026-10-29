import { randomUUID } from "node:crypto";
import { decodeUuid, encodeUuid } from "@sbx/auth";
import { insertOperation } from "@sbx/core/testing";
import { createTestDatabase, skipPg, type TestDatabase } from "@sbx/db/testing";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { decodeCursor, encodeCursor } from "../src/http/cursor.ts";
import { testSettings } from "../src/testing/index.ts";
import type { Harness, HarnessResponse } from "./helpers/harness.ts";
import { type ApiWorld, apiWorld } from "./helpers/world.ts";

const BIG_NODE = { topology: { node: { ramCapMb: 1_000_000 } } };

// biome-ignore lint/suspicious/noExplicitAny: response bodies are checked by the conformance harness
type Body = any;

function body(r: HarnessResponse): Body {
	return r.body as Body;
}

function errorOf(r: HarnessResponse): {
	code: string;
	retryable: boolean;
	details: Record<string, unknown>;
} {
	return body(r).error;
}

function uuidOf(kind: "sandbox" | "operation", id: string): string {
	const u = decodeUuid(kind, id);
	if (u === null) throw new Error(`not a ${kind} id: ${id}`);
	return u;
}

describe("cursor", () => {
	const key = testSettings().cursorKey;

	it("round-trips and rejects forged or foreign cursors with invalid_cursor", () => {
		const c = encodeCursor("abc", key);
		expect(decodeCursor(c, key)).toBe("abc");
		const forged = `${c.slice(0, -2)}${c.endsWith("AA") ? "BB" : "AA"}`;
		for (const bad of [
			forged,
			"abc",
			`${Buffer.from('{"c":"x"}').toString("base64url")}.`,
			encodeCursor("abc", Buffer.alloc(32, 1)),
		]) {
			expect(() => decodeCursor(bad, key)).toThrow(
				expect.objectContaining({ status: 400, code: "invalid_cursor" }),
			);
		}
	});
});

describe.skipIf(skipPg())("sandbox routes", () => {
	let db: TestDatabase;
	let w: ApiWorld;
	let h: Harness;

	beforeAll(async () => {
		db = await createTestDatabase({ max: 20 });
		w = await apiWorld(db.pool, BIG_NODE);
		h = w.harness();
	});
	afterAll(async () => {
		await w?.close();
		await db?.drop();
	});

	const create = (json: unknown = {}, headers: Record<string, string> = {}) =>
		h.request("POST", "/v1/sandboxes", { json, headers });

	describe("POST /v1/sandboxes", () => {
		it("answers 202 {sandbox, operation} with public ids and §8.1 fields", async () => {
			const r = await create({ name: "ci-run", labels: { suite: "create" } });
			expect(r.status).toBe(202);
			const { sandbox, operation } = body(r);
			expect(sandbox.id).toMatch(/^sb_[0-9a-z]{26}$/);
			expect(sandbox.teamId).toBe(encodeUuid("team", w.teamId));
			expect(sandbox.state).toBe("creating");
			expect(sandbox.name).toBe("ci-run");
			expect(sandbox.createdBy).toBeNull();
			expect(sandbox.createdByKey).toBe(encodeUuid("apiKey", w.keyId));
			expect(sandbox.template).toBe(w.env.template);
			expect(sandbox.templateVersion).toMatch(/^v\d+$/);
			expect(sandbox.origin).toEqual({ kind: "template" });
			expect(sandbox.environment).toBeNull();
			expect(sandbox.excludeOwnerSecrets).toBe(false);
			expect(sandbox.endpoints).toEqual({
				portUrlTemplate: `https://${sandbox.slug}-{port}.sbx.test`,
				ssh: `ssh ${sandbox.slug}@ssh.sbx.test`,
			});
			expect(sandbox.createdAt).toMatch(
				/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z$/,
			);
			expect(sandbox.updatedAt).toMatch(/Z$/);
			expect(sandbox.activeOperation.id).toBe(operation.id);
			expect(operation.id).toMatch(/^op_[0-9a-z]{26}$/);
			expect(operation.sandboxId).toBe(sandbox.id);
			expect(operation.kind).toBe("create");
			expect(operation.error).toBeNull();
			expect(r.headers.get("idempotency-replayed")).toBeNull();
			expect(r.text).not.toMatch(/"request"|bodyHash|fromPool|failFast/);
		});

		it("an empty request works (all fields are optional)", async () => {
			const r = await h.request("POST", "/v1/sandboxes");
			expect(r.status).toBe(202);
			expect(body(r).sandbox.size).toBe("2gb");
		});

		it("a repeat with the same Idempotency-Key replays with Idempotency-Replayed: true", async () => {
			const key = `k-${randomUUID()}`;
			const json = { labels: { suite: "idem" } };
			const a = await create(json, { "idempotency-key": key });
			const b = await create(json, { "idempotency-key": key });
			expect(a.status).toBe(202);
			expect(b.status).toBe(202);
			expect(a.headers.get("idempotency-replayed")).toBeNull();
			expect(b.headers.get("idempotency-replayed")).toBe("true");
			expect(body(b).sandbox.id).toBe(body(a).sandbox.id);
			expect(body(b).operation.id).toBe(body(a).operation.id);

			const other = await create(
				{ labels: { suite: "other" } },
				{ "idempotency-key": key },
			);
			expect(other.status).toBe(409);
			expect(errorOf(other).code).toBe("idempotency_key_reused");
		});

		it("a malformed Idempotency-Key is 400 validation", async () => {
			const r = await create({}, { "idempotency-key": "x".repeat(256) });
			expect(r.status).toBe(400);
			expect(errorOf(r).code).toBe("validation");
		});

		it("failFast is not part of the API: 400 validation", async () => {
			const r = await create({ failFast: true });
			expect(r.status).toBe(400);
			expect(errorOf(r).code).toBe("validation");
			expect(JSON.stringify(errorOf(r).details)).toContain("failFast");
		});

		it("idleTimeoutSeconds below 60 is 400; null and 60 are accepted", async () => {
			const r = await create({ idleTimeoutSeconds: 30 });
			expect(r.status).toBe(400);
			expect(errorOf(r).code).toBe("validation");
			expect((await create({ idleTimeoutSeconds: 60 })).status).toBe(202);
			const off = await create({ idleTimeoutSeconds: null });
			expect(body(off).sandbox.idleTimeoutSeconds).toBeNull();
		});

		it("`from` needs snapshots:read", async () => {
			const k = await w.key(["sandboxes:write"]);
			const r = await w
				.harness({ bearer: k.secret })
				.request("POST", "/v1/sandboxes", {
					json: { from: { snapshot: "nope" } },
				});
			expect(r.status).toBe(403);
			expect(errorOf(r).details.requiredScope).toBe("snapshots:read");
		});

		it("an unknown snapshot is 404 snapshot_not_found", async () => {
			const r = await create({ from: { snapshot: "missing-snap" } });
			expect(r.status).toBe(404);
			expect(errorOf(r).code).toBe("snapshot_not_found");
		});

		it("needs sandboxes:write", async () => {
			const k = await w.key(["sandboxes:read"]);
			const r = await w
				.harness({ bearer: k.secret })
				.request("POST", "/v1/sandboxes", { json: {} });
			expect(r.status).toBe(403);
			expect(errorOf(r).details.requiredScope).toBe("sandboxes:write");
		});
	});

	describe("GET /v1/sandboxes", () => {
		const suite = `list-${randomUUID().slice(0, 8)}`;
		let ids: string[] = [];

		beforeAll(async () => {
			ids = [];
			for (const n of ["1", "2", "3"]) {
				const r = await create({ labels: { suite, n } });
				ids.push(body(r).sandbox.id);
			}
			const gone = await w.seed({
				state: "deleted",
				machineState: null,
				labels: { suite, n: "gone" },
			});
			ids.push(encodeUuid("sandbox", gone.sandboxId));
		});

		const list = (query: string) => h.request("GET", `/v1/sandboxes?${query}`);

		it("label=k=v twice: all must match", async () => {
			const r = await list(`label=suite=${suite}&label=n=2`);
			expect(r.status).toBe(200);
			expect(body(r).data.map((s: Body) => s.id)).toEqual([ids[1]]);
			const one = await list(`label=suite=${suite}`);
			expect(body(one).data).toHaveLength(3);
		});

		it("deleted sandboxes only with state=deleted", async () => {
			const r = await list(`label=suite=${suite}&state=deleted`);
			expect(body(r).data.map((s: Body) => s.id)).toEqual([ids[3]]);
			const both = await list(`label=suite=${suite}&state=creating,deleted`);
			expect(body(both).data).toHaveLength(4);
		});

		it("pages with a signed cursor, newest first; a forged cursor is 400 invalid_cursor", async () => {
			const p1 = await list(`label=suite=${suite}&limit=2`);
			expect(body(p1).data.map((s: Body) => s.id)).toEqual([ids[2], ids[1]]);
			const next = body(p1).nextCursor as string;
			expect(next).toMatch(/\./);
			const p2 = await list(
				`label=suite=${suite}&limit=2&cursor=${encodeURIComponent(next)}`,
			);
			expect(body(p2).data.map((s: Body) => s.id)).toEqual([ids[0]]);
			expect(body(p2).nextCursor).toBeNull();

			const [payload] = next.split(".");
			for (const bad of [`${payload}.AAAAAAAAAAAAAAAAAAAAAA`, payload ?? ""]) {
				const r = await list(`cursor=${encodeURIComponent(bad)}`);
				expect(r.status).toBe(400);
				expect(errorOf(r).code).toBe("invalid_cursor");
			}
		});

		it("rejects unknown states, bad labels and limits with 400 validation", async () => {
			for (const q of ["state=bogus", "label=nokey", "limit=0", "limit=201"]) {
				const r = await list(q);
				expect(r.status, q).toBe(400);
				expect(errorOf(r).code, q).toBe("validation");
			}
		});
	});

	describe("GET /v1/sandboxes/{sandbox}", () => {
		it("by id and by slug; bad ids, bare UUIDs and other teams are 404", async () => {
			const s = await w.seed({ state: "ready" });
			const id = encodeUuid("sandbox", s.sandboxId);
			const byId = await h.request("GET", `/v1/sandboxes/${id}`);
			expect(byId.status).toBe(200);
			expect(body(byId).slug).toBe(s.slug);
			const upper = await h.request("GET", `/v1/sandboxes/${id.toUpperCase()}`);
			expect(upper.status).toBe(200);
			const bySlug = await h.request("GET", `/v1/sandboxes/${s.slug}`);
			expect(body(bySlug).id).toBe(id);
			for (const ref of ["sb_garbage", s.sandboxId, "no-such-box"]) {
				const r = await h.request("GET", `/v1/sandboxes/${ref}`);
				expect(r.status, ref).toBe(404);
				expect(errorOf(r).code).toBe("not_found");
			}
			const other = await w.seed({ state: "ready", teamId: randomUUID() });
			const r = await h.request(
				"GET",
				`/v1/sandboxes/${encodeUuid("sandbox", other.sandboxId)}`,
			);
			expect(r.status).toBe(404);
		});

		it("long-poll returns on markReady before waitSeconds", async () => {
			const c = await create({});
			const { sandbox } = body(c);
			const started = Date.now();
			const pending = h.request(
				"GET",
				`/v1/sandboxes/${sandbox.id}?waitFor=ready&waitSeconds=20`,
			);
			await new Promise((r) => setTimeout(r, 300));
			await w.markReady(uuidOf("sandbox", sandbox.id));
			const r = await pending;
			expect(r.status).toBe(200);
			expect(body(r).state).toBe("ready");
			expect(body(r).activeOperation).toBeNull();
			expect(Date.now() - started).toBeLessThan(10_000);
		});

		it("long-poll ends on error and times out with the current state", async () => {
			const c = await create({});
			const id = body(c).sandbox.id as string;
			const t0 = Date.now();
			const timeout = await h.request(
				"GET",
				`/v1/sandboxes/${id}?waitFor=stopped&waitSeconds=1`,
			);
			expect(body(timeout).state).toBe("creating");
			expect(Date.now() - t0).toBeGreaterThanOrEqual(900);

			const pending = h.request(
				"GET",
				`/v1/sandboxes/${id}?waitFor=ready&waitSeconds=20`,
			);
			await new Promise((r) => setTimeout(r, 200));
			await w.markState(uuidOf("sandbox", id), "error");
			expect(body(await pending).state).toBe("error");
		});

		it("waitSeconds over 60 and unknown waitFor states are 400", async () => {
			const s = await w.seed({ state: "ready" });
			for (const q of ["waitFor=ready&waitSeconds=61", "waitFor=soon"]) {
				const r = await h.request("GET", `/v1/sandboxes/${s.slug}?${q}`);
				expect(r.status, q).toBe(400);
			}
		});
	});

	describe("PATCH /v1/sandboxes/{sandbox}", () => {
		it("changes name, labels, idle timeout and slug (rename)", async () => {
			const s = await w.seed({ state: "ready" });
			const slug = `ren-${randomUUID().slice(0, 8)}x`;
			const r = await h.request("PATCH", `/v1/sandboxes/${s.slug}`, {
				json: {
					name: "renamed",
					labels: { a: "b" },
					idleTimeoutSeconds: 120,
					slug,
				},
			});
			expect(r.status).toBe(200);
			expect(body(r)).toMatchObject({
				slug,
				name: "renamed",
				labels: { a: "b" },
				idleTimeoutSeconds: 120,
			});
			expect(body(r).endpoints.ssh).toBe(`ssh ${slug}@ssh.sbx.test`);
			expect((await h.request("GET", `/v1/sandboxes/${s.slug}`)).status).toBe(
				404,
			);
		});

		it("slug_taken, idleTimeoutSeconds: 30 and unknown fields are refused", async () => {
			const a = await w.seed({ state: "ready" });
			const b = await w.seed({ state: "ready" });
			const taken = await h.request("PATCH", `/v1/sandboxes/${a.slug}`, {
				json: { slug: b.slug },
			});
			expect(taken.status).toBe(409);
			expect(errorOf(taken).code).toBe("slug_taken");
			for (const json of [{ idleTimeoutSeconds: 30 }, { state: "ready" }]) {
				const r = await h.request("PATCH", `/v1/sandboxes/${a.slug}`, {
					json,
				});
				expect(r.status).toBe(400);
				expect(errorOf(r).code).toBe("validation");
			}
		});
	});

	describe("DELETE /v1/sandboxes/{sandbox}", () => {
		it("without Sbx-Confirm-Delete: 428 missing; another sandbox's id: 428 mismatch; nothing deleted", async () => {
			const s = await w.seed({ state: "ready" });
			const other = await w.seed({ state: "ready" });
			const missing = await h.request("DELETE", `/v1/sandboxes/${s.slug}`);
			expect(missing.status).toBe(428);
			expect(errorOf(missing)).toMatchObject({
				code: "confirmation_required",
				retryable: false,
				details: { reason: "missing" },
			});
			const mismatch = await h.request("DELETE", `/v1/sandboxes/${s.slug}`, {
				headers: {
					"sbx-confirm-delete": encodeUuid("sandbox", other.sandboxId),
				},
			});
			expect(mismatch.status).toBe(428);
			expect(errorOf(mismatch).details.reason).toBe("mismatch");
			for (const id of [s.sandboxId, other.sandboxId]) {
				const g = await h.request(
					"GET",
					`/v1/sandboxes/${encodeUuid("sandbox", id)}`,
				);
				expect(body(g).state).toBe("ready");
			}
		});

		it("202 with the delete operation; a repeat returns it; a deleted sandbox gives 200 operation: null", async () => {
			const s = await w.seed({ state: "ready" });
			const id = encodeUuid("sandbox", s.sandboxId);
			const r = await h.request("DELETE", `/v1/sandboxes/${id}`, {
				headers: { "sbx-confirm-delete": s.slug },
			});
			expect(r.status).toBe(202);
			expect(body(r).sandbox.state).toBe("deleting");
			expect(body(r).operation.kind).toBe("delete");
			const again = await h.request("DELETE", `/v1/sandboxes/${id}`, {
				headers: { "sbx-confirm-delete": id.toUpperCase() },
			});
			expect(again.status).toBe(202);
			expect(body(again).operation.id).toBe(body(r).operation.id);

			await w.finishOperation(
				uuidOf("operation", body(r).operation.id),
				"succeeded",
			);
			await w.markState(s.sandboxId, "deleted");
			const done = await h.request("DELETE", `/v1/sandboxes/${id}`, {
				headers: { "sbx-confirm-delete": id },
			});
			expect(done.status).toBe(200);
			expect(body(done).operation).toBeNull();
			expect(body(done).sandbox.state).toBe("deleted");
		});

		it("needs sandboxes:delete", async () => {
			const s = await w.seed({ state: "ready" });
			const k = await w.key(["sandboxes:read", "sandboxes:write"]);
			const r = await w
				.harness({ bearer: k.secret })
				.request("DELETE", `/v1/sandboxes/${s.slug}`, {
					headers: { "sbx-confirm-delete": s.slug },
				});
			expect(r.status).toBe(403);
			expect(errorOf(r).details.requiredScope).toBe("sandboxes:delete");
		});
	});

	describe("actions", () => {
		it("a repeat of POST /stop during the stop returns 202 with the same operation", async () => {
			const s = await w.seed({ state: "ready" });
			const a = await h.request("POST", `/v1/sandboxes/${s.slug}/stop`);
			expect(a.status).toBe(202);
			expect(body(a).operation.kind).toBe("stop");
			expect(body(a).sandbox.state).toBe("stopping");
			expect(body(a).sandbox.activeOperation.id).toBe(body(a).operation.id);
			const b = await h.request("POST", `/v1/sandboxes/${s.slug}/stop`);
			expect(b.status).toBe(202);
			expect(body(b).operation.id).toBe(body(a).operation.id);
		});

		it("another kind while an operation is active: 409 operation_in_progress, retryable, public operation id", async () => {
			const s = await w.seed({ state: "ready" });
			const stop = await h.request("POST", `/v1/sandboxes/${s.slug}/stop`);
			const r = await h.request("POST", `/v1/sandboxes/${s.slug}/recover`);
			expect(r.status).toBe(409);
			expect(errorOf(r)).toMatchObject({
				code: "operation_in_progress",
				retryable: true,
				details: { operationId: body(stop).operation.id, kind: "stop" },
			});
		});

		it("an active reprovision is hidden: activeOperation null, its id 404, actions 409 without naming it", async () => {
			const s = await w.seed({ state: "ready" });
			const opId = await insertOperation(db.pool, {
				sandboxId: s.sandboxId,
				kind: "reprovision",
				state: "running",
			});
			const g = await h.request("GET", `/v1/sandboxes/${s.slug}`);
			expect(body(g).activeOperation).toBeNull();
			const op = await h.request(
				"GET",
				`/v1/operations/${encodeUuid("operation", opId)}`,
			);
			expect(op.status).toBe(404);
			const stop = await h.request("POST", `/v1/sandboxes/${s.slug}/stop`);
			expect(stop.status).toBe(409);
			expect(errorOf(stop).code).toBe("operation_in_progress");
			expect(errorOf(stop).retryable).toBe(true);
			expect(stop.text).not.toContain("reprovision");
			expect(stop.text).not.toContain(opId);
			expect(errorOf(stop).details).toEqual({});
		});

		it("resume of a stopped sandbox: 202; the body hash of the operation never leaks", async () => {
			const s = await w.seed({ state: "stopped", machineState: "stopped" });
			const r = await h.request("POST", `/v1/sandboxes/${s.slug}/resume`, {
				json: { env: { A: "1" } },
			});
			expect(r.status).toBe(202);
			expect(body(r).operation.kind).toBe("resume");
			expect(body(r).sandbox.state).toBe("starting");
			expect(r.text).not.toMatch(/bodyHash|"request"/);
			const op = await h.request(
				"GET",
				`/v1/operations/${body(r).operation.id}`,
			);
			expect(op.text).not.toMatch(/bodyHash|"request"/);
			const again = await h.request("POST", `/v1/sandboxes/${s.slug}/resume`, {
				json: { env: { A: "1" } },
			});
			expect(again.status).toBe(202);
			expect(body(again).operation.id).toBe(body(r).operation.id);
		});

		it("proxied: a JSON body needs Content-Type application/json, also on an optional body", async () => {
			const s = await w.seed({ state: "stopped", machineState: "stopped" });
			const { h: ph, headers } = w.session();
			const r = await ph.request("POST", `/v1/sandboxes/${s.slug}/resume`, {
				headers: { ...headers, "content-type": "text/plain" },
				body: JSON.stringify({ size: "4gb" }),
			});
			expect(r.status).toBe(400);
			expect(errorOf(r).code).toBe("validation");
			const g = await h.request("GET", `/v1/sandboxes/${s.slug}`);
			expect(body(g).state).toBe("stopped");
			const ok = await ph.request("POST", `/v1/sandboxes/${s.slug}/resume`, {
				headers,
				json: {},
			});
			expect(ok.status).toBe(202);
		});

		it("recover of a sandbox in error: 202", async () => {
			const s = await w.seed({
				state: "error",
				lastRecoverAgoSeconds: 100_000,
			});
			const r = await h.request("POST", `/v1/sandboxes/${s.slug}/recover`);
			expect(r.status).toBe(202);
			expect(body(r).operation.kind).toBe("recover");
		});

		it("fork: 202 {sandbox, operation, sourceOperation} with origin fork; Idempotency-Key replays", async () => {
			const s = await w.seed({ state: "ready" });
			const key = `fork-${randomUUID()}`;
			const json = { name: "child", idleTimeoutSeconds: 300 };
			const r = await h.request("POST", `/v1/sandboxes/${s.slug}/fork`, {
				json,
				headers: { "idempotency-key": key },
			});
			expect(r.status).toBe(202);
			const b = body(r);
			expect(b.sandbox.origin).toEqual({
				kind: "fork",
				sandboxId: encodeUuid("sandbox", s.sandboxId),
			});
			expect(b.operation.kind).toBe("create");
			expect(b.sourceOperation.kind).toBe("fork");
			expect(b.sourceOperation.sandboxId).toBe(
				encodeUuid("sandbox", s.sandboxId),
			);
			expect(r.headers.get("idempotency-replayed")).toBeNull();
			const again = await h.request("POST", `/v1/sandboxes/${s.slug}/fork`, {
				json,
				headers: { "idempotency-key": key },
			});
			expect(again.headers.get("idempotency-replayed")).toBe("true");
			expect(body(again).sandbox.id).toBe(b.sandbox.id);
			const low = await h.request("POST", `/v1/sandboxes/${s.slug}/fork`, {
				json: { idleTimeoutSeconds: 30 },
			});
			expect(low.status).toBe(400);
		});

		it("extend moves the deadline of a ready sandbox", async () => {
			const s = await w.seed({ state: "ready", ttlSeconds: 600 });
			const r = await h.request("POST", `/v1/sandboxes/${s.slug}/extend`, {
				json: { ttlSeconds: 3600 },
			});
			expect(r.status).toBe(200);
			const left = Date.parse(body(r).deadlineAt) - Date.now();
			expect(left).toBeGreaterThan(3_000_000);
			const dflt = await h.request("POST", `/v1/sandboxes/${s.slug}/extend`);
			expect(dflt.status).toBe(200);
			expect(body(dflt).ttlSeconds).toBe(600);
		});

		it("starts are rate limited per team (create, fork, resume)", async () => {
			const limited = w.harness({
				deps: {
					settings: testSettings({
						SBX_API_RATE_BURST: "1000",
						SBX_API_RATE_STARTS_PER_MIN: "1",
					}),
				},
			});
			expect(
				(await limited.request("POST", "/v1/sandboxes", { json: {} })).status,
			).toBe(202);
			const r = await limited.request("POST", "/v1/sandboxes", { json: {} });
			expect(r.status).toBe(429);
			expect(errorOf(r).details.limit).toBe("starts");
		});
	});
});
