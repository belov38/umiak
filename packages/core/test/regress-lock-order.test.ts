// Regression (S6 acceptance M4): admitCold tried candidates in `place()`
// order and kept the node lock of a refused admission while it tried the
// next one. Two creates that saw the candidates in opposite order deadlocked
// (40P01 to the caller). A refused admission now gives its node lock back,
// and the admission transactions retry 40P01/40001, then `out_of_capacity`.
import { type Tx, withTx } from "@sbx/db";
import { createTestDatabase, skipPg, type TestDatabase } from "@sbx/db/testing";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
	admit,
	lockNode,
	RecordingJobSender,
	SandboxServiceImpl,
	SbxError,
} from "../src/index.ts";
import { SERVICE_TX_RETRIES } from "../src/service/tx.ts";
import { principal, serviceEnv } from "./helpers/service.ts";
import {
	createTopology,
	insertMachine,
	insertNode,
	insertStorage,
	insertTemplateBuild,
} from "./helpers/topology.ts";

describe.skipIf(skipPg())("multi-node admission lock order (M4)", () => {
	let t: TestDatabase;

	beforeAll(async () => {
		t = await createTestDatabase({ max: 60 });
	});
	afterAll(async () => {
		await t?.drop();
	});

	it("two admissions that try full nodes in opposite order do not deadlock", async () => {
		const a = await createTopology(t.pool, { node: { ramCapMb: 2048 } });
		const b = await createTopology(t.pool, {
			providerId: a.providerId,
			node: { ramCapMb: 2048 },
		});
		// Both nodes full.
		await insertMachine(t.pool, a, { state: "running", memoryMb: 2048 });
		await insertMachine(t.pool, b, { state: "running", memoryMb: 2048 });
		const jobs = new RecordingJobSender();

		let release1!: () => void;
		let release2!: () => void;
		const gate1 = new Promise<void>((r) => {
			release1 = r;
		});
		const gate2 = new Promise<void>((r) => {
			release2 = r;
		});
		const input = { needMb: 2048, pairKey: "x/2gb", evict: true, jobs };

		// Same loop as admitCold: first candidate refused, then the next one.
		const tx1 = withTx(t.pool, async (tx) => {
			const r1 = await admit(tx, { ...input, nodeId: a.nodeId });
			release1();
			await gate2;
			const r2 = await admit(tx, { ...input, nodeId: b.nodeId });
			return [r1.ok, r2.ok];
		});
		const tx2 = withTx(t.pool, async (tx) => {
			await gate1;
			const r1 = await admit(tx, { ...input, nodeId: b.nodeId });
			release2();
			const r2 = await admit(tx, { ...input, nodeId: a.nodeId });
			return [r1.ok, r2.ok];
		});
		const res = await Promise.allSettled([tx1, tx2]);
		const errors = res
			.filter((r) => r.status === "rejected")
			.map((r) => (r as PromiseRejectedResult).reason as { code?: string });
		// Both refused (out_of_capacity in admitCold), no 40P01.
		expect(errors.map((e) => e.code)).toEqual([]);
	});

	// Smoke test: probabilistic (it found the deadlock only sometimes on the
	// old code); test 1 is the deterministic regression.
	it("smoke: parallel cold creates of different teams on two near-full nodes only fail with SbxError", async () => {
		const nonDomain: string[] = [];
		for (let round = 0; round < 8; round++) {
			const env = await serviceEnv(t.pool, {
				topology: { node: { ramCapMb: 4096 } },
			});
			// Second node with an active build of the same template.
			const nodeB = await insertNode(t.pool, env.topo.providerId, {
				ramCapMb: 4096,
			});
			const storageB = await insertStorage(t.pool, env.topo.providerId, nodeB);
			await insertTemplateBuild(
				t.pool,
				{ providerId: env.topo.providerId, nodeId: nodeB, storageId: storageB },
				{ templateSlug: env.template },
			);
			const results = await Promise.allSettled(
				Array.from({ length: 40 }, () => env.svc.create(principal(), {})),
			);
			const ok = results.filter((r) => r.status === "fulfilled").length;
			for (const r of results) {
				if (r.status === "rejected" && !(r.reason instanceof SbxError)) {
					nonDomain.push(String(r.reason));
				}
			}
			expect(ok).toBeGreaterThan(0);
		}
		// Only domain errors (out_of_capacity), never "deadlock detected".
		expect(nonDomain).toEqual([]);
	});
	it("a refused admission gives its node lock back; an admitted one keeps it", async () => {
		const a = await createTopology(t.pool, { node: { ramCapMb: 2048 } });
		await insertMachine(t.pool, a, { state: "running", memoryMb: 2048 });
		const free = await createTopology(t.pool, { node: { ramCapMb: 8192 } });
		const jobs = new RecordingJobSender();
		const nodeLocks = (tx: Tx) =>
			tx.client
				.query<{ n: number }>(
					`SELECT count(*)::int AS n FROM pg_locks
					 WHERE locktype = 'advisory' AND pid = pg_backend_pid()`,
				)
				.then((r) => r.rows[0]?.n ?? 0);
		await withTx(t.pool, async (tx) => {
			const input = { needMb: 1024, pairKey: null, evict: true, jobs };
			expect((await admit(tx, { ...input, nodeId: a.nodeId })).ok).toBe(false);
			expect(await nodeLocks(tx)).toBe(0);
			expect((await admit(tx, { ...input, nodeId: free.nodeId })).ok).toBe(
				true,
			);
			expect(await nodeLocks(tx)).toBe(1);
			// A lock taken before the call survives a refusal.
			await lockNode(tx, a.nodeId);
			expect((await admit(tx, { ...input, nodeId: a.nodeId })).ok).toBe(false);
			expect(await nodeLocks(tx)).toBe(2);
		});
	});

	it("a create that hits 40P01 is run again and succeeds", async () => {
		const env = await serviceEnv(t.pool);
		let failures = 1;
		const svc = new SandboxServiceImpl({
			pool: t.pool,
			config: flaky(env.config, () => failures-- > 0),
			keys: env.keys,
			jobs: env.jobs,
		});
		const { sandbox } = await svc.create(env.p, {});
		expect(sandbox.state).toBe("creating");
		expect(failures).toBe(-1);
		const n = await t.pool.query<{ n: number }>(
			"SELECT count(*)::int AS n FROM runtime.sandboxes WHERE team_id = $1",
			[env.p.teamId],
		);
		expect(n.rows[0]?.n).toBe(1);
	});

	it("after the retries a create gets a retryable out_of_capacity, nothing is written", async () => {
		const env = await serviceEnv(t.pool);
		let calls = 0;
		const warnings: { obj: Record<string, unknown>; msg: string }[] = [];
		const svc = new SandboxServiceImpl({
			log: { warn: (obj, msg) => warnings.push({ obj, msg }) },
			pool: t.pool,
			config: flaky(
				env.config,
				() => {
					calls += 1;
					return true;
				},
				"40001",
			),
			keys: env.keys,
			jobs: env.jobs,
		});
		const err = await svc.create(env.p, {}).catch((e: unknown) => e);
		expect(err).toBeInstanceOf(SbxError);
		expect((err as SbxError).code).toBe("out_of_capacity");
		expect((err as SbxError).retryable).toBe(true);
		expect(calls).toBe(SERVICE_TX_RETRIES + 1);
		expect(((err as SbxError).cause as { code?: string }).code).toBe("40001");
		expect(warnings).toEqual([
			{
				obj: { sqlstate: "40001", attempts: SERVICE_TX_RETRIES + 1 },
				msg: expect.stringContaining("out_of_capacity"),
			},
		]);
		const n = await t.pool.query<{ n: number }>(
			"SELECT count(*)::int AS n FROM runtime.sandboxes WHERE team_id = $1",
			[env.p.teamId],
		);
		expect(n.rows[0]?.n).toBe(0);
	});
});

/** A config whose `teamQuota` (read inside the create transaction) fails like Postgres when `fail()`. */
function flaky<C extends { teamQuota: (teamId: string) => Promise<unknown> }>(
	config: C,
	fail: () => boolean,
	code = "40P01",
): C {
	return new Proxy(config, {
		get(target, prop, receiver) {
			if (prop === "teamQuota") {
				return async (teamId: string) => {
					if (fail()) {
						throw Object.assign(new Error("deadlock detected"), { code });
					}
					return target.teamQuota(teamId);
				};
			}
			const v = Reflect.get(target, prop, receiver);
			return typeof v === "function" ? v.bind(target) : v;
		},
	});
}
