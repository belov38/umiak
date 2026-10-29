import { createTestDatabase, skipPg, type TestDatabase } from "@sbx/db/testing";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { DELETE_RETRY_LIMIT, uuidv7 } from "../src/index.ts";
import { expectCode, principal, serviceEnv } from "./helpers/service.ts";
import { insertOperation, insertSandbox } from "./helpers/topology.ts";

describe.skipIf(skipPg())("SandboxService.delete (S6 §7.2)", () => {
	let t: TestDatabase;

	beforeAll(async () => {
		t = await createTestDatabase({ max: 20 });
	});
	afterAll(async () => {
		await t?.drop();
	});

	async function op(id: string) {
		const r = await t.pool.query(
			"SELECT state, superseded_by, finished_at FROM runtime.operations WHERE id = $1",
			[id],
		);
		return r.rows[0];
	}

	it("supersedes the active create, moves the sandbox to deleting, enqueues the delete", async () => {
		const env = await serviceEnv(t.pool);
		const { sandbox, operation: create } = await env.svc.create(env.p, {});
		env.jobs.clear();

		const del = await env.svc.delete(env.p, sandbox.id);

		expect(del.kind).toBe("delete");
		expect(del.state).toBe("pending");
		expect(del.deadlineAt).toBeNull();
		expect(del.sandboxId).toBe(sandbox.id);
		expect(del.requestedByKey).toBe(env.p.apiKeyId);
		const c = await op(create.id);
		expect(c.state).toBe("superseded");
		expect(c.superseded_by).toBe(del.id);
		expect(c.finished_at).not.toBeNull();

		const s = await env.svc.get(env.p, sandbox.id);
		expect(s.state).toBe("deleting");
		expect(s.activeOperation?.id).toBe(del.id);

		expect(env.jobs.sent).toEqual([
			{
				queue: "sandbox-op",
				data: { operationId: del.id },
				opts: { singletonKey: sandbox.id, retryLimit: DELETE_RETRY_LIMIT },
			},
		]);
		const ev = await t.pool.query(
			"SELECT from_state, to_state FROM runtime.sandbox_events WHERE sandbox_id = $1 ORDER BY created_at, id",
			[sandbox.id],
		);
		expect(ev.rows.at(-1)).toEqual({
			from_state: "creating",
			to_state: "deleting",
		});
	});

	it("a repeated delete returns the same operation and enqueues nothing", async () => {
		const env = await serviceEnv(t.pool);
		const { sandbox } = await env.svc.create(env.p, {});
		const first = await env.svc.delete(env.p, sandbox.id);
		env.jobs.clear();
		const again = await env.svc.delete(env.p, sandbox.id);
		expect(again.id).toBe(first.id);
		expect(env.jobs.sent).toEqual([]);
	});

	it("on a deleted sandbox returns its finished delete operation", async () => {
		const env = await serviceEnv(t.pool);
		const id = await insertSandbox(t.pool, env.topo, {
			teamId: env.p.teamId,
			state: "deleted",
		});
		const opId = await insertOperation(t.pool, {
			sandboxId: id,
			kind: "delete",
			state: "succeeded",
		});
		const r = await env.svc.delete(env.p, id);
		expect(r.id).toBe(opId);
		expect(env.jobs.sent).toEqual([]);
	});

	it("works from any non-deleting state, by id or slug", async () => {
		const env = await serviceEnv(t.pool);
		for (const state of ["ready", "stopped", "error", "starting", "stopping"]) {
			const id = await insertSandbox(t.pool, env.topo, {
				teamId: env.p.teamId,
				state,
			});
			const slug = (
				await t.pool.query<{ slug: string }>(
					"SELECT slug FROM runtime.sandboxes WHERE id = $1",
					[id],
				)
			).rows[0]?.slug as string;
			const d = await env.svc.delete(env.p, state === "ready" ? slug : id);
			expect(d.kind).toBe("delete");
			expect((await env.svc.get(env.p, id)).state).toBe("deleting");
		}
	});

	it("parallel deletes create one delete operation", async () => {
		const env = await serviceEnv(t.pool);
		const { sandbox } = await env.svc.create(env.p, {});
		const [a, b] = await Promise.all([
			env.svc.delete(env.p, sandbox.id),
			env.svc.delete(env.p, sandbox.id),
		]);
		expect(a.id).toBe(b.id);
	});

	it("another team's sandbox or an unknown id is not_found", async () => {
		const env = await serviceEnv(t.pool);
		const { sandbox } = await env.svc.create(env.p, {});
		await expectCode(env.svc.delete(principal(), sandbox.id), "not_found");
		await expectCode(env.svc.delete(env.p, uuidv7()), "not_found");
		await expectCode(env.svc.delete(env.p, "no-such-slug"), "not_found");
		expect((await env.svc.get(env.p, sandbox.id)).state).toBe("creating");
	});
});
