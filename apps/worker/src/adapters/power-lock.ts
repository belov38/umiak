// Per-node serialization of VM start and delete. Proxmox writes the SDN
// ethers/IPAM entries of a VM on start and removes them on destroy, sbx-node
// rewrites the dnsmasq files on dhcp.release, and concurrent runs of these on
// one node race on those files. Clones stay parallel (they are limited by
// node_clone_slots).
import type pg from "pg";

/**
 * Runs fn while holding the session advisory lock
 * `hashtextextended('power:' || nodeId, 0)` on a dedicated pool client, so
 * starts and deletes on one node are serialized across all worker replicas.
 * Not for use inside a transaction: the caller must hold no row or advisory
 * locks (the wait can be as long as a start or a verified delete).
 */
export async function withNodePowerLock<T>(
	pool: pg.Pool,
	nodeId: string,
	fn: () => Promise<T>,
): Promise<T> {
	const key = `power:${nodeId}`;
	const client = await pool.connect();
	try {
		await client.query("SELECT pg_advisory_lock(hashtextextended($1, 0))", [
			key,
		]);
	} catch (err) {
		client.release(err instanceof Error ? err : true);
		throw err;
	}
	try {
		return await fn();
	} finally {
		try {
			await client.query("SELECT pg_advisory_unlock(hashtextextended($1, 0))", [
				key,
			]);
			client.release();
		} catch (err) {
			// A broken connection drops its session locks; never return it to the pool.
			client.release(err instanceof Error ? err : true);
		}
	}
}
