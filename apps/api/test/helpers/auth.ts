// Postgres-backed identity for auth tests: the PgIdentityStore of @sbx/auth,
// its seeding helpers and a live `sbx_identity` listener.
import { randomUUID } from "node:crypto";
import { PgIdentityStore } from "@sbx/auth";
import { pgIdentitySeeding } from "@sbx/auth/testing";
import { createTestDatabase, type TestDatabase } from "@sbx/db/testing";
import { IdentityListener } from "../../src/index.ts";

export const OPERATOR_GROUP = "sbx-operators";

export interface IdentityWorld {
	db: TestDatabase;
	identity: PgIdentityStore;
	seed: ReturnType<typeof pgIdentitySeeding>;
	events: IdentityListener;
	/** A fresh team with a unique name. */
	team(): Promise<string>;
	close(): Promise<void>;
}

export async function identityWorld(): Promise<IdentityWorld> {
	const db = await createTestDatabase({ max: 20 });
	const identity = new PgIdentityStore({
		pool: db.pool,
		operatorGroups: [OPERATOR_GROUP],
	});
	const seed = pgIdentitySeeding(db.pool);
	const events = IdentityListener.connect(db.url, { reconnectDelayMs: 50 });
	events.start();
	await events.whenReady();
	return {
		db,
		identity,
		seed,
		events,
		team: () => seed.seedTeam(`team-${randomUUID()}`),
		async close() {
			await events.close();
			await db.drop();
		},
	};
}

/** Retries `fn` every 25 ms until it returns true or `ms` pass. */
export async function eventually(
	fn: () => Promise<boolean>,
	ms = 1000,
): Promise<number> {
	const start = Date.now();
	for (;;) {
		if (await fn()) return Date.now() - start;
		if (Date.now() - start > ms) throw new Error(`not within ${ms} ms`);
		await new Promise((r) => setTimeout(r, 25));
	}
}

export function uniqueEmail(): string {
	return `u-${randomUUID()}@example.com`;
}
