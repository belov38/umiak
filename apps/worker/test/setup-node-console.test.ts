import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createTopology } from "@umiak/core/testing";
import { createTestDatabase, type TestDatabase } from "@umiak/db/testing";
import { afterAll, beforeAll, expect, it } from "vitest";
// @ts-expect-error JavaScript console adapter is tested across the real PostgreSQL boundary.
import { nodeCommand } from "../../../deploy/compose/quickstart/nodes.mjs";
// @ts-expect-error JavaScript setup adapter exercises real PostgreSQL registration.
import { createSetupHandler } from "../../../deploy/compose/quickstart/setup.mjs";
// @ts-expect-error JavaScript setup adapter.
import { nodeService } from "../../../deploy/compose/quickstart/setup-nodes.mjs";

let db: TestDatabase;
beforeAll(async () => {
	db = await createTestDatabase();
});
afterAll(async () => {
	await db?.drop();
});
it("bootstrap preserves explicit cordon and other nodes through the real registry", async () => {
	const a = await createTopology(db.pool);
	const b = await createTopology(db.pool, { providerId: a.providerId });
	await db.pool.query("UPDATE runtime.nodes SET state='cordoned' WHERE id=$1", [
		a.nodeId,
	]);
	const n = (await nodeService(db.pool).list(a.providerId)).find(
		(x: { nodeId: string }) => x.nodeId === a.nodeId,
	);
	await nodeService(db.pool).register(
		{
			providerId: a.providerId,
			name: n.name,
			sshHost: "changed",
			storage: n.storage,
			mediaStorage: "local",
			ramCapMb: 2048,
		},
		{ preserveState: true },
	);
	expect(
		(
			await db.pool.query(
				"SELECT state,ram_cap_mb FROM runtime.nodes WHERE id=$1",
				[a.nodeId],
			)
		).rows[0],
	).toEqual({ state: "cordoned", ram_cap_mb: 8192 });
	expect(
		(await nodeService(db.pool).list(a.providerId)).map(
			(x: { nodeId: string }) => x.nodeId,
		),
	).toContain(b.nodeId);
});
it("console explicitly retires only a verified idle Umiak template, enabling node removal", async () => {
	const a = await createTopology(db.pool);
	await db.pool.query(
		"UPDATE runtime.template_builds SET pve_vmid=601 WHERE id=$1",
		[a.templateBuildId],
	);
	await db.pool.query("CREATE SCHEMA IF NOT EXISTS quickstart");
	await db.pool.query(
		"CREATE TABLE quickstart.setup (id boolean PRIMARY KEY, state jsonb)",
	);
	await db.pool.query("INSERT INTO quickstart.setup VALUES(true,$1)", [
		{
			steps: {
				limits: {
					data: {
						providerId: a.providerId,
						templateVmidMin: 600,
						templateVmidMax: 699,
						vmidMin: 500,
						vmidMax: 589,
					},
				},
				connection: { data: { node: "pve" } },
			},
		},
	]);
	const dir = await mkdtemp(join(tmpdir(), "s19-console-"));
	await writeFile(join(dir, "pve-token"), "test");
	let deleted = false;
	const fake = {
		get: async (path: string) =>
			path.endsWith("/config")
				? { template: 1, tags: "umiak-tpl" }
				: { status: "stopped", exitstatus: "OK" },
		delete: async () => {
			deleted = true;
			return "task";
		},
	};
	try {
		const result = await nodeCommand(
			db.pool,
			{ op: "retire-template", nodeId: a.nodeId, buildId: a.templateBuildId },
			{ secretsDir: dir, makePve: () => fake },
		);
		expect(result.ok).toBe(true);
		expect(deleted).toBe(true);
		expect(
			(
				await db.pool.query(
					"SELECT status FROM runtime.template_builds WHERE id=$1",
					[a.templateBuildId],
				)
			).rows[0].status,
		).toBe("retired");
		expect(
			await nodeCommand(db.pool, { op: "retire", nodeId: a.nodeId }),
		).toEqual({ ok: true });
	} finally {
		await rm(dir, { recursive: true, force: true });
	}
});

it("cleanup refuses running jobs and surviving interrupted runners before host inventory", async () => {
	const a = await createTopology(db.pool);
	await db.pool.query("UPDATE quickstart.setup SET state=$1 WHERE id=true", [
		{
			steps: {
				limits: { data: { providerId: a.providerId } },
				connection: { data: { node: "pve" } },
			},
		},
	]);
	const job = `cleanup-${a.nodeId}`;
	await db.pool.query(
		"INSERT INTO runtime.node_build_jobs(id,node_id,template_slug) VALUES($1,$2,'linux')",
		[job, a.nodeId],
	);
	await expect(
		nodeCommand(db.pool, { op: "cleanup-build", nodeId: a.nodeId, jobId: job }),
	).rejects.toThrow(/interrupted/);
	await db.pool.query(
		"UPDATE runtime.node_build_jobs SET status='interrupted' WHERE id=$1",
		[job],
	);
	const runner = await db.pool.connect();
	try {
		await runner.query(
			"SELECT pg_advisory_lock(hashtextextended('template-runner:' || $1::text,0))",
			[job],
		);
		await expect(
			nodeCommand(db.pool, {
				op: "cleanup-build",
				nodeId: a.nodeId,
				jobId: job,
			}),
		).rejects.toThrow(/still alive/);
	} finally {
		runner.release(true);
	}
	expect(
		(
			await db.pool.query(
				"SELECT status FROM runtime.node_build_jobs WHERE id=$1",
				[job],
			)
		).rows[0].status,
	).toBe("interrupted");
});

