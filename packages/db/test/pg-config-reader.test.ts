import { afterEach, describe, expect, it } from "vitest";
import { PgConfigReader } from "../../config/src/pg-reader.ts";
import {
	createTestDatabase,
	skipPg,
	type TestDatabase,
} from "../src/testing/index.ts";

describe.skipIf(skipPg())("SQL ConfigReader", () => {
	const databases: TestDatabase[] = [];
	afterEach(async () => {
		for (const db of databases.splice(0)) await db.drop();
	});
	async function open() {
		const db = await createTestDatabase();
		databases.push(db);
		return { db, reader: new PgConfigReader({ pool: db.pool }) };
	}
	it("reads numeric sizes, canonical aliases and capability lists", async () => {
		const { reader } = await open();
		expect(await reader.size("4gb")).toEqual({
			slug: "4gb",
			vcpu: 4,
			memoryMb: 4096,
		});
		expect((await reader.template("windows-desktop"))?.slug).toBe("windows");
		expect((await reader.template("windows"))?.capabilities).toContain(
			"desktop",
		);
		const first = await reader.templates();
		first[0]?.allowedSizes.push("poison");
		expect((await reader.templates())[0]?.allowedSizes).not.toContain("poison");
	});
	it("inherits null quota fields and denies missing teams", async () => {
		const { db, reader } = await open();
		const team = (
			await db.pool.query(
				"INSERT INTO runtime.teams(name,quota_max_ram_mb) VALUES('Team',12345) RETURNING id",
			)
		).rows[0].id;
		expect(await reader.teamQuota(team)).toEqual({
			maxActiveSandboxes: 10000,
			maxRamMb: 12345,
			maxSavedSnapshots: 10,
		});
		expect(await reader.teamQuota("not-a-uuid")).toEqual({
			maxActiveSandboxes: 0,
			maxRamMb: 0,
			maxSavedSnapshots: 0,
		});
	});
	it("reads policy defaults fresh even with a long list cache", async () => {
		const { db, reader } = await open();
		expect((await reader.defaults()).publicPortsEnabled).toBe(true);
		await db.pool.query(
			"UPDATE runtime.platform_defaults SET public_ports_enabled=false,stopped_retention_days=NULL",
		);
		expect((await reader.defaults()).publicPortsEnabled).toBe(false);
		expect((await reader.defaults()).stoppedRetentionDays).toBeNull();
	});
});
