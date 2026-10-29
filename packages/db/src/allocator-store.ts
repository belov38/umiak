import type {
	AllocatorStore,
	LeasePurpose,
	LeaseState,
	VmidLease,
} from "@sbx/pve";
import type pg from "pg";

interface LeaseRow {
	vmid: number;
	mac: string;
	state: LeaseState;
	purpose: LeasePurpose;
	machine_id: string | null;
	created_ms: number;
	updated_ms: number;
}

const COLUMNS = `vmid, mac, state, purpose, machine_id,
  round(extract(epoch FROM created_at) * 1000)::float8 AS created_ms,
  round(extract(epoch FROM updated_at) * 1000)::float8 AS updated_ms`;

/**
 * Postgres-backed VMID/MAC allocator state (runtime.vmid_leases), one store per
 * provider. The `cluster` argument of the S1 interface is ignored: the provider
 * id already identifies the cluster. `ownerId` maps to `machine_id`, so it must
 * be a UUID.
 */
export class PgAllocatorStore implements AllocatorStore {
	readonly #pool: pg.Pool;
	readonly #providerId: string;

	constructor(pool: pg.Pool, providerId: string) {
		this.#pool = pool;
		this.#providerId = providerId;
	}

	#toLease(cluster: number, r: LeaseRow): VmidLease {
		return {
			cluster,
			vmid: r.vmid,
			mac: r.mac,
			state: r.state,
			purpose: r.purpose,
			createdAt: r.created_ms,
			updatedAt: r.updated_ms,
			...(r.machine_id !== null ? { ownerId: r.machine_id } : {}),
		};
	}

	/** The insert is the lock: a conflict on (provider, vmid), mac or live machine returns false. */
	async tryInsert(l: VmidLease): Promise<boolean> {
		const res = await this.#pool.query(
			`INSERT INTO runtime.vmid_leases
			   (provider_id, vmid, mac, state, purpose, machine_id, created_at, updated_at)
			 VALUES ($1, $2, $3, $4, $5, $6, to_timestamp($7::float8 / 1000), to_timestamp($8::float8 / 1000))
			 ON CONFLICT DO NOTHING`,
			[
				this.#providerId,
				l.vmid,
				l.mac,
				l.state,
				l.purpose,
				l.ownerId ?? null,
				l.createdAt,
				l.updatedAt,
			],
		);
		return res.rowCount === 1;
	}

	async get(cluster: number, vmid: number): Promise<VmidLease | undefined> {
		const res = await this.#pool.query<LeaseRow>(
			`SELECT ${COLUMNS} FROM runtime.vmid_leases WHERE provider_id = $1 AND vmid = $2`,
			[this.#providerId, vmid],
		);
		const row = res.rows[0];
		return row ? this.#toLease(cluster, row) : undefined;
	}

	async list(cluster: number): Promise<VmidLease[]> {
		const res = await this.#pool.query<LeaseRow>(
			`SELECT ${COLUMNS} FROM runtime.vmid_leases WHERE provider_id = $1 ORDER BY vmid`,
			[this.#providerId],
		);
		return res.rows.map((r) => this.#toLease(cluster, r));
	}

	async setState(
		_cluster: number,
		vmid: number,
		state: LeaseState,
	): Promise<void> {
		await this.#pool.query(
			`UPDATE runtime.vmid_leases SET state = $3, updated_at = now()
			 WHERE provider_id = $1 AND vmid = $2`,
			[this.#providerId, vmid, state],
		);
	}

	async remove(_cluster: number, vmid: number): Promise<void> {
		await this.#pool.query(
			"DELETE FROM runtime.vmid_leases WHERE provider_id = $1 AND vmid = $2",
			[this.#providerId, vmid],
		);
	}

	async findByOwner(
		cluster: number,
		ownerId: string,
	): Promise<VmidLease | undefined> {
		const res = await this.#pool.query<LeaseRow>(
			`SELECT ${COLUMNS} FROM runtime.vmid_leases
			 WHERE provider_id = $1 AND machine_id = $2 AND state <> 'releasing'`,
			[this.#providerId, ownerId],
		);
		const row = res.rows[0];
		return row ? this.#toLease(cluster, row) : undefined;
	}
}
