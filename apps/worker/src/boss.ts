// pg-boss wiring of the worker (S6 §15): the database adapter over the
// shared pg.Pool, job handlers with their local concurrency, and the
// controller queues.
//
// Heartbeats: pg-boss 12 refreshes `heartbeat_on` of every job in hand by
// itself while the handler promise is pending (every heartbeatSeconds / 2), so
// long steps need nothing extra. A job whose worker died stops getting
// refreshed and the supervisor of any instance fails it after
// heartbeatSeconds (30 s for operation queues); it is then retried.
import { DELETE_RETRY_LIMIT, isUuid, type QueueName } from "@sbx/core";
import { type Tx, withTx } from "@sbx/db";
import type pg from "pg";
import {
	type Db as BossDb,
	type ConstructorOptions,
	type Job,
	PgBoss,
} from "pg-boss";
import type { Logger } from "pino";
import type { WorkerCtx } from "./context.ts";
import type { ControllerSpec } from "./controllers/index.ts";
import { handleSandboxOpDeadLetter } from "./handlers/dlq.ts";
import { handleMachineEvents } from "./handlers/machine-events.ts";
import { handleMachineOp, type MachineOpData } from "./handlers/machine-op.ts";
import { handleSandboxOp } from "./handlers/sandbox-op.ts";
import {
	handleSnapshotOp,
	SnapshotInUse,
	type SnapshotOpData,
} from "./handlers/snapshot-op.ts";
import { errFields, errText } from "./log.ts";

/** pg-boss schema; `pgBossLiveJobs` (reconcile) reads `pgboss.job`. */
export const BOSS_SCHEMA = "pgboss";

/** Queues with a job handler (controller queues are registered per spec). */
export type JobQueue =
	| "sandbox-op"
	| "sandbox-op-dlq"
	| "machine-op"
	| "snapshot-op"
	| "machine-events";

/** `localConcurrency` per pod (S6 §15.2); the DLQ is not in the spec: 2. */
export const LOCAL_CONCURRENCY: Record<JobQueue, number> = {
	"sandbox-op": 16,
	"sandbox-op-dlq": 2,
	"machine-op": 8,
	"snapshot-op": 4,
	"machine-events": 8,
};

/** pg-boss runs its statements on the shared pool (S6 §15.2: one pool per pod). */
export function poolDb(pool: pg.Pool): BossDb {
	return {
		executeSql: (text, values) => pool.query(text, values as unknown[]),
	};
}

/** pg-boss statements inside the caller's transaction. */
export function txDb(tx: Tx): BossDb {
	return {
		executeSql: (text, values) => tx.client.query(text, values as unknown[]),
	};
}

export const SUPERVISE_INTERVAL_S = 30;

export function createBoss(
	db: BossDb,
	log: Logger,
	overrides: Partial<ConstructorOptions> = {},
): PgBoss {
	const boss = new PgBoss({
		db,
		schema: BOSS_SCHEMA,
		instanceName: "sbx-worker",
		// Expired heartbeats are failed by the supervise pass, which handles a
		// queue at most every monitorIntervalSeconds (default 60). 30 s each
		// gives a dead pod's jobs back within ~30-60 s after the heartbeat.
		superviseIntervalSeconds: SUPERVISE_INTERVAL_S,
		monitorIntervalSeconds: SUPERVISE_INTERVAL_S,
		...overrides,
	});
	// Without listeners an `error` event would crash the process.
	boss.on("error", (err) => log.error(errFields(err), "pg-boss error"));
	boss.on("warning", (w) =>
		log.warn({ warning: w.message, data: w.data }, "pg-boss warning"),
	);
	return boss;
}

export interface HandlerOptions {
	concurrency?: Partial<Record<QueueName, number>>;
	pollingIntervalSeconds?: number;
}

/** The job's own ctx: the same ports, a logger bound to the job. */
function jobCtx(ctx: WorkerCtx, queue: string, job: Job<unknown>): WorkerCtx {
	return { ...ctx, log: ctx.log.child({ queue, jobId: job.id }) };
}

function workOptions(queue: QueueName, dflt: number, o: HandlerOptions) {
	return {
		localConcurrency: o.concurrency?.[queue] ?? dflt,
		...(o.pollingIntervalSeconds !== undefined
			? { pollingIntervalSeconds: o.pollingIntervalSeconds }
			: {}),
	};
}

