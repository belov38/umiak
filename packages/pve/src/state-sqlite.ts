import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { DatabaseSync } from "node:sqlite";
import type {
	AllocatorStore,
	LeaseState,
	SnapshotStore,
	VmidLease,
} from "./allocator.ts";
import type { SnapshotRef } from "./storage/types.ts";

interface LeaseRow {
	cluster: number;
	vmid: number;
	mac: string;
	state: LeaseState;
	purpose: VmidLease["purpose"];
	created_at: number;
	updated_at: number;
}

const toLease = (r: LeaseRow): VmidLease => ({
	cluster: r.cluster,
	vmid: r.vmid,
	mac: r.mac,
	state: r.state,
	purpose: r.purpose,
	createdAt: r.created_at,
	updatedAt: r.updated_at,
});

/** PoC state in SQLite (node:sqlite). Snapshot metadata never contains smbios1 or vmgenid. */
export class SqliteStateStore implements AllocatorStore, SnapshotStore {
	readonly #db: DatabaseSync;

	constructor(path: string) {
		if (path !== ":memory:")
			mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
		this.#db = new DatabaseSync(path);
		this.#db.exec(`
			PRAGMA journal_mode = WAL;
			PRAGMA busy_timeout = 5000;
			CREATE TABLE IF NOT EXISTS vmid_lease (
				cluster INTEGER NOT NULL,
				vmid INTEGER NOT NULL,
				mac TEXT NOT NULL,
				state TEXT NOT NULL CHECK (state IN ('reserved', 'active', 'releasing')),
				purpose TEXT NOT NULL CHECK (purpose IN ('machine', 'template')),
				created_at INTEGER NOT NULL,
				updated_at INTEGER NOT NULL,
				PRIMARY KEY (cluster, vmid),
				UNIQUE (cluster, mac)
			);
			CREATE TABLE IF NOT EXISTS snapshot (
				id TEXT PRIMARY KEY,
				source_vmid INTEGER NOT NULL,
				meta_json TEXT NOT NULL,
				created_at INTEGER NOT NULL
			);
		`);
	}

	tryInsert(l: VmidLease): boolean {
		const r = this.#db
			.prepare(
				`INSERT INTO vmid_lease (cluster, vmid, mac, state, purpose, created_at, updated_at)
				 VALUES (?, ?, ?, ?, ?, ?, ?) ON CONFLICT DO NOTHING`,
			)
			.run(
				l.cluster,
				l.vmid,
				l.mac,
				l.state,
				l.purpose,
				l.createdAt,
				l.updatedAt,
			);
		return Number(r.changes) === 1;
	}

	get(cluster: number, vmid: number): VmidLease | undefined {
		const r = this.#db
			.prepare("SELECT * FROM vmid_lease WHERE cluster = ? AND vmid = ?")
			.get(cluster, vmid);
		return r ? toLease(r as unknown as LeaseRow) : undefined;
	}

	list(cluster: number): VmidLease[] {
		return this.#db
			.prepare("SELECT * FROM vmid_lease WHERE cluster = ? ORDER BY vmid")
			.all(cluster)
			.map((r) => toLease(r as unknown as LeaseRow));
	}

	setState(cluster: number, vmid: number, state: LeaseState): void {
		this.#db
			.prepare(
				"UPDATE vmid_lease SET state = ?, updated_at = ? WHERE cluster = ? AND vmid = ?",
			)
			.run(state, Date.now(), cluster, vmid);
	}

	remove(cluster: number, vmid: number): void {
		this.#db
			.prepare("DELETE FROM vmid_lease WHERE cluster = ? AND vmid = ?")
			.run(cluster, vmid);
	}

	putSnapshot(s: SnapshotRef): void {
		this.#db
			.prepare(
				"INSERT OR REPLACE INTO snapshot (id, source_vmid, meta_json, created_at) VALUES (?, ?, ?, ?)",
			)
			.run(s.id, s.sourceVmid, JSON.stringify(s), s.createdAt);
	}

	getSnapshot(id: string): SnapshotRef | undefined {
		const r = this.#db
			.prepare("SELECT meta_json FROM snapshot WHERE id = ?")
			.get(id) as { meta_json: string } | undefined;
		return r ? (JSON.parse(r.meta_json) as SnapshotRef) : undefined;
	}

	listSnapshots(): SnapshotRef[] {
		return this.#db
			.prepare("SELECT meta_json FROM snapshot ORDER BY created_at")
			.all()
			.map(
				(r) =>
					JSON.parse((r as { meta_json: string }).meta_json) as SnapshotRef,
			);
	}

	removeSnapshot(id: string): void {
		this.#db.prepare("DELETE FROM snapshot WHERE id = ?").run(id);
	}

	close(): void {
		this.#db.close();
	}
}
