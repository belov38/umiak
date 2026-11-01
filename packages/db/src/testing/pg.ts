// Test databases without vitest (`@umiak/db/testing/pg`): the template
// database umiak_tmpl migrated from db/migrations, copies of it, and their
// removal. createTestDatabase (vitest) and test servers run outside vitest
// (packages/sdk-py/tests/api_server.ts) share this code, so they serialize
// on the same advisory lock and template.
import { randomBytes } from "node:crypto";
import Pg from "pg";
import { MIGRATIONS_DIR, migrate } from "../migrate.ts";
import { createPool } from "../tx.ts";

export const TEMPLATE_DB = "umiak_tmpl";

/** Advisory lock on the admin database: template creation and cloning are serialized. */
export const TEMPLATE_LOCK_KEY = 727002;

/** The admin DSN with another database name. */
export function dsnFor(admin: string, database: string): string {
	const url = new URL(admin);
	url.pathname = `/${database}`;
	return url.toString();
}

export interface CreateDatabaseOptions {
	/** Copy of the migrated template (default) or an empty database (false). */
	migrated?: boolean;
	/**
	 * Skip the template check (the caller already checked it in this
	 * process); default false.
	 */
	templateChecked?: boolean;
}

/**
 * Creates `umiak_test_<random>` on the server of `admin` and returns its name
 * and DSN. A migrated copy brings umiak_tmpl up to date first.
 */
export async function createDatabase(
	admin: string,
	opts: CreateDatabaseOptions = {},
): Promise<{ name: string; url: string }> {
	const migrated = opts.migrated !== false;
	const name = `umiak_test_${randomBytes(6).toString("hex")}`;
	const client = new Pg.Client({ connectionString: admin });
	await client.connect();
	try {
		await client.query("SELECT pg_advisory_lock($1)", [TEMPLATE_LOCK_KEY]);
		try {
			if (migrated && opts.templateChecked !== true) {
				await ensureTemplate(client, admin);
			}
			const source = migrated ? TEMPLATE_DB : "template0";
			await client.query(`CREATE DATABASE ${name} TEMPLATE ${source}`);
		} finally {
			await client.query("SELECT pg_advisory_unlock($1)", [TEMPLATE_LOCK_KEY]);
		}
	} finally {
		await client.end();
	}
	return { name, url: dsnFor(admin, name) };
}

/** Drops a database made by createDatabase (connections are closed by force). */
export async function dropDatabase(admin: string, name: string): Promise<void> {
	const c = new Pg.Client({ connectionString: admin });
	await c.connect();
	try {
		await c.query(`DROP DATABASE IF EXISTS ${name} WITH (FORCE)`);
	} finally {
		await c.end();
	}
}

// Brings umiak_tmpl up to date. An existing template (UMIAK_TEST_DATABASE_URL reused
// across runs) is migrated forward; if that fails (a changed migration file, a
// template left by an older layout) it is rebuilt from scratch. The caller
// holds TEMPLATE_LOCK_KEY.
async function ensureTemplate(
	admin: Pg.Client,
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
	} finally {
		await pool.end();
	}
}
