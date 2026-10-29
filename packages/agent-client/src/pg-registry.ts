import pg from "pg";
import { NOTIFY_CHANNEL } from "./constants.js";
import type { Registry, Route } from "./registry.js";

export interface PgRegistryOptions {
	/** Postgres connection string of the database with the tunnel schema. */
	connectionString: string;
	/** A gateway instance whose heartbeat is older than this is ignored. Default 15000. */
	staleAfterMs?: number;
	/** How long a found route is served from cache (NOTIFY invalidates earlier). Default 5000. */
	cacheTtlMs?: number;
	/** First delay before reconnecting the LISTEN connection; doubles up to 5 s. Default 100. */
	reconnectDelayMs?: number;
	/** Pool size for lookups. Default 10. */
	maxConnections?: number;
}

const lookupSql = `
SELECT s.machine_id::text AS machine_id, s.instance_id, s.epoch::text AS epoch,
       s.capabilities, g.internal_url
FROM tunnel.tunnel_sessions s
JOIN tunnel.gateway_instances g ON g.id = s.instance_id
WHERE s.machine_id = $1
  AND s.state = 'connected'
  AND g.heartbeat_at > now() - make_interval(secs => $2)`;

interface Row {
	machine_id: string;
	instance_id: string;
	epoch: string;
	capabilities: string[];
	internal_url: string;
}

const uuidRe = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const maxReconnectDelayMs = 5000;
const cacheSweepSize = 10_000;

/** Application name of the LISTEN connection (visible in pg_stat_activity). */
export const LISTEN_APPLICATION_NAME = "sbx-agent-client-listen";

/**
 * Registry backed by the tunnel schema in Postgres (spec section 8.4).
 * Lookups join tunnel_sessions with gateway_instances (state connected, fresh
 * heartbeat by the database clock) and are cached; a dedicated connection
 * LISTENs on tunnel_sessions and invalidates entries. While that connection is
 * down the cache is bypassed; after it reconnects the whole cache is cleared
 * and every waiter is woken, because NOTIFYs may have been missed.
 */
export class PgRegistry implements Registry {
	private readonly pool: pg.Pool;
	private readonly staleAfterSec: number;
	private readonly cacheTtlMs: number;
	private readonly reconnectDelayMs: number;
	private readonly cache = new Map<
		string,
		{ route: Route; expiresAt: number }
	>();
	// Token of the newest lookup in flight per machine; an invalidation removes
	// it so a result read before the change is not cached.
	private readonly inflight = new Map<string, object>();
	private readonly waiters = new Map<string, Set<() => void>>();
	private listener: pg.Client | undefined;
	private reconnectTimer: NodeJS.Timeout | undefined;
	private closed = false;

	private constructor(private readonly opts: PgRegistryOptions) {
		this.staleAfterSec = (opts.staleAfterMs ?? 15_000) / 1000;
		this.cacheTtlMs = opts.cacheTtlMs ?? 5000;
		this.reconnectDelayMs = opts.reconnectDelayMs ?? 100;
		this.pool = new pg.Pool({
			connectionString: opts.connectionString,
			max: opts.maxConnections ?? 10,
			application_name: "sbx-agent-client",
		});
		// Idle clients that lose their connection emit here; the pool drops them.
		this.pool.on("error", () => {});
	}

	/** Connects the pool and the LISTEN connection. */
	static async connect(opts: PgRegistryOptions): Promise<PgRegistry> {
		const r = new PgRegistry(opts);
		try {
			await r.listen();
		} catch (err) {
			await r.pool.end().catch(() => {});
			throw err;
		}
		return r;
	}

	async lookup(machineId: string): Promise<Route | undefined> {
		const key = machineId.toLowerCase();
		if (!uuidRe.test(key)) {
			throw new TypeError(`invalid machine id: ${machineId}`);
		}
		const hit = this.cache.get(key);
		if (hit !== undefined) {
			if (this.listener !== undefined && hit.expiresAt > Date.now()) {
				return hit.route;
			}
			this.cache.delete(key);
		}
		const token = {};
		this.inflight.set(key, token);
		try {
			const res = await this.pool.query<Row>(lookupSql, [
				key,
				this.staleAfterSec,
			]);
			const row = res.rows[0];
			const route =
				row === undefined
					? undefined
					: {
							machineId: row.machine_id,
							instanceId: row.instance_id,
							internalUrl: row.internal_url,
							epoch: BigInt(row.epoch),
							capabilities: row.capabilities,
						};
			// Only routes are cached: a miss must see the next poll.
			if (
				route !== undefined &&
				this.inflight.get(key) === token &&
				this.listener !== undefined
			) {
				this.store(key, route);
			}
			return route;
		} finally {
			if (this.inflight.get(key) === token) {
				this.inflight.delete(key);
			}
		}
	}

