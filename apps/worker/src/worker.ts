// The worker process (S6 §15): migrations, pg-boss over the shared pool,
// queues, job handlers, controllers, HTTP probes and metrics, shutdown.
// Ports are parameters so tests run the real process wiring over fakes;
// main.ts passes the real adapters.
import type { Server } from "node:http";
import type { ConfigReader } from "@umiak/config";
import {
	ensureQueues,
	type KeyRing,
	PgBossJobSender,
	type QueueName,
} from "@umiak/core";
import { dbOf, MIGRATIONS_DIR, migrate, missingMigrations } from "@umiak/db";
import type pg from "pg";
import type { Db as BossDb, ConstructorOptions, PgBoss } from "pg-boss";
import type { Logger } from "pino";
import {
	createBoss,
	poolDb,
	registerControllers,
	registerHandlers,
} from "./boss.ts";
import {
	createLogger,
	DEFAULT_TIMING,
	type Timing,
	type WorkerCtx,
} from "./context.ts";
import type { IdpSync } from "./controllers/idp-sync.ts";
import { activeControllers, type ControllerSpec } from "./controllers/index.ts";
import {
	closeServer,
	createHttpServer,
	LoopMonitor,
	listen,
	type Readiness,
} from "./http.ts";
import { errText } from "./log.ts";
import { PromMetrics } from "./metrics.ts";
import type { AgentPort, GatewayPort, InfraRegistry } from "./ports.ts";

export interface WorkerOptions {
	turn?: import("./desktop.ts").TurnConfig;
	/** Shared pool: pg-boss, Drizzle and the handlers (S6 §15.2). Owned by the caller. */
	pool: pg.Pool;
	config: ConfigReader;
	keys: KeyRing;
	/** `close()` (if any) is called on stop. */
	infra: InfraRegistry & { close?(): Promise<void> };
	agent: AgentPort;
	gateway: GatewayPort;
	/** S8 IdP sync; `ctl-idp-sync` runs only when set (decision 15). */
	idpSync?: IdpSync;
	/** `UMIAK_IDP_SYNC_INTERVAL`; default the controller's 300 s. */
	idpSyncIntervalMs?: number;
	log?: Logger;
	metrics?: PromMetrics;
	timing?: Timing;
	/** `UMIAK_RECONCILE_DRY_RUN` (default true). */
	reconcileDryRun?: boolean;
	/**
	 * `UMIAK_MIGRATE_ON_START` (default true). When false the worker waits for
	 * another process (api, `umiak-admin migrate`) to apply them; /readyz says
	 * why in the meantime.
	 */
	migrateOnStart?: boolean;
	migrationsDir?: string;
	migrationWaitPollMs?: number;
	/**
	 * Throws while the Payload schema is not ready (main: assertPayloadMigrated
	 * over the config reader's instance); /readyz reports `payload_migrations`.
	 */
	payloadReady?: () => Promise<void>;
	/** HTTP port; null = no server; 0 = any free port (tests). */
	httpPort?: number | null;
	httpHost?: string;
	/** Overrides of `localConcurrency` per queue. */
	concurrency?: Partial<Record<QueueName, number>>;
	/** Default: `activeControllers(ctx)`. Tests pass instrumented specs. */
	controllers?: readonly ControllerSpec[];
	/** pg-boss polling of every worker (pg-boss default 2 s). */
	pollingIntervalSeconds?: number;
	/** pg-boss constructor overrides (tests: supervise interval). */
	boss?: Partial<ConstructorOptions>;
	/** pg-boss database adapter; default the shared pool. */
	bossDb?: BossDb;
}

export interface StopOptions {
	/** Let active jobs finish (default true); false fails them at once. */
	graceful?: boolean;
	/** Grace for active jobs (S6 §15.2: 60 s). */
	timeoutMs?: number;
}

export const STOP_TIMEOUT_MS = 60_000;
const READINESS_TIMEOUT_MS = 3000;

