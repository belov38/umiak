import { randomBytes, randomUUID } from "node:crypto";
import {
	createTestDatabase,
	skipPg,
	type TestDatabase,
} from "@umiak/db/testing";
import type { Payload } from "payload";
import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
	authenticateRequest,
	closeUmiakPayload,
	flushesSessions,
	getUmiakPayload,
	migrateUmiakPayload,
	SESSION_LISTENER_APPLICATION_NAME,
	SessionCache,
	sessionCacheKey,
	sessionCacheOf,
} from "../src/index.ts";
import { testOptions } from "./helpers.ts";

describe("SessionCache", () => {
	it("keeps a value for ttlMs", async () => {
		let now = 1_000;
		const c = new SessionCache<number>({ ttlMs: 100, now: () => now });
		let n = 0;
		const load = async () => ++n;
		expect(await c.load("k", load)).toBe(1);
		now += 99;
		expect(await c.load("k", load)).toBe(1);
		now += 1;
		expect(await c.load("k", load)).toBe(2);
	});

	it("flush drops everything", async () => {
		const c = new SessionCache<number>();
		let n = 0;
		await c.load("k", async () => ++n);
		c.flush();
		expect(await c.load("k", async () => ++n)).toBe(2);
	});

	it("a load that spans a flush is returned but not stored", async () => {
		const c = new SessionCache<string>();
		let release!: (v: string) => void;
		const slow = c.load("k", () => new Promise((r) => (release = r)));
		c.flush();
		release("old");
		expect(await slow).toBe("old");
		expect(c.size).toBe(0);
		expect(await c.load("k", async () => "new")).toBe("new");
	});

	it("concurrent loads of a key share one call", async () => {
		const c = new SessionCache<number>();
		let calls = 0;
		const load = async () => {
			calls++;
			await new Promise((r) => setTimeout(r, 10));
			return calls;
		};
		const all = await Promise.all([1, 2, 3].map(() => c.load("k", load)));
		expect(all).toEqual([1, 1, 1]);
		expect(calls).toBe(1);
	});

	it("does not store failures or values refused by keep", async () => {
		const c = new SessionCache<string>();
		await expect(
			c.load("k", async () => {
				throw new Error("db down");
			}),
		).rejects.toThrow("db down");
		expect(
			await c.load(
				"k",
				async () => "denied",
				(v) => v !== "denied",
			),
		).toBe("denied");
		expect(c.size).toBe(0);
		expect(await c.load("k", async () => "ok")).toBe("ok");
		expect(c.size).toBe(1);
	});

	it("key: group order and repeats do not matter; email, sub and groups do", () => {
		const base = { email: "a@b.com", user: "s", groups: ["x", "y"] };
		const k = sessionCacheKey(base);
		expect(sessionCacheKey({ ...base, groups: ["y", "x", "y"] })).toBe(k);
		expect(sessionCacheKey({ ...base, email: "c@b.com" })).not.toBe(k);
		expect(sessionCacheKey({ ...base, user: "t" })).not.toBe(k);
		expect(sessionCacheKey({ ...base, groups: ["x"] })).not.toBe(k);
		expect(k).toMatch(/^[0-9a-f]{64}$/);
	});

	it("umiak_identity payloads that flush", () => {
		expect(flushesSessions(null)).toBe(true);
		expect(flushesSessions("*")).toBe(true);
		expect(flushesSessions("users:1")).toBe(true);
		expect(flushesSessions("teams:1")).toBe(true);
		expect(flushesSessions("memberships:1:2")).toBe(true);
		// Operator blocks and key changes are not session changes.
		expect(flushesSessions("sandboxes:1")).toBe(false);
		expect(flushesSessions("api-keys:1")).toBe(false);
		expect(flushesSessions("ssh-keys:1")).toBe(false);
	});
});

