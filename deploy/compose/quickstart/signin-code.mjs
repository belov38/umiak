// Console-only non-destructive sign-in. Run through run.mjs for database credentials.
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { OwnerStore, PgOwnerRepository } from "./owner.mjs";

export async function printSigninCode(store, write = console.log) {
	const issued = await store.signinCode();
	write(`One-time owner sign-in code: ${issued.code}`);
	write(
		`Expires: ${new Date(issued.expires).toISOString()}. Existing sessions remain valid.`,
	);
	return issued;
}
if (
	process.argv[1] &&
	resolve(process.argv[1]) === fileURLToPath(import.meta.url)
) {
	const { default: pg } = await import("pg");
	const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL });
	try {
		await printSigninCode(new OwnerStore(new PgOwnerRepository(pool)));
	} finally {
		await pool.end();
	}
}
