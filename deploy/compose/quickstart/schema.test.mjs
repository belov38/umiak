import assert from "node:assert/strict";
import { readdir, readFile } from "node:fs/promises";
import test from "node:test";
import { PgOwnerRepository } from "./owner.mjs";
import { PgPlatformUpdates } from "./platform-updates.mjs";
import { PgSetupStore } from "./setup.mjs";

test("startup bootstraps only missing singleton rows without DDL", async () => {
	const queries = [];
	const pool = {
		async query(sql, args) {
			assert.doesNotMatch(sql, /\b(CREATE|ALTER|DROP|TRUNCATE)\b/i);
			queries.push({ sql, args });
			return { rows: [] };
		},
	};
	await new PgOwnerRepository(pool).init();
	await new PgSetupStore(pool).init();
	await new PgPlatformUpdates(pool, {}).init();
	assert.equal(queries.length, 2);
	assert.match(
		queries[0].sql,
		/INSERT INTO quickstart.owner.*ON CONFLICT DO NOTHING/,
	);
	assert.equal(queries[0].args[0].claimed, false);
	assert.match(
		queries[1].sql,
		/INSERT INTO quickstart.setup.*ON CONFLICT DO NOTHING/,
	);
});

test("quickstart runtime contains no schema DDL", async () => {
	for (const name of await readdir(new URL(".", import.meta.url))) {
		if (!name.endsWith(".mjs") || name.includes("test")) continue;
		const source = await readFile(new URL(name, import.meta.url), "utf8");
		assert.doesNotMatch(
			source,
			/\b(?:CREATE\s+(?:TABLE|SCHEMA)|ALTER\s+TABLE)\b/i,
			name,
		);
	}
});

test("compose quickstart waits for successful SQL migrations directly", async () => {
	const compose = await readFile(
		new URL("../../../compose.yaml", import.meta.url),
		"utf8",
	);
	const quickstart = compose
		.split("\n  quickstart:\n")[1]
		.split("\nvolumes:")[0];
	assert.match(
		quickstart,
		/depends_on:\n\s+migrate: \{ condition: service_completed_successfully \}/,
	);
});