it("prevalidates a re-add before host preparation and keeps failed preparation fenced", async () => {
	const a = await createTopology(db.pool);
	await db.pool.query("UPDATE quickstart.setup SET state=$1 WHERE id=true", [
		{
			steps: {
				limits: { data: { providerId: a.providerId } },
				connection: { data: { node: "pve" } },
			},
		},
	]);
	const existing = (await nodeService(db.pool).list(a.providerId))[0];
	const cfg = {
		name: existing.name,
		sshHost: existing.sshHost,
		storage: existing.storage,
		mediaStorage: existing.mediaStorage,
		ramCapMb: existing.ramCapMb,
	};
	await expect(
		nodeCommand(db.pool, {
			op: "prepare-add",
			node: { ...cfg, storage: "other" },
		}),
	).rejects.toThrow(/storage migration/);
	expect(
		(
			await db.pool.query("SELECT state FROM runtime.nodes WHERE id=$1", [
				a.nodeId,
			])
		).rows[0].state,
	).toBe("active");
	const prep = await nodeCommand(db.pool, { op: "prepare-add", node: cfg });
	expect(prep.preparationId).toMatch(/^prepare-/);
	expect(
		(
			await db.pool.query("SELECT state FROM runtime.nodes WHERE id=$1", [
				a.nodeId,
			])
		).rows[0].state,
	).toBe("cordoned");
	const retry = await nodeCommand(db.pool, { op: "prepare-add", node: cfg });
	expect(retry.preparationId).toBe(prep.preparationId);
	await expect(
		nodeCommand(db.pool, {
			op: "prepare-add",
			node: { ...cfg, ramCapMb: 4096 },
		}),
	).rejects.toThrow(/same node configuration/);
	const blockers = await nodeCommand(db.pool, {
		op: "retire",
		nodeId: a.nodeId,
	});
	expect(blockers.ok).toBe(false);
	expect(blockers.blockers).toContainEqual({
		kind: "build",
		id: prep.preparationId,
	});
});

it("a new verified artifact may reuse the VMID of a physically retired template", async () => {
	const a = await createTopology(db.pool);
	const job = `reuse-${a.nodeId}`;
	await db.pool.query(
		"UPDATE runtime.template_builds SET status='retired',pve_vmid=600,version='retired-old' WHERE id=$1",
		[a.templateBuildId],
	);
	await db.pool.query(
		"INSERT INTO runtime.node_build_jobs(id,node_id,template_slug) VALUES($1,$2,'linux')",
		[job, a.nodeId],
	);
	const dir = await mkdtemp(join(tmpdir(), "s19-rebuild-"));
	await writeFile(join(dir, "pve-token"), "test");
	const state = {
		steps: {
			connection: { data: { node: "pve" } },
			limits: {
				data: {
					providerId: a.providerId,
					nodeId: a.nodeId,
					vmidMin: 500,
					vmidMax: 589,
				},
			},
		},
	};
	const handler = createSetupHandler({
		pool: db.pool,
		secretsDir: dir,
		makePve: () => ({
			get: async () => ({
				template: 1,
				tags: "umiak-tpl",
				ostype: "l26",
				scsi0: "local-lvm:base-600-disk-0,size=4G",
			}),
		}),
	});
	try {
		await expect(
			handler.wizard.steps.templates(
				{
					builds: [
						{
							nodeId: a.nodeId,
							templateSlug: "linux",
							pveVmid: 600,
							version: "20261104.99",
						},
					],
				},
				state,
				{},
			),
		).rejects.toThrow(/retired/);
		const result = await handler.wizard.steps.templates(
			{
				builds: [
					{
						nodeId: a.nodeId,
						templateSlug: "linux",
						pveVmid: 600,
						version: "20261104.99",
					},
				],
			},
			state,
			{ job: { id: job }, dashboardBuild: true },
		);
		expect(result.builds[0].id).not.toBe(a.templateBuildId);
		expect(
			(
				await db.pool.query(
					"SELECT version,status FROM runtime.template_builds WHERE id=$1",
					[result.builds[0].id],
				)
			).rows[0],
		).toEqual({ version: "20261104.99", status: "active" });
		expect(
			(
				await db.pool.query(
					"SELECT status FROM runtime.template_builds WHERE id=$1",
					[a.templateBuildId],
				)
			).rows[0].status,
		).toBe("retired");
	} finally {
		await rm(dir, { recursive: true, force: true });
	}
});
