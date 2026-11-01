import { withTx } from "@umiak/db";
import {
	createTestDatabase,
	skipPg,
	type TestDatabase,
} from "@umiak/db/testing";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
	claimIdempotencyKey,
	IDEMPOTENCY_TTL_SECONDS,
	requestHash,
	uuidv7,
} from "../src/index.ts";
import {
	expectCode,
	idempotencyRows,
	serviceEnv,
	teamRowCounts,
	testKeys,
} from "./helpers/service.ts";
import { insertMachine } from "./helpers/topology.ts";

describe.skipIf(skipPg())("idempotency (S6 §14.1, S7 §5.7)", () => {
	let t: TestDatabase;

	beforeAll(async () => {
		t = await createTestDatabase({ max: 20 });
	});
	afterAll(async () => {
		await t?.drop();
	});

	describe("claimIdempotencyKey", () => {
		const keys = testKeys();
		const base = () => ({
			principalId: uuidv7(),
			scope: "sandboxes.create",
			key: "k",
			requestHash: requestHash(keys, "sandboxes.create", { a: 1 }),
			sandboxId: uuidv7(),
			operationId: uuidv7(),
		});

		it("new key is stored with ids-only response and a 24 h expiry", async () => {
			const input = base();
			const r = await withTx(t.pool, (tx) => claimIdempotencyKey(tx, input));
			expect(r).toEqual({ kind: "new" });
			const row = await t.pool.query(
				`SELECT sandbox_id, operation_id, response,
				        extract(epoch FROM expires_at - created_at)::int AS ttl
				 FROM runtime.idempotency_keys WHERE principal_id = $1`,
				[input.principalId],
			);
			expect(row.rows[0]).toEqual({
				sandbox_id: input.sandboxId,
				operation_id: input.operationId,
				response: {
					sandboxId: input.sandboxId,
					operationId: input.operationId,
				},
				ttl: IDEMPOTENCY_TTL_SECONDS,
			});
		});

		it("same hash replays stored ids; another hash is idempotency_key_reused", async () => {
			const input = base();
			await withTx(t.pool, (tx) => claimIdempotencyKey(tx, input));
			const again = await withTx(t.pool, (tx) =>
				claimIdempotencyKey(tx, {
					...input,
					sandboxId: uuidv7(),
					operationId: uuidv7(),
				}),
			);
			expect(again).toEqual({
				kind: "replay",
				sandboxId: input.sandboxId,
				operationId: input.operationId,
				response: {
					sandboxId: input.sandboxId,
					operationId: input.operationId,
				},
			});
			await expectCode(
				withTx(t.pool, (tx) =>
					claimIdempotencyKey(tx, {
						...input,
						requestHash: requestHash(keys, "sandboxes.create", { a: 2 }),
					}),
				),
				"idempotency_key_reused",
			);
		});

		it("an expired key is treated as absent", async () => {
			const input = base();
			await withTx(t.pool, (tx) => claimIdempotencyKey(tx, input));
			await t.pool.query(
				"UPDATE runtime.idempotency_keys SET expires_at = now() - interval '1 s' WHERE principal_id = $1",
				[input.principalId],
			);
			const fresh = {
				...input,
				requestHash: requestHash(keys, "sandboxes.create", { other: true }),
				sandboxId: uuidv7(),
			};
			const r = await withTx(t.pool, (tx) => claimIdempotencyKey(tx, fresh));
			expect(r).toEqual({ kind: "new" });
			const row = await t.pool.query(
				"SELECT sandbox_id FROM runtime.idempotency_keys WHERE principal_id = $1",
				[input.principalId],
			);
			expect(row.rows).toEqual([{ sandbox_id: fresh.sandboxId }]);
		});

		it("scopes and principals are separate namespaces", async () => {
			const input = base();
			await withTx(t.pool, (tx) => claimIdempotencyKey(tx, input));
			const r1 = await withTx(t.pool, (tx) =>
				claimIdempotencyKey(tx, { ...input, scope: "sandboxes.fork" }),
			);
			const r2 = await withTx(t.pool, (tx) =>
				claimIdempotencyKey(tx, { ...input, principalId: uuidv7() }),
			);
			expect(r1.kind).toBe("new");
			expect(r2.kind).toBe("new");
		});

		it("rejects keys outside 1-255 printable ASCII", async () => {
			for (const key of ["", "x".repeat(256), "naïve", "a\nb"]) {
				await expectCode(
					withTx(t.pool, (tx) => claimIdempotencyKey(tx, { ...base(), key })),
					"validation",
				);
			}
		});
	});

	describe("create with Idempotency-Key", () => {
		it("same key and body return the same sandbox and operation", async () => {
			const env = await serviceEnv(t.pool);
			const body = { name: "a", secrets: { T: "s1" } };
			const first = await env.svc.create(env.p, body, "same");
			env.jobs.clear();
			const second = await env.svc.create(env.p, body, "same");
			expect(second.sandbox.id).toBe(first.sandbox.id);
			expect(second.operation.id).toBe(first.operation.id);
			expect(env.jobs.sent).toEqual([]);
			expect((await teamRowCounts(t.pool, env.p.teamId)).sandboxes).toBe(1);
		});

		it("another body (also a different secret value) is idempotency_key_reused", async () => {
			const env = await serviceEnv(t.pool);
			await env.svc.create(env.p, { secrets: { T: "s1" } }, "k");
			await expectCode(
				env.svc.create(env.p, { secrets: { T: "s2" } }, "k"),
				"idempotency_key_reused",
			);
		});

		it("without a key a repeat creates a new sandbox", async () => {
			const env = await serviceEnv(t.pool);
			const a = await env.svc.create(env.p, {});
			const b = await env.svc.create(env.p, {});
			expect(a.sandbox.id).not.toBe(b.sandbox.id);
		});

		it("two parallel creates with one key make one sandbox", async () => {
			const env = await serviceEnv(t.pool);
			const [a, b] = await Promise.all([
				env.svc.create(env.p, { name: "par" }, "parallel"),
				env.svc.create(env.p, { name: "par" }, "parallel"),
			]);
			expect(a.sandbox.id).toBe(b.sandbox.id);
			expect(a.operation.id).toBe(b.operation.id);
			expect((await teamRowCounts(t.pool, env.p.teamId)).sandboxes).toBe(1);
			expect(await idempotencyRows(t.pool, env.p.apiKeyId as string)).toBe(1);
		});

		it("a failed create (pool_exhausted) leaves no key: a retry may succeed", async () => {
			const env = await serviceEnv(t.pool);
			await expectCode(
				env.svc.create(env.p, { failFast: true }, "retry"),
				"pool_exhausted",
			);
			await insertMachine(t.pool, env.topo, {
				state: "warm",
				poolKey: env.pairKey,
			});
			const ok = await env.svc.create(env.p, { failFast: true }, "retry");
			expect(ok.sandbox.state).toBe("creating");
		});

		it("a key of the same user in another team does not replay its sandbox", async () => {
			const env = await serviceEnv(t.pool);
			const userId = uuidv7();
			const pa = { ...env.p, kind: "session" as const, userId };
			delete pa.apiKeyId;
			await env.svc.create(pa, {}, "shared");
			const pb = { ...pa, teamId: uuidv7() };
			await expectCode(
				env.svc.create(pb, {}, "shared"),
				"idempotency_key_reused",
			);
		});
	});
});
