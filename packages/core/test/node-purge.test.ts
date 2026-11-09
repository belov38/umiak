import { randomUUID } from "node:crypto";
import {
	createTestDatabase,
	skipPg,
	type TestDatabase,
} from "@umiak/db/testing";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
	nodeRemovalPlan,
	RecordingJobSender,
	requestNodePurge,
} from "../src/index.ts";
import { insertSavedSnapshot } from "./helpers/service.ts";
import {
	createTopology,
	insertMachine,
	insertSandbox,
	type Topology,
} from "./helpers/topology.ts";

describe.skipIf(skipPg())("node removal purge (S19)", () => {
	let db: TestDatabase;
	beforeAll(async () => {
		db = await createTestDatabase();
	});
	afterAll(async () => {
		await db?.drop();
	});

	const team = randomUUID();

	/** A node with one running sandbox, a saved snapshot, a warm machine and its template. */
	async function occupied(): Promise<
		Topology & { sandboxId: string; slug: string; warmId: string }
	> {
		const topo = await createTopology(db.pool, {
			build: { version: "1.2.0" },
		});
		const sandboxId = randomUUID();
		const machineId = await insertMachine(db.pool, topo, {
			state: "running",
			sandboxId,
		});
		await db.pool.query("UPDATE runtime.machines SET vmid=10007 WHERE id=$1", [
			machineId,
		]);
		await insertSandbox(db.pool, topo, {
			id: sandboxId,
			teamId: team,
			state: "ready",
			machineId,
		});
		await db.pool.query(
			"UPDATE runtime.sandboxes SET name='agent box' WHERE id=$1",
			[sandboxId],
		);
		const warmId = await insertMachine(db.pool, topo, { state: "warm" });
		await insertSavedSnapshot(db.pool, topo, {
			teamId: team,
			name: `snap-${sandboxId.slice(0, 6)}`,
		});
		const slug = (
			await db.pool.query("SELECT slug FROM runtime.sandboxes WHERE id=$1", [
				sandboxId,
			])
		).rows[0].slug;
		return { ...topo, sandboxId, slug, warmId };
	}

	it("lists sandboxes with VMIDs, saved snapshots, orphan machines and templates", async () => {
		const n = await occupied();
		const plan = await nodeRemovalPlan(db.pool, n.nodeId);
		expect(plan.sandboxes).toEqual([
			{
				id: n.sandboxId,
				slug: n.slug,
				name: "agent box",
				state: "ready",
				vmids: [10007],
			},
		]);
		expect(plan.machines).toEqual([
			{ id: n.warmId, vmid: null, state: "warm" },
		]);
		expect(plan.snapshots).toEqual([
			expect.objectContaining({
				name: `snap-${n.sandboxId.slice(0, 6)}`,
				kind: "saved",
				state: "ready",
			}),
		]);
		expect(plan.templates).toEqual([
			{
				buildId: n.templateBuildId,
				slug: "linux",
				version: "1.2.0",
				vmid: 599,
				status: "active",
			},
		]);
		expect(plan.blockers).toEqual([]);
	});

	it("includes a sandbox whose current machine sits on the node", async () => {
		const here = await createTopology(db.pool);
		const there = await createTopology(db.pool, {
			providerId: here.providerId,
		});
		const sandboxId = randomUUID();
		const machineId = await insertMachine(db.pool, here, {
			state: "stopped",
			sandboxId,
		});
		await insertSandbox(db.pool, there, {
			id: sandboxId,
			teamId: team,
			state: "stopped",
			machineId,
		});
		const plan = await nodeRemovalPlan(db.pool, here.nodeId);
		expect(plan.sandboxes.map((s) => s.id)).toEqual([sandboxId]);
		expect(plan.machines).toEqual([]);
	});

	it("reports running builds and transfers as plain-language blockers; a retirement intent is not one", async () => {
		const n = await createTopology(db.pool);
		await db.pool.query(
			"INSERT INTO runtime.node_build_jobs(id,node_id,template_slug) VALUES($1,$2,'windows')",
			[`build-${n.nodeId}`, n.nodeId],
		);
		let plan = await nodeRemovalPlan(db.pool, n.nodeId);
		expect(plan.blockers).toEqual([
			{
				kind: "build",
				id: `build-${n.nodeId}`,
				message: expect.stringMatching(/template build windows is running/),
			},
		]);
		await db.pool.query(
			"UPDATE runtime.node_build_jobs SET status='succeeded',finished_at=now() WHERE id=$1",
			[`build-${n.nodeId}`],
		);
		await db.pool.query(
			"INSERT INTO runtime.node_build_jobs(id,node_id,template_slug,retiring_build_id,status) VALUES($1,$2,'linux',$3,'interrupted')",
			[`retire-${n.nodeId}`, n.nodeId, n.templateBuildId],
		);
		plan = await nodeRemovalPlan(db.pool, n.nodeId);
		expect(plan.blockers).toEqual([]);
	});

	it("requests the normal lifecycle deletes, cordons the node and is idempotent", async () => {
		const n = await occupied();
		const jobs = new RecordingJobSender();
		const after = await requestNodePurge(db.pool, jobs, n.nodeId);
		expect(after.sandboxes[0]?.state).toBe("deleting");
		expect(after.machines[0]?.state).toBe("deleting");
		expect(after.snapshots[0]?.state).toBe("deleting");
		expect(jobs.sent.map((j) => j.queue).sort()).toEqual([
			"machine-op",
			"sandbox-op",
			"snapshot-op",
		]);
		expect(
			(
				await db.pool.query("SELECT state FROM runtime.nodes WHERE id=$1", [
					n.nodeId,
				])
			).rows[0].state,
		).toBe("cordoned");
		const ops = await db.pool.query(
			"SELECT kind,request FROM runtime.operations WHERE sandbox_id=$1",
			[n.sandboxId],
		);
		expect(ops.rows).toEqual([
			{ kind: "delete", request: { reason: "node_removal" } },
		]);

		jobs.clear();
		await requestNodePurge(db.pool, jobs, n.nodeId);
		expect(
			(
				await db.pool.query(
					"SELECT count(*)::int AS n FROM runtime.operations WHERE sandbox_id=$1",
					[n.sandboxId],
				)
			).rows[0].n,
		).toBe(1);
		// Deleting machines and snapshots are nudged again; the singleton key dedupes.
		expect(jobs.sent.map((j) => j.queue).sort()).toEqual([
			"machine-op",
			"snapshot-op",
		]);
	});

	it("refuses to purge while a blocker exists and changes nothing", async () => {
		const n = await occupied();
		await db.pool.query(
			"INSERT INTO runtime.node_build_jobs(id,node_id,template_slug) VALUES($1,$2,'linux')",
			[`build-${n.nodeId}`, n.nodeId],
		);
		const jobs = new RecordingJobSender();
		await expect(requestNodePurge(db.pool, jobs, n.nodeId)).rejects.toThrow(
			/template build linux is running/,
		);
		expect(jobs.sent).toEqual([]);
		expect(
			(
				await db.pool.query(
					"SELECT n.state AS node,s.state AS sandbox FROM runtime.nodes n, runtime.sandboxes s WHERE n.id=$1 AND s.id=$2",
					[n.nodeId, n.sandboxId],
				)
			).rows[0],
		).toEqual({ node: "active", sandbox: "ready" });
	});
});