function field(data: unknown, name: string): unknown {
	return data !== null && typeof data === "object"
		? (data as Record<string, unknown>)[name]
		: undefined;
}

/** Ids from job data; a malformed job is logged and completed, never retried. */
function uuidField(
	ctx: WorkerCtx,
	job: Job<unknown>,
	name: string,
): string | undefined {
	const v = field(job.data, name);
	if (typeof v === "string" && isUuid(v)) return v;
	ctx.log.error({ field: name }, "malformed job data; dropped");
	return undefined;
}

async function opMetrics(
	ctx: WorkerCtx,
	operationId: string,
	outcome: string,
	err?: unknown,
): Promise<void> {
	try {
		const r = await ctx.pool.query<{
			kind: string;
			error_code: string | null;
			s: number | null;
		}>(
			`SELECT kind, error_code,
			   EXTRACT(EPOCH FROM finished_at - created_at)::float8 AS s
			 FROM runtime.operations WHERE id = $1`,
			[operationId],
		);
		const op = r.rows[0];
		if (!op) return;
		if (err !== undefined) {
			const code = (err as { code?: unknown } | null)?.code;
			ctx.metrics.inc("sbx_operation_errors_total", {
				kind: op.kind,
				code: typeof code === "string" ? code : "internal",
			});
			return;
		}
		if (outcome === "failed") {
			ctx.metrics.inc("sbx_operation_errors_total", {
				kind: op.kind,
				code: op.error_code ?? "internal",
			});
		}
		if ((outcome === "succeeded" || outcome === "failed") && op.s !== null) {
			ctx.metrics.observe("sbx_operation_duration_seconds", op.s, {
				kind: op.kind,
				outcome,
			});
		}
	} catch (e) {
		ctx.log.debug({ err: errText(e) }, "operation metrics skipped");
	}
}

/** Registers the handlers of the job queues (not the controllers). */
export async function registerHandlers(
	boss: PgBoss,
	ctx: WorkerCtx,
	o: HandlerOptions = {},
): Promise<void> {
	const each =
		(queue: JobQueue, fn: (c: WorkerCtx, job: Job<unknown>) => Promise<void>) =>
		async (jobs: Job<unknown>[]) => {
			for (const job of jobs) await fn(jobCtx(ctx, queue, job), job);
		};

	await boss.work(
		"sandbox-op",
		workOptions("sandbox-op", LOCAL_CONCURRENCY["sandbox-op"], o),
		each("sandbox-op", async (c, job) => {
			const operationId = uuidField(c, job, "operationId");
			if (!operationId) return;
			try {
				const r = await handleSandboxOp(c, { operationId });
				c.log.debug({ operationId, result: r }, "sandbox-op done");
				await opMetrics(c, operationId, r);
			} catch (err) {
				c.log.warn(
					{ operationId, ...errFields(err) },
					"sandbox-op failed; pg-boss retries it",
				);
				await opMetrics(c, operationId, "error", err);
				throw err;
			}
		}),
	);

	await boss.work(
		"sandbox-op-dlq",
		workOptions("sandbox-op-dlq", LOCAL_CONCURRENCY["sandbox-op-dlq"], o),
		each("sandbox-op-dlq", async (c, job) => {
			const operationId = uuidField(c, job, "operationId");
			if (!operationId) return;
			const r = await handleSandboxOpDeadLetter(c, { operationId });
			c.log.info({ operationId, result: r }, "sandbox-op dead letter handled");
		}),
	);

	await boss.work(
		"machine-op",
		workOptions("machine-op", LOCAL_CONCURRENCY["machine-op"], o),
		each("machine-op", async (c, job) => {
			const machineId = uuidField(c, job, "machineId");
			const action = field(job.data, "action");
			if (!machineId) return;
			if (action !== "provision" && action !== "delete") {
				c.log.error(
					{ machineId, action },
					"machine-op: unknown action; dropped",
				);
				return;
			}
			try {
				const r = await handleMachineOp(c, {
					machineId,
					action,
				} satisfies MachineOpData);
				c.log.debug({ machineId, action, result: r }, "machine-op done");
			} catch (err) {
				c.log.warn(
					{ machineId, action, ...errFields(err) },
					"machine-op failed; pg-boss retries it",
				);
				throw err;
			}
		}),
	);

	await boss.work(
		"snapshot-op",
		workOptions("snapshot-op", LOCAL_CONCURRENCY["snapshot-op"], o),
		each("snapshot-op", async (c, job) => {
			const snapshotId = uuidField(c, job, "snapshotId");
			if (!snapshotId) return;
			const data: SnapshotOpData = { snapshotId, action: "delete" };
			try {
				const r = await handleSnapshotOp(c, data);
				c.log.debug({ snapshotId, result: r }, "snapshot-op done");
			} catch (err) {
				if (err instanceof SnapshotInUse) {
					// Not a failure: the same job again in 30 s, this one completes
					// (a retry would burn the backoff and log an error each time).
					await withTx(c.pool, (tx) =>
						c.jobs.send(
							tx,
							"snapshot-op",
							{ ...data },
							{
								singletonKey: snapshotId,
								startAfter: err.retryAfterSeconds,
								retryLimit: DELETE_RETRY_LIMIT,
							},
						),
					);
					c.metrics.inc("sbx_snapshot_in_use_requeued_total");
					c.log.info(
						{ snapshotId, retryAfterS: err.retryAfterSeconds },
						"snapshot still in use; delete postponed",
					);
					return;
				}
				c.log.warn(
					{ snapshotId, ...errFields(err) },
					"snapshot-op failed; pg-boss retries it",
				);
				throw err;
			}
		}),
	);

	await boss.work(
		"machine-events",
		workOptions("machine-events", LOCAL_CONCURRENCY["machine-events"], o),
		each("machine-events", async (c, job) => {
			const machineId = uuidField(c, job, "machineId");
			if (!machineId) return;
			const r = await handleMachineEvents(c, { machineId });
			c.log.debug({ machineId, processed: r.processed }, "machine events");
		}),
	);
}