	invalidate(machineId: string): void {
		const key = machineId.toLowerCase();
		this.cache.delete(key);
		this.inflight.delete(key);
	}

	waitForChange(
		machineId: string,
		timeoutMs: number,
		signal?: AbortSignal,
	): Promise<void> {
		const key = machineId.toLowerCase();
		return new Promise((resolve) => {
			if (this.closed || signal?.aborted) {
				resolve();
				return;
			}
			let set = this.waiters.get(key);
			if (set === undefined) {
				set = new Set();
				this.waiters.set(key, set);
			}
			const waiters = set;
			const done = () => {
				clearTimeout(timer);
				signal?.removeEventListener("abort", done);
				waiters.delete(done);
				if (waiters.size === 0 && this.waiters.get(key) === waiters) {
					this.waiters.delete(key);
				}
				resolve();
			};
			const timer = setTimeout(done, Math.max(0, timeoutMs));
			signal?.addEventListener("abort", done, { once: true });
			waiters.add(done);
		});
	}

	/** Stops the LISTEN connection and the pool, and wakes all waiters. */
	async close(): Promise<void> {
		if (this.closed) {
			return;
		}
		this.closed = true;
		clearTimeout(this.reconnectTimer);
		this.clearAll();
		this.wakeAll();
		const l = this.listener;
		this.listener = undefined;
		await l?.end().catch(() => {});
		await this.pool.end();
	}

	private async listen(): Promise<void> {
		const c = new pg.Client({
			connectionString: this.opts.connectionString,
			application_name: LISTEN_APPLICATION_NAME,
		});
		const down = () => this.listenerDown(c);
		c.on("error", down);
		c.on("end", down);
		c.on("notification", (msg) => {
			if (msg.channel === NOTIFY_CHANNEL && msg.payload) {
				const key = msg.payload.toLowerCase();
				this.invalidate(key);
				this.wake(key);
			}
		});
		try {
			await c.connect();
			await c.query(`LISTEN ${NOTIFY_CHANNEL}`);
		} catch (err) {
			await c.end().catch(() => {});
			throw err;
		}
		if (this.closed) {
			await c.end().catch(() => {});
			return;
		}
		this.listener = c;
	}

	private listenerDown(c: pg.Client): void {
		if (c !== this.listener) {
			return;
		}
		this.listener = undefined;
		this.clearAll();
		c.end().catch(() => {});
		this.scheduleReconnect(this.reconnectDelayMs);
	}

	private scheduleReconnect(delayMs: number): void {
		if (this.closed) {
			return;
		}
		// Full jitter between half the delay and the delay.
		const wait = delayMs / 2 + Math.random() * (delayMs / 2);
		this.reconnectTimer = setTimeout(() => {
			this.listen().then(
				() => {
					// NOTIFYs may have been missed while down.
					this.clearAll();
					this.wakeAll();
				},
				() =>
					this.scheduleReconnect(Math.min(delayMs * 2, maxReconnectDelayMs)),
			);
		}, wait);
	}

	private store(key: string, route: Route): void {
		const now = Date.now();
		if (this.cache.size >= cacheSweepSize) {
			for (const [k, v] of this.cache) {
				if (v.expiresAt <= now) {
					this.cache.delete(k);
				}
			}
		}
		this.cache.set(key, { route, expiresAt: now + this.cacheTtlMs });
	}

	private clearAll(): void {
		this.cache.clear();
		this.inflight.clear();
	}

	private wake(key: string): void {
		const set = this.waiters.get(key);
		if (set === undefined) {
			return;
		}
		for (const w of [...set]) {
			w();
		}
	}

	private wakeAll(): void {
		for (const set of [...this.waiters.values()]) {
			for (const w of [...set]) {
				w();
			}
		}
	}
}
