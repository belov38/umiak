// Prometheus metrics (S6 §20) behind the `Metrics` hook of WorkerCtx.
//
// Event metrics (counters, histograms, the `sbx_delete_stuck` gauge of the
// health controller) are pushed by the code through `inc`/`set`/`observe`.
// State gauges that are a function of the database (pool size, node RAM,
// degraded sandboxes, queue depth, event lag) are computed at scrape time by
// `collectDb`: five cheap aggregate queries per scrape, no background loop,
// and the values are never staler than the scrape.
import { QUEUE_NAMES } from "@sbx/core";
import type pg from "pg";
import type { Logger } from "pino";
import {
	Counter,
	collectDefaultMetrics,
	Gauge,
	Histogram,
	Registry,
} from "prom-client";
import type { Metrics } from "./context.ts";
import { nodeRam, poolCounts } from "./pool-status.ts";

type Kind = "counter" | "gauge" | "histogram";

export interface MetricDef {
	name: string;
	kind: Kind;
	help: string;
	labels?: readonly string[];
	buckets?: number[];
}

const DURATION_BUCKETS = [
	0.5, 1, 2, 5, 10, 20, 30, 60, 120, 300, 600, 1200, 3600,
];

/** Metrics that exist from the start, with fixed label sets. */
export const METRIC_DEFS: readonly MetricDef[] = [
	// S6 §20
	{
		name: "sbx_pool_machines",
		kind: "gauge",
		help: "Warm pool machines (not claimed) per pair and state; computed on scrape",
		labels: ["pair", "state"],
	},
	{
		name: "sbx_operation_duration_seconds",
		kind: "histogram",
		help: "Operation time from creation to a terminal state, per kind and outcome",
		labels: ["kind", "outcome"],
		buckets: DURATION_BUCKETS,
	},
	{
		name: "sbx_operation_errors_total",
		kind: "counter",
		help: "Errors of sandbox-op jobs (retried and final) per operation kind and error code",
		labels: ["kind", "code"],
	},
	{
		name: "sbx_node_ram_mb",
		kind: "gauge",
		help: "Node RAM: cap, reserved and powered (S6 §8.1); computed on scrape",
		labels: ["node", "kind"],
	},
	{
		name: "sbx_reconcile_actions_total",
		kind: "counter",
		help: "Reconcile actions per kind and mode (applied, skipped, failed, dry_run)",
		labels: ["kind", "mode"],
	},
	{
		name: "sbx_reconcile_skipped_total",
		kind: "counter",
		help: "VMs reconcile refused to touch, per reason",
		labels: ["reason"],
	},
	{
		name: "sbx_reconcile_failed_total",
		kind: "counter",
		help: "Reconcile parts that failed",
		labels: ["part"],
	},
	{
		name: "sbx_degraded_sandboxes",
		kind: "gauge",
		help: "Live sandboxes with health degraded; computed on scrape",
	},
	{
		name: "sbx_queue_depth",
		kind: "gauge",
		help: "pg-boss jobs waiting (created or retry) per queue; computed on scrape",
		labels: ["queue"],
	},
	{
		name: "sbx_event_lag_seconds",
		kind: "gauge",
		help: "Age of the oldest unprocessed agent event; computed on scrape",
	},
	{
		name: "sbx_delete_stuck",
		kind: "gauge",
		help: "Delete operations active for more than 30 min (alert when > 0)",
	},
	{
		name: "sbx_delete_dead_letter_total",
		kind: "counter",
		help: "Delete jobs that reached the dead letter queue and were enqueued again",
		labels: ["step"],
	},
	{
		name: "sbx_unexpected_identity_change_total",
		kind: "counter",
		help: "Agent identity changes that were not a first boot from a snapshot",
	},
	{
		name: "sbx_quiesce_watchdog_thawed_total",
		kind: "counter",
		help: "Quiesce leases the guest watchdog thawed on its own",
	},
	{
		name: "sbx_cleanup_failed_total",
		kind: "counter",
		help: "Cleanup parts that failed",
		labels: ["part"],
	},
	// Operations and jobs
	{
		name: "sbx_operation_failed_total",
		kind: "counter",
		help: "Operations that failed after compensation, per kind and code",
		labels: ["kind", "code"],
	},
	{
		name: "sbx_operation_retries_exhausted_total",
		kind: "counter",
		help: "Operations whose job reached the dead letter queue",
		labels: ["kind"],
	},
	{
		name: "sbx_fenced_out_total",
		kind: "counter",
		help: "Executors that lost their fence (another attempt or a delete took over)",
		labels: ["queue", "kind", "action"],
	},
	{
		name: "sbx_owner_mismatch_total",
		kind: "counter",
		help: "Power operations S1 refused because the VMID's lease is not the machine's (freed and maybe reused)",
		labels: ["op"],
	},
	{
		name: "sbx_claim_retried_total",
		kind: "counter",
		help: "Creates that retried after a rejected pool claim",
		labels: ["code", "path"],
	},
	{
		name: "sbx_machine_provision_failed_total",
		kind: "counter",
		help: "Pool machine provisions that failed",
		labels: ["code"],
	},
	{
		name: "sbx_snapshot_in_use_requeued_total",
		kind: "counter",
		help: "snapshot-op deletes postponed because a create still clones from the snapshot",
	},
	// Controllers
	{
		name: "sbx_controller_runs_total",
		kind: "counter",
		help: "Controller runs per queue and result",
		labels: ["queue", "result"],
	},
	{
		name: "sbx_controller_duration_seconds",
		kind: "histogram",
		help: "Controller run time per queue",
		labels: ["queue"],
		buckets: [0.01, 0.05, 0.1, 0.5, 1, 5, 10, 30, 60, 300],
	},
	{
		name: "sbx_sandbox_degraded_total",
		kind: "counter",
		help: "Sandboxes the health controller marked degraded",
	},
	{
		name: "sbx_agent_restart_total",
		kind: "counter",
		help: "Agent restarts through QGA per result",
		labels: ["result"],
	},
	{
		name: "sbx_autostop_total",
		kind: "counter",
		help: "Stops requested by auto-stop per reason (ttl, idle)",
		labels: ["reason"],
	},
	{
		name: "sbx_cleanup_delete_total",
		kind: "counter",
		help: "Sandboxes deleted by cleanup per reason",
		labels: ["reason"],
	},
	{
		name: "sbx_secrets_old_key_rows",
		kind: "gauge",
		help: "sandbox_secrets and environments rows still encrypted with an old key version",
	},
	{
		name: "sbx_secrets_reencrypt_failed_total",
		kind: "counter",
		help: "sandbox_secrets and environments rows cleanup failed to re-encrypt",
	},
	{
		name: "sbx_idp_sync_total",
		kind: "counter",
		help: "IdP sync runs per result",
		labels: ["result"],
	},
	{
		name: "sbx_idp_sync_duration_seconds",
		kind: "histogram",
		help: "IdP sync run time",
		buckets: [0.1, 0.5, 1, 5, 10, 30, 60, 300],
	},
];