/** Cron of the safety net: once a minute per controller queue (S6 §15.1). */
export const CONTROLLER_CRON = "* * * * *";

/**
 * Controller queues (S6 §15.1). Each run ends by handing the turn over in one
 * transaction: the current job is completed and the next one is sent with
 * `startAfter = intervalMs`. The `exclusive` policy allows one live job per
 * queue in the whole cluster, so the next job can only be sent once this one
 * is completed, and any duplicate (cron, a second pod's startup kick) is
 * dropped. A failed run is logged and counted and still reschedules: the next
 * interval is its retry. The cron once a minute restarts a chain that broke
 * (a pod died between the run and the hand-over).
 */
export async function registerControllers(
	boss: PgBoss,
	ctx: WorkerCtx,
	controllers: readonly ControllerSpec[],
	o: { pollingIntervalSeconds?: number } = {},
): Promise<void> {
	for (const spec of controllers) {
		await boss.work(
			spec.queue,
			{
				localConcurrency: 1,
				...(o.pollingIntervalSeconds !== undefined
					? { pollingIntervalSeconds: o.pollingIntervalSeconds }
					: {}),
			},
			async (jobs: Job<unknown>[]) => {
				for (const job of jobs) await runController(boss, ctx, spec, job);
			},
		);
		await boss.schedule(spec.queue, CONTROLLER_CRON);
		// First run at startup; dropped if a job of this queue is already live.
		await boss.send(spec.queue, {});
	}
}

async function runController(
	boss: PgBoss,
	ctx: WorkerCtx,
	spec: ControllerSpec,
	job: Job<unknown>,
): Promise<void> {
	const c = jobCtx(ctx, spec.queue, job);
	const started = performance.now();
	let result = "ok";
	try {
		await spec.run(c);
	} catch (err) {
		result = "failed";
		c.log.error(errFields(err), "controller run failed");
	}
	const seconds = (performance.now() - started) / 1000;
	c.metrics.inc("sbx_controller_runs_total", { queue: spec.queue, result });
	c.metrics.observe("sbx_controller_duration_seconds", seconds, {
		queue: spec.queue,
	});
	await withTx(c.pool, async (tx) => {
		const db = txDb(tx);
		await boss.complete(spec.queue, job, null, { db });
		await boss.send(spec.queue, {}, { startAfter: spec.intervalMs / 1000, db });
	});
}
