import {
	createTestDatabase,
	skipPg,
	type TestDatabase,
} from "@umiak/db/testing";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { PgNotifier, uuidv7 } from "../src/index.ts";
import { expectCode, principal, serviceEnv } from "./helpers/service.ts";
import { insertSandbox } from "./helpers/topology.ts";

const BIG_NODE = { node: { ramCapMb: 1_000_000 } };

describe.skipIf(skipPg())("SandboxService reads and updates", () => {
	let t: TestDatabase;

	beforeAll(async () => {
		t = await createTestDatabase({ max: 20 });
	});
	afterAll(async () => {
		await t?.drop();
	});

	const setState = (id: string, state: string) =>
		t.pool.query("UPDATE runtime.sandboxes SET state = $2 WHERE id = $1", [
			id,
			state,
		]);

	/** The database clock (deadlines are `now()` there, not on this host). */
	const dbNow = async (): Promise<number> =>
		(
			await t.pool.query<{ t: Date }>("SELECT clock_timestamp() AS t")
		).rows[0]?.t.getTime() ?? Number.NaN;

	/**
	 * Runs `fn` between two readings of the database clock and checks that
	 * its deadline is `now() + seconds` of a transaction inside that window.
	 */
	async function expectDeadlineIn<T extends { deadlineAt: Date | null }>(
		seconds: number,
		fn: () => Promise<T>,
	): Promise<T> {
		const before = await dbNow();
		const r = await fn();
		const after = await dbNow();
		const start = (r.deadlineAt?.getTime() ?? 0) - seconds * 1000;
		expect(start).toBeGreaterThanOrEqual(before);
		expect(start).toBeLessThanOrEqual(after);
		return r;
	}

	describe("get", () => {
		it("returns the sandbox with its active operation, by id or slug", async () => {
			const env = await serviceEnv(t.pool);
			const { sandbox, operation } = await env.svc.create(env.p, {});
			const byId = await env.svc.get(env.p, sandbox.id);
			expect(byId.id).toBe(sandbox.id);
			expect(byId.activeOperation?.id).toBe(operation.id);
			expect(byId.createdAt).toBeInstanceOf(Date);
			const bySlug = await env.svc.get(env.p, sandbox.slug);
			expect(bySlug.id).toBe(sandbox.id);
		});

		it("activeOperation is null without an active operation; tombstones are readable", async () => {
			const env = await serviceEnv(t.pool);
			const id = await insertSandbox(t.pool, env.topo, {
				teamId: env.p.teamId,
				state: "deleted",
			});
			const s = await env.svc.get(env.p, id);
			expect(s.state).toBe("deleted");
			expect(s.activeOperation).toBeNull();
		});

		it("another team's sandbox, unknown id and garbage are not_found", async () => {
			const env = await serviceEnv(t.pool);
			const { sandbox } = await env.svc.create(env.p, {});
			await expectCode(env.svc.get(principal(), sandbox.id), "not_found");
			await expectCode(env.svc.get(env.p, uuidv7()), "not_found");
			await expectCode(env.svc.get(env.p, "x"), "not_found");
		});
	});

	describe("getOperation", () => {
		it("returns the team's operation; another team gets not_found", async () => {
			const env = await serviceEnv(t.pool);
			const { operation } = await env.svc.create(env.p, {});
			expect((await env.svc.getOperation(env.p, operation.id)).id).toBe(
				operation.id,
			);
			await expectCode(
				env.svc.getOperation(principal(), operation.id),
				"not_found",
			);
			await expectCode(env.svc.getOperation(env.p, "nope"), "not_found");
		});
	});

	describe("list", () => {
		it("filters, orders newest first and pages with an opaque cursor", async () => {
			const env = await serviceEnv(t.pool, { topology: BIG_NODE });
			const a = await env.svc.create(env.p, {
				name: "alpha-1",
				labels: { env: "ci", run: "1" },
			});
			const b = await env.svc.create(env.p, {
				name: "beta",
				labels: { env: "ci", run: "2" },
			});
			const c = await env.svc.create(env.p, {
				name: "alpha-2",
				labels: { env: "dev" },
			});
			const deleted = await insertSandbox(t.pool, env.topo, {
				teamId: env.p.teamId,
				state: "deleted",
			});
			await setState(b.sandbox.id, "ready");
			// Another team's sandbox never shows up.
			await insertSandbox(t.pool, env.topo, {
				teamId: uuidv7(),
				state: "ready",
			});

			const ids = (page: { data: { id: string }[] }) =>
				page.data.map((s) => s.id);

			const all = await env.svc.list(env.p, {});
			expect(ids(all)).toEqual([c.sandbox.id, b.sandbox.id, a.sandbox.id]);
			expect(all.nextCursor).toBeNull();
			expect(all.data[2]?.activeOperation?.id).toBe(a.operation.id);

			expect(ids(await env.svc.list(env.p, { state: ["deleted"] }))).toEqual([
				deleted,
			]);
			expect(ids(await env.svc.list(env.p, { state: ["ready"] }))).toEqual([
				b.sandbox.id,
			]);
			expect(ids(await env.svc.list(env.p, { labels: { env: "ci" } }))).toEqual(
				[b.sandbox.id, a.sandbox.id],
			);
			expect(
				ids(await env.svc.list(env.p, { labels: { env: "ci", run: "1" } })),
			).toEqual([a.sandbox.id]);
			expect(ids(await env.svc.list(env.p, { q: "alpha" }))).toEqual([
				c.sandbox.id,
				a.sandbox.id,
			]);
			expect(
				ids(await env.svc.list(env.p, { q: b.sandbox.slug.slice(0, 12) })),
			).toContain(b.sandbox.id);
			expect(ids(await env.svc.list(env.p, { q: "%" }))).toEqual([]);
			expect(
				ids(await env.svc.list(env.p, { template: env.template })),
			).toHaveLength(3);
			expect(ids(await env.svc.list(env.p, { template: "other" }))).toEqual([]);

			const p1 = await env.svc.list(env.p, { limit: 2 });
			expect(ids(p1)).toEqual([c.sandbox.id, b.sandbox.id]);
			expect(p1.nextCursor).toEqual(expect.any(String));
			const p2 = await env.svc.list(
				env.p,
				{ limit: 2 },
				p1.nextCursor as string,
			);
			expect(ids(p2)).toEqual([a.sandbox.id]);
			expect(p2.nextCursor).toBeNull();
		});

		it("rejects a bad limit and a bad cursor", async () => {
			const env = await serviceEnv(t.pool);
			await expectCode(env.svc.list(env.p, { limit: 0 }), "validation");
			await expectCode(env.svc.list(env.p, { limit: 201 }), "validation");
			await expectCode(env.svc.list(env.p, {}, "garbage"), "validation");
			await expectCode(
				env.svc.list(env.p, { state: ["nope" as "ready"] }),
				"validation",
			);
		});
	});

	describe("update", () => {
		it("changes name, labels and idle timeout; ttl sets the deadline of a ready sandbox", async () => {
			const env = await serviceEnv(t.pool);
			const { sandbox } = await env.svc.create(env.p, { labels: { a: "1" } });
			const u1 = await env.svc.update(env.p, sandbox.id, {
				name: "renamed",
				labels: { b: "2" },
				idleTimeoutSeconds: 60,
				ttlSeconds: 600,
			});
			expect(u1.name).toBe("renamed");
			expect(u1.labels).toEqual({ b: "2" });
			expect(u1.idleTimeoutSeconds).toBe(60);
			expect(u1.ttlSeconds).toBe(600);
			// Not ready yet: the worker sets the deadline at ready.
			expect(u1.deadlineAt).toBeNull();
			expect(u1.version).toBe(sandbox.version + 1);

			await setState(sandbox.id, "ready");
			await expectDeadlineIn(600, () =>
				env.svc.update(env.p, sandbox.id, { ttlSeconds: 600 }),
			);

			const u3 = await env.svc.update(env.p, sandbox.id, {
				ttlSeconds: null,
				name: null,
			});
			expect(u3.ttlSeconds).toBeNull();
			expect(u3.deadlineAt).toBeNull();
			expect(u3.name).toBeNull();
		});

		it("validates the patch; deleting is invalid_state; another team not_found", async () => {
			const env = await serviceEnv(t.pool, {
				defaults: { maxTtlSeconds: 100 },
			});
			const { sandbox } = await env.svc.create(env.p, {});
			await expectCode(
				env.svc.update(env.p, sandbox.id, { ttlSeconds: 101 }),
				"validation",
			);
			await expectCode(
				env.svc.update(env.p, sandbox.id, {
					slug: "x",
				} as unknown as { name: string }),
				"validation",
			);
			await expectCode(
				env.svc.update(principal(), sandbox.id, { name: "x" }),
				"not_found",
			);
			await env.svc.delete(env.p, sandbox.id);
			await expectCode(
				env.svc.update(env.p, sandbox.id, { name: "x" }),
				"invalid_state",
			);
		});
	});

	describe("extend", () => {
		it("moves the deadline of a ready sandbox to now + ttl", async () => {
			const env = await serviceEnv(t.pool);
			const { sandbox } = await env.svc.create(env.p, { ttlSeconds: 300 });
			await expectCode(env.svc.extend(env.p, sandbox.id), "invalid_state");
			await setState(sandbox.id, "ready");
			await expectDeadlineIn(300, () => env.svc.extend(env.p, sandbox.id));
			const e2 = await expectDeadlineIn(1200, () =>
				env.svc.extend(env.p, sandbox.id, 1200),
			);
			expect(e2.ttlSeconds).toBe(300);
		});

		it("needs a TTL and respects maxTtlSeconds", async () => {
			const env = await serviceEnv(t.pool, {
				defaults: { maxTtlSeconds: 1000 },
			});
			const { sandbox } = await env.svc.create(env.p, {});
			await setState(sandbox.id, "ready");
			await expectCode(env.svc.extend(env.p, sandbox.id), "validation");
			await expectCode(env.svc.extend(env.p, sandbox.id, 1001), "validation");
			await expectCode(
				env.svc.extend(principal(), sandbox.id, 10),
				"not_found",
			);
		});
	});

	describe("waitForState", () => {
		it("resolves on a transition notified through LISTEN umiak_sandboxes", async () => {
			const notifier = new PgNotifier({ connectionString: t.url });
			try {
				// No fallback poll within the test: only the notification (or the
				// 20 s timeout) can end the wait.
				const env = await serviceEnv(t.pool, {
					notifier,
					waitPollMs: 3_600_000,
				});
				const { sandbox } = await env.svc.create(env.p, {});
				const started = Date.now();
				const waiting = env.svc.waitForState(sandbox.id, ["ready"], 20_000);
				setTimeout(() => void setState(sandbox.id, "ready"), 200);
				const s = await waiting;
				expect(s.state).toBe("ready");
				// Well before the timeout: the notification woke it.
				expect(Date.now() - started).toBeLessThan(10_000);
			} finally {
				await notifier.close();
			}
		});

		it("returns at once when already in a wanted state; the current row on timeout", async () => {
			const env = await serviceEnv(t.pool);
			const { sandbox } = await env.svc.create(env.p, {});
			const now = await env.svc.waitForState(sandbox.id, ["creating"], 5000);
			expect(now.state).toBe("creating");
			const started = Date.now();
			const late = await env.svc.waitForState(sandbox.id, ["ready"], 300);
			expect(late.state).toBe("creating");
			expect(Date.now() - started).toBeGreaterThanOrEqual(290);
		});

		it("without a notifier falls back to polling", async () => {
			const env = await serviceEnv(t.pool);
			const { sandbox } = await env.svc.create(env.p, {});
			const waiting = env.svc.waitForState(sandbox.id, ["ready"], 10_000);
			setTimeout(() => void setState(sandbox.id, "ready"), 100);
			expect((await waiting).state).toBe("ready");
		});

		it("an unknown sandbox is not_found", async () => {
			const env = await serviceEnv(t.pool);
			await expectCode(
				env.svc.waitForState(uuidv7(), ["ready"], 100),
				"not_found",
			);
		});
	});
});
