import { createTestDatabase, skipPg, type TestDatabase } from "@sbx/db/testing";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { DELETE_RETRY_LIMIT } from "../src/index.ts";
import {
	expectCode,
	idempotencyRows,
	insertSavedSnapshot,
	machineRow,
	serviceEnv,
	teamRowCounts,
} from "./helpers/service.ts";
import { insertMachine } from "./helpers/topology.ts";

const SECRET = "SECRET-MARKER-7f3a";

describe.skipIf(skipPg())("SandboxService.create (S6 §7.3)", () => {
	let t: TestDatabase;

	beforeAll(async () => {
		t = await createTestDatabase({ max: 20 });
	});
	afterAll(async () => {
		await t?.drop();
	});

	it("claims a warm machine of the pair: machine claiming, one sandbox-op job", async () => {
		const env = await serviceEnv(t.pool);
		const older = await insertMachine(t.pool, env.topo, {
			state: "warm",
			poolKey: env.pairKey,
			warmAgoSeconds: 120,
		});
		const newer = await insertMachine(t.pool, env.topo, {
			state: "warm",
			poolKey: env.pairKey,
			warmAgoSeconds: 10,
		});

		const { sandbox, operation } = await env.svc.create(env.p, {
			name: "ci",
			labels: { run: "1" },
		});

		expect(sandbox.state).toBe("creating");
		expect(sandbox.machineId).toBe(older);
		expect(sandbox.nodeId).toBe(env.topo.nodeId);
		expect(sandbox.providerId).toBe(env.topo.providerId);
		expect(sandbox.templateBuildId).toBe(env.topo.templateBuildId);
		expect(sandbox.templateSlug).toBe(env.template);
		expect(sandbox.sizeSlug).toBe("2gb");
		expect(sandbox.memoryMb).toBe(2048);
		expect(sandbox.origin).toBe("template");
		expect(sandbox.teamId).toBe(env.p.teamId);
		expect(sandbox.createdBy).toBeNull();
		expect(sandbox.createdByKey).toBe(env.p.apiKeyId);
		expect(sandbox.labels).toEqual({ run: "1" });
		expect(sandbox.idleTimeoutSeconds).toBe(900);
		expect(sandbox.ttlSeconds).toBeNull();
		expect(sandbox.deadlineAt).toBeNull();
		expect(sandbox.slug.split("-")).toHaveLength(3);
		expect(sandbox.activeOperation?.id).toBe(operation.id);

		expect(operation.kind).toBe("create");
		expect(operation.state).toBe("pending");
		expect(operation.sandboxId).toBe(sandbox.id);
		expect(operation.requestedByKey).toBe(env.p.apiKeyId);
		expect(operation.request).toMatchObject({
			template: env.template,
			size: "2gb",
			fromPool: true,
			failFast: false,
		});
		// 2 min deadline for a linux pool claim.
		const ms = (operation.deadlineAt?.getTime() ?? 0) - Date.now();
		expect(ms).toBeGreaterThan(100_000);
		expect(ms).toBeLessThanOrEqual(120_000);

		const m = await machineRow(t.pool, older);
		expect(m).toMatchObject({
			state: "claiming",
			sandbox_id: sandbox.id,
			pool_key: null,
		});
		expect(m?.claimed_at).not.toBeNull();
		expect((await machineRow(t.pool, newer))?.state).toBe("warm");

		expect(env.jobs.sent).toEqual([
			{
				queue: "sandbox-op",
				data: { operationId: operation.id },
				opts: { singletonKey: sandbox.id },
			},
		]);

		const ev = await t.pool.query(
			"SELECT type, from_state, to_state FROM runtime.sandbox_events WHERE sandbox_id = $1",
			[sandbox.id],
		);
		expect(ev.rows).toEqual([
			{ type: "state_changed", from_state: null, to_state: "creating" },
		]);
	});

	it("does not claim a warm machine of another pair or of an old build", async () => {
		const env = await serviceEnv(t.pool);
		const other = await insertMachine(t.pool, env.topo, {
			state: "warm",
			poolKey: `${env.template}/4gb`,
			sizeSlug: "4gb",
			memoryMb: 4096,
		});
		const { sandbox } = await env.svc.create(env.p, {});
		expect(sandbox.machineId).not.toBe(other);
		expect((await machineRow(t.pool, other))?.state).toBe("warm");
	});

	it("goes cold without a warm machine: machine allocating with sandbox_id", async () => {
		const env = await serviceEnv(t.pool, { os: "windows" });
		const { sandbox, operation } = await env.svc.create(env.p, {
			size: "4gb",
		});
		expect(sandbox.machineId).not.toBeNull();
		const m = await machineRow(t.pool, sandbox.machineId as string);
		expect(m).toMatchObject({
			state: "allocating",
			sandbox_id: sandbox.id,
			node_id: env.topo.nodeId,
			provider_id: env.topo.providerId,
			storage_id: env.topo.storageId,
			template_build_id: env.topo.templateBuildId,
			origin: "template",
			pool_key: null,
			size_slug: "4gb",
			vcpu: 2,
			memory_mb: 4096,
		});
		expect(operation.request).toMatchObject({ fromPool: false, size: "4gb" });
		// Windows cold create: 20 min.
		const ms = (operation.deadlineAt?.getTime() ?? 0) - Date.now();
		expect(ms).toBeGreaterThan(19 * 60_000);
		expect(ms).toBeLessThanOrEqual(20 * 60_000);
		expect(env.jobs.sent).toHaveLength(1);
	});

	it("evicts a warm machine of another pair when RAM is short", async () => {
		const env = await serviceEnv(t.pool, {
			topology: { node: { ramCapMb: 4096 } },
		});
		const other = await insertMachine(t.pool, env.topo, {
			state: "warm",
			poolKey: `${env.template}/4gb`,
			sizeSlug: "4gb",
			memoryMb: 4096,
		});
		const { sandbox, operation } = await env.svc.create(env.p, {});
		expect((await machineRow(t.pool, other))?.state).toBe("deleting");
		expect((await machineRow(t.pool, sandbox.machineId as string))?.state).toBe(
			"allocating",
		);
		expect(env.jobs.sent).toEqual([
			{
				queue: "machine-op",
				data: { machineId: other, action: "delete" },
				opts: { singletonKey: other, retryLimit: DELETE_RETRY_LIMIT },
			},
			{
				queue: "sandbox-op",
				data: { operationId: operation.id },
				opts: { singletonKey: sandbox.id },
			},
		]);
	});

	it("out_of_capacity without RAM: nothing new in the database", async () => {
		const env = await serviceEnv(t.pool, {
			topology: { node: { ramCapMb: 2048 } },
		});
		await insertMachine(t.pool, env.topo, { state: "running" });
		const err = await expectCode(
			env.svc.create(env.p, {}, "key-1"),
			"out_of_capacity",
		);
		expect(err.retryable).toBe(true);
		expect(err.details.retryAfterSeconds).toBe(30);
		expect(await teamRowCounts(t.pool, env.p.teamId)).toEqual({
			sandboxes: 0,
			secrets: 0,
			operations: 0,
			events: 0,
			machines: 0,
		});
		expect(await idempotencyRows(t.pool, env.p.apiKeyId as string)).toBe(0);
		expect(env.jobs.sent).toEqual([]);
	});

	it("failFast without warm: pool_exhausted and no rows, key or jobs", async () => {
		const env = await serviceEnv(t.pool);
		const err = await expectCode(
			env.svc.create(
				env.p,
				{ failFast: true, secrets: { TOKEN: SECRET } },
				"key-ff",
			),
			"pool_exhausted",
		);
		expect(err.retryable).toBe(true);
		expect(err.details.retryAfterSeconds).toBe(60);
		expect(await teamRowCounts(t.pool, env.p.teamId)).toEqual({
			sandboxes: 0,
			secrets: 0,
			operations: 0,
			events: 0,
			machines: 0,
		});
		expect(await idempotencyRows(t.pool, env.p.apiKeyId as string)).toBe(0);
		expect(env.jobs.sent).toEqual([]);
	});

	it("failFast with warm claims as usual", async () => {
		const env = await serviceEnv(t.pool);
		const warm = await insertMachine(t.pool, env.topo, {
			state: "warm",
			poolKey: env.pairKey,
		});
		const { sandbox, operation } = await env.svc.create(env.p, {
			failFast: true,
		});
		expect(sandbox.machineId).toBe(warm);
		expect(operation.request).toMatchObject({ failFast: true, fromPool: true });
	});

	it("failFast with from is a validation error", async () => {
		const env = await serviceEnv(t.pool);
		await expectCode(
			env.svc.create(env.p, { failFast: true, from: { snapshot: "x" } }),
			"validation",
		);
	});

	it("quota: maxActiveSandboxes and maxRamMb", async () => {
		const env = await serviceEnv(t.pool, {
			quota: { maxActiveSandboxes: 1, maxRamMb: 4096 },
		});
		await env.svc.create(env.p, {});
		const e1 = await expectCode(env.svc.create(env.p, {}), "quota_exceeded");
		expect(e1.details.quota).toBe("maxActiveSandboxes");

		const env2 = await serviceEnv(t.pool, { quota: { maxRamMb: 4096 } });
		await env2.svc.create(env2.p, { size: "4gb" });
		const e2 = await expectCode(env2.svc.create(env2.p, {}), "quota_exceeded");
		expect(e2.details.quota).toBe("maxRamMb");
	});

	it("disabled template, unknown template and disallowed size: template_unavailable", async () => {
		const off = await serviceEnv(t.pool, { enabled: false });
		await expectCode(off.svc.create(off.p, {}), "template_unavailable");
		const env = await serviceEnv(t.pool);
		await expectCode(
			env.svc.create(env.p, { template: "nope" }),
			"template_unavailable",
		);
		await expectCode(
			env.svc.create(env.p, { size: "8gb" }),
			"template_unavailable",
		);
		await expectCode(
			env.svc.create(env.p, { size: "nope" }),
			"template_unavailable",
		);
	});

	it("validates ttl, idle timeout, labels and slug", async () => {
		const env = await serviceEnv(t.pool, { defaults: { maxTtlSeconds: 3600 } });
		await expectCode(env.svc.create(env.p, { ttlSeconds: 3601 }), "validation");
		await expectCode(env.svc.create(env.p, { ttlSeconds: 0 }), "validation");
		await expectCode(
			env.svc.create(env.p, { idleTimeoutSeconds: 1.5 }),
			"validation",
		);
		await expectCode(
			env.svc.create(env.p, {
				labels: { a: 1 } as unknown as Record<string, string>,
			}),
			"validation",
		);
		await expectCode(env.svc.create(env.p, { slug: "Bad_Slug" }), "validation");
		await expectCode(
			env.svc.create(env.p, { env: { SBX_SECRET: "x" } }),
			"validation",
		);
		const ok = await env.svc.create(env.p, {
			ttlSeconds: 3600,
			idleTimeoutSeconds: null,
		});
		expect(ok.sandbox.ttlSeconds).toBe(3600);
		expect(ok.sandbox.idleTimeoutSeconds).toBeNull();
		// The deadline is set by the worker when the sandbox becomes ready.
		expect(ok.sandbox.deadlineAt).toBeNull();
	});

	it("uses a given slug; a taken one is slug_taken", async () => {
		const env = await serviceEnv(t.pool);
		const slug = `my-box-${env.template}`;
		const { sandbox } = await env.svc.create(env.p, { slug });
		expect(sandbox.slug).toBe(slug);
		await expectCode(env.svc.create(env.p, { slug }), "slug_taken");
		expect((await teamRowCounts(t.pool, env.p.teamId)).sandboxes).toBe(1);
	});

	it("retries a generated slug on collision and then uses four words", async () => {
		// Index 0 always: every three-word slug is the same; four words differ.
		const env = await serviceEnv(t.pool, { slugRandom: () => 0 });
		const a = await env.svc.create(env.p, {});
		const b = await env.svc.create(env.p, {});
		expect(a.sandbox.slug.split("-")).toHaveLength(3);
		expect(b.sandbox.slug.split("-")).toHaveLength(4);
	});

	it("stores secrets encrypted; request and job data carry no secret values", async () => {
		const env = await serviceEnv(t.pool);
		const { sandbox, operation } = await env.svc.create(
			env.p,
			{
				env: { PLAIN: `${SECRET}-env` },
				secrets: { TOKEN: SECRET },
				secretFiles: [
					{
						name: "key.json",
						contentBase64: Buffer.from(SECRET).toString("base64"),
					},
				],
			},
			"key-secret",
		);
		const raw = await t.pool.query(
			`SELECT o.request::text AS request, k.response::text AS response,
			        encode(s.ciphertext, 'escape') AS ct, s.key_version
			 FROM runtime.operations o
			 JOIN runtime.idempotency_keys k ON k.operation_id = o.id
			 JOIN runtime.sandbox_secrets s ON s.sandbox_id = o.sandbox_id
			 WHERE o.id = $1`,
			[operation.id],
		);
		const row = raw.rows[0];
		expect(row.request).not.toContain(SECRET);
		expect(row.request).not.toContain("TOKEN");
		expect(row.response).not.toContain(SECRET);
		expect(row.ct).not.toContain(SECRET);
		expect(JSON.stringify(env.jobs.sent)).not.toContain(SECRET);

		const blob = await t.pool.query(
			"SELECT key_version, nonce, ciphertext FROM runtime.sandbox_secrets WHERE sandbox_id = $1",
			[sandbox.id],
		);
		const sets = env.keys.decrypt(sandbox.id, {
			keyVersion: blob.rows[0].key_version,
			nonce: blob.rows[0].nonce,
			ciphertext: blob.rows[0].ciphertext,
		});
		expect(sets.env).toEqual({ PLAIN: `${SECRET}-env` });
		expect(sets.secrets).toEqual({ TOKEN: SECRET });
		expect(sets.secretFiles).toHaveLength(1);
	});

	it("records the user principal on sandbox and operation", async () => {
		const env = await serviceEnv(t.pool);
		const userId = "0195c3a4-0000-7000-8000-000000000001";
		const p = {
			...env.p,
			kind: "session" as const,
			userId,
			role: "member" as const,
		};
		delete p.apiKeyId;
		const { sandbox, operation } = await env.svc.create(p, {});
		expect(sandbox.createdBy).toBe(userId);
		expect(sandbox.createdByKey).toBeNull();
		expect(operation.requestedBy).toBe(userId);
		expect(operation.requestedByKey).toBeNull();
	});

	describe("from a saved snapshot", () => {
		it("always cold on the snapshot's node with its build", async () => {
			const env = await serviceEnv(t.pool);
			await insertMachine(t.pool, env.topo, {
				state: "warm",
				poolKey: env.pairKey,
			});
			const snapId = await insertSavedSnapshot(t.pool, env.topo, {
				teamId: env.p.teamId,
				name: "web-stack",
			});
			const { sandbox, operation } = await env.svc.create(env.p, {
				template: "ignored",
				from: { snapshot: "web-stack" },
			});
			expect(sandbox.origin).toBe("snapshot");
			expect(sandbox.originSnapshotId).toBe(snapId);
			expect(sandbox.templateSlug).toBe(env.template);
			const m = await machineRow(t.pool, sandbox.machineId as string);
			expect(m).toMatchObject({
				state: "allocating",
				origin: "snapshot",
				origin_snapshot_id: snapId,
				node_id: env.topo.nodeId,
				template_build_id: env.topo.templateBuildId,
			});
			expect(operation.request).toMatchObject({
				from: { snapshot: "web-stack" },
				fromPool: false,
			});
		});

		it("snapshot_not_found for a missing, other team's or not ready snapshot", async () => {
			const env = await serviceEnv(t.pool);
			await insertSavedSnapshot(t.pool, env.topo, {
				teamId: env.p.teamId,
				name: "creating-one",
				state: "creating",
			});
			await insertSavedSnapshot(t.pool, env.topo, {
				teamId: "0195c3a4-0000-7000-8000-0000000000ff",
				name: "foreign",
			});
			for (const name of ["missing", "creating-one", "foreign"]) {
				await expectCode(
					env.svc.create(env.p, { from: { snapshot: name } }),
					"snapshot_not_found",
				);
			}
		});
	});
});
