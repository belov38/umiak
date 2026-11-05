import {
	createTestDatabase,
	skipPg,
	type TestDatabase,
} from "@umiak/db/testing";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
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
