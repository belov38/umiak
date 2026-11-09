import { randomUUID } from "node:crypto";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	createTopology,
	insertMachine,
	insertSandbox,
} from "@umiak/core/testing";
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
	// Migration 0900 creates the table; replace any row a previous test left.
	await db.pool.query(
		"CREATE TABLE IF NOT EXISTS quickstart.setup (id boolean PRIMARY KEY, state jsonb)",
	);
	await db.pool.query("DELETE FROM quickstart.setup");
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
		get: async (path: string) => {
			if (path.endsWith("/config")) return { template: 1, tags: "umiak-tpl" };
			if (path.endsWith("/tasks")) return [];
			if (path.endsWith("/qemu"))
				return deleted ? [] : [{ vmid: 601, status: "stopped" }];
			return { status: "stopped", exitstatus: "OK" };
		},
		delete: async () => {
			deleted = true;
			return "task";
		},
	};
	try {
		const result = await nodeCommand(
			db.pool,
			{ op: "retire-template", nodeId: a.nodeId, buildId: a.templateBuildId },
			{
				secretsDir: dir,
				makePve: () => fake,
				probe: async () => ({ lvs: [] }),
			},
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

it("cleanup refuses node preparation and surviving interrupted runners before host inventory", async () => {
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
		"INSERT INTO runtime.node_build_jobs(id,node_id,template_slug) VALUES($1,$2,'node-prepare')",
		[job, a.nodeId],
	);
	await expect(
		nodeCommand(db.pool, { op: "cleanup-build", nodeId: a.nodeId, jobId: job }),
	).rejects.toThrow(/interrupted/);
	await db.pool.query(
		"UPDATE runtime.node_build_jobs SET status='interrupted',template_slug='linux' WHERE id=$1",
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

it("retries interrupted retirement after PVE deleted the VM and task polling failed", async () => {
	const a = await createTopology(db.pool);
	await db.pool.query(
		"UPDATE runtime.template_builds SET pve_vmid=602 WHERE id=$1",
		[a.templateBuildId],
	);
	await db.pool.query("UPDATE quickstart.setup SET state=$1 WHERE id=true", [
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
	const dir = await mkdtemp(join(tmpdir(), "s19-retire-retry-"));
	await writeFile(join(dir, "pve-token"), "test");
	let present = true,
		failed = false,
		deletes = 0;
	const pve = {
		get: async (path: string) => {
			if (path.endsWith("/config")) {
				if (!present)
					throw Object.assign(Error("PVE config missing"), { status: 404 });
				return { template: 1, tags: "umiak-tpl" };
			}
			if (path.endsWith("/qemu"))
				return present ? [{ vmid: 602, status: "stopped" }] : [];
			if (path.endsWith("/tasks")) return [];
			if (!failed) {
				failed = true;
				throw Error("poll network failure");
			}
			return { status: "stopped", exitstatus: "OK" };
		},
		delete: async () => {
			present = false;
			deletes++;
			return "retire-task";
		},
	};
	const options = {
		secretsDir: dir,
		makePve: () => pve,
		probe: async () => ({ lvs: [] }),
	};
	try {
		await expect(
			nodeCommand(
				db.pool,
				{ op: "retire-template", nodeId: a.nodeId, buildId: a.templateBuildId },
				options,
			),
		).rejects.toThrow(/poll network failure/);
		expect(
			(
				await db.pool.query(
					"SELECT status FROM runtime.template_builds WHERE id=$1",
					[a.templateBuildId],
				)
			).rows[0].status,
		).toBe("deprecated");
		const job = (
			await db.pool.query(
				"SELECT id FROM runtime.node_build_jobs WHERE retiring_build_id=$1",
				[a.templateBuildId],
			)
		).rows[0].id;
		expect(
			(
				await db.pool.query(
					"SELECT purpose,build_job_id FROM runtime.vmid_leases WHERE provider_id=$1 AND vmid=602",
					[a.providerId],
				)
			).rows[0],
		).toEqual({ purpose: "template", build_job_id: job });
		const alive = await db.pool.connect();
		try {
			await alive.query(
				"SELECT pg_advisory_lock(hashtextextended('template-runner:' || $1::text,0))",
				[job],
			);
			await expect(
				nodeCommand(
					db.pool,
					{
						op: "retire-template",
						nodeId: a.nodeId,
						buildId: a.templateBuildId,
					},
					options,
				),
			).rejects.toThrow(/still alive/);
		} finally {
			alive.release(true);
		}
		// A console killed before its catch handler leaves running, not interrupted.
		await db.pool.query(
			"UPDATE runtime.node_build_jobs SET status='running' WHERE id=$1",
			[job],
		);

		expect(
			await nodeCommand(
				db.pool,
				{ op: "retire-template", nodeId: a.nodeId, buildId: a.templateBuildId },
				options,
			),
		).toEqual({ ok: true });
		expect(deletes).toBe(1);
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

it("ordinary interrupted cleanup reads active tasks and frees only absent job leases", async () => {
	const a = await createTopology(db.pool),
		job = `clean-tasks-${a.nodeId}`;
	await db.pool.query("UPDATE quickstart.setup SET state=$1 WHERE id=true", [
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
	await db.pool.query(
		"INSERT INTO runtime.node_build_jobs(id,node_id,template_slug,status) VALUES($1,$2,'linux','interrupted')",
		[job, a.nodeId],
	);
	await db.pool.query(
		"INSERT INTO runtime.vmid_leases(provider_id,vmid,mac,state,purpose,build_job_id) VALUES($1,550,'02:ed:00:00:02:26','active','machine',$2)",
		[a.providerId, job],
	);
	const dir = await mkdtemp(join(tmpdir(), "s19-active-clean-"));
	await writeFile(join(dir, "pve-token"), "test");
	let active = true;
	let disks = [{ name: "base-550-disk-0" }];
	const options = {
		secretsDir: dir,
		probe: async (
			connection: { node: string; sshHost: string },
			_dir: string,
			operation: unknown,
		) => {
			const node = (await nodeService(db.pool).list(a.providerId)).find(
				(n: { nodeId: string }) => n.nodeId === a.nodeId,
			);
			expect(connection).toMatchObject({
				node: node.name,
				sshHost: node.sshHost,
			});
			expect(operation).toEqual({ op: "lv.list", args: {} });
			return { lvs: disks };
		},
		makePve: () => ({
			get: async (path: string, parameters?: { source: string }) => {
				if (path.endsWith("/tasks")) {
					expect(parameters).toEqual({ source: "active" });
					return active ? [{ user: "umiak@pve!sandbox" }] : [];
				}
				return [];
			},
		}),
	};
	try {
		await expect(
			nodeCommand(
				db.pool,
				{ op: "cleanup-build", nodeId: a.nodeId, jobId: job },
				options,
			),
		).rejects.toThrow(/still running/);
		expect(
			(
				await db.pool.query(
					"SELECT 1 FROM runtime.vmid_leases WHERE build_job_id=$1",
					[job],
				)
			).rowCount,
		).toBe(1);
		active = false;
		await expect(
			nodeCommand(
				db.pool,
				{ op: "cleanup-build", nodeId: a.nodeId, jobId: job },
				options,
			),
		).rejects.toThrow(/confirm removal/);
		expect(
			(
				await db.pool.query(
					"SELECT 1 FROM runtime.vmid_leases WHERE build_job_id=$1",
					[job],
				)
			).rowCount,
		).toBe(1);
		disks = [{ name: "base-5500-disk-0" }];
		expect(
			await nodeCommand(
				db.pool,
				{ op: "cleanup-build", nodeId: a.nodeId, jobId: job },
				options,
			),
		).toEqual({ ok: true });
		expect(
			(
				await db.pool.query(
					"SELECT 1 FROM runtime.vmid_leases WHERE build_job_id=$1",
					[job],
				)
			).rowCount,
		).toBe(0);
	} finally {
		await rm(dir, { recursive: true, force: true });
	}
});

it("retirement retains its lease for local disks and recovers a lost delete reply with verified task identity", async () => {
	const a = await createTopology(db.pool);
	await db.pool.query(
		"UPDATE runtime.template_builds SET pve_vmid=603 WHERE id=$1",
		[a.templateBuildId],
	);
	await db.pool.query(
		"INSERT INTO runtime.vmid_leases(provider_id,vmid,mac,state,purpose) VALUES($1,603,'02:ed:00:00:02:27','active','template')",
		[a.providerId],
	);
	await db.pool.query("UPDATE quickstart.setup SET state=$1 WHERE id=true", [
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
	const dir = await mkdtemp(join(tmpdir(), "s19-retire-identity-"));
	await writeFile(join(dir, "pve-token"), "test");
	let disk = true,
		deletes = 0,
		foreign = true;
	const pve = {
		get: async (path: string) => {
			if (path.endsWith("/config")) return { template: 1, tags: "umiak-tpl" };
			if (path.endsWith("/tasks") || path.endsWith("/qemu")) return [];
			return {
				status: "stopped",
				exitstatus: "OK",
				type: "qmdestroy",
				id: foreign ? "999" : "603",
				user: "umiak@pve!sandbox",
				starttime: Math.ceil(Date.now() / 1000),
			};
		},
		delete: async () => {
			deletes++;
			throw Error("delete reply lost");
		},
	};
	const options = {
		secretsDir: dir,
		makePve: () => pve,
		probe: async () => ({ lvs: disk ? [{ name: "base-603-disk-0" }] : [] }),
	};
	const request = {
		op: "retire-template",
		nodeId: a.nodeId,
		buildId: a.templateBuildId,
	};
	try {
		await expect(nodeCommand(db.pool, request, options)).rejects.toThrow(
			/delete reply lost/,
		);
		const job = (
			await db.pool.query(
				"SELECT id FROM runtime.node_build_jobs WHERE retiring_build_id=$1",
				[a.templateBuildId],
			)
		).rows[0].id;
		await expect(
			nodeCommand(
				db.pool,
				{ op: "cleanup-build", nodeId: a.nodeId, jobId: job },
				options,
			),
		).rejects.toThrow(/retry retire-template/);
		await expect(nodeCommand(db.pool, request, options)).rejects.toThrow(
			/taskUpid/,
		);
		await expect(
			nodeCommand(db.pool, { ...request, taskUpid: "recovery-task" }, options),
		).rejects.toThrow(/does not match/);
		foreign = false;
		await expect(
			nodeCommand(db.pool, { ...request, taskUpid: "recovery-task" }, options),
		).rejects.toThrow(/local disks remain/);
		expect(
			(
				await db.pool.query(
					"SELECT 1 FROM runtime.vmid_leases WHERE provider_id=$1 AND vmid=603",
					[a.providerId],
				)
			).rowCount,
		).toBe(1);
		disk = false;
		expect(await nodeCommand(db.pool, request, options)).toEqual({ ok: true });
		expect(deletes).toBe(1);
		expect(
			(
				await db.pool.query(
					"SELECT 1 FROM runtime.vmid_leases WHERE provider_id=$1 AND vmid=603",
					[a.providerId],
				)
			).rowCount,
		).toBe(0);
	} finally {
		await rm(dir, { recursive: true, force: true });
	}
});

it("removal-plan lists what purge deletes; purge sends the normal delete jobs through pg-boss", async () => {
	const a = await createTopology(db.pool, { build: { version: "2.0.0" } });
	const team = randomUUID();
	const sandboxId = randomUUID();
	const machineId = await insertMachine(db.pool, a, {
		state: "running",
		sandboxId,
	});
	await insertSandbox(db.pool, a, {
		id: sandboxId,
		teamId: team,
		state: "ready",
		machineId,
	});
	await db.pool.query("UPDATE quickstart.setup SET state=$1 WHERE id=true", [
		{
			steps: {
				limits: { data: { providerId: a.providerId } },
				connection: { data: { node: "pve" } },
			},
		},
	]);
	const plan = await nodeCommand(db.pool, {
		op: "removal-plan",
		nodeId: a.nodeId,
	});
	expect(plan.sandboxes.map((s: { id: string }) => s.id)).toEqual([sandboxId]);
	expect(plan.templates[0]).toMatchObject({
		buildId: a.templateBuildId,
		version: "2.0.0",
	});
	await expect(
		nodeCommand(db.pool, { op: "purge", nodeId: a.nodeId }),
	).rejects.toThrow(/confirmed/);
	const after = await nodeCommand(db.pool, {
		op: "purge",
		nodeId: a.nodeId,
		confirmed: [sandboxId],
	});
	expect(after.sandboxes[0].state).toBe("deleting");
	const queued = await db.pool.query(
		"SELECT name FROM pgboss.job WHERE data->>'operationId' IN (SELECT id::text FROM runtime.operations WHERE sandbox_id=$1)",
		[sandboxId],
	);
	expect(queued.rows).toEqual([{ name: "sandbox-op" }]);
	await expect(
		nodeCommand(db.pool, { op: "removal-plan", nodeId: randomUUID() }),
	).rejects.toThrow(/Unknown sandbox node/);
});