describe.skipIf(skipPg())(
	"session cache on a Payload instance (decision 8)",
	() => {
		let t: TestDatabase;
		let payload: Payload;
		let plain: Payload;
		let plainDb: TestDatabase;

		const headers = (e: string, sub: string) =>
			new Headers({
				"x-auth-request-email": e,
				"x-umiak-client-ip": "127.0.0.1",
				"x-auth-request-user": sub,
				"x-auth-request-groups": "devs",
			});

		const _notify = (payloadText: string) =>
			t.pool.query("SELECT pg_notify('umiak_identity', $1)", [payloadText]);

		/** Waits until the cache is flushed (the notification went through LISTEN). */
		async function flushed(): Promise<void> {
			const c = sessionCacheOf(payload);
			for (let i = 0; i < 200 && (c?.size ?? 0) > 0; i++) {
				await new Promise((r) => setTimeout(r, 10));
			}
			expect(c?.size).toBe(0);
		}

		beforeAll(async () => {
			process.env.UMIAK_LOCAL_ALLOWED_CIDRS = "127.0.0.0/8";
			t = await createTestDatabase({ migrated: false, max: 4 });
			payload = await getUmiakPayload({
				...testOptions(t.url),
				poolMax: 6,
				sessionCache: {},
			});
			await migrateUmiakPayload(payload);
			plainDb = await createTestDatabase({ migrated: false, max: 2 });
			plain = await getUmiakPayload({
				...testOptions(plainDb.url),
				poolMax: 4,
			});
		});
		afterAll(async () => {
			if (t) await closeUmiakPayload(t.url);
			if (plainDb) await closeUmiakPayload(plainDb.url);
			await t?.drop();
			await plainDb?.drop();
		});

		it("is attached in onInit with one LISTEN connection; not without the option", async () => {
			expect(sessionCacheOf(payload)).not.toBe(null);
			expect(sessionCacheOf(plain)).toBe(null);
			const r = await t.pool.query<{ n: string }>(
				"SELECT count(*) AS n FROM pg_stat_activity WHERE application_name = $1 AND datname = current_database()",
				[SESSION_LISTENER_APPLICATION_NAME],
			);
			expect(Number(r.rows[0]?.n)).toBe(1);
		});

		it("a deactivation through Payload logs the user out of /admin and /app at once", async () => {
			const e = `d-${randomBytes(5).toString("hex")}@example.com`;
			const h = headers(e, randomUUID());
			const first = await authenticateRequest(payload, h);
			if (first.kind !== "session") throw new Error(first.kind);
			expect((await payload.auth({ headers: h })).user).not.toBe(null);
			await payload.update({
				collection: "users",
				id: first.session.user.id,
				data: { active: false, deactivatedReason: "operator" },
			});
			await flushed();
			expect(await authenticateRequest(payload, h)).toEqual({
				kind: "denied",
				status: 403,
				reason: "user_disabled",
			});
			expect((await payload.auth({ headers: h })).user).toBe(null);
		});

		it("without headers: anonymous, nothing cached", async () => {
			const before = sessionCacheOf(payload)?.size;
			expect(await authenticateRequest(payload, new Headers())).toEqual({
				kind: "denied",
				status: 403,
				reason: "client_network_forbidden",
			});
			expect(sessionCacheOf(payload)?.size).toBe(before);
		});

		it("closing the instance closes the listener", async () => {
			const db = await createTestDatabase({ migrated: false, max: 2 });
			try {
				const p = await getUmiakPayload({
					...testOptions(db.url),
					poolMax: 4,
					sessionCache: {},
				});
				await closeUmiakPayload(db.url);
				expect(sessionCacheOf(p)).toBe(null);
				const c = new pg.Client({ connectionString: db.url });
				await c.connect();
				try {
					for (let i = 0; i < 100; i++) {
						const r = await c.query<{ n: string }>(
							"SELECT count(*) AS n FROM pg_stat_activity WHERE application_name = $1 AND datname = current_database()",
							[SESSION_LISTENER_APPLICATION_NAME],
						);
						if (Number(r.rows[0]?.n) === 0) return;
						await new Promise((r) => setTimeout(r, 20));
					}
					throw new Error("listener connection still open");
				} finally {
					await c.end();
				}
			} finally {
				await db.drop();
			}
		});
	},
);
