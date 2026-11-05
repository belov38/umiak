import { createTestDatabase, type TestDatabase } from "@umiak/db/testing";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { PromMetrics } from "../src/metrics.ts";
import { createTopology, type Topology } from "./fakes/world.ts";
import { testLogger } from "./helpers/worker.ts";

describe("PromMetrics", () => {
	it("exposes every §20 metric even before the first value", async () => {
		const m = new PromMetrics();
		const text = await m.registry.metrics();
		for (const name of [
			"umiak_operation_duration_seconds",
			"umiak_operation_errors_total",
			"umiak_node_ram_mb",
			"umiak_reconcile_actions_total",
			"umiak_reconcile_skipped_total",
			"umiak_degraded_sandboxes",
			"umiak_queue_depth",
			"umiak_event_lag_seconds",
			"umiak_delete_stuck",
			"umiak_delete_dead_letter_total",
			"umiak_unexpected_identity_change_total",
			"umiak_quiesce_watchdog_thawed_total",
			"umiak_cleanup_failed_total",
		]) {
			expect(text).toContain(`# TYPE ${name} `);
		}
	});

	it("records the hook calls with their labels", async () => {
		const m = new PromMetrics();
		m.inc("umiak_reconcile_actions_total", {
			kind: "orphan_vm",
			mode: "dry_run",
		});
		m.inc("umiak_reconcile_actions_total", {
			kind: "orphan_vm",
			mode: "dry_run",
		});
		m.set("umiak_delete_stuck", 3);
		m.observe("umiak_operation_duration_seconds", 12, {
			kind: "create",
			outcome: "succeeded",
		});
		m.inc("umiak_unexpected_identity_change_total");
		const text = await m.registry.metrics();
		expect(text).toContain(
			'umiak_reconcile_actions_total{kind="orphan_vm",mode="dry_run"} 2',
		);
		expect(text).toMatch(/^umiak_delete_stuck 3$/m);
		expect(text).toContain(
			'umiak_operation_duration_seconds_count{kind="create",outcome="succeeded"} 1',
		);
		expect(text).toMatch(/^umiak_unexpected_identity_change_total 1$/m);
	});

	it("never throws: unknown names are registered on first use, label sets are normalized", async () => {
		const { log, captured } = testLogger("debug");
		const m = new PromMetrics({ log });
		m.inc("umiak_fenced_out_total", { queue: "sandbox-op", kind: "create" });
		m.inc("umiak_fenced_out_total", { queue: "machine-op", action: "delete" });
		m.inc("umiak_brand_new_total", { a: "1" });
		m.inc("umiak_brand_new_total", { b: "2" });
		m.set("umiak_reconcile_actions_total", 5, { kind: "x", mode: "y" });
		m.observe("umiak_brand_new_seconds", 1);
		m.inc("bad name with spaces");
		const text = await m.registry.metrics();
		expect(text).toContain(
			'umiak_fenced_out_total{queue="sandbox-op",kind="create",action=""} 1',
		);
		expect(text).toContain(
			'umiak_fenced_out_total{queue="machine-op",kind="",action="delete"} 1',
		);
		expect(text).toContain('umiak_brand_new_total{a="1"} 1');
		expect(text).toContain('umiak_brand_new_total{a=""} 1');
		expect(text).toContain("umiak_brand_new_seconds_count 1");
		expect(captured.text()).toContain("bad name with spaces");
	});
});

describe("PromMetrics.collectDb", () => {
	let db: TestDatabase;
	let topo: Topology;

	beforeAll(async () => {
		db = await createTestDatabase();
		topo = await createTopology(db.pool, { ramCapMb: 8192 });
	});
	afterAll(async () => {
		await db?.drop();
	});

	it("computes pool, RAM, degraded, queue depth and event lag gauges from the database", async () => {
		for (const state of ["warm", "warm", "booting", "deleted"]) {
			await db.pool.query(
				`INSERT INTO runtime.machines
				   (provider_id, node_id, storage_id, template_build_id, origin, pool_key,
				    size_slug, vcpu, memory_mb, state, power_observed)
				 VALUES ($1, $2, $3, $4, 'template', 'linux/2gb', '2gb', 2, 1024, $5, 'running')`,
				[
					topo.providerId,
					topo.nodeId,
					topo.storageId,
					topo.templateBuildId,
					state,
				],
			);
		}
		await db.pool.query(
			`INSERT INTO runtime.agent_events (machine_id, seq, boot_id, type, time, received_at)
			 VALUES (gen_random_uuid(), 1, 'b', 'phase', now(), now() - interval '42 seconds')`,
		);
		const m = new PromMetrics();
		await m.collectDb(db.pool);
		const text = await m.registry.metrics();
		expect(text).not.toContain("umiak_pool_machines");
		expect(text).not.toContain('state="deleted"');
		const node = (
			await db.pool.query("SELECT name FROM runtime.nodes WHERE id = $1", [
				topo.nodeId,
			])
		).rows[0].name;
		expect(text).toContain(`umiak_node_ram_mb{node="${node}",kind="cap"} 8192`);
		expect(text).toContain(
			`umiak_node_ram_mb{node="${node}",kind="reserved"} 3072`,
		);
		expect(text).toContain(
			`umiak_node_ram_mb{node="${node}",kind="powered"} 3072`,
		);
		expect(text).toMatch(/^umiak_degraded_sandboxes 0$/m);
		// No pg-boss schema in this database: depth 0 for every queue.
		expect(text).toContain('umiak_queue_depth{queue="sandbox-op"} 0');
		const lag = /^umiak_event_lag_seconds (\S+)$/m.exec(text)?.[1];
		expect(Number(lag)).toBeGreaterThanOrEqual(41);
		expect(Number(lag)).toBeLessThan(60);

		// A machine that left the pool disappears from the gauge.
		await db.pool.query(
			"UPDATE runtime.machines SET state = 'deleted' WHERE state = 'booting'",
		);
		await m.collectDb(db.pool);
		expect(await m.registry.metrics()).not.toContain('state="booting"');
	});
});
