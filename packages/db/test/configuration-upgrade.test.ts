import { readFile } from "node:fs/promises";
import { afterEach, describe, expect, it } from "vitest";
import { migrate } from "../src/migrate.ts";
import {
	createTestDatabase,
	skipPg,
	type TestDatabase,
} from "../src/testing/index.ts";

describe.skipIf(skipPg())("API configuration cutover", () => {
	const databases: TestDatabase[] = [];
	afterEach(async () => {
		for (const db of databases.splice(0)) await db.drop();
	});
	async function database() {
		const db = await createTestDatabase();
		databases.push(db);
		return db;
	}
	async function legacy(db: TestDatabase) {
		await db.pool.query(
			"DELETE FROM public.umiak_schema_migrations WHERE version >= 800 AND version < 900",
		);
		for (const table of [
			"users",
			"teams",
			"memberships",
			"api_keys",
			"ssh_keys",
			"templates",
			"sizes",
			"platform_defaults",
		]) {
			await db.pool.query(`DROP TABLE IF EXISTS runtime.${table} CASCADE`);
		}
		await db.pool.query(
			await readFile(
				new URL("./fixtures/payload-owner.sql", import.meta.url),
				"utf8",
			),
		);
	}
	it("imports owner IDs, nullable revoked-key audit, edited catalog and null defaults exactly once", async () => {
		const db = await database();
		// The template DB already applies new migrations. Remove their journal entries
		// and empty targets to model a pre-cutover install with legacy source data.
		await legacy(db);
		await db.pool.query(`
INSERT INTO payload.users(id,email,idp_subject,active) VALUES('00000000-0000-0000-0000-000000000001','owner@example.test','owner-stable',true);
INSERT INTO payload.teams(id,name,personal,created_by_id,quota_max_ram_mb) VALUES('00000000-0000-0000-0000-000000000002','My workspace',true,'00000000-0000-0000-0000-000000000001',12345);
UPDATE payload.users SET personal_team_id='00000000-0000-0000-0000-000000000002';
UPDATE payload.users SET default_team_id=personal_team_id;
INSERT INTO payload.memberships(id,user_id,team_id,role) VALUES('00000000-0000-0000-0000-000000000003','00000000-0000-0000-0000-000000000001','00000000-0000-0000-0000-000000000002','owner');
INSERT INTO payload.api_keys(id,name,team_id,kind,secret_hash,prefix,last4,scopes,expires_at,created_via,revoked_at,revoked_by_key_id)
 VALUES('00000000-0000-0000-0000-000000000004','Audit key',NULL,'team',repeat('a',64),'umiak_','abcd','["sandbox:read"]',now()+interval '1 day','api',now(),'00000000-0000-0000-0000-000000000004');
INSERT INTO payload.sizes(id,slug,vcpu,memory_mb) VALUES(uuidv7(),'custom',3,3456);
INSERT INTO payload.templates(id,slug,name,description,os,enabled,default_size,allowed_sizes,capabilities)
 VALUES(uuidv7(),'linux','Operator edit','Keep this description','linux',false,'custom','["custom"]','["exec","files","ssh"]');
INSERT INTO payload.pool_targets(id,template,size,target) VALUES(uuidv7(),'linux','custom',0);
INSERT INTO payload.ssh_keys(id,user_id,name,public_key,fingerprint,type)
 VALUES(uuidv7(),'00000000-0000-0000-0000-000000000001','Owner key','ssh-ed25519 synthetic','SHA256:synthetic','ed25519');
INSERT INTO payload.platform_defaults(id,stopped_retention_days,default_template,default_quota_max_ram_mb) VALUES(uuidv7(),NULL,'linux',12345);
`);
		await migrate(db.pool);
		for (const table of [
			"users",
			"teams",
			"memberships",
			"api_keys",
			"ssh_keys",
			"templates",
			"sizes",
			"platform_defaults",
		]) {
			const source = await db.pool.query(
				`SELECT to_jsonb(t) AS row FROM payload.${table} t ORDER BY id`,
			);
			const target = await db.pool.query(
				`SELECT to_jsonb(t) AS row FROM runtime.${table} t ORDER BY id`,
			);
			expect(target.rows, table).toEqual(source.rows);
		}
		expect((await migrate(db.pool)).applied).toEqual([]);
	});
	it("seeds only fresh installs", async () => {
		const db = await database();
		expect(
			(
				await db.pool.query(
					"SELECT slug FROM runtime.templates ORDER BY sort_order",
				)
			).rows.map((r) => r.slug),
		).toEqual(["linux", "windows", "linux-desktop"]);
		expect(
			(
				await db.pool.query(
					"SELECT stopped_retention_days FROM runtime.platform_defaults",
				)
			).rows,
		).toEqual([{ stopped_retention_days: "1" }]);
	});
	it("rejects incomplete legacy schema rather than seeding over it", async () => {
		const db = await database();
		await legacy(db);
		await db.pool.query("DROP TABLE payload.ssh_keys");
		await expect(migrate(db.pool)).rejects.toThrow("incomplete Payload schema");
		expect(
			(await db.pool.query("SELECT count(*) FROM runtime.templates")).rows[0]
				.count,
		).toBe("0");
		expect(
			(
				await db.pool.query(
					"SELECT 1 FROM public.umiak_schema_migrations WHERE version=801",
				)
			).rowCount,
		).toBe(0);
	});
	it("rolls back copied rows when a source relationship is invalid", async () => {
		const db = await database();
		await legacy(db);
		await db.pool.query(
			"INSERT INTO payload.platform_defaults(id) VALUES(uuidv7()); INSERT INTO payload.users(id,email,default_team_id) VALUES(uuidv7(),'bad@example.test',uuidv7())",
		);
		await expect(migrate(db.pool)).rejects.toThrow("foreign key");
		expect(
			(await db.pool.query("SELECT count(*) FROM runtime.users")).rows[0].count,
		).toBe("0");
		expect(
			(await db.pool.query("SELECT count(*) FROM payload.users")).rows[0].count,
		).toBe("1");
	});
	it("applies pending Debian deferral without overwriting other edits", async () => {
		const db = await database();
		await legacy(db);
		await db.pool.query(`INSERT INTO payload.platform_defaults(id,default_template) VALUES(uuidv7(),'debian');
INSERT INTO payload.sizes(id,slug,vcpu,memory_mb) VALUES(uuidv7(),'edited',5,5120);
INSERT INTO payload.templates(id,slug,name,os,default_size,allowed_sizes) VALUES(uuidv7(),'debian','Debian','linux','edited','["edited"]'),(uuidv7(),'linux','Keep edit','linux','edited','["edited"]');
INSERT INTO payload.pool_targets(id,template,size,target) VALUES(uuidv7(),'debian','edited',0);`);
		await migrate(db.pool);
		expect(
			(await db.pool.query("SELECT slug,name FROM runtime.templates")).rows,
		).toEqual([{ slug: "linux", name: "Keep edit" }]);
		expect(
			(
				await db.pool.query(
					"SELECT default_template FROM runtime.platform_defaults",
				)
			).rows[0].default_template,
		).toBe("linux");
	});
});