function withTimeout<T>(p: Promise<T>, ms: number, what: string): Promise<T> {
	let timer: NodeJS.Timeout | undefined;
	const t = new Promise<never>((_, reject) => {
		timer = setTimeout(() => reject(new Error(`${what} timed out`)), ms);
	});
	return Promise.race([p, t]).finally(() => clearTimeout(timer));
}

export class Worker {
	readonly ctx: WorkerCtx;
	readonly boss: PgBoss;
	readonly metrics: PromMetrics;
	/** Bound HTTP port once the server listens. */
	httpPort: number | undefined;
	readonly #o: WorkerOptions;
	readonly #log: Logger;
	readonly #loop = new LoopMonitor();
	readonly #abort = new AbortController();
	#server: Server | undefined;
	#started = false;
	#stopping = false;
	#stopped: Promise<void> | undefined;

	constructor(o: WorkerOptions) {
		this.#o = o;
		this.#log = o.log ?? createLogger();
		this.metrics = o.metrics ?? new PromMetrics({ log: this.#log });
		this.boss = createBoss(o.bossDb ?? poolDb(o.pool), this.#log, o.boss);
		this.ctx = {
			...(o.turn ? { turn: o.turn } : {}),
			pool: o.pool,
			db: dbOf(o.pool),
			jobs: new PgBossJobSender(this.boss),
			config: o.config,
			keys: o.keys,
			infra: o.infra,
			agent: o.agent,
			gateway: o.gateway,
			timing: o.timing ?? DEFAULT_TIMING,
			log: this.#log,
			metrics: this.metrics,
			reconcileDryRun: o.reconcileDryRun ?? true,
			...(o.idpSync !== undefined ? { idpSync: o.idpSync } : {}),
		};
	}

	/** Starts everything; resolves once jobs are being taken. */
	async start(): Promise<void> {
		const o = this.#o;
		this.#loop.start();
		if (o.httpPort !== null && o.httpPort !== undefined) {
			this.#server = createHttpServer({
				log: this.#log,
				liveness: () => this.#loop.liveness(),
				readiness: () => this.readiness(),
				metrics: async () => {
					try {
						await withTimeout(
							this.metrics.collectDb(o.pool),
							READINESS_TIMEOUT_MS,
							"metrics collection",
						);
					} catch (err) {
						// Serve the last values rather than nothing.
						this.#log.warn({ err: errText(err) }, "metrics collection failed");
					}
					return {
						contentType: this.metrics.registry.contentType,
						body: await this.metrics.registry.metrics(),
					};
				},
			});
			this.httpPort = await listen(this.#server, o.httpPort, o.httpHost);
			this.#log.info({ port: this.httpPort }, "http listening");
		}

		const dir = o.migrationsDir ?? MIGRATIONS_DIR;
		if (o.migrateOnStart ?? true) {
			const r = await migrate(o.pool, {
				dir,
				log: (msg) => this.#log.info(msg),
			});
			this.#log.info({ applied: r.applied }, "migrations done");
		} else {
			await this.#waitForMigrations(dir, o.migrationWaitPollMs ?? 2000);
		}
		if (this.#stopping) return;

		await this.boss.start();
		await ensureQueues(this.boss);
		await registerHandlers(this.boss, this.ctx, {
			...(o.concurrency !== undefined ? { concurrency: o.concurrency } : {}),
			...(o.pollingIntervalSeconds !== undefined
				? { pollingIntervalSeconds: o.pollingIntervalSeconds }
				: {}),
		});
		const controllers = (o.controllers ?? activeControllers(this.ctx)).map(
			(c) =>
				c.queue === "ctl-idp-sync" && o.idpSyncIntervalMs !== undefined
					? { ...c, intervalMs: o.idpSyncIntervalMs }
					: c,
		);
		await registerControllers(this.boss, this.ctx, controllers, {
			...(o.pollingIntervalSeconds !== undefined
				? { pollingIntervalSeconds: o.pollingIntervalSeconds }
				: {}),
		});
		this.#started = true;
		this.#log.info(
			{
				controllers: controllers.map((c) => c.queue),
				reconcileDryRun: this.ctx.reconcileDryRun,
			},
			"worker started",
		);
	}

	async #waitForMigrations(dir: string, pollMs: number): Promise<void> {
		let logged = false;
		while (!this.#stopping) {
			try {
				const missing = await missingMigrations(this.#o.pool, dir);
				if (missing.length === 0) return;
				if (!logged) {
					this.#log.warn(
						{ missing },
						"waiting for migrations (UMIAK_MIGRATE_ON_START=0)",
					);
					logged = true;
				}
			} catch (err) {
				this.#log.warn({ err: errText(err) }, "migration check failed");
			}
			await new Promise<void>((resolve) => {
				const t = setTimeout(resolve, pollMs);
				this.#abort.signal.addEventListener(
					"abort",
					() => {
						clearTimeout(t);
						resolve();
					},
					{ once: true },
				);
			});
		}
	}

