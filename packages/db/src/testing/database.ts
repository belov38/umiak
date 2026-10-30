// Per-test-file Postgres databases. Each one is a copy of the template database
// sbx_tmpl, which is migrated from db/migrations (S2's 0100 tunnel schema and
// S6's runtime schema). The admin DSN comes from global-setup.ts; the
// database work itself (lock, template, copy, drop) is in pg.ts, which
// servers run outside vitest use too.
import type pg from "pg";
import { inject } from "vitest";
import { createPool, type Db, dbOf } from "../tx.ts";
import { createDatabase, dropDatabase, TEMPLATE_DB } from "./pg.ts";
import "./provided.ts";

export { TEMPLATE_DB };

export interface TestDatabase {
	/** Connection string of the new database. */
	url: string;
	pool: pg.Pool;
	db: Db;
	/** Ends the pool and drops the database. */
	drop(): Promise<void>;
}

export interface TestDatabaseOptions {
	/** Copy of the migrated template (default) or an empty database (false). */
	migrated?: boolean;
	/** Pool size (default 10). */
	max?: number;
}

/** True when database tests must be skipped (SBX_TEST_SKIP_PG=1 and no URL). */
export function skipPg(): boolean {
	return inject("sbxPgAdminDsn") === "" && inject("sbxPgError") === "";
}

function adminDsn(): string {
	const admin = inject("sbxPgAdminDsn");
	const startErr = inject("sbxPgError");
	if (startErr !== "") throw new Error(startErr);
	if (admin === "")
		throw new Error("no Postgres available (SBX_TEST_SKIP_PG=1)");
	return admin;
}

// Set once the template was checked in this module instance (one per test file
// with vitest isolation); checking again is cheap but needs a connection.
let templateChecked = false;

/** Creates a fresh database for a test file. */
export async function createTestDatabase(
	opts: TestDatabaseOptions = {},
): Promise<TestDatabase> {
	const admin = adminDsn();
	const migrated = opts.migrated !== false;
	const { name, url } = await createDatabase(admin, {
		migrated,
		templateChecked,
	});
	if (migrated) templateChecked = true;
	const pool = createPool(url, opts.max ?? 10);
	return {
		url,
		pool,
		db: dbOf(pool),
		async drop() {
			await pool.end();
			await dropDatabase(admin, name);
		},
	};
}
