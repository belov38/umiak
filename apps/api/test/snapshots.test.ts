import { randomUUID } from "node:crypto";
import { decodeUuid, encodeUuid } from "@sbx/auth";
import { insertSavedSnapshot } from "@sbx/core/testing";
import { createTestDatabase, skipPg, type TestDatabase } from "@sbx/db/testing";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { Harness, HarnessResponse } from "./helpers/harness.ts";
import { type ApiWorld, apiWorld } from "./helpers/world.ts";

// biome-ignore lint/suspicious/noExplicitAny: response bodies are checked by the conformance harness
type Body = any;
const body = (r: HarnessResponse): Body => r.body as Body;

describe.skipIf(skipPg())("saved snapshots (S7 §13)", () => {
	let db: TestDatabase;
	let w: ApiWorld;
	let h: Harness;

	beforeAll(async () => {
		db = await createTestDatabase({ max: 20 });
		w = await apiWorld(db.pool, {
			quota: {
				maxActiveSandboxes: 100,
				maxRamMb: 1_000_000,
				maxSavedSnapshots: 100,
			},
		});
		h = w.harness();
	});
	afterAll(async () => {
		await w?.close();
		await db?.drop();
	});

	const uniqueName = (p: string) => `${p}-${randomUUID().slice(0, 8)}`;

	async function makeReady(snapshotId: string, name: string) {
		await db.pool.query(
			`UPDATE runtime.snapshots
			 SET state = 'ready', name = $2, pending_name = NULL, ready_at = now(),
			     consistency = 'quiesced', hw = '{}'::jsonb
			 WHERE id = $1`,
			[snapshotId, name],
		);
	}

	it("POST /snapshots answers 202 {snapshot, operation}; the snapshot is creating under its pending name", async () => {
		const s = await w.seed({ state: "ready" });
		const name = uniqueName("web");
		const r = await h.request("POST", "/v1/snapshots", {
			json: { sandbox: s.slug, name },
		});
		expect(r.status).toBe(202);
		const { snapshot, operation } = body(r);
		expect(snapshot).toMatchObject({
			name,
			state: "creating",
			sourceSandboxId: encodeUuid("sandbox", s.sandboxId),
			template: w.env.template,
			size: "2gb",
			consistency: null,
			error: null,
			readyAt: null,
		});
		expect(snapshot.id).toMatch(/^snap_/);
		expect(snapshot.templateVersion).toEqual(expect.any(String));
		expect(operation).toMatchObject({
			kind: "save_snapshot",
			state: "pending",
			sandboxId: encodeUuid("sandbox", s.sandboxId),
		});
		expect(operation).not.toHaveProperty("request");

		const byName = await h.request("GET", `/v1/snapshots/${name}`);
		expect(byName.status).toBe(200);
		expect(body(byName).id).toBe(snapshot.id);
		expect(body(byName).state).toBe("creating");

		const list = await h.request("GET", "/v1/snapshots");
		expect(list.status).toBe(200);
		expect(body(list).data.map((x: Body) => x.id)).toContain(snapshot.id);
	});

	it("the sandbox may be an sb_ id; an unknown or foreign sandbox is 404", async () => {
		const s = await w.seed({ state: "ready" });
		const r = await h.request("POST", "/v1/snapshots", {
			json: {
				sandbox: encodeUuid("sandbox", s.sandboxId),
				name: uniqueName("id"),
			},
		});
		expect(r.status).toBe(202);

		const other = await w.seed({ state: "ready", teamId: randomUUID() });
		for (const sandbox of [
			other.slug,
			encodeUuid("sandbox", other.sandboxId),
			"nope-nope-nope",
		]) {
			const f = await h.request("POST", "/v1/snapshots", {
				json: { sandbox, name: uniqueName("x") },
			});
			expect(f.status, sandbox).toBe(404);
			expect(body(f).error.code).toBe("not_found");
		}
	});

	it("Idempotency-Key: the same body replays the same snapshot; another body is 409", async () => {
		const s = await w.seed({ state: "ready" });
		const key = `k-${randomUUID()}`;
		const name = uniqueName("idem");
		const first = await h.request("POST", "/v1/snapshots", {
			headers: { "Idempotency-Key": key },
			json: { sandbox: s.slug, name },
		});
		expect(first.status).toBe(202);
		expect(first.headers.get("idempotency-replayed")).toBeNull();
		const again = await h.request("POST", "/v1/snapshots", {
			headers: { "Idempotency-Key": key },
			json: { sandbox: encodeUuid("sandbox", s.sandboxId), name },
		});
		expect(again.status).toBe(202);
		expect(again.headers.get("idempotency-replayed")).toBe("true");
		expect(body(again).snapshot.id).toBe(body(first).snapshot.id);
		expect(body(again).operation.id).toBe(body(first).operation.id);

		const other = await h.request("POST", "/v1/snapshots", {
			headers: { "Idempotency-Key": key },
			json: { sandbox: s.slug, name: uniqueName("idem") },
		});
		expect(other.status).toBe(409);
		expect(body(other).error.code).toBe("idempotency_key_reused");
	});

	it("validation: a bad name or an unknown field is 400; an active operation is 409", async () => {
		const s = await w.seed({ state: "ready" });
		for (const json of [
			{ sandbox: s.slug, name: "Bad_Name" },
			{ sandbox: s.slug, name: "-x" },
			{ sandbox: s.slug },
			{ sandbox: s.slug, name: "ok", extra: 1 },
		]) {
			const r = await h.request("POST", "/v1/snapshots", { json });
			expect(r.status, JSON.stringify(json)).toBe(400);
			expect(body(r).error.code).toBe("validation");
		}
		await h.request("POST", "/v1/snapshots", {
			json: { sandbox: s.slug, name: uniqueName("busy") },
		});
		const busy = await h.request("POST", "/v1/snapshots", {
			json: { sandbox: s.slug, name: uniqueName("busy") },
		});
		expect(busy.status).toBe(409);
		expect(body(busy).error.code).toBe("operation_in_progress");
		expect(body(busy).error.details.operationId).toMatch(/^op_/);
	});

	it("a ready snapshot: consistency, readyAt; a failed one carries the operation's error", async () => {
		const s = await w.seed({ state: "ready" });
		const name = uniqueName("ok");
		const r = await h.request("POST", "/v1/snapshots", {
			json: { sandbox: s.slug, name },
		});
		const id = decodeUuid("snapshot", body(r).snapshot.id) as string;
		await makeReady(id, name);
		await w.finishOperation(
			decodeUuid("operation", body(r).operation.id) as string,
			"succeeded",
		);
		const ready = await h.request("GET", `/v1/snapshots/${name}`);
		expect(body(ready)).toMatchObject({
			name,
			state: "ready",
			consistency: "quiesced",
			error: null,
		});
		expect(body(ready).readyAt).toEqual(expect.any(String));

		const failedName = uniqueName("bad");
		const f = await h.request("POST", "/v1/snapshots", {
			json: { sandbox: s.slug, name: failedName },
		});
		const opId = decodeUuid("operation", body(f).operation.id) as string;
		await db.pool.query(
			`UPDATE runtime.operations
			 SET state = 'failed', error_code = 'snapshot_failed', error_message = 'disk full',
			     finished_at = now()
			 WHERE id = $1`,
			[opId],
		);
		await db.pool.query(
			"UPDATE runtime.snapshots SET state = 'failed' WHERE id = $1",
			[decodeUuid("snapshot", body(f).snapshot.id)],
		);
		const list = await h.request("GET", "/v1/snapshots");
		const failed = body(list).data.find(
			(x: Body) => x.id === body(f).snapshot.id,
		);
		expect(failed).toMatchObject({
			name: failedName,
			state: "failed",
			error: { code: "snapshot_failed", message: "disk full" },
		});
		// A failed snapshot is not found by name.
		const g = await h.request("GET", `/v1/snapshots/${failedName}`);
		expect(g.status).toBe(404);
		expect(body(g).error.code).toBe("snapshot_not_found");
	});

	it("DELETE needs Sbx-Confirm-Delete (snap_ id or name): 428 without or with another one, then 204", async () => {
		const name = uniqueName("del");
		const id = await insertSavedSnapshot(db.pool, w.env.topo, {
			teamId: w.teamId,
			name,
		});
		const missing = await h.request("DELETE", `/v1/snapshots/${name}`);
		expect(missing.status).toBe(428);
		expect(body(missing).error.code).toBe("confirmation_required");
		expect(body(missing).error.details.reason).toBe("missing");

		const wrong = await h.request("DELETE", `/v1/snapshots/${name}`, {
			headers: { "Sbx-Confirm-Delete": "another-name" },
		});
		expect(wrong.status).toBe(428);
		expect(body(wrong).error.details.reason).toBe("mismatch");
		const state = await db.pool.query(
			"SELECT state FROM runtime.snapshots WHERE id = $1",
			[id],
		);
		expect(state.rows[0].state).toBe("ready");

		const byId = await h.request("DELETE", `/v1/snapshots/${name}`, {
			headers: {
				"Sbx-Confirm-Delete": encodeUuid("snapshot", id).toUpperCase(),
			},
		});
		expect(byId.status).toBe(204);
		const after = await db.pool.query(
			"SELECT state FROM runtime.snapshots WHERE id = $1",
			[id],
		);
		expect(after.rows[0].state).toBe("deleting");
		// The name is free at once.
		const gone = await h.request("GET", `/v1/snapshots/${name}`);
		expect(gone.status).toBe(404);

		const name2 = uniqueName("del");
		await insertSavedSnapshot(db.pool, w.env.topo, {
			teamId: w.teamId,
			name: name2,
		});
		const byName = await h.request("DELETE", `/v1/snapshots/${name2}`, {
			headers: { "Sbx-Confirm-Delete": name2 },
		});
		expect(byName.status).toBe(204);
	});

	it("DELETE of a snapshot still creating is 409 invalid_state; of an unknown name 404", async () => {
		const s = await w.seed({ state: "ready" });
		const name = uniqueName("wip");
		const r = await h.request("POST", "/v1/snapshots", {
			json: { sandbox: s.slug, name },
		});
		const d = await h.request("DELETE", `/v1/snapshots/${name}`, {
			headers: { "Sbx-Confirm-Delete": body(r).snapshot.id },
		});
		expect(d.status).toBe(409);
		expect(body(d).error.code).toBe("invalid_state");
		expect(body(d).error.details.state).toBe("creating");

		const none = await h.request("DELETE", "/v1/snapshots/no-such-snap", {
			headers: { "Sbx-Confirm-Delete": "no-such-snap" },
		});
		expect(none.status).toBe(404);
		expect(body(none).error.code).toBe("snapshot_not_found");
	});

	it("another team's snapshot is not visible, readable or deletable", async () => {
		const otherTeam = randomUUID();
		const name = uniqueName("theirs");
		const id = await insertSavedSnapshot(db.pool, w.env.topo, {
			teamId: otherTeam,
			name,
		});
		const list = await h.request("GET", "/v1/snapshots");
		expect(body(list).data.map((x: Body) => x.id)).not.toContain(
			encodeUuid("snapshot", id),
		);
		const g = await h.request("GET", `/v1/snapshots/${name}`);
		expect(g.status).toBe(404);
		const d = await h.request("DELETE", `/v1/snapshots/${name}`, {
			headers: { "Sbx-Confirm-Delete": name },
		});
		expect(d.status).toBe(404);
		const state = await db.pool.query(
			"SELECT state FROM runtime.snapshots WHERE id = $1",
			[id],
		);
		expect(state.rows[0].state).toBe("ready");
	});

	it("scopes: reads need snapshots:read, create and delete snapshots:write", async () => {
		const reader = await w.key(["snapshots:read"]);
		const rh = w.harness({ bearer: reader.secret });
		expect((await rh.request("GET", "/v1/snapshots")).status).toBe(200);
		const s = await w.seed({ state: "ready" });
		const c = await rh.request("POST", "/v1/snapshots", {
			json: { sandbox: s.slug, name: uniqueName("no") },
		});
		expect(c.status).toBe(403);
		expect(body(c).error.details.requiredScope).toBe("snapshots:write");
		const d = await rh.request("DELETE", "/v1/snapshots/x", {
			headers: { "Sbx-Confirm-Delete": "x" },
		});
		expect(d.status).toBe(403);
		expect(body(d).error.details.requiredScope).toBe("snapshots:write");

		const writer = await w.key(["snapshots:write"]);
		const wh = w.harness({ bearer: writer.secret });
		const l = await wh.request("GET", "/v1/snapshots");
		expect(l.status).toBe(403);
		expect(body(l).error.details.requiredScope).toBe("snapshots:read");
	});
});
