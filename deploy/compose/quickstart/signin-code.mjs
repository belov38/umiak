// Console-only non-destructive sign-in. Run through run.mjs for database credentials.
import { appendFileSync } from "node:fs";
import { hostname } from "node:os";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { OwnerStore, PgOwnerRepository } from "./owner.mjs";

export async function printSigninCode(store, write = console.log) {
	let issued;
	try {
		issued = await store.signinCode({
			source: "console",
			hostname: hostname(),
			issuer: "console",
		});
	} catch (error) {
		if (error.message !== "signin_limited") throw error;
		write(
			"10 sign-in codes are already outstanding. Wait for one to expire (up to 10 minutes) or use an existing code.",
		);
		return null;
	}
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
	if (process.argv.includes("--help")) {
		console.log(
			"Usage: umiak-signin\nIssue a one-time owner browser sign-in code. Existing sessions remain valid.",
		);
	} else {
		const { default: pg } = await import("pg");
		const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL });
		try {
			await printSigninCode(
				new OwnerStore(new PgOwnerRepository(pool), {
					audit: (event) =>
						appendFileSync("/proc/1/fd/1", `${JSON.stringify(event)}\n`),
				}),
			);
		} finally {
			await pool.end();
		}
	}
}
