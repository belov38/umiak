import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import {
	MIGRATIONS_DIR,
	MigrationChecksumError,
	migrate,
	missingMigrations,
} from "../src/index.ts";
import {
	createTestDatabase,
	skipPg,
	type TestDatabase,
} from "../src/testing/index.ts";

const realFiles = (await readdir(MIGRATIONS_DIR))
	.filter((n) => /^\d{4}_[a-z0-9_]+\.sql$/.test(n))
	.sort();

describe("MIGRATIONS_DIR", () => {
	it("points at db/migrations in the repo root", () => {
		expect(path.basename(MIGRATIONS_DIR)).toBe("migrations");
		expect(existsSync(path.join(MIGRATIONS_DIR, "0200_runtime_init.sql"))).toBe(
			true,
		);
		expect(
			existsSync(path.join(MIGRATIONS_DIR, "..", "..", "pnpm-workspace.yaml")),
		).toBe(true);
	});
});

describe.skipIf(skipPg())("migrate", () => {
	const dbs: TestDatabase[] = [];
	const dirs: string[] = [];

	async function emptyDb(): Promise<TestDatabase> {
		const db = await createTestDatabase({ migrated: false });
		dbs.push(db);
		return db;
	}

	async function tempDir(files: Record<string, string>): Promise<string> {
		const dir = await mkdtemp(path.join(tmpdir(), "umiak-mig-"));
		dirs.push(dir);
		for (const [name, sql] of Object.entries(files)) {
			await writeFile(path.join(dir, name), sql);
		}
		return dir;
	}

	afterEach(async () => {
		for (const db of dbs.splice(0)) await db.drop();
		for (const dir of dirs.splice(0)) await rm(dir, { recursive: true });
	});

	it("applies 0200 and 0201 once; the second run does nothing", async () => {
		const db = await emptyDb();
		const logs: string[] = [];
		const first = await migrate(db.pool, { log: (m) => logs.push(m) });
		expect(first.applied).toEqual(realFiles);
		expect(first.applied).toContain("0200_runtime_init.sql");
		expect(first.applied).toContain("0201_runtime_triggers.sql");
		expect(logs.length).toBeGreaterThan(0);

		const second = await migrate(db.pool);
		expect(second.applied).toEqual([]);

		const rows = await db.pool.query<{
			version: number;
			name: string;
			sha256: string;
		}>(
			"SELECT version, name, sha256 FROM public.umiak_schema_migrations ORDER BY version",
		);
		expect(rows.rows.map((r) => r.name)).toEqual(realFiles);
		for (const r of rows.rows) {
			const body = await readFile(path.join(MIGRATIONS_DIR, r.name));
			expect(r.sha256).toBe(createHash("sha256").update(body).digest("hex"));
			expect(r.version).toBe(Number(r.name.slice(0, 4)));
		}
		const schemas = await db.pool.query(
			"SELECT 1 FROM information_schema.schemata WHERE schema_name = 'runtime'",
		);
		expect(schemas.rowCount).toBe(1);
	});

	it("applies matching files only, in ascending version order", async () => {
		const db = await emptyDb();
		const dir = await tempDir({
			"0010_second.sql": "INSERT INTO mig_order VALUES ('second');",
			"0002_first.sql": "CREATE TABLE mig_order (v text);",
			"0003_Bad.sql": "SELECT broken syntax here;",
			"README.md": "not a migration",
			"0004_x.sql.bak": "SELECT broken syntax here;",
		});
		const res = await migrate(db.pool, { dir });
		expect(res.applied).toEqual(["0002_first.sql", "0010_second.sql"]);
		const rows = await db.pool.query("SELECT v FROM mig_order");
		expect(rows.rows).toEqual([{ v: "second" }]);
	});

	it("runs each file in its own transaction", async () => {
		const db = await emptyDb();
		const dir = await tempDir({
			"0001_ok.sql": "CREATE TABLE mig_ok (v int);",
			"0002_fail.sql":
				"CREATE TABLE mig_partial (v int); SELECT * FROM no_such_table;",
		});
		await expect(migrate(db.pool, { dir })).rejects.toThrow(/0002_fail\.sql/);
		const t = await db.pool.query(
			"SELECT table_name FROM information_schema.tables WHERE table_name IN ('mig_ok', 'mig_partial')",
		);
		expect(t.rows).toEqual([{ table_name: "mig_ok" }]);
		const applied = await db.pool.query(
			"SELECT name FROM public.umiak_schema_migrations",
		);
		expect(applied.rows).toEqual([{ name: "0001_ok.sql" }]);
	});

	it("applies a missing older file after newer ones (separate ranges)", async () => {
		const db = await emptyDb();
		const dir = await tempDir({ "0300_b.sql": "CREATE TABLE mig_b (v int);" });
		await migrate(db.pool, { dir });
		await writeFile(
			path.join(dir, "0201_a.sql"),
			"CREATE TABLE mig_a (v int);",
		);
		const res = await migrate(db.pool, { dir });
		expect(res.applied).toEqual(["0201_a.sql"]);
	});

	it("fails with MigrationChecksumError when an applied file changed", async () => {
		const db = await emptyDb();
		const dir = await tempDir({
			"0001_a.sql": "CREATE TABLE mig_a (v int);",
			"0002_b.sql": "CREATE TABLE mig_b (v int);",
		});
		await migrate(db.pool, { dir });
		await writeFile(
			path.join(dir, "0001_a.sql"),
			"CREATE TABLE mig_a (v int, w int);",
		);
		await writeFile(
			path.join(dir, "0003_c.sql"),
			"CREATE TABLE mig_c (v int);",
		);
		const err = await migrate(db.pool, { dir }).catch((e: unknown) => e);
		expect(err).toBeInstanceOf(MigrationChecksumError);
		expect((err as MigrationChecksumError).file).toBe("0001_a.sql");
		// Nothing after the checksum failure is applied.
		const c = await db.pool.query("SELECT to_regclass('public.mig_c') AS t");
		expect(c.rows[0].t).toBeNull();
	});

	it("rejects two files with the same version", async () => {
		const db = await emptyDb();
		const dir = await tempDir({
			"0001_a.sql": "SELECT 1;",
			"0001_b.sql": "SELECT 1;",
		});
		await expect(migrate(db.pool, { dir })).rejects.toThrow(/0001/);
	});

	it("two concurrent runs both succeed and apply each file once", async () => {
		const db = await emptyDb();
		const [a, b] = await Promise.all([migrate(db.pool), migrate(db.pool)]);
		const all = [...a.applied, ...b.applied].sort();
		expect(all).toEqual(realFiles);
		const n = await db.pool.query(
			"SELECT count(*)::int AS n FROM public.umiak_schema_migrations",
		);
		expect(n.rows[0].n).toBe(realFiles.length);
	});

	it("missingMigrations lists unapplied files and ignores unknown newer ones", async () => {
		const db = await emptyDb();
		expect(await missingMigrations(db.pool)).toEqual(realFiles);
		await migrate(db.pool);
		expect(await missingMigrations(db.pool)).toEqual([]);
		await db.pool.query(
			"INSERT INTO public.umiak_schema_migrations (version, name, sha256) VALUES (9999, '9999_future.sql', 'x')",
		);
		expect(await missingMigrations(db.pool)).toEqual([]);
		// Unknown newer migrations do not break migrate either.
		expect((await migrate(db.pool)).applied).toEqual([]);
	});
});

describe.skipIf(skipPg())("createTestDatabase", () => {
	let db: TestDatabase;
	beforeAll(async () => {
		db = await createTestDatabase();
	});
	afterAll(async () => {
		await db?.drop();
	});

	it("returns a migrated database with the tunnel schema", async () => {
		expect(await missingMigrations(db.pool)).toEqual([]);
		const t = await db.pool.query(
			"SELECT to_regclass('tunnel.tunnel_sessions') AS s, to_regclass('runtime.sandboxes') AS r",
		);
		expect(t.rows[0].s).not.toBeNull();
		expect(t.rows[0].r).not.toBeNull();
		expect(db.url).toMatch(/^postgres(ql)?:\/\//);
	});
});
