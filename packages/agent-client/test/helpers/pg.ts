// Per-test-file Postgres databases with the tunnel migrations applied.
// The admin DSN comes from pg-global-setup.ts through vitest's provide/inject.
import { randomBytes } from "node:crypto";
import { existsSync } from "node:fs";
import { readdir, readFile } from "node:fs/promises";
import path from "node:path";
import pg from "pg";
import { inject } from "vitest";

export interface TestDatabase {
	/** Connection string of the new database. */
	connectionString: string;
	/** A pool on the new database for fixtures. */
	pool: pg.Pool;
	/** Ends the pool and drops the database. */
	drop(): Promise<void>;
}

/** True when database tests must be skipped (UMIAK_TEST_SKIP_PG=1 and no URL). */
export function skipPg(): boolean {
	return inject("umiakPgAdminDsn") === "" && inject("umiakPgError") === "";
}

export interface TestDatabaseOptions {
	/**
	 * Apply db/migrations/01??_*.sql (default true). The Go tunnel harness
	 * applies them itself, so its database is created empty.
	 */
	migrate?: boolean;
}

/** Creates a fresh database and applies db/migrations/01??_*.sql in name order. */
export async function createTestDatabase(
	opts: TestDatabaseOptions = {},
): Promise<TestDatabase> {
	const admin = inject("umiakPgAdminDsn");
	const startErr = inject("umiakPgError");
	if (startErr !== "") {
		throw new Error(startErr);
	}
	if (admin === "") {
		throw new Error("no Postgres available (UMIAK_TEST_SKIP_PG=1)");
	}
	const name = `umiak_test_${randomBytes(6).toString("hex")}`;
	const adminClient = new pg.Client({ connectionString: admin });
	await adminClient.connect();
	try {
		await adminClient.query(`CREATE DATABASE ${name}`);
	} finally {
		await adminClient.end();
	}
	const url = new URL(admin);
	url.pathname = `/${name}`;
	const connectionString = url.toString();
	const pool = new pg.Pool({ connectionString, max: 4 });
	pool.on("error", () => {});
	const files = opts.migrate === false ? [] : await migrationFiles();
	for (const file of files) {
		const sql = await readFile(file, "utf8");
		const client = await pool.connect();
		try {
			await client.query("BEGIN");
			await client.query(sql);
			await client.query("COMMIT");
		} catch (err) {
			await client.query("ROLLBACK").catch(() => {});
			throw new Error(`migration ${path.basename(file)}: ${String(err)}`);
		} finally {
			client.release();
		}
	}
	return {
		connectionString,
		pool,
		async drop() {
			await pool.end();
			const c = new pg.Client({ connectionString: admin });
			await c.connect();
			try {
				await c.query(`DROP DATABASE IF EXISTS ${name} WITH (FORCE)`);
			} finally {
				await c.end();
			}
		},
	};
}

async function migrationFiles(): Promise<string[]> {
	const dir = path.join(repoRoot(), "db", "migrations");
	const names = (await readdir(dir))
		.filter((n) => /^01\d\d_.*\.sql$/.test(n))
		.sort();
	return names.map((n) => path.join(dir, n));
}

function repoRoot(): string {
	let dir = import.meta.dirname;
	for (;;) {
		if (existsSync(path.join(dir, "pnpm-workspace.yaml"))) {
			return dir;
		}
		const parent = path.dirname(dir);
		if (parent === dir) {
			throw new Error("repo root (pnpm-workspace.yaml) not found");
		}
		dir = parent;
	}
}
