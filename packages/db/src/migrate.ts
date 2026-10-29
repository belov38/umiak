// SQL migration runner for db/migrations (S6 §5.12).
// Files NNNN_<name>.sql are applied in ascending version order, each inside its
// own transaction, under a session advisory lock so that concurrent api and
// worker pods do not migrate at the same time. An applied file whose sha256
// changed is an error.
import { createHash } from "node:crypto";
import { readdir, readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type pg from "pg";

/** Absolute path of db/migrations in the repo; SBX_MIGRATIONS_DIR overrides it. */
export const MIGRATIONS_DIR: string =
	process.env.SBX_MIGRATIONS_DIR ||
	fileURLToPath(new URL("../../../db/migrations", import.meta.url));

/** Key of pg_advisory_lock held for the whole migration run. */
export const MIGRATION_LOCK_KEY = 727001;

const FILE_RE = /^(\d{4})_[a-z0-9_]+\.sql$/;

export interface MigrationFile {
	version: number;
	name: string;
	sha256: string;
	sql: string;
}

export interface MigrateOptions {
	dir?: string;
	log?: (msg: string) => void;
}

export class MigrationChecksumError extends Error {
	readonly file: string;
	readonly expected: string;
	readonly actual: string;

	constructor(file: string, expected: string, actual: string) {
		super(
			`migration ${file} was changed after it was applied (sha256 ${expected} in the database, ${actual} on disk)`,
		);
		this.name = "MigrationChecksumError";
		this.file = file;
		this.expected = expected;
		this.actual = actual;
	}
}

/** Reads the migration files of a directory, sorted by version. */
export async function readMigrations(
	dir: string = MIGRATIONS_DIR,
): Promise<MigrationFile[]> {
	const names = (await readdir(dir)).filter((n) => FILE_RE.test(n));
	const files: MigrationFile[] = [];
	for (const name of names) {
		const body = await readFile(path.join(dir, name));
		files.push({
			version: Number(name.slice(0, 4)),
			name,
			sha256: createHash("sha256").update(body).digest("hex"),
			sql: body.toString("utf8"),
		});
	}
	files.sort((a, b) => a.version - b.version);
	for (let i = 1; i < files.length; i++) {
		const prev = files[i - 1];
		const cur = files[i];
		if (prev && cur && prev.version === cur.version) {
			throw new Error(
				`duplicate migration version ${prev.name.slice(0, 4)}: ${prev.name}, ${cur.name}`,
			);
		}
	}
	return files;
}

const CREATE_TABLE = `CREATE TABLE IF NOT EXISTS public.sbx_schema_migrations (
	version    int PRIMARY KEY,
	name       text NOT NULL,
	sha256     text NOT NULL,
	applied_at timestamptz NOT NULL DEFAULT now()
)`;

interface AppliedRow {
	version: number;
	name: string;
	sha256: string;
}

/**
 * Applies the migrations that are not applied yet. Files applied earlier must
 * be unchanged. Versions applied in the database but unknown to this code
 * (newer releases) are allowed.
 */
export async function migrate(
	pool: pg.Pool,
	opts: MigrateOptions = {},
): Promise<{ applied: string[] }> {
	const files = await readMigrations(opts.dir);
	const log = opts.log ?? (() => {});
	const client = await pool.connect();
	let broken: Error | undefined;
	try {
		await client.query("SELECT pg_advisory_lock($1)", [MIGRATION_LOCK_KEY]);
		try {
			await client.query(CREATE_TABLE);
			const res = await client.query<AppliedRow>(
				"SELECT version, name, sha256 FROM public.sbx_schema_migrations",
			);
			const applied = new Map(res.rows.map((r) => [r.version, r]));
			for (const f of files) {
				const row = applied.get(f.version);
				if (row && row.sha256 !== f.sha256) {
					throw new MigrationChecksumError(f.name, row.sha256, f.sha256);
				}
			}
			const done: string[] = [];
			for (const f of files) {
				if (applied.has(f.version)) continue;
				log(`applying migration ${f.name}`);
				try {
					await client.query("BEGIN");
					await client.query(f.sql);
					await client.query(
						"INSERT INTO public.sbx_schema_migrations (version, name, sha256) VALUES ($1, $2, $3)",
						[f.version, f.name, f.sha256],
					);
					await client.query("COMMIT");
				} catch (err) {
					await client.query("ROLLBACK").catch((e: unknown) => {
						broken = e instanceof Error ? e : new Error(String(e));
					});
					throw new Error(`migration ${f.name} failed: ${String(err)}`, {
						cause: err,
					});
				}
				done.push(f.name);
			}
			if (done.length === 0) log("migrations are up to date");
			return { applied: done };
		} finally {
			if (!broken) {
				await client
					.query("SELECT pg_advisory_unlock($1)", [MIGRATION_LOCK_KEY])
					.catch((e: unknown) => {
						broken = e instanceof Error ? e : new Error(String(e));
					});
			}
		}
	} finally {
		// A broken connection is destroyed; that also releases the session lock.
		client.release(broken);
	}
}

/**
 * Migrations known to this code but not applied to the database (readiness).
 * Applied versions unknown to the code are ignored.
 */
export async function missingMigrations(
	pool: pg.Pool,
	dir: string = MIGRATIONS_DIR,
): Promise<string[]> {
	const files = await readMigrations(dir);
	const exists = await pool.query<{ t: string | null }>(
		"SELECT to_regclass('public.sbx_schema_migrations')::text AS t",
	);
	if (exists.rows[0]?.t == null) return files.map((f) => f.name);
	const res = await pool.query<{ version: number }>(
		"SELECT version FROM public.sbx_schema_migrations",
	);
	const applied = new Set(res.rows.map((r) => r.version));
	return files.filter((f) => !applied.has(f.version)).map((f) => f.name);
}
