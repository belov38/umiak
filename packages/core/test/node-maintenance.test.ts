import { randomUUID } from "node:crypto";
import { withTx } from "@umiak/db";
import { createTestDatabase, type TestDatabase } from "@umiak/db/testing";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { admit, lockNode, place, tryPoweredStart } from "../src/index.ts";
import {
	beginNodeBuild,
	finishNodeBuild,
	interruptNodeBuild,
	promoteNodeTemplate,
	reactivateNode,
	retireNode,
} from "../src/node-maintenance.ts";
import {
	createTopology,
	insertMachine,
	insertSandbox,
	insertStoppedWithOperation,
} from "./helpers/topology.ts";

let db: TestDatabase;
beforeAll(async () => {
	db = await createTestDatabase();
});
afterAll(async () => {
	await db?.drop();
});
const jobs = { send: async () => {} };
const reserve = (nodeId: string, jobId = randomUUID()) =>
	withTx(db.pool, (tx) =>
		beginNodeBuild(tx, { nodeId, jobId, templateSlug: "linux" }),
	);

describe("node maintenance (S19)", () => {
	it("an admission waiting for the node lock observes a newly committed build reservation", async () => {
		const a = await createTopology(db.pool);
		let admission: Promise<unknown> | undefined;
		await withTx(db.pool, async (tx) => {
			await lockNode(tx, a.nodeId);
			const entered = Promise.withResolvers<void>();
			admission = withTx(db.pool, async (other) => {
				entered.resolve();
				return admit(other, {
					nodeId: a.nodeId,
					storageId: a.storageId,
					templateBuildId: a.templateBuildId,
					needMb: 2048,
					pairKey: null,
					evict: false,
					jobs,
				});
			});
			await entered.promise;
			await beginNodeBuild(tx, {
				nodeId: a.nodeId,
				jobId: randomUUID(),
				templateSlug: "linux",
			});
		});
		expect(await admission).toEqual({ ok: false });
	});
	it("a build waiting on admitted placement sees the committed machine reservation", async () => {
		const a = await createTopology(db.pool);
		let building: Promise<unknown> | undefined;
		await withTx(db.pool, async (tx) => {
			expect(
				await admit(tx, {
					nodeId: a.nodeId,
					needMb: 2048,
					pairKey: null,
					evict: false,
					jobs,
				}),
			).toMatchObject({ ok: true });
			const entered = Promise.withResolvers<void>();
			building = withTx(db.pool, async (other) => {
				entered.resolve();
				return beginNodeBuild(other, {
					nodeId: a.nodeId,
					jobId: randomUUID(),
					templateSlug: "linux",
				});
			});
			// Observe rejection immediately, but assert it after the owner commits.
			void building.catch(() => {});
			await entered.promise;
			await insertMachine(tx.client, a, { state: "allocating" });
		});
		await expect(building).rejects.toThrow(/idle/);
	});

	it("promotes a build on one node without deprecating the other's build, fenced by reservation", async () => {
		const a = await createTopology(db.pool);
		const b = await createTopology(db.pool, { providerId: a.providerId });
		const nextId = randomUUID();
		await db.pool.query(
			`INSERT INTO runtime.template_builds(id,template_slug,version,os,provider_id,node_id,storage_id,pve_vmid,disk_layout,hw,boot_timeout_s,status) VALUES($1,'linux','next','linux',$2,$3,$4,601,'{}','{}',300,'building')`,
			[nextId, a.providerId, a.nodeId, a.storageId],
		);
		const jobId = randomUUID();
		await reserve(a.nodeId, jobId);
		await expect(
			withTx(db.pool, (tx) =>
				promoteNodeTemplate(tx, { nodeId: a.nodeId, buildId: nextId }),
			),
		).rejects.toThrow(/reservation/);
		await withTx(db.pool, (tx) =>
			promoteNodeTemplate(tx, { nodeId: a.nodeId, buildId: nextId, jobId }),
		);
		const active = await db.pool.query(
			"SELECT id FROM runtime.template_builds WHERE node_id=ANY($1::uuid[]) AND status='active'",
			[[a.nodeId, b.nodeId]],
		);
		expect(active.rows.map((x) => x.id).sort()).toEqual(
			[nextId, b.templateBuildId].sort(),
		);
	});
	it("reactivates the same retired node ID after external preparation, without deleting build history", async () => {
		const a = await createTopology(db.pool, { build: { status: "retired" } });
		await withTx(db.pool, (tx) => retireNode(tx, a.nodeId));
		await withTx(db.pool, (tx) => reactivateNode(tx, a.nodeId));
		const n = (
			await db.pool.query(
				"SELECT state,retired_at FROM runtime.nodes WHERE id=$1",
				[a.nodeId],
			)
		).rows[0];
		expect(n).toMatchObject({ state: "active", retired_at: null });
		expect(
			(
				await db.pool.query(
					"SELECT id FROM runtime.template_builds WHERE id=$1",
					[a.templateBuildId],
				)
			).rowCount,
		).toBe(1);
	});

	it("reserves only the selected idle node and fences placement, admission and starts", async () => {
		const a = await createTopology(db.pool);
		const b = await createTopology(db.pool, { providerId: a.providerId });
		const stopped = await insertMachine(db.pool, a, {
			state: "stopped",
			powerObserved: "stopped",
		});
		const jobId = randomUUID();
		await reserve(a.nodeId, jobId);
		const candidates = await withTx(db.pool, (tx) =>
			place(tx, { templateSlug: "linux", needMb: 2048 }),
		);
		expect(candidates.map((c) => c.nodeId)).not.toContain(a.nodeId);
		expect(candidates.map((c) => c.nodeId)).toContain(b.nodeId);
		expect(
			await withTx(db.pool, (tx) =>
				admit(tx, {
					nodeId: a.nodeId,
					needMb: 2048,
					pairKey: null,
					evict: false,
					jobs,
				}),
			),
		).toEqual({ ok: false });
		expect(
			await withTx(db.pool, (tx) =>
				tryPoweredStart(tx, { machineId: stopped, toState: "starting" }),
			),
		).toBe(false);
		await withTx(db.pool, (tx) => interruptNodeBuild(tx, a.nodeId, jobId));
		await expect(reserve(a.nodeId)).rejects.toThrow(/build/);
		await expect(
			withTx(db.pool, (tx) =>
				finishNodeBuild(tx, {
					nodeId: a.nodeId,
					jobId: "wrong",
					status: "failed",
				}),
			),
		).rejects.toThrow(/build/);
		await withTx(db.pool, (tx) =>
			finishNodeBuild(tx, { nodeId: a.nodeId, jobId, status: "failed" }),
		);
		await reserve(a.nodeId);
	});
	it.each(["allocating", "running", "deleting", "failed", "stopped"])(
		"refuses a build with a %s machine whose RAM or power is uncertain",
		async (state) => {
			const a = await createTopology(db.pool);
			await insertMachine(db.pool, a, { state, powerObserved: "unknown" });
			await expect(reserve(a.nodeId)).rejects.toThrow(/idle/);
		},
	);
	it("refuses a build when a stopped machine has already been admitted to resume", async () => {
		const a = await createTopology(db.pool);
		await insertStoppedWithOperation(db.pool, a, {
			operation: { kind: "resume", state: "pending" },
		});
		await expect(reserve(a.nodeId)).rejects.toThrow(/idle/);
	});
	it("removal lists active templates and non-deleted machines, sandboxes and snapshots", async () => {
		const a = await createTopology(db.pool);
		const machineId = await insertMachine(db.pool, a, {
			state: "stopped",
			powerObserved: "stopped",
		});
		const sandboxId = await insertSandbox(db.pool, a, {
			state: "stopped",
			teamId: randomUUID(),
			machineId,
		});
		const snapshotId = randomUUID();
		await db.pool.query(
			`INSERT INTO runtime.snapshots (id,kind,team_id,node_id,provider_id,storage_id,template_build_id,lv_id,state) VALUES ($1,'saved',$2,$3,$4,$5,$6,$7,'ready')`,
			[
				snapshotId,
				randomUUID(),
				a.nodeId,
				a.providerId,
				a.storageId,
				a.templateBuildId,
				randomUUID().replaceAll("-", ""),
			],
		);
		const result = await withTx(db.pool, (tx) => retireNode(tx, a.nodeId));
		expect(result).toMatchObject({ ok: false });
		if (result.ok) throw new Error("unexpected retirement");
		expect(result.blockers).toEqual(
			expect.arrayContaining([
				{ kind: "template", id: a.templateBuildId },
				{ kind: "machine", id: machineId },
				{ kind: "sandbox", id: sandboxId },
				{ kind: "snapshot", id: snapshotId },
			]),
		);
		expect(
			(
				await db.pool.query("SELECT state FROM runtime.nodes WHERE id=$1", [
					a.nodeId,
				])
			).rows[0].state,
		).toBe("active");
	});
	it("removal refuses an interrupted build; empty nodes retire idempotently without deleting history", async () => {
		const a = await createTopology(db.pool, { build: { status: "retired" } });
		const jobId = randomUUID();
		await reserve(a.nodeId, jobId);
		await withTx(db.pool, (tx) => interruptNodeBuild(tx, a.nodeId, jobId));
		expect(await withTx(db.pool, (tx) => retireNode(tx, a.nodeId))).toEqual({
			ok: false,
			blockers: [{ kind: "build", id: jobId }],
		});
		await withTx(db.pool, (tx) =>
			finishNodeBuild(tx, { nodeId: a.nodeId, jobId, status: "failed" }),
		);
		expect(await withTx(db.pool, (tx) => retireNode(tx, a.nodeId))).toEqual({
			ok: true,
		});
		expect(await withTx(db.pool, (tx) => retireNode(tx, a.nodeId))).toEqual({
			ok: true,
		});
		expect(
			(
				await db.pool.query(
					"SELECT retired_at FROM runtime.nodes WHERE id=$1",
					[a.nodeId],
				)
			).rows[0].retired_at,
		).not.toBeNull();
		await expect(reserve(a.nodeId)).rejects.toThrow(/active/);
	});
	it("rechecks a stale cold candidate after cordon or template replacement", async () => {
		const a = await createTopology(db.pool);
		const input = {
			nodeId: a.nodeId,
			storageId: a.storageId,
			templateBuildId: a.templateBuildId,
			needMb: 2048,
			pairKey: null,
			evict: false,
			jobs,
		};
		await db.pool.query(
			"UPDATE runtime.nodes SET state='cordoned' WHERE id=$1",
			[a.nodeId],
		);
		expect(await withTx(db.pool, (tx) => admit(tx, input))).toEqual({
			ok: false,
		});
		await db.pool.query("UPDATE runtime.nodes SET state='active' WHERE id=$1", [
			a.nodeId,
		]);
		await db.pool.query(
			"UPDATE runtime.template_builds SET status='deprecated' WHERE id=$1",
			[a.templateBuildId],
		);
		expect(await withTx(db.pool, (tx) => admit(tx, input))).toEqual({
			ok: false,
		});
	});
});
