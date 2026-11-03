// Local Docker console recovery. Never expose this command through an HTTP route.
import pg from "pg";
import { OwnerStore, PgOwnerRepository } from "./owner.mjs";

const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL });
try {
	const store = new OwnerStore(new PgOwnerRepository(pool));
	console.log(`New one-time owner setup code: ${await store.recover()}`);
	console.log(
		"All previous owner sessions and CLI pairings have been revoked. Claim in the dashboard.",
	);
} finally {
	await pool.end();
}