	/**
	 * S6 §15.2: pg-boss started, Postgres answers, every known migration
	 * applied, runtime and (with `payloadReady`) Payload.
	 */
	async readiness(): Promise<Readiness> {
		const reasons: string[] = [];
		if (this.#stopping) reasons.push("stopping");
		else if (!this.#started) reasons.push("pg-boss not started");
		try {
			await withTimeout(
				this.#o.pool.query("SELECT 1"),
				READINESS_TIMEOUT_MS,
				"SELECT 1",
			);
			const missing = await withTimeout(
				missingMigrations(
					this.#o.pool,
					this.#o.migrationsDir ?? MIGRATIONS_DIR,
				),
				READINESS_TIMEOUT_MS,
				"migration check",
			);
			if (missing.length > 0) {
				reasons.push(`migrations pending: ${missing.join(", ")}`);
			}
		} catch (err) {
			reasons.push(`postgres: ${errText(err)}`);
		}
		if (this.#o.payloadReady !== undefined) {
			try {
				await withTimeout(
					this.#o.payloadReady(),
					READINESS_TIMEOUT_MS,
					"payload migration check",
				);
			} catch (err) {
				reasons.push(`payload_migrations: ${errText(err)}`);
			}
		}
		return { ready: reasons.length === 0, reasons };
	}

	/**
	 * Stops taking jobs, waits up to `timeoutMs` for active ones (S6 §15.2),
	 * closes the infra clients and the HTTP server. The pool stays open (the
	 * caller owns it). Idempotent.
	 */
	stop(opts: StopOptions = {}): Promise<void> {
		this.#stopped ??= this.#stop(opts);
		return this.#stopped;
	}

	async #stop(opts: StopOptions): Promise<void> {
		this.#stopping = true;
		this.#abort.abort();
		const graceful = opts.graceful ?? true;
		this.#log.info({ graceful }, "worker stopping");
		try {
			await this.boss.stop({
				graceful,
				timeout: opts.timeoutMs ?? STOP_TIMEOUT_MS,
			});
		} catch (err) {
			this.#log.error({ err: errText(err) }, "pg-boss stop failed");
		}
		try {
			await this.#o.infra.close?.();
		} catch (err) {
			this.#log.error({ err: errText(err) }, "infra close failed");
		}
		this.#loop.stop();
		if (this.#server) await closeServer(this.#server);
		this.#started = false;
		this.#log.info("worker stopped");
	}
}

export function createWorker(o: WorkerOptions): Worker {
	return new Worker(o);
}

/** createWorker + start; a failed start stops what was started and rethrows. */
export async function startWorker(o: WorkerOptions): Promise<Worker> {
	const w = createWorker(o);
	try {
		await w.start();
	} catch (err) {
		await w.stop({ graceful: false }).catch(() => {});
		throw err;
	}
	return w;
}
