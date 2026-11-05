import { readFile } from "node:fs/promises";
import { afterEach, describe, expect, it } from "vitest";
import { migrate } from "../src/migrate.ts";
import {
	createTestDatabase,
	skipPg,
	type TestDatabase,
} from "../src/testing/index.ts";

// Verbatim historical DDL: 40762650/5886dc8c, 7b96c611/ce326fa3, b4eb6a23.
// Git history contains no later column changes.
const legacy = {
	owner: `CREATE TABLE IF NOT EXISTS quickstart.owner (id integer PRIMARY KEY CHECK(id=1),state jsonb NOT NULL)`,
	setup: `CREATE TABLE IF NOT EXISTS quickstart.setup (id boolean PRIMARY KEY DEFAULT true CHECK(id),state jsonb NOT NULL DEFAULT '{"steps":{},"complete":false}')`,
	updates: `CREATE TABLE IF NOT EXISTS quickstart.updates(id boolean PRIMARY KEY DEFAULT true CHECK(id), settings jsonb NOT NULL, status jsonb NOT NULL DEFAULT '{}', history jsonb NOT NULL DEFAULT '[]')`,
};
const owner = {
	claimed: true,
	claim: null,
	sessions: {
		browser: 1999999999999,
		cli: { expires: 1999999999999, kind: "cli" },
	},
	pairs: {
		pending: { approved: false, secret: "hash", expires: 1999999999999 },
	},
	signins: { pending: { attempts: 2 } },
	unknownFutureField: [null, false, "keep"],
};
const setup = {
	steps: {
		host: { status: "ready", data: { tokenFile: "/pve-secrets/token" } },
	},
	complete: true,
	platform: { channel: "edge" },
	builds: [{ id: "unfinished", status: "running" }],
};
const updates = {
	settings: {
		channel: "edge",
		auto: true,
		paused: true,
		start: "23:00",
		end: "02:00",
	},
	status: { phase: "rolled-back", backup: "backup-id" },
	history: [{ from: "1.0.0", to: "1.0.1", result: "failed", dataLoss: false }],
};
const migrationSql = await readFile(
	new URL("../../../db/migrations/0900_quickstart.sql", import.meta.url),
	"utf8",
);
const runtime = new URL("../../../deploy/compose/quickstart/", import.meta.url);
const { PgOwnerRepository } = await import(new URL("owner.mjs", runtime).href);
const { PgSetupStore } = await import(new URL("setup.mjs", runtime).href);
const { PgPlatformUpdates } = await import(
	new URL("platform-updates.mjs", runtime).href
);

describe.skipIf(skipPg())("quickstart SQL adoption", () => {
	let db: TestDatabase | undefined;
	afterEach(async () => {
		await db?.drop();
		db = undefined;
	});

	// All historical release stages, plus every partial initialization.
	it.each(Array.from({ length: 8 }, (_, mask) => mask))(
		"adopts historical tables (presence mask %i) without changing JSON",
		async (mask) => {
			db = await createTestDatabase({ migrated: false });
			await db.pool.query("CREATE SCHEMA IF NOT EXISTS quickstart");
			const names = ["owner", "setup", "updates"] as const;
			for (const [index, name] of names.entries()) {
				if (!(mask & (1 << index))) continue;
				await db.pool.query(legacy[name]);
				if (name === "updates") {
					await db.pool.query(
						"INSERT INTO quickstart.updates VALUES(true,$1,$2,$3)",
						[updates.settings, updates.status, JSON.stringify(updates.history)],
					);
				} else {
					await db.pool.query(`INSERT INTO quickstart.${name} VALUES($1,$2)`, [
						name === "owner" ? 1 : true,
						name === "owner" ? owner : setup,
					]);
				}
			}
			expect((await migrate(db.pool)).applied).toContain("0900_quickstart.sql");
			expect((await migrate(db.pool)).applied).toEqual([]);
			// Replay the SQL itself independently of the journal.
			await db.pool.query(migrationSql);
			for (const [index, name] of names.entries()) {
				const rows = (await db.pool.query(`SELECT * FROM quickstart.${name}`))
					.rows;
				expect(rows).toEqual(
					mask & (1 << index)
						? [
								name === "updates"
									? { id: true, ...updates }
									: {
											id: name === "owner" ? 1 : true,
											state: name === "owner" ? owner : setup,
										},
							]
						: [],
				);
			}
			const setupStore = new PgSetupStore(db.pool);
			for (let n = 0; n < 2; n++) {
				await new PgOwnerRepository(db.pool).init();
				await setupStore.init();
				await new PgPlatformUpdates(db.pool, setupStore).init();
			}
			const expectedOwner =
				mask & 1
					? owner
					: {
							claimed: false,
							claim: null,
							sessions: {},
							pairs: {},
							signins: {},
						};
			expect(
				(await db.pool.query("SELECT state FROM quickstart.owner")).rows,
			).toEqual([{ state: expectedOwner }]);
			const expectedSetup = mask & 2 ? setup : { steps: {}, complete: false };
			expect(await setupStore.read()).toEqual(expectedSetup);
			const policy = new PgPlatformUpdates(db.pool, setupStore);
			const expected =
				mask & 4
					? updates
					: {
							settings: {
								channel: mask & 2 ? "edge" : "stable",
								auto: false,
								paused: false,
								start: "03:00",
								end: "04:00",
							},
							status: {},
							history: [],
						};
			expect(await policy.read()).toEqual(expected);
			// S22 rollback: previous runtime startup DDL and inserts still work.
			for (const sql of Object.values(legacy)) await db.pool.query(sql);
			await db.pool.query(
				"INSERT INTO quickstart.owner VALUES(1,$1) ON CONFLICT DO NOTHING",
				[{ claimed: false }],
			);
			await db.pool.query(
				"INSERT INTO quickstart.setup(id) VALUES(true) ON CONFLICT DO NOTHING",
			);
			expect(await policy.read()).toEqual(expected);
			expect(await setupStore.read()).toEqual(expectedSetup);
			expect(
				(await db.pool.query("SELECT state FROM quickstart.owner")).rows,
			).toEqual([{ state: expectedOwner }]);
		},
	);

	it("creates an absent schema with historical defaults and singleton constraints", async () => {
		db = await createTestDatabase({ migrated: false });
		await migrate(db.pool);
		await db.pool.query("INSERT INTO quickstart.setup DEFAULT VALUES");
		expect(
			(await db.pool.query("SELECT * FROM quickstart.setup")).rows,
		).toEqual([{ id: true, state: { steps: {}, complete: false } }]);
		await db.pool.query("INSERT INTO quickstart.updates(settings) VALUES($1)", [
			updates.settings,
		]);
		expect(
			(await db.pool.query("SELECT * FROM quickstart.updates")).rows,
		).toEqual([
			{ id: true, settings: updates.settings, status: {}, history: [] },
		]);
		await expect(
			db.pool.query("INSERT INTO quickstart.owner VALUES(2, '{}')"),
		).rejects.toThrow(/check constraint/);
		await expect(
			db.pool.query("INSERT INTO quickstart.setup(id) VALUES(false)"),
		).rejects.toThrow(/check constraint/);
		await expect(
			db.pool.query(
				"INSERT INTO quickstart.updates(id,settings) VALUES(false,'{}')",
			),
		).rejects.toThrow(/check constraint/);
	});
});
