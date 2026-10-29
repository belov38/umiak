import { createTestDatabase, type TestDatabase } from "@sbx/db/testing";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { PromMetrics } from "../src/metrics.ts";
import { createTopology, type Topology } from "./fakes/world.ts";
import { testLogger } from "./helpers/worker.ts";

describe("PromMetrics", () => {
	it("exposes every §20 metric even before the first value", async () => {
		const m = new PromMetrics();
		const text = await m.registry.metrics();
		for (const name of [
			"sbx_pool_machines",
			"sbx_operation_duration_seconds",
			"sbx_operation_errors_total",
			"sbx_node_ram_mb",
			"sbx_reconcile_actions_total",
			"sbx_reconcile_skipped_total",
			"sbx_degraded_sandboxes",
			"sbx_queue_depth",
			"sbx_event_lag_seconds",
			"sbx_delete_stuck",
			"sbx_delete_dead_letter_total",
			"sbx_unexpected_identity_change_total",
			"sbx_quiesce_watchdog_thawed_total",
			"sbx_cleanup_failed_total",
		]) {
			expect(text).toContain(`# TYPE ${name} `);
		}
	});

	it("records the hook calls with their labels", async () => {
		const m = new PromMetrics();
		m.inc("sbx_reconcile_actions_total", {
			kind: "orphan_vm",
			mode: "dry_run",
		});
		m.inc("sbx_reconcile_actions_total", {
			kind: "orphan_vm",
			mode: "dry_run",
		});
		m.set("sbx_delete_stuck", 3);
		m.observe("sbx_operation_duration_seconds", 12, {
			kind: "create",
			outcome: "succeeded",
		});
		m.inc("sbx_unexpected_identity_change_total");
		const text = await m.registry.metrics();
		expect(text).toContain(
			'sbx_reconcile_actions_total{kind="orphan_vm",mode="dry_run"} 2',
		);
		expect(text).toMatch(/^sbx_delete_stuck 3$/m);
		expect(text).toContain(
			'sbx_operation_duration_seconds_count{kind="create",outcome="succeeded"} 1',
		);
		expect(text).toMatch(/^sbx_unexpected_identity_change_total 1$/m);
	});

	it("never throws: unknown names are registered on first use, label sets are normalized", async () => {
		const { log, captured } = testLogger("debug");
		const m = new PromMetrics({ log });
		m.inc("sbx_fenced_out_total", { queue: "sandbox-op", kind: "create" });
		m.inc("sbx_fenced_out_total", { queue: "machine-op", action: "delete" });
		m.inc("sbx_brand_new_total", { a: "1" });
		m.inc("sbx_brand_new_total", { b: "2" });
		m.set("sbx_reconcile_actions_total", 5, { kind: "x", mode: "y" });
		m.observe("sbx_brand_new_seconds", 1);
		m.inc("bad name with spaces");
		const text = await m.registry.metrics();
		expect(text).toContain(
			'sbx_fenced_out_total{queue="sandbox-op",kind="create",action=""} 1',
		);
		expect(text).toContain(
			'sbx_fenced_out_total{queue="machine-op",kind="",action="delete"} 1',
		);
		expect(text).toContain('sbx_brand_new_total{a="1"} 1');
		expect(text).toContain('sbx_brand_new_total{a=""} 1');
		expect(text).toContain("sbx_brand_new_seconds_count 1");
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
		expect(text).toContain(
			'sbx_pool_machines{pair="linux/2gb",state="warm"} 2',
		);
		expect(text).toContain(
			'sbx_pool_machines{pair="linux/2gb",state="booting"} 1',
		);
		expect(text).not.toContain('state="deleted"');
		const node = (
			await db.pool.query("SELECT name FROM runtime.nodes WHERE id = $1", [
				topo.nodeId,
			])
		).rows[0].name;
		expect(text).toContain(`sbx_node_ram_mb{node="${node}",kind="cap"} 8192`);
		expect(text).toContain(
			`sbx_node_ram_mb{node="${node}",kind="reserved"} 3072`,
		);
		expect(text).toContain(
			`sbx_node_ram_mb{node="${node}",kind="powered"} 3072`,
		);
		expect(text).toMatch(/^sbx_degraded_sandboxes 0$/m);
		// No pg-boss schema in this database: depth 0 for every queue.
		expect(text).toContain('sbx_queue_depth{queue="sandbox-op"} 0');
		const lag = /^sbx_event_lag_seconds (\S+)$/m.exec(text)?.[1];
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
