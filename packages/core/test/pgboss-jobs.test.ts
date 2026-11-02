import { withTx } from "@umiak/db";
import {
	createTestDatabase,
	skipPg,
	type TestDatabase,
} from "@umiak/db/testing";
import { PgBoss } from "pg-boss";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
	DELETE_RETRY_LIMIT,
	ensureQueues,
	PgBossJobSender,
	QUEUE_NAMES,
	QUEUES,
	uuidv7,
} from "../src/index.ts";

describe.skipIf(skipPg())(
	"PgBossJobSender and ensureQueues (real pg-boss)",
	() => {
		let t: TestDatabase;
		let boss: PgBoss;
		let jobs: PgBossJobSender;

		beforeAll(async () => {
			t = await createTestDatabase({ max: 10 });
			boss = new PgBoss({
				connectionString: t.url,
				schema: "pgboss",
				max: 2,
				supervise: false,
				schedule: false,
			});
			boss.on("error", () => {});
			await boss.start();
			await ensureQueues(boss);
			jobs = new PgBossJobSender(boss);
		});
		afterAll(async () => {
			await boss?.stop({ graceful: false });
			await t?.drop();
		});

		async function jobsWith(key: string) {
			const r = await t.pool.query(
				`SELECT name, data, singleton_key, retry_limit, state,
			        extract(epoch FROM start_after - created_on)::int AS delay_s
			 FROM pgboss.job WHERE singleton_key = $1 ORDER BY created_on`,
				[key],
			);
			return r.rows;
		}

		it("ensureQueues creates every queue with its options and is idempotent", async () => {
			await ensureQueues(boss);
			for (const name of QUEUE_NAMES) {
				const q = await boss.getQueue(name);
				expect(q?.policy).toBe(QUEUES[name].policy);
			}
			const op = await boss.getQueue("sandbox-op");
			expect(op).toMatchObject({
				deadLetter: "sandbox-op-dlq",
				retryLimit: 20,
				retryBackoff: true,
				retryDelay: 2,
				retryDelayMax: 120,
				heartbeatSeconds: 30,
				expireInSeconds: 3600,
			});
		});

		it("machine-events: the job of a dead pod is failed by the heartbeat and comes back (M1)", async () => {
			const machineId = uuidv7();
			await withTx(t.pool, (tx) =>
				jobs.send(
					tx,
					"machine-events",
					{ machineId },
					{ singletonKey: machineId },
				),
			);
			// A pod takes the job and dies (kill -9): no heartbeat, no completion.
			const [taken] = await boss.fetch("machine-events");
			expect(taken?.data).toEqual({ machineId });
			// Stately: until it is no longer active, no other job of this
			// machine can run. Its heartbeat is now older than 30 s.
			await t.pool.query(
				`UPDATE pgboss.job SET heartbeat_on = now() - interval '31 seconds',
				   started_on = now() - interval '31 seconds'
				 WHERE id = $1`,
				[taken?.id],
			);
			await boss.supervise("machine-events");
			const r = await t.pool.query<{ state: string }>(
				"SELECT state FROM pgboss.job WHERE id = $1",
				[taken?.id],
			);
			expect(r.rows[0]?.state).toBe("retry");
		});

		it("ensureQueues brings changed queue options back", async () => {
			await boss.updateQueue("machine-op", { retryLimit: 3 });
			await ensureQueues(boss);
			expect((await boss.getQueue("machine-op"))?.retryLimit).toBe(20);
		});

		it("a send in a committed transaction exists; in a rolled-back one it does not", async () => {
			const committed = uuidv7();
			await withTx(t.pool, (tx) =>
				jobs.send(
					tx,
					"sandbox-op",
					{ operationId: "op-1" },
					{ singletonKey: committed },
				),
			);
			const rows = await jobsWith(committed);
			expect(rows).toHaveLength(1);
			expect(rows[0]).toMatchObject({
				name: "sandbox-op",
				data: { operationId: "op-1" },
				retry_limit: 20,
				state: "created",
			});

			const rolledBack = uuidv7();
			await expect(
				withTx(t.pool, async (tx) => {
					await jobs.send(
						tx,
						"sandbox-op",
						{ operationId: "op-2" },
						{ singletonKey: rolledBack },
					);
					expect(
						await tx.client.query(
							"SELECT 1 FROM pgboss.job WHERE singleton_key = $1",
							[rolledBack],
						),
					).toMatchObject({ rowCount: 1 });
					throw new Error("rollback");
				}),
			).rejects.toThrow("rollback");
			expect(await jobsWith(rolledBack)).toEqual([]);
		});

		it("passes retryLimit and startAfter per job", async () => {
			const key = uuidv7();
			await withTx(t.pool, (tx) =>
				jobs.send(
					tx,
					"sandbox-op",
					{ operationId: "del" },
					{ singletonKey: key, retryLimit: DELETE_RETRY_LIMIT, startAfter: 60 },
				),
			);
			const [row] = await jobsWith(key);
			expect(row.retry_limit).toBe(DELETE_RETRY_LIMIT);
			expect(row.delay_s).toBeGreaterThanOrEqual(59);
			expect(row.delay_s).toBeLessThanOrEqual(61);
		});

		it("singleton keeps several queued jobs of one key; exclusive drops the duplicate", async () => {
			const key = uuidv7();
			for (const operationId of ["create", "delete"]) {
				await withTx(t.pool, (tx) =>
					jobs.send(tx, "sandbox-op", { operationId }, { singletonKey: key }),
				);
			}
			expect((await jobsWith(key)).map((r) => r.data.operationId)).toEqual([
				"create",
				"delete",
			]);

			const ctl = uuidv7();
			for (let i = 0; i < 2; i++) {
				await withTx(t.pool, (tx) =>
					jobs.send(tx, "ctl-pool", {}, { singletonKey: ctl }),
				);
			}
			expect(await jobsWith(ctl)).toHaveLength(1);
		});
	},
);