type AnyMetric = Counter<string> | Gauge<string> | Histogram<string>;

interface Entry {
	kind: Kind;
	labels: readonly string[];
	metric: AnyMetric;
}

export interface PromMetricsOptions {
	/** Node.js process metrics (CPU, memory, event loop). Default false. */
	defaultMetrics?: boolean;
	log?: Logger;
}

/**
 * `Metrics` over a prom-client registry. Never throws into the caller: an
 * unknown name is registered on first use with the label names of that call,
 * later label sets are normalized to them (missing → "", extra dropped), and
 * an invalid name or a call that does not fit the metric's type is logged
 * once and ignored.
 */
export class PromMetrics implements Metrics {
	readonly registry = new Registry();
	readonly #entries = new Map<string, Entry>();
	readonly #warned = new Set<string>();
	readonly #log: Logger | undefined;

	constructor(o: PromMetricsOptions = {}) {
		this.#log = o.log;
		for (const d of METRIC_DEFS) this.#create(d);
		if (o.defaultMetrics) collectDefaultMetrics({ register: this.registry });
	}

	#create(d: MetricDef): Entry {
		const labelNames = [...(d.labels ?? [])];
		const common = {
			name: d.name,
			help: d.help,
			labelNames,
			registers: [this.registry],
		};
		const metric: AnyMetric =
			d.kind === "counter"
				? new Counter(common)
				: d.kind === "gauge"
					? new Gauge(common)
					: new Histogram(
							d.buckets ? { ...common, buckets: d.buckets } : common,
						);
		const e: Entry = { kind: d.kind, labels: labelNames, metric };
		this.#entries.set(d.name, e);
		return e;
	}

	#warn(key: string, fields: Record<string, unknown>, msg: string): void {
		if (this.#warned.has(key)) return;
		this.#warned.add(key);
		this.#log?.warn(fields, msg);
	}

	#entry(
		name: string,
		kind: Kind,
		labels: Record<string, string>,
	): Entry | undefined {
		const e = this.#entries.get(name);
		if (e) return e;
		try {
			const created = this.#create({
				name,
				kind,
				help: `${name} (registered on first use)`,
				labels: Object.keys(labels),
			});
			this.#log?.debug(
				{ metric: name, kind, labels: created.labels },
				"metric registered on first use",
			);
			return created;
		} catch (err) {
			this.#warn(
				`create:${name}`,
				{ metric: name, err: err instanceof Error ? err.message : String(err) },
				"metric dropped: cannot register",
			);
			return undefined;
		}
	}

	#labels(e: Entry, labels: Record<string, string>): Record<string, string> {
		const out: Record<string, string> = {};
		for (const l of e.labels) out[l] = labels[l] ?? "";
		return out;
	}

	#apply(
		op: "inc" | "set" | "observe",
		name: string,
		labels: Record<string, string>,
		value: number,
	): void {
		try {
			const kind: Kind =
				op === "inc" ? "counter" : op === "set" ? "gauge" : "histogram";
			const e = this.#entry(name, kind, labels);
			if (!e) return;
			const l = this.#labels(e, labels);
			if (op === "inc" && (e.kind === "counter" || e.kind === "gauge")) {
				(e.metric as Counter<string>).inc(l, value);
			} else if (op === "set" && e.kind === "gauge") {
				(e.metric as Gauge<string>).set(l, value);
			} else if (op === "observe" && e.kind === "histogram") {
				(e.metric as Histogram<string>).observe(l, value);
			} else {
				this.#warn(
					`op:${op}:${name}`,
					{ metric: name, op, kind: e.kind },
					"metric call ignored: does not fit the metric type",
				);
			}
		} catch (err) {
			this.#warn(
				`err:${op}:${name}`,
				{ metric: name, err: err instanceof Error ? err.message : String(err) },
				"metric call failed",
			);
		}
	}

	inc(name: string, labels: Record<string, string> = {}, value = 1): void {
		this.#apply("inc", name, labels, value);
	}

	set(name: string, value: number, labels: Record<string, string> = {}): void {
		this.#apply("set", name, labels, value);
	}

	observe(
		name: string,
		value: number,
		labels: Record<string, string> = {},
	): void {
		this.#apply("observe", name, labels, value);
	}

	#gauge(name: string): Gauge<string> {
		const e = this.#entries.get(name);
		if (e?.kind !== "gauge") throw new Error(`no gauge ${name}`);
		return e.metric as Gauge<string>;
	}

	/**
	 * Recomputes the database gauges. Label sets that disappeared (a pair with
	 * no machines left, a removed node) are dropped.
	 */
	async collectDb(q: Pick<pg.Pool, "query">): Promise<void> {
		const [pool, ram, degraded, depth, lag] = await Promise.all([
			poolCounts(q),
			nodeRam(q),
			q.query<{ n: number }>(
				`SELECT count(*)::int AS n FROM runtime.sandboxes
				 WHERE health = 'degraded' AND state NOT IN ('deleting', 'deleted')`,
			),
			queueDepth(q),
			q.query<{ s: number | null }>(
				`SELECT EXTRACT(EPOCH FROM now() - min(t))::float8 AS s FROM (
				   SELECT min(received_at) AS t FROM runtime.agent_events WHERE processed_at IS NULL
				   UNION ALL
				   SELECT min(received_at) FROM runtime.agent_synthetic_events WHERE processed_at IS NULL
				 ) x`,
			),
		]);
		const g = this.#gauge("sbx_pool_machines");
		g.reset();
		for (const p of pool) g.set({ pair: p.pair, state: p.state }, p.count);
		const r = this.#gauge("sbx_node_ram_mb");
		r.reset();
		for (const n of ram) {
			r.set({ node: n.node, kind: "cap" }, n.capMb);
			r.set({ node: n.node, kind: "reserved" }, n.reservedMb);
			r.set({ node: n.node, kind: "powered" }, n.poweredMb);
		}
		this.#gauge("sbx_degraded_sandboxes").set(degraded.rows[0]?.n ?? 0);
		const d = this.#gauge("sbx_queue_depth");
		d.reset();
		for (const queue of QUEUE_NAMES) d.set({ queue }, depth.get(queue) ?? 0);
		this.#gauge("sbx_event_lag_seconds").set(Math.max(0, lag.rows[0]?.s ?? 0));
	}
}

/** Waiting jobs per queue; an empty map before pg-boss created its schema. */
async function queueDepth(
	q: Pick<pg.Pool, "query">,
): Promise<Map<string, number>> {
	const t = await q.query<{ t: string | null }>(
		"SELECT to_regclass('pgboss.job')::text AS t",
	);
	if (t.rows[0]?.t == null) return new Map();
	const r = await q.query<{ name: string; n: number }>(
		`SELECT name, count(*)::int AS n FROM pgboss.job
		 WHERE state IN ('created', 'retry') GROUP BY name`,
	);
	return new Map(r.rows.map((x) => [x.name, x.n]));
}
