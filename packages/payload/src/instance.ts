// One Payload instance per process and database (Local API without Next).
import { BasePayload, type Payload } from "payload";
import { buildSbxConfig, type SbxPayloadOptions } from "./config.ts";
import { dbPool } from "./db.ts";
import { detachSessionCache } from "./identity/session-cache.ts";

const instances = new Map<string, Promise<Payload>>();

/**
 * The Payload instance of `o.databaseUrl`, initialized once per process.
 * Later calls with the same URL get the same instance whatever their other
 * options.
 */
export function getSbxPayload(o: SbxPayloadOptions): Promise<Payload> {
	let p = instances.get(o.databaseUrl);
	if (!p) {
		p = buildSbxConfig(o).then((config) => new BasePayload().init({ config }));
		instances.set(o.databaseUrl, p);
		p.catch(() => {
			if (instances.get(o.databaseUrl) === p) instances.delete(o.databaseUrl);
		});
	}
	return p;
}

/** Drops the cached instance of a database and releases its connections. */
export async function closeSbxPayload(databaseUrl: string): Promise<void> {
	const p = instances.get(databaseUrl);
	if (!p) return;
	instances.delete(databaseUrl);
	const payload = await p.catch(() => null);
	if (!payload) return;
	const pool = dbPool(payload);
	await detachSessionCache(payload);
	await payload.destroy();
	// The adapter keeps one client checked out for good (connect), so end()
	// settles only once that client is gone; idle clients close at once.
	void pool?.end().catch(() => {});
}
