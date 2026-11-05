// One Payload instance per process and database (Local API without Next),
// shared by reference count: api and worker may run in one process (the
// E2E backend), each opening and closing it on its own.
import { BasePayload, type Payload } from "payload";
import { buildUmiakConfig, type UmiakPayloadOptions } from "./config.ts";
import { dbPool } from "./db.ts";

interface Entry {
	instance: Promise<Payload>;
	/** Open references: getUmiakPayload calls not yet matched by closeUmiakPayload. */
	refs: number;
	/** The largest poolMax asked for so far. */
	poolMax: number;
}

const DEFAULT_POOL_MAX = 10;

const instances = new Map<string, Entry>();

/**
 * Raises the max of the adapter pool: pg reads `options.max` on every
 * connect, so a larger value takes effect for the next checkout.
 */
function growPool(payload: Payload, max: number): void {
	const pool = dbPool(payload) as unknown as
		| { options?: { max?: number } }
		| undefined;
	if (pool?.options !== undefined && (pool.options.max ?? 0) < max) {
		pool.options.max = max;
	}
}

/**
 * The Payload instance of `o.databaseUrl`, initialized once per process.
 * Every call takes a reference; each must be released by one
 * `closeUmiakPayload(databaseUrl)`, and the instance is destroyed with the
 * last one. Later calls share the first call's config (secret, groups,
 * origin); a larger `poolMax` raises the pool's max.
 */
export function getUmiakPayload(o: UmiakPayloadOptions): Promise<Payload> {
	const poolMax = o.poolMax ?? DEFAULT_POOL_MAX;
	const e = instances.get(o.databaseUrl);
	if (e !== undefined) {
		e.refs += 1;
		if (poolMax > e.poolMax) {
			e.poolMax = poolMax;
			void e.instance.then((p) => growPool(p, poolMax)).catch(() => {});
		}
		return e.instance;
	}
	const entry: Entry = {
		instance: buildUmiakConfig(o).then((config) =>
			new BasePayload().init({ config }),
		),
		refs: 1,
		poolMax,
	};
	instances.set(o.databaseUrl, entry);
	entry.instance.then(
		(p) => growPool(p, entry.poolMax),
		() => {
			// A failed init is not cached: the next call tries again.
			if (instances.get(o.databaseUrl) === entry) {
				instances.delete(o.databaseUrl);
			}
		},
	);
	return entry.instance;
}

/** Open references to the instance of a database (0: none cached). */
export function umiakPayloadRefs(databaseUrl: string): number {
	return instances.get(databaseUrl)?.refs ?? 0;
}

/**
 * Releases one reference of the database's instance; the last one drops
 * the cached instance and releases its connections. Extra calls do nothing.
 */
export async function closeUmiakPayload(databaseUrl: string): Promise<void> {
	const e = instances.get(databaseUrl);
	if (!e) return;
	e.refs -= 1;
	if (e.refs > 0) return;
	instances.delete(databaseUrl);
	const payload = await e.instance.catch(() => null);
	if (!payload) return;
	const pool = dbPool(payload);
	await payload.destroy();
	// The adapter keeps one client checked out for good (connect), so end()
	// settles only once that client is gone; idle clients close at once.
	void pool?.end().catch(() => {});
}
