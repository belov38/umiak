import { createTestDatabase } from "@umiak/db/testing";
import { expect, it } from "vitest";

it("serializes concurrent claims and pair delivery in Postgres and preserves owner after restart", async () => {
	const database = await createTestDatabase({ migrated: false });
	const moduleUrl = new URL(
		"../../../deploy/compose/quickstart/owner.mjs",
		import.meta.url,
	).href;
	const { OwnerStore, PgOwnerRepository } = await import(moduleUrl);
	try {
		const store = new OwnerStore(new PgOwnerRepository(database.pool));
		const code = await store.init();
		const attempts = await Promise.allSettled(
			Array.from({ length: 10 }, () => store.claim(code)),
		);
		expect(attempts.filter((item) => item.status === "fulfilled")).toHaveLength(
			1,
		);
		const success = attempts.find((item) => item.status === "fulfilled");
		if (success?.status !== "fulfilled")
			throw new Error("Claim did not succeed");
		const token = success.value;
		const restarted = new OwnerStore(new PgOwnerRepository(database.pool));
		expect(await restarted.init()).toBeNull();
		expect(await restarted.authenticate(token)).toBe(true);
		const state = await database.pool.query(
			"SELECT state FROM quickstart.owner",
		);
		expect(JSON.stringify(state.rows)).not.toContain(token);
		expect(JSON.stringify(state.rows)).not.toContain(code);
		await expect(restarted.claim(code)).rejects.toThrow("invalid_claim");
		const pair = await restarted.pairStart();
		await restarted.pairApprove(pair.id, pair.code);
		const polls = await Promise.allSettled([
			store.pairPoll(pair.id, pair.secret),
			restarted.pairPoll(pair.id, pair.secret),
		]);
		expect(polls.filter((item) => item.status === "fulfilled")).toHaveLength(1);
		await restarted.revoke(token);
		expect(await store.authenticate(token)).toBe(false);
	} finally {
		await database.drop();
	}
});
