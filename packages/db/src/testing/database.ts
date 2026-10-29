// Per-test-file Postgres databases. Each one is a copy of the template database
// sbx_tmpl, which is migrated from db/migrations (plus the tunnel fixture while
// S2 is not merged, decision 16). The admin DSN comes from global-setup.ts.
import { randomBytes } from "node:crypto";
import type pg from "pg";
import Pg from "pg";
import { inject } from "vitest";
import { MIGRATIONS_DIR, migrate } from "../migrate.ts";
import { applyTunnelFixture, TUNNEL_FIXTURE } from "../tunnel-fixture.ts";
import { createPool, type Db, dbOf } from "../tx.ts";
import "./provided.ts";

export const TEMPLATE_DB = "sbx_tmpl";

/** Advisory lock on the admin database: template creation and cloning are serialized. */
const TEMPLATE_LOCK_KEY = 727002;

export { TUNNEL_FIXTURE };

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

function dsnFor(admin: string, database: string): string {
	const url = new URL(admin);
	url.pathname = `/${database}`;
	return url.toString();
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
	const name = `sbx_test_${randomBytes(6).toString("hex")}`;
	const client = new Pg.Client({ connectionString: admin });
	await client.connect();
	try {
		await client.query("SELECT pg_advisory_lock($1)", [TEMPLATE_LOCK_KEY]);
		try {
			if (migrated && !templateChecked) {
				await ensureTemplate(client, admin);
				templateChecked = true;
			}
			const source = migrated ? TEMPLATE_DB : "template0";
			await client.query(`CREATE DATABASE ${name} TEMPLATE ${source}`);
		} finally {
			await client.query("SELECT pg_advisory_unlock($1)", [TEMPLATE_LOCK_KEY]);
		}
	} finally {
		await client.end();
	}
	const url = dsnFor(admin, name);
	const pool = createPool(url, opts.max ?? 10);
	return {
		url,
		pool,
		db: dbOf(pool),
		async drop() {
			await pool.end();
			const c = new Pg.Client({ connectionString: admin });
			await c.connect();
			try {
				await c.query(`DROP DATABASE IF EXISTS ${name} WITH (FORCE)`);
			} finally {
				await c.end();
			}
		},
	};
}

// Brings sbx_tmpl up to date. An existing template (SBX_TEST_DATABASE_URL reused
// across runs) is migrated forward; if that fails (changed file, S2's real
// tunnel migration over the fixture) it is rebuilt from scratch.
async function ensureTemplate(
	admin: pg.Client,
	adminUrl: string,
): Promise<void> {
	const url = dsnFor(adminUrl, TEMPLATE_DB);
	const exists = await admin.query(
		"SELECT 1 FROM pg_database WHERE datname = $1",
		[TEMPLATE_DB],
	);
	if (exists.rowCount) {
		try {
			await prepareTemplate(url);
			return;
		} catch {
			// rebuilt below
		}
	}
	await admin.query(`DROP DATABASE IF EXISTS ${TEMPLATE_DB} WITH (FORCE)`);
	await admin.query(`CREATE DATABASE ${TEMPLATE_DB} TEMPLATE template0`);
	await prepareTemplate(url);
}

async function prepareTemplate(url: string): Promise<void> {
	const pool = createPool(url, 1);
	try {
		await migrate(pool, { dir: MIGRATIONS_DIR });
		await applyTunnelFixture(pool);
	} finally {
		await pool.end();
	}
}
