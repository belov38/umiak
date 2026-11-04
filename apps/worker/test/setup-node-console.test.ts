import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createTopology } from "@umiak/core/testing";
import { createTestDatabase, type TestDatabase } from "@umiak/db/testing";
import { afterAll, beforeAll, expect, it } from "vitest";
// @ts-expect-error JavaScript console adapter is tested across the real PostgreSQL boundary.
import { nodeCommand } from "../../../deploy/compose/quickstart/nodes.mjs";
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
