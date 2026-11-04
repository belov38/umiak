import type {
	AllocatorStore,
	LeasePurpose,
	LeaseState,
	VmidLease,
} from "@umiak/pve";
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
 * be a UUID. A builder scope reads/mutates only its job's leases while INSERT
 * still competes with every lease in the provider. New scoped leases require
 * the durable job to be running; retained leases survive interruption.
 */
export class PgAllocatorStore implements AllocatorStore {
	readonly #pool: pg.Pool;
	readonly #providerId: string;
	readonly #buildJobId: string | null;

	constructor(
		pool: pg.Pool,
		providerId: string,
		options: { buildJobId?: string } = {},
	) {
		this.#buildJobId = options.buildJobId ?? null;
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
			   (provider_id, vmid, mac, state, purpose, machine_id, created_at, updated_at, build_job_id)
			 SELECT $1, $2, $3, $4, $5, $6, to_timestamp($7::float8 / 1000), to_timestamp($8::float8 / 1000), $9
 WHERE $9::text IS NULL OR EXISTS (SELECT 1 FROM runtime.node_build_jobs b JOIN runtime.nodes n ON n.id=b.node_id WHERE b.id=$9 AND b.status='running' AND b.retiring_build_id IS NULL AND b.template_slug<>'node-prepare' AND n.provider_id=$1)
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
				this.#buildJobId,
			],
		);
		return res.rowCount === 1;
	}

	async get(cluster: number, vmid: number): Promise<VmidLease | undefined> {
		const res = await this.#pool.query<LeaseRow>(
			`SELECT ${COLUMNS} FROM runtime.vmid_leases WHERE provider_id = $1 AND vmid = $2 AND ($3::text IS NULL OR build_job_id=$3)`,
			[this.#providerId, vmid, this.#buildJobId],
		);
		const row = res.rows[0];
		return row ? this.#toLease(cluster, row) : undefined;
	}

	async list(cluster: number): Promise<VmidLease[]> {
		const res = await this.#pool.query<LeaseRow>(
			`SELECT ${COLUMNS} FROM runtime.vmid_leases WHERE provider_id = $1 AND ($2::text IS NULL OR build_job_id=$2) ORDER BY vmid`,
			[this.#providerId, this.#buildJobId],
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
			 WHERE provider_id = $1 AND vmid = $2 AND ($4::text IS NULL OR build_job_id=$4)`,
			[this.#providerId, vmid, state, this.#buildJobId],
		);
	}

	async remove(_cluster: number, vmid: number): Promise<void> {
		await this.#pool.query(
			"DELETE FROM runtime.vmid_leases WHERE provider_id = $1 AND vmid = $2 AND ($3::text IS NULL OR build_job_id=$3)",
			[this.#providerId, vmid, this.#buildJobId],
		);
	}

	async removeReleasing(
		_cluster: number,
		vmid: number,
		ownerId: string | null,
	): Promise<boolean> {
		const res = await this.#pool.query(
			`DELETE FROM runtime.vmid_leases
			 WHERE provider_id = $1 AND vmid = $2 AND state = 'releasing'
			   AND machine_id IS NOT DISTINCT FROM $3 AND ($4::text IS NULL OR build_job_id=$4)`,
			[this.#providerId, vmid, ownerId, this.#buildJobId],
		);
		return res.rowCount === 1;
	}

	async findByOwner(
		cluster: number,
		ownerId: string,
	): Promise<VmidLease | undefined> {
		const res = await this.#pool.query<LeaseRow>(
			`SELECT ${COLUMNS} FROM runtime.vmid_leases
			 WHERE provider_id = $1 AND machine_id = $2 AND state <> 'releasing' AND ($3::text IS NULL OR build_job_id=$3)`,
			[this.#providerId, ownerId, this.#buildJobId],
		);
		const row = res.rows[0];
		return row ? this.#toLease(cluster, row) : undefined;
	}
}
