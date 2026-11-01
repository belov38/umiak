import { mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { MIGRATIONS_DIR, migrate } from "../src/index.ts";
import { createTestDatabase, skipPg } from "../src/testing/index.ts";

async function activeNotifyBodies(pool: import("pg").Pool) {
	return pool.query<{ body: string }>(`SELECT p.prosrc AS body FROM pg_proc p
	 JOIN pg_namespace n ON n.oid=p.pronamespace
	 WHERE n.nspname IN ('runtime','identity') AND p.prosrc LIKE '%pg_notify%'`);
}

describe.skipIf(skipPg())("R1 namespace migration", () => {
	it("fresh databases notify on Umiak channels only", async () => {
		const db = await createTestDatabase();
		try {
			const { rows } = await activeNotifyBodies(db.pool);
			expect(rows.length).toBeGreaterThanOrEqual(6);
			for (const { body } of rows) {
				expect(body).not.toContain("sbx_");
				expect(body).toContain("umiak_");
			}
		} finally {
			await db.drop();
		}
	});

	it("upgrades the old journal without replaying or changing historical checksums", async () => {
		const db = await createTestDatabase({ migrated: false });
		const dir = await mkdtemp(path.join(tmpdir(), "umiak-upgrade-"));
		try {
			for (const name of await readdir(MIGRATIONS_DIR)) {
				if (/^0[1-4]\d\d_.*\.sql$/.test(name)) {
					await writeFile(
						path.join(dir, name),
						await readFile(path.join(MIGRATIONS_DIR, name)),
					);
				}
			}
			await migrate(db.pool, { dir });
			const before = await db.pool.query(
				"SELECT * FROM public.umiak_schema_migrations ORDER BY version",
			);
			await db.pool.query(
				"ALTER TABLE public.umiak_schema_migrations RENAME TO sbx_schema_migrations",
			);
			await db.pool.query(
				"ALTER TABLE public.sbx_schema_migrations RENAME CONSTRAINT umiak_schema_migrations_pkey TO sbx_schema_migrations_pkey",
			);
			const result = await migrate(db.pool);
			expect(result.applied).toEqual(["0500_umiak_names.sql"]);
			const after = await db.pool.query(
				"SELECT * FROM public.umiak_schema_migrations WHERE version < 500 ORDER BY version",
			);
			expect(after.rows).toEqual(before.rows);
			const old = await db.pool.query(
				"SELECT to_regclass('public.sbx_schema_migrations') AS t",
			);
			expect(old.rows[0].t).toBeNull();
			const oldIndex = await db.pool.query(
				"SELECT to_regclass('public.sbx_schema_migrations_pkey') AS t",
			);
			expect(oldIndex.rows[0].t).toBeNull();
			expect((await migrate(db.pool)).applied).toEqual([]);
			for (const { body } of (await activeNotifyBodies(db.pool)).rows)
				expect(body).not.toContain("sbx_");
		} finally {
			await db.drop();
			await rm(dir, { recursive: true });
		}
	});
});
