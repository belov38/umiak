import {
	createTestDatabase,
	skipPg,
	type TestDatabase,
} from "@umiak/db/testing";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { seedRuntimeIdentity } from "../src/runtime-seed.ts";
import {
	runIdentityStoreContract,
	runtimeContractSubject,
} from "./runtime-subject.ts";

describe.skipIf(skipPg())("runtime identity", () => {
	let db: TestDatabase;
	beforeAll(async () => {
		db = await createTestDatabase({ max: 20 });
	});
	afterAll(async () => {
		await db?.drop();
	});
	runIdentityStoreContract("API SQL identity", async () =>
		runtimeContractSubject(db.pool),
	);
	it("merges a never-logged-in email stub without losing its memberships", async () => {
		const store = runtimeContractSubject(db.pool);
		const owner = await store.resolveSession({
			email: "old-owner@example.test",
			user: "rename-owner",
			groups: [],
		});
		const stub = await store.seedUser({ email: "new-owner@example.test" });
		const team = await store.seedTeam("Imported workspace");
		await store.addMember(stub, team, "owner");
		const updated = await store.resolveSession({
			email: "new-owner@example.test",
			user: "rename-owner",
			groups: [],
		});
		expect(updated.user.id).toBe(owner.user.id);
		expect(await store.membership(owner.user.id, team)).toEqual({
			role: "owner",
		});
		expect(await store.user(stub)).toBeNull();
	});
	it("records personal-team ownership and login bookkeeping", async () => {
		const store = runtimeContractSubject(db.pool);
		const session = await store.resolveSession({
			email: "bookkeeping@example.test",
			user: "stable-bookkeeping",
			groups: [],
		});
		const row = (
			await db.pool.query(
				"SELECT personal_team_id,last_login_at FROM runtime.users WHERE id=$1",
				[session.user.id],
			)
		).rows[0];
		expect(row.personal_team_id).toBe(session.defaultTeamId);
		expect(row.last_login_at).toBeInstanceOf(Date);
		const team = (
			await db.pool.query(
				"SELECT created_by_id FROM runtime.teams WHERE id=$1",
				[session.defaultTeamId],
			)
		).rows[0];
		expect(team.created_by_id).toBe(session.user.id);
	});
});

it("bootstrap seeds insert missing rows and preserve imported operator edits", async () => {
	const database = await createTestDatabase();
	const team = "00000000-0000-0000-0000-00000000aaa1",
		user = "00000000-0000-0000-0000-00000000aaa2",
		key = "00000000-0000-0000-0000-00000000aaa3";
	const file = JSON.stringify({
		teams: [{ id: team, name: "Seed team" }],
		users: [
			{
				id: user,
				email: "seed@example.test",
				name: "Seed owner",
				teams: { [team]: "owner" },
			},
		],
		apiKeys: [
			{
				id: key,
				teamId: team,
				name: "Seed key",
				sha256: "a".repeat(64),
				preset: "read-only",
				expiresAt: "2030-01-01T00:00:00Z",
			},
		],
	});
	try {
		expect(await seedRuntimeIdentity(database.pool, file)).toEqual({
			teams: 1,
			users: 1,
			memberships: 1,
			apiKeys: 1,
		});
		await database.pool.query(
			"UPDATE runtime.teams SET name='Operator edit' WHERE id=$1",
			[team],
		);
		await database.pool.query(
			"UPDATE runtime.users SET active=false WHERE id=$1",
			[user],
		);
		await database.pool.query(
			"UPDATE runtime.api_keys SET revoked_at=now() WHERE id=$1",
			[key],
		);
		expect(await seedRuntimeIdentity(database.pool, file)).toEqual({
			teams: 0,
			users: 0,
			memberships: 0,
			apiKeys: 0,
		});
		expect(
			(
				await database.pool.query(
					"SELECT name FROM runtime.teams WHERE id=$1",
					[team],
				)
			).rows[0].name,
		).toBe("Operator edit");
		expect(
			(
				await database.pool.query(
					"SELECT active FROM runtime.users WHERE id=$1",
					[user],
				)
			).rows[0].active,
		).toBe(false);
		expect(
			(
				await database.pool.query(
					"SELECT revoked_at FROM runtime.api_keys WHERE id=$1",
					[key],
				)
			).rows[0].revoked_at,
		).not.toBeNull();
	} finally {
		await database.drop();
	}
});
