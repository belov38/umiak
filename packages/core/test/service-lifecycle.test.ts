import { randomUUID } from "node:crypto";
import { withTx } from "@sbx/db";
import { createTestDatabase, skipPg, type TestDatabase } from "@sbx/db/testing";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
	RecordingJobSender,
	requestHash,
	requestStop,
	requestSystemResume,
} from "../src/index.ts";
import {
	expectCode,
	machineRow,
	readSecrets,
	sandboxRow,
	secretsRow,
	seedSandbox,
	serviceEnv,
} from "./helpers/service.ts";
import { insertMachine, insertOperation } from "./helpers/topology.ts";

const SECRET = "lifecycle-secret-marker-7f3a";

describe.skipIf(skipPg())(
	"SandboxService stop/resume/recover (S6 §7.5, §7.6, §7.8)",
	() => {
		let t: TestDatabase;

		beforeAll(async () => {
			t = await createTestDatabase({ max: 20 });
		});
		afterAll(async () => {
			await t?.drop();
		});

		async function events(sandboxId: string) {
			const r = await t.pool.query(
				`SELECT type, from_state, to_state, reason, data FROM runtime.sandbox_events
			 WHERE sandbox_id = $1 ORDER BY created_at, id`,
				[sandboxId],
			);
			return r.rows;
		}

		async function opCount(sandboxId: string): Promise<number> {
			const r = await t.pool.query<{ n: number }>(
				"SELECT count(*)::int AS n FROM runtime.operations WHERE sandbox_id = $1",
				[sandboxId],
			);
			return r.rows[0]?.n ?? 0;
		}

		describe("stop", () => {
			it("moves a ready sandbox to stopping with a stop operation and a job", async () => {
				const env = await serviceEnv(t.pool);
				const s = await seedSandbox(t.pool, env, { state: "ready" });

				const op = await env.svc.stop(env.p, s.sandboxId);

				expect(op.kind).toBe("stop");
				expect(op.state).toBe("pending");
				expect(op.request).toEqual({ reason: "user" });
				expect(op.deadlineAt).not.toBeNull();
				expect(op.requestedByKey).toBe(env.p.apiKeyId);
				const row = await sandboxRow(t.pool, s.sandboxId);
				expect(row?.state).toBe("stopping");
				expect(row?.stop_reason).toBe("user");
				expect(env.jobs.sent).toEqual([
					{
						queue: "sandbox-op",
						data: { operationId: op.id },
						opts: { singletonKey: s.sandboxId },
					},
				]);
				expect((await events(s.sandboxId)).at(-1)).toMatchObject({
					type: "state_changed",
					from_state: "ready",
					to_state: "stopping",
					reason: "stop",
				});
			});

			it("a second stop returns the active stop and enqueues nothing", async () => {
				const env = await serviceEnv(t.pool);
				const s = await seedSandbox(t.pool, env, { state: "ready" });
				const first = await env.svc.stop(env.p, s.slug);
				env.jobs.clear();
				const again = await env.svc.stop(env.p, s.sandboxId);
				expect(again.id).toBe(first.id);
				expect(env.jobs.sent).toEqual([]);
				expect(await opCount(s.sandboxId)).toBe(1);
			});

			it("is invalid_state outside ready and operation_in_progress with another active operation", async () => {
				const env = await serviceEnv(t.pool);
				const stopped = await seedSandbox(t.pool, env, {
					state: "stopped",
					machineState: "stopped",
				});
				const e = await expectCode(
					env.svc.stop(env.p, stopped.sandboxId),
					"invalid_state",
				);
				expect(e.details.state).toBe("stopped");

				const busy = await seedSandbox(t.pool, env, { state: "ready" });
				const forkOp = await insertOperation(t.pool, {
					sandboxId: busy.sandboxId,
					kind: "fork",
				});
				const e2 = await expectCode(
					env.svc.stop(env.p, busy.sandboxId),
					"operation_in_progress",
				);
				expect(e2.details).toMatchObject({ operationId: forkOp, kind: "fork" });
				expect(e2.retryable).toBe(true);
			});

			it("another team's sandbox is not_found", async () => {
				const env = await serviceEnv(t.pool);
				const s = await seedSandbox(t.pool, env, {
					state: "ready",
					teamId: randomUUID(),
				});
				await expectCode(env.svc.stop(env.p, s.sandboxId), "not_found");
			});

			it("requestStop (controllers) records the reason without a principal", async () => {
				const env = await serviceEnv(t.pool);
				const s = await seedSandbox(t.pool, env, { state: "ready" });
				const jobs = new RecordingJobSender();
				const op = await withTx(t.pool, (tx) =>
					requestStop(tx, jobs, s.sandboxId, "idle"),
				);
				expect(op.request).toEqual({ reason: "idle" });
				expect(op.requestedBy).toBeNull();
				expect(op.requestedByKey).toBeNull();
				expect((await sandboxRow(t.pool, s.sandboxId))?.stop_reason).toBe(
					"idle",
				);
				expect(jobs.sent).toHaveLength(1);
				// The active stop is returned to a later TTL stop as well.
				const again = await withTx(t.pool, (tx) =>
					requestStop(tx, jobs, s.sandboxId, "ttl"),
				);
				expect(again.id).toBe(op.id);
			});
		});

		describe("resume", () => {
			it("from stopped: sandbox starting, machine stays stopped, resume operation with a body hash", async () => {
				const env = await serviceEnv(t.pool);
				const s = await seedSandbox(t.pool, env, {
					state: "stopped",
					machineState: "stopped",
				});

				const op = await env.svc.resume(env.p, s.sandboxId, {});

				expect(op.kind).toBe("resume");
				expect(op.request).toEqual({
					size: null,
					ttlSeconds: null,
					bodyHash: requestHash("sandboxes.resume", {}).toString("hex"),
				});
				expect((await sandboxRow(t.pool, s.sandboxId))?.state).toBe("starting");
				expect((await machineRow(t.pool, s.machineId ?? ""))?.state).toBe(
					"stopped",
				);
				expect(env.jobs.sent).toEqual([
					{
						queue: "sandbox-op",
						data: { operationId: op.id },
						opts: { singletonKey: s.sandboxId },
					},
				]);
			});

			it("from error with the machine stopped; error with the machine failed is invalid_state", async () => {
				const env = await serviceEnv(t.pool);
				const ok = await seedSandbox(t.pool, env, {
					state: "error",
					machineState: "stopped",
				});
				const op = await env.svc.resume(env.p, ok.sandboxId);
				expect(op.kind).toBe("resume");
				expect((await sandboxRow(t.pool, ok.sandboxId))?.state).toBe(
					"starting",
				);

				const bad = await seedSandbox(t.pool, env, {
					state: "error",
					machineState: "failed",
				});
				const e = await expectCode(
					env.svc.resume(env.p, bad.sandboxId),
					"invalid_state",
				);
				expect(e.details.state).toBe("error");
				await expectCode(
					env.svc.resume(
						env.p,
						(await seedSandbox(t.pool, env, { state: "ready" })).sandboxId,
					),
					"invalid_state",
				);
			});

			it("overlays env/secrets/files on the stored sets in the same transaction", async () => {
				const env = await serviceEnv(t.pool);
				const s = await seedSandbox(t.pool, env, {
					state: "stopped",
					machineState: "stopped",
					sets: {
						env: { A: "1", C: "3" },
						secrets: { KEEP: "k", DROP: "d" },
						secretFiles: [{ name: "a.json", contentBase64: "YQ==" }],
					},
				});

				const op = await env.svc.resume(env.p, s.sandboxId, {
					env: { A: null, B: "2" },
					secrets: { DROP: null, TOKEN: SECRET },
					secretFiles: {
						"a.json": null,
						"b.pem": { contentBase64: "Yg==", mode: 0o400 },
					},
				});

				expect(await readSecrets(t.pool, env.keys, s.sandboxId)).toEqual({
					env: { C: "3", B: "2" },
					secrets: { KEEP: "k", TOKEN: SECRET },
					secretFiles: [{ name: "b.pem", contentBase64: "Yg==", mode: 0o400 }],
				});
				expect(JSON.stringify(op.request)).not.toContain(SECRET);
				expect(JSON.stringify(op.request)).not.toContain("TOKEN");
				expect(JSON.stringify(env.jobs.sent)).not.toContain(SECRET);
			});

			it("validates the merged sets and the patch shape", async () => {
				const env = await serviceEnv(t.pool);
				const s = await seedSandbox(t.pool, env, {
					state: "stopped",
					machineState: "stopped",
				});
				await expectCode(
					env.svc.resume(env.p, s.sandboxId, { env: { A: 1 as never } }),
					"validation",
				);
				await expectCode(
					env.svc.resume(env.p, s.sandboxId, { env: { SBX_X: "1" } }),
					"validation",
				);
				await expectCode(
					env.svc.resume(env.p, s.sandboxId, {
						secretFiles: { "x.txt": { contentBase64: "not base64!" } },
					}),
					"validation",
				);
				await expectCode(
					env.svc.resume(env.p, s.sandboxId, { bogus: 1 } as never),
					"validation",
				);
				await expectCode(
					env.svc.resume(env.p, s.sandboxId, { size: "8gb" }),
					"template_unavailable",
				);
				expect((await sandboxRow(t.pool, s.sandboxId))?.state).toBe("stopped");
			});

			it("out_of_capacity rolls back everything, including the secrets", async () => {
				const env = await serviceEnv(t.pool, {
					topology: { node: { ramCapMb: 2048 } },
				});
				const s = await seedSandbox(t.pool, env, {
					state: "stopped",
					machineState: "stopped",
					sets: { env: { A: "1" }, secrets: {}, secretFiles: [] },
				});
				// Another sandbox's running machine holds the whole node.
				await insertMachine(t.pool, env.topo, {
					state: "running",
					memoryMb: 2048,
					sandboxId: randomUUID(),
				});
				const before = await secretsRow(t.pool, s.sandboxId);

				const e = await expectCode(
					env.svc.resume(env.p, s.sandboxId, { env: { A: "2" } }),
					"out_of_capacity",
				);
				expect(e.details.retryAfterSeconds).toBe(30);

				expect(await secretsRow(t.pool, s.sandboxId)).toEqual(before);
				expect((await sandboxRow(t.pool, s.sandboxId))?.state).toBe("stopped");
				expect(await opCount(s.sandboxId)).toBe(0);
				expect(env.jobs.sent).toEqual([]);
			});

			it("evicts warm machines of other pairs on the sandbox's node", async () => {
				const env = await serviceEnv(t.pool, {
					topology: { node: { ramCapMb: 2048 } },
				});
				const s = await seedSandbox(t.pool, env, {
					state: "stopped",
					machineState: "stopped",
				});
				const warm = await insertMachine(t.pool, env.topo, {
					state: "warm",
					memoryMb: 2048,
					poolKey: "other/2gb",
					warmAgoSeconds: 60,
				});
				await env.svc.resume(env.p, s.sandboxId);
				expect((await machineRow(t.pool, warm))?.state).toBe("deleting");
			});

			it("a repeated resume with the same body returns the active one without admission; another body is operation_in_progress", async () => {
				// The node fits exactly this machine: a second admission would fail.
				const env = await serviceEnv(t.pool, {
					topology: { node: { ramCapMb: 2048 } },
				});
				const s = await seedSandbox(t.pool, env, {
					state: "stopped",
					machineState: "stopped",
				});
				const body = { ttlSeconds: 600, env: { X: "1" } };
				const first = await env.svc.resume(env.p, s.sandboxId, body);
				env.jobs.clear();
				const before = await secretsRow(t.pool, s.sandboxId);

				const again = await env.svc.resume(env.p, s.sandboxId, {
					env: { X: "1" },
					ttlSeconds: 600,
				});
				expect(again.id).toBe(first.id);
				expect(env.jobs.sent).toEqual([]);
				expect(await secretsRow(t.pool, s.sandboxId)).toEqual(before);

				const e = await expectCode(
					env.svc.resume(env.p, s.sandboxId, { ttlSeconds: 601 }),
					"operation_in_progress",
				);
				expect(e.details.operationId).toBe(first.id);
				// An empty body is a body too.
				await expectCode(
					env.svc.resume(env.p, s.sandboxId),
					"operation_in_progress",
				);
			});

			it("with a new size: quota and admission use its RAM; sandbox and machine take the size", async () => {
				const env = await serviceEnv(t.pool, {
					topology: { node: { ramCapMb: 4096 } },
				});
				const s = await seedSandbox(t.pool, env, {
					state: "stopped",
					machineState: "stopped",
					ttlSeconds: 100,
				});
				const op = await env.svc.resume(env.p, s.sandboxId, {
					size: "4gb",
					ttlSeconds: 7200,
				});
				expect(op.request).toMatchObject({ size: "4gb", ttlSeconds: 7200 });
				const row = await sandboxRow(t.pool, s.sandboxId);
				expect(row).toMatchObject({
					size_slug: "4gb",
					memory_mb: 4096,
					ttl_seconds: 7200,
				});
				expect(await machineRow(t.pool, s.machineId ?? "")).toMatchObject({
					state: "stopped",
					size_slug: "4gb",
					memory_mb: 4096,
				});
			});

			it("checks the team quota", async () => {
				const env = await serviceEnv(t.pool, { quota: { maxRamMb: 3000 } });
				const s = await seedSandbox(t.pool, env, {
					state: "stopped",
					machineState: "stopped",
				});
				const e = await expectCode(
					env.svc.resume(env.p, s.sandboxId, { size: "4gb" }),
					"quota_exceeded",
				);
				expect(e.details.quota).toBe("maxRamMb");
				// The current size fits.
				await env.svc.resume(env.p, s.sandboxId);
			});

			it("requestSystemResume: ready sandbox with a stopped machine goes starting without a principal; refused admission changes nothing", async () => {
				const env = await serviceEnv(t.pool, {
					topology: { node: { ramCapMb: 2048 } },
				});
				const s = await seedSandbox(t.pool, env, {
					state: "ready",
					machineState: "stopped",
				});
				const jobs = new RecordingJobSender();
				const res = await withTx(t.pool, (tx) =>
					requestSystemResume(tx, jobs, s.sandboxId),
				);
				expect(res.ok).toBe(true);
				if (!res.ok) return;
				expect(res.operation.kind).toBe("resume");
				expect(res.operation.requestedBy).toBeNull();
				expect(res.operation.requestedByKey).toBeNull();
				expect((await sandboxRow(t.pool, s.sandboxId))?.state).toBe("starting");
				expect(jobs.sent).toHaveLength(1);

				// No RAM left on the node for a second one.
				const other = await seedSandbox(t.pool, env, {
					state: "ready",
					machineState: "stopped",
				});
				const jobs2 = new RecordingJobSender();
				const res2 = await withTx(t.pool, (tx) =>
					requestSystemResume(tx, jobs2, other.sandboxId),
				);
				expect(res2.ok).toBe(false);
				expect((await sandboxRow(t.pool, other.sandboxId))?.state).toBe(
					"ready",
				);
				expect(await opCount(other.sandboxId)).toBe(0);
				expect(jobs2.sent).toEqual([]);
			});
		});

		describe("recover", () => {
			it("from ready: starting, last_recover_at set, recover operation and job", async () => {
				const env = await serviceEnv(t.pool);
				const s = await seedSandbox(t.pool, env, { state: "ready" });
				const op = await env.svc.recover(env.p, s.sandboxId);
				expect(op.kind).toBe("recover");
				expect(op.request).toEqual({});
				const row = await sandboxRow(t.pool, s.sandboxId);
				expect(row?.state).toBe("starting");
				expect(row?.last_recover_at).not.toBeNull();
				expect(env.jobs.sent).toEqual([
					{
						queue: "sandbox-op",
						data: { operationId: op.id },
						opts: { singletonKey: s.sandboxId },
					},
				]);
				// The active recover is returned again.
				env.jobs.clear();
				const again = await env.svc.recover(env.p, s.sandboxId);
				expect(again.id).toBe(op.id);
				expect(env.jobs.sent).toEqual([]);
			});

			it("more often than recoverMinIntervalSeconds is recover_rate_limited", async () => {
				const env = await serviceEnv(t.pool);
				const s = await seedSandbox(t.pool, env, {
					state: "ready",
					lastRecoverAgoSeconds: 100,
				});
				const e = await expectCode(
					env.svc.recover(env.p, s.sandboxId),
					"recover_rate_limited",
				);
				expect(e.retryable).toBe(true);
				const after = e.details.retryAfterSeconds as number;
				expect(after).toBeGreaterThanOrEqual(499);
				expect(after).toBeLessThanOrEqual(501);
				expect((await sandboxRow(t.pool, s.sandboxId))?.state).toBe("ready");

				const old = await seedSandbox(t.pool, env, {
					state: "ready",
					lastRecoverAgoSeconds: 601,
				});
				await env.svc.recover(env.p, old.sandboxId);
			});

			it("from error: machine failed is invalid_state; machine stopped needs admission", async () => {
				const env = await serviceEnv(t.pool, {
					topology: { node: { ramCapMb: 2048 } },
				});
				const failed = await seedSandbox(t.pool, env, {
					state: "error",
					machineState: "failed",
				});
				await expectCode(
					env.svc.recover(env.p, failed.sandboxId),
					"invalid_state",
				);
				const none = await seedSandbox(t.pool, env, {
					state: "error",
					machineState: null,
				});
				await expectCode(
					env.svc.recover(env.p, none.sandboxId),
					"invalid_state",
				);

				const stopped = await seedSandbox(t.pool, env, {
					state: "error",
					machineState: "stopped",
				});
				const blocker = await insertMachine(t.pool, env.topo, {
					state: "running",
					memoryMb: 2048,
					sandboxId: randomUUID(),
				});
				await expectCode(
					env.svc.recover(env.p, stopped.sandboxId),
					"out_of_capacity",
				);
				expect(
					(await sandboxRow(t.pool, stopped.sandboxId))?.last_recover_at,
				).toBeNull();
				await t.pool.query(
					"UPDATE runtime.machines SET state = 'deleting' WHERE id = $1",
					[blocker],
				);
				const op = await env.svc.recover(env.p, stopped.sandboxId);
				expect(op.kind).toBe("recover");
			});
		});
	},
);
