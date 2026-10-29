// TEMPORARY (decision 16): stand-in for S2's tunnel schema migration until S2
// is merged into main. Remove this file, the fixture and the callers
// (`sbx-admin migrate --tunnel-fixture`, the test database helper) after the
// S2 merge.
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import type pg from "pg";

/** Copy of S2's 0100_tunnel_init.sql, applied only when schema tunnel is missing. */
export const TUNNEL_FIXTURE: string = fileURLToPath(
	new URL("../test/fixtures/0100_tunnel_init.sql", import.meta.url),
);

/**
 * Applies the tunnel fixture in one transaction unless schema `tunnel` exists.
 * Returns true when the fixture was applied.
 */
export async function applyTunnelFixture(pool: pg.Pool): Promise<boolean> {
	const t = await pool.query<{ n: string | null }>(
		"SELECT to_regnamespace('tunnel')::text AS n",
	);
	if (t.rows[0]?.n != null) return false;
	const sql = await readFile(TUNNEL_FIXTURE, "utf8");
	const c = await pool.connect();
	try {
		await c.query("BEGIN");
		await c.query(sql);
		await c.query("COMMIT");
	} catch (err) {
		await c.query("ROLLBACK").catch(() => {});
		throw err;
	} finally {
		c.release();
	}
	return true;
}
