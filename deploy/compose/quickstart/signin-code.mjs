// Console-only non-destructive sign-in. Run through run.mjs for database credentials.
import { appendFileSync } from "node:fs";
import { hostname } from "node:os";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { OwnerStore, PgOwnerRepository } from "./owner.mjs";

/** With link, the first line is the path form `/signin#<code>` for a one-click link. */
export async function printSigninCode(
	store,
	write = console.log,
	{ link = false } = {},
) {
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
	write(
		link
			? `/signin#${encodeURIComponent(issued.code)}`
			: `One-time owner sign-in code: ${issued.code}`,
	);
	write(
		`Expires: ${new Date(issued.expires).toISOString()}. Existing sessions remain valid.`,
	);
	return issued;
}
export async function runSigninCode(store, write = console.log, options = {}) {
	return (await printSigninCode(store, write, options)) ? 0 : 2;
}

if (
	process.argv[1] &&
	resolve(process.argv[1]) === fileURLToPath(import.meta.url)
) {
	if (process.argv.includes("--help")) {
		console.log(
			"Usage: umiak-signin [--link]\nIssue a one-time owner browser sign-in code. Existing sessions remain valid.\n--link  print the code as the path /signin#<code> for a one-click link",
		);
	} else {
		const { default: pg } = await import("pg");
		const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL });
		try {
			process.exitCode = await runSigninCode(
				new OwnerStore(new PgOwnerRepository(pool), {
					audit: (event) =>
						appendFileSync("/proc/1/fd/1", `${JSON.stringify(event)}\n`),
				}),
				console.log,
				{ link: process.argv.includes("--link") },
			);
		} finally {
			await pool.end();
		}
	}
}
