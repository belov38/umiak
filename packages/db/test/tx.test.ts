import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createPool, dbOf, schema, withTx } from "../src/index.ts";
import {
	createTestDatabase,
	skipPg,
	type TestDatabase,
} from "../src/testing/index.ts";

const { sandboxEvents } = schema;

describe.skipIf(skipPg())("withTx", () => {
	let t: TestDatabase;
	beforeAll(async () => {
		t = await createTestDatabase();
	});
	afterAll(async () => {
		await t?.drop();
	});

	async function count(sandboxId: string): Promise<number> {
		const rows = await dbOf(t.pool)
			.select()
			.from(sandboxEvents)
			.where(eq(sandboxEvents.sandboxId, sandboxId));
		return rows.length;
	}

	it("commits drizzle and raw client writes together", async () => {
		const sb = randomUUID();
		const res = await withTx(t.pool, async ({ db, client }) => {
			await db.insert(sandboxEvents).values({ sandboxId: sb, type: "a" });
			await client.query(
				"INSERT INTO runtime.sandbox_events (sandbox_id, type) VALUES ($1, 'b')",
				[sb],
			);
			return "ok";
		});
		expect(res).toBe("ok");
		expect(await count(sb)).toBe(2);
	});

	it("rolls back on an exception and rethrows it", async () => {
		const sb = randomUUID();
		const boom = new Error("boom");
		await expect(
			withTx(t.pool, async ({ db, client }) => {
				await db.insert(sandboxEvents).values({ sandboxId: sb, type: "a" });
				await client.query(
					"INSERT INTO runtime.sandbox_events (sandbox_id, type) VALUES ($1, 'b')",
					[sb],
				);
				throw boom;
			}),
		).rejects.toBe(boom);
		expect(await count(sb)).toBe(0);
	});

	it("returns the client to the pool after a failed statement", async () => {
		for (let i = 0; i < 5; i++) {
			await expect(
				withTx(t.pool, async ({ client }) => {
					await client.query("SELECT * FROM no_such_table");
				}),
			).rejects.toThrow(/no_such_table/);
		}
		expect(t.pool.waitingCount).toBe(0);
		expect(await withTx(t.pool, async () => 1)).toBe(1);
	});

	it("maps camelCase fields to snake_case columns", async () => {
		const sb = randomUUID();
		const [row] = await dbOf(t.pool)
			.insert(sandboxEvents)
			.values({ sandboxId: sb, type: "state_changed", fromState: "creating" })
			.returning();
		expect(row?.sandboxId).toBe(sb);
		expect(row?.fromState).toBe("creating");
		expect(row?.createdAt).toBeInstanceOf(Date);
	});
});

describe("createPool", () => {
	it("reports idle client errors to onError and never crashes without it", async () => {
		const seen: string[] = [];
		const pool = createPool("postgres://u:p@127.0.0.1:1/x", 1, {
			onError: (e) => seen.push(e.message),
		});
		pool.emit("error", new Error("connection reset"));
		expect(seen).toEqual(["connection reset"]);
		const quiet = createPool("postgres://u:p@127.0.0.1:1/x", 1);
		expect(() => quiet.emit("error", new Error("x"))).not.toThrow();
		await pool.end();
		await quiet.end();
	});
});
