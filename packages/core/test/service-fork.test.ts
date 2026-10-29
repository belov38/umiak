import { randomUUID } from "node:crypto";
import { createTestDatabase, skipPg, type TestDatabase } from "@sbx/db/testing";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
	expectCode,
	insertSavedSnapshot,
	machineRow,
	readSecrets,
	sandboxRow,
	secretsRow,
	seedSandbox,
	serviceEnv,
	uniqueSlug,
} from "./helpers/service.ts";
import { insertMachine, insertOperation } from "./helpers/topology.ts";

const SECRET = "fork-secret-marker-91bc";
const PATCH_SECRET = "fork-patch-secret-4d20";

describe.skipIf(skipPg())("SandboxService.fork (S6 §7.7)", () => {
	let t: TestDatabase;

	beforeAll(async () => {
		t = await createTestDatabase({ max: 20 });
	});
	afterAll(async () => {
		await t?.drop();
	});

	const SOURCE_SETS = {
		env: { A: "1", B: "2" },
		secrets: { TOKEN: SECRET, OLD: "old" },
		secretFiles: [{ name: "k.json", contentBase64: "YQ==" }],
	};

	it("creates the target with inherited sets plus the patch, a fork job on the source and a jobless target create", async () => {
		const env = await serviceEnv(t.pool, {
			defaults: { ttlSeconds: 1800 },
		});
		const src = await seedSandbox(t.pool, env, {
			state: "ready",
			labels: { team: "x" },
			ttlSeconds: 99,
			sets: SOURCE_SETS,
		});
		const srcBefore = await secretsRow(t.pool, src.sandboxId);

		const res = await env.svc.fork(env.p, src.sandboxId, {
			name: "child",
			env: { B: null, C: "3" },
			secrets: { OLD: null, NEW: PATCH_SECRET },
			secretFiles: { "k.json": null, "n.pem": { contentBase64: "Yg==" } },
		});

		const { sandbox, operation, sourceOperation } = res;
		expect(sandbox.state).toBe("creating");
		expect(sandbox.origin).toBe("fork");
		expect(sandbox.forkedFromSandboxId).toBe(src.sandboxId);
		expect(sandbox.name).toBe("child");
		expect(sandbox.labels).toEqual({ team: "x" });
		expect(sandbox.sizeSlug).toBe("2gb");
		expect(sandbox.memoryMb).toBe(2048);
		expect(sandbox.templateSlug).toBe(env.template);
		expect(sandbox.templateBuildId).toBe(env.topo.templateBuildId);
		expect(sandbox.nodeId).toBe(env.topo.nodeId);
		expect(sandbox.ttlSeconds).toBe(1800); // not inherited
		expect(sandbox.slug).not.toBe(src.slug);

		const m = await machineRow(t.pool, sandbox.machineId ?? "");
		expect(m).toMatchObject({
			state: "allocating",
			node_id: env.topo.nodeId,
			sandbox_id: sandbox.id,
			memory_mb: 2048,
			origin: "snapshot",
			template_build_id: env.topo.templateBuildId,
		});

		expect(sourceOperation).toMatchObject({
			kind: "fork",
			state: "pending",
			sandboxId: src.sandboxId,
		});
		expect(operation).toMatchObject({
			kind: "create",
			state: "pending",
			sandboxId: sandbox.id,
			parentOperationId: sourceOperation.id,
		});
		expect(env.jobs.sent).toEqual([
			{
				queue: "sandbox-op",
				data: { operationId: sourceOperation.id },
				opts: { singletonKey: src.sandboxId },
			},
		]);

		// The target's blob decrypts with the target's AAD to source + patch.
		expect(await readSecrets(t.pool, env.keys, sandbox.id)).toEqual({
			env: { A: "1", C: "3" },
			secrets: { TOKEN: SECRET, NEW: PATCH_SECRET },
			secretFiles: [{ name: "n.pem", contentBase64: "Yg==" }],
		});
		// The source is untouched.
		expect(await secretsRow(t.pool, src.sandboxId)).toEqual(srcBefore);
		expect(await readSecrets(t.pool, env.keys, src.sandboxId)).toEqual(
			SOURCE_SETS,
		);
		const srcRow = await sandboxRow(t.pool, src.sandboxId);
		expect(srcRow?.state).toBe("ready");
	});

	it("keeps secrets out of operations, idempotency rows and job data", async () => {
		const env = await serviceEnv(t.pool);
		const src = await seedSandbox(t.pool, env, {
			state: "stopped",
			machineState: "stopped",
			sets: SOURCE_SETS,
		});
		const res = await env.svc.fork(
			env.p,
			src.sandboxId,
			{ secrets: { NEW: PATCH_SECRET } },
			"fork-key-1",
		);
		const ops = await t.pool.query(
			"SELECT request::text AS r FROM runtime.operations WHERE sandbox_id = ANY($1::uuid[])",
			[[src.sandboxId, res.sandbox.id]],
		);
		const idem = await t.pool.query(
			"SELECT response::text AS r FROM runtime.idempotency_keys WHERE principal_id = $1",
			[env.p.apiKeyId],
		);
		const dump = JSON.stringify([ops.rows, idem.rows, env.jobs.sent]);
		for (const marker of [SECRET, PATCH_SECRET, "NEW", "TOKEN"]) {
			expect(dump).not.toContain(marker);
		}
		const cipher = await secretsRow(t.pool, res.sandbox.id);
		expect(cipher?.ciphertext.toString("latin1")).not.toContain(PATCH_SECRET);
	});

	it("is idempotent by key (hash includes the source); another body is idempotency_key_reused", async () => {
		const env = await serviceEnv(t.pool);
		const src = await seedSandbox(t.pool, env, { state: "ready" });
		const first = await env.svc.fork(env.p, src.sandboxId, { name: "a" }, "k");
		// The source now has an active fork; a replay must not care.
		const again = await env.svc.fork(env.p, src.slug, { name: "a" }, "k");
		expect(again.sandbox.id).toBe(first.sandbox.id);
		expect(again.operation.id).toBe(first.operation.id);
		expect(again.sourceOperation.id).toBe(first.sourceOperation.id);
		await expectCode(
			env.svc.fork(env.p, src.sandboxId, { name: "b" }, "k"),
			"idempotency_key_reused",
		);
		const other = await seedSandbox(t.pool, env, { state: "ready" });
		await expectCode(
			env.svc.fork(env.p, other.sandboxId, { name: "a" }, "k"),
			"idempotency_key_reused",
		);
	});

	it("takes the given size, labels, slug and durations", async () => {
		const env = await serviceEnv(t.pool);
		const src = await seedSandbox(t.pool, env, {
			state: "ready",
			labels: { a: "1" },
		});
		const slug = uniqueSlug("child");
		const { sandbox } = await env.svc.fork(env.p, src.sandboxId, {
			size: "4gb",
			labels: { b: "2" },
			slug,
			ttlSeconds: 600,
			idleTimeoutSeconds: null,
		});
		expect(sandbox).toMatchObject({
			sizeSlug: "4gb",
			memoryMb: 4096,
			labels: { b: "2" },
			slug,
			ttlSeconds: 600,
			idleTimeoutSeconds: null,
		});
		await expectCode(
			env.svc.fork(env.p, src.sandboxId, { slug }),
			"operation_in_progress",
		);
	});

	it("rejects a source in stopping, with an active operation, or another team's", async () => {
		const env = await serviceEnv(t.pool);
		const stopping = await seedSandbox(t.pool, env, { state: "stopping" });
		const e = await expectCode(
			env.svc.fork(env.p, stopping.sandboxId, {}),
			"invalid_state",
		);
		expect(e.details.state).toBe("stopping");

		const busy = await seedSandbox(t.pool, env, { state: "ready" });
		await insertOperation(t.pool, { sandboxId: busy.sandboxId, kind: "stop" });
		await expectCode(
			env.svc.fork(env.p, busy.sandboxId, {}),
			"operation_in_progress",
		);

		const foreign = await seedSandbox(t.pool, env, {
			state: "ready",
			teamId: randomUUID(),
		});
		await expectCode(env.svc.fork(env.p, foreign.sandboxId, {}), "not_found");
		await expectCode(
			env.svc.fork(env.p, busy.sandboxId, { bogus: true } as never),
			"validation",
		);
	});

	it("out_of_capacity and quota_exceeded create nothing", async () => {
		const env = await serviceEnv(t.pool, {
			topology: { node: { ramCapMb: 4096 } },
			quota: { maxActiveSandboxes: 2 },
		});
		const src = await seedSandbox(t.pool, env, { state: "ready" });
		await insertMachine(t.pool, env.topo, {
			state: "running",
			memoryMb: 2048,
			sandboxId: randomUUID(),
		});
		const count = async () =>
			(
				await t.pool.query<{ n: number }>(
					"SELECT count(*)::int AS n FROM runtime.sandboxes WHERE team_id = $1",
					[env.p.teamId],
				)
			).rows[0]?.n;
		await expectCode(env.svc.fork(env.p, src.sandboxId, {}), "out_of_capacity");
		expect(await count()).toBe(1);
		expect(env.jobs.sent).toEqual([]);

		await seedSandbox(t.pool, env, { state: "ready", machineState: null });
		await expectCode(env.svc.fork(env.p, src.sandboxId, {}), "quota_exceeded");
		expect(await count()).toBe(2);
	});
	it("checks like create: a disabled template and storage over its thresholds refuse the fork", async () => {
		const env = await serviceEnv(t.pool);
		const src = await seedSandbox(t.pool, env, { state: "ready" });
		const count = async () =>
			(
				await t.pool.query<{ n: number }>(
					"SELECT count(*)::int AS n FROM runtime.sandboxes WHERE team_id = $1",
					[env.p.teamId],
				)
			).rows[0]?.n;

		const off = await serviceEnv(t.pool, { enabled: false });
		const offSrc = await seedSandbox(t.pool, off, { state: "ready" });
		await expectCode(
			off.svc.fork(off.p, offSrc.sandboxId, {}),
			"template_unavailable",
		);
		await expectCode(
			off.svc.fork(off.p, offSrc.sandboxId, { size: "2gb" }),
			"template_unavailable",
		);

		await t.pool.query(
			`UPDATE runtime.storages SET usage = '{"dataPercent": 85, "metadataPercent": 10}'
			 WHERE id = $1`,
			[env.topo.storageId],
		);
		const full = await expectCode(
			env.svc.fork(env.p, src.sandboxId, {}),
			"out_of_capacity",
		);
		expect(full.details).toMatchObject({ reason: "storage_over_threshold" });
		// Create from a saved snapshot on that storage is refused the same way.
		await insertSavedSnapshot(t.pool, env.topo, {
			teamId: env.p.teamId,
			name: "full-disk",
		});
		await expectCode(
			env.svc.create(env.p, { from: { snapshot: "full-disk" } }),
			"out_of_capacity",
		);
		expect(await count()).toBe(1);
		expect(env.jobs.sent).toEqual([]);

		await t.pool.query(
			`UPDATE runtime.storages SET usage = '{"dataPercent": 10, "metadataPercent": 10}'
			 WHERE id = $1`,
			[env.topo.storageId],
		);
		await env.svc.fork(env.p, src.sandboxId, {});
		expect(await count()).toBe(2);
	});

	it("a source on a cordoned node or a draining provider cannot be forked: out_of_capacity, reason node_not_active (§8.4)", async () => {
		for (const sql of [
			"UPDATE runtime.nodes SET state = 'cordoned' WHERE id = $1",
			"UPDATE runtime.providers SET state = 'draining' WHERE id = (SELECT provider_id FROM runtime.nodes WHERE id = $1)",
		]) {
			const env = await serviceEnv(t.pool);
			const src = await seedSandbox(t.pool, env, { state: "ready" });
			await t.pool.query(sql, [env.topo.nodeId]);
			const err = await expectCode(
				env.svc.fork(env.p, src.sandboxId, {}),
				"out_of_capacity",
			);
			expect(err.retryable).toBe(true);
			expect(err.details).toMatchObject({
				reason: "node_not_active",
				retryAfterSeconds: 30,
			});
			expect(env.jobs.sent).toEqual([]);
			const n = await t.pool.query<{ n: number }>(
				"SELECT count(*)::int AS n FROM runtime.sandboxes WHERE team_id = $1",
				[env.p.teamId],
			);
			expect(n.rows[0]?.n).toBe(1);
		}
	});
});
