import { randomUUID } from "node:crypto";
import { withTx } from "@sbx/db";
import { createTestDatabase, skipPg, type TestDatabase } from "@sbx/db/testing";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
	admit,
	checkQuota,
	DELETE_RETRY_LIMIT,
	isSbxError,
	lockNode,
	lockTeam,
	MACHINE_STATES,
	nodeRam,
	RecordingJobSender,
	tryPoweredStart,
} from "../src/index.ts";
import {
	createTopology,
	insertMachine,
	insertSandbox,
	insertStoppedWithOperation,
	type Topology,
} from "./helpers/topology.ts";

describe.skipIf(skipPg())("capacity", () => {
	let t: TestDatabase;

	beforeAll(async () => {
		t = await createTestDatabase({ max: 40 });
	});
	afterAll(async () => {
		await t?.drop();
	});

	const ram = (nodeId: string) => withTx(t.pool, (tx) => nodeRam(tx, nodeId));

	async function machineState(id: string): Promise<string | undefined> {
		const r = await t.pool.query<{ state: string }>(
			"SELECT state FROM runtime.machines WHERE id = $1",
			[id],
		);
		return r.rows[0]?.state;
	}

	describe("nodeRam (S6 §8.1)", () => {
		const RESERVED = new Set([
			"allocating",
			"provisioning",
			"booting",
			"warm",
			"claiming",
			"running",
			"starting",
			"stopping",
		]);
		const POWERED = new Set([
			"booting",
			"warm",
			"claiming",
			"running",
			"starting",
			"stopping",
		]);
		const POWERED_UNLESS_OBSERVED_STOPPED = new Set([
			"failed",
			"deleting",
			"stopped",
		]);
		const cases = MACHINE_STATES.flatMap((state) =>
			(["running", "stopped", "unknown"] as const).map((power) => ({
				state,
				power,
				reserved: RESERVED.has(state) ? 1024 : 0,
				powered:
					POWERED.has(state) ||
					(POWERED_UNLESS_OBSERVED_STOPPED.has(state) && power !== "stopped")
						? 1024
						: 0,
			})),
		);

		it.each(cases)(
			"$state with power_observed=$power: reserved $reserved, powered $powered",
			async ({ state, power, reserved, powered }) => {
				const topo = await createTopology(t.pool, {
					node: { ramCapMb: 8192 },
				});
				await insertMachine(t.pool, topo, {
					state,
					memoryMb: 1024,
					powerObserved: power,
				});
				expect(await ram(topo.nodeId)).toEqual({
					capMb: 8192,
					reservedMb: reserved,
					poweredMb: powered,
				});
			},
		);

		it.each([
			{ kind: "resume", state: "pending", reserved: 2048 },
			{ kind: "resume", state: "running", reserved: 2048 },
			{ kind: "recover", state: "pending", reserved: 2048 },
			{ kind: "recover", state: "running", reserved: 2048 },
			{ kind: "resume", state: "succeeded", reserved: 0 },
			{ kind: "resume", state: "failed", reserved: 0 },
			{ kind: "stop", state: "pending", reserved: 0 },
			{ kind: "delete", state: "running", reserved: 0 },
		])(
			"stopped machine with a $state $kind operation: reserved $reserved",
			async ({ kind, state, reserved }) => {
				const topo = await createTopology(t.pool);
				await insertStoppedWithOperation(t.pool, topo, {
					operation: { kind, state },
				});
				const r = await ram(topo.nodeId);
				expect(r.reservedMb).toBe(reserved);
				expect(r.poweredMb).toBe(0);
			},
		);

		it("a stopped machine that is not the sandbox's current machine is not reserved by its resume", async () => {
			const topo = await createTopology(t.pool);
			const { sandboxId } = await insertStoppedWithOperation(t.pool, topo, {
				operation: { kind: "resume", state: "pending" },
			});
			// An older stopped machine of the same sandbox (history, 1:N).
			await insertMachine(t.pool, topo, {
				state: "stopped",
				memoryMb: 4096,
				powerObserved: "stopped",
				sandboxId,
			});
			expect((await ram(topo.nodeId)).reservedMb).toBe(2048);
		});

		it("sums several machines and ignores other nodes", async () => {
			const topo = await createTopology(t.pool, { node: { ramCapMb: 6144 } });
			const other = await createTopology(t.pool);
			await insertMachine(t.pool, topo, { state: "running", memoryMb: 2048 });
			await insertMachine(t.pool, topo, {
				state: "allocating",
				memoryMb: 1024,
			});
			await insertMachine(t.pool, topo, {
				state: "deleting",
				memoryMb: 512,
				powerObserved: "running",
			});
			await insertMachine(t.pool, other, { state: "running", memoryMb: 4096 });
			expect(await ram(topo.nodeId)).toEqual({
				capMb: 6144,
				reservedMb: 3072,
				poweredMb: 2560,
			});
		});

		it("unknown node is not_found", async () => {
			await expect(ram(randomUUID())).rejects.toSatisfy((e) =>
				isSbxError(e, "not_found"),
			);
		});
	});

	describe("admit (S6 §8.2)", () => {
		async function fullNode(): Promise<{
			topo: Topology;
			oldOther: string;
			newOther: string;
			ownPair: string;
		}> {
			// cap 8192 = running 2048 + three warm 2048
			const topo = await createTopology(t.pool, { node: { ramCapMb: 8192 } });
			await insertMachine(t.pool, topo, { state: "running", memoryMb: 2048 });
			const ownPair = await insertMachine(t.pool, topo, {
				state: "warm",
				poolKey: "linux/2gb",
				warmAgoSeconds: 1000,
			});
			const oldOther = await insertMachine(t.pool, topo, {
				state: "warm",
				poolKey: "windows/2gb",
				warmAgoSeconds: 300,
			});
			const newOther = await insertMachine(t.pool, topo, {
				state: "warm",
				poolKey: "ubuntu/2gb",
				warmAgoSeconds: 100,
			});
			return { topo, oldOther, newOther, ownPair };
		}

		it("admits from free RAM without evicting", async () => {
			const topo = await createTopology(t.pool, { node: { ramCapMb: 8192 } });
			await insertMachine(t.pool, topo, { state: "running", memoryMb: 2048 });
			await insertMachine(t.pool, topo, {
				state: "warm",
				poolKey: "windows/2gb",
				warmAgoSeconds: 10,
			});
			const jobs = new RecordingJobSender();
			const res = await withTx(t.pool, (tx) =>
				admit(tx, {
					nodeId: topo.nodeId,
					needMb: 4096,
					pairKey: "linux/2gb",
					evict: true,
					jobs,
				}),
			);
			expect(res).toEqual({ ok: true, evicted: [] });
			expect(jobs.sent).toEqual([]);
		});

		it("refuses without eviction when RAM is short", async () => {
			const { topo, oldOther, newOther } = await fullNode();
			const jobs = new RecordingJobSender();
			const res = await withTx(t.pool, (tx) =>
				admit(tx, {
					nodeId: topo.nodeId,
					needMb: 2048,
					pairKey: "linux/2gb",
					evict: false,
					jobs,
				}),
			);
			expect(res).toEqual({ ok: false });
			expect(await machineState(oldOther)).toBe("warm");
			expect(await machineState(newOther)).toBe("warm");
			expect(jobs.sent).toEqual([]);
		});

		it("evicts the oldest warm machine of another pair and sends machine-op delete", async () => {
			const { topo, oldOther, newOther, ownPair } = await fullNode();
			const jobs = new RecordingJobSender();
			const res = await withTx(t.pool, (tx) =>
				admit(tx, {
					nodeId: topo.nodeId,
					needMb: 2048,
					pairKey: "linux/2gb",
					evict: true,
					jobs,
				}),
			);
			expect(res).toEqual({ ok: true, evicted: [oldOther] });
			expect(await machineState(oldOther)).toBe("deleting");
			expect(await machineState(newOther)).toBe("warm");
			expect(await machineState(ownPair)).toBe("warm");
			// Strict: a missing retryLimit must fail (delete never gives up, §15.1).
			expect(jobs.sent).toStrictEqual([
				{
					queue: "machine-op",
					data: { machineId: oldOther, action: "delete" },
					opts: { singletonKey: oldOther, retryLimit: DELETE_RETRY_LIMIT },
				},
			]);
			expect((await ram(topo.nodeId)).reservedMb).toBe(6144);
		});

		it("evicts several machines, oldest first, never its own pair", async () => {
			const { topo, oldOther, newOther, ownPair } = await fullNode();
			const jobs = new RecordingJobSender();
			const res = await withTx(t.pool, (tx) =>
				admit(tx, {
					nodeId: topo.nodeId,
					needMb: 4096,
					pairKey: "linux/2gb",
					evict: true,
					jobs,
				}),
			);
			expect(res).toEqual({ ok: true, evicted: [oldOther, newOther] });
			expect(await machineState(ownPair)).toBe("warm");
			expect(jobs.sent.map((j) => j.data.machineId)).toEqual([
				oldOther,
				newOther,
			]);
		});

		it("refuses and changes nothing when other pairs' warm RAM is not enough", async () => {
			const { topo, oldOther, newOther, ownPair } = await fullNode();
			const jobs = new RecordingJobSender();
			const res = await withTx(t.pool, (tx) =>
				admit(tx, {
					nodeId: topo.nodeId,
					needMb: 6144,
					pairKey: "linux/2gb",
					evict: true,
					jobs,
				}),
			);
			expect(res).toEqual({ ok: false });
			for (const id of [oldOther, newOther, ownPair]) {
				expect(await machineState(id)).toBe("warm");
			}
			expect(jobs.sent).toEqual([]);
		});

		it("with pairKey null every warm machine may be evicted", async () => {
			const { topo, ownPair } = await fullNode();
			const jobs = new RecordingJobSender();
			const res = await withTx(t.pool, (tx) =>
				admit(tx, {
					nodeId: topo.nodeId,
					needMb: 2048,
					pairKey: null,
					evict: true,
					jobs,
				}),
			);
			expect(res).toEqual({ ok: true, evicted: [ownPair] });
		});

		it("30 concurrent admissions at cap 6144 admit exactly three 2048 MB machines", async () => {
			const topo = await createTopology(t.pool, { node: { ramCapMb: 6144 } });
			const jobs = new RecordingJobSender();
			const observed: number[] = [];
			const results = await Promise.all(
				Array.from({ length: 30 }, () =>
					withTx(t.pool, async (tx) => {
						await lockNode(tx, topo.nodeId);
						const res = await admit(tx, {
							nodeId: topo.nodeId,
							needMb: 2048,
							pairKey: "linux/2gb",
							evict: false,
							jobs,
						});
						if (!res.ok) return false;
						await insertMachine(tx.client, topo, {
							state: "allocating",
							memoryMb: 2048,
						});
						observed.push((await nodeRam(tx, topo.nodeId)).reservedMb);
						return true;
					}),
				),
			);
			expect(results.filter(Boolean)).toHaveLength(3);
			expect(observed).toHaveLength(3);
			for (const r of observed) expect(r).toBeLessThanOrEqual(6144);
			expect((await ram(topo.nodeId)).reservedMb).toBe(6144);
		});
	});

	describe("tryPoweredStart (S6 §8.2)", () => {
		it("starts a provisioning machine when powered RAM allows and refuses otherwise", async () => {
			const topo = await createTopology(t.pool, { node: { ramCapMb: 4096 } });
			await insertMachine(t.pool, topo, { state: "running", memoryMb: 2048 });
			const a = await insertMachine(t.pool, topo, {
				state: "provisioning",
				memoryMb: 2048,
			});
			const b = await insertMachine(t.pool, topo, {
				state: "provisioning",
				memoryMb: 2048,
			});
			expect(
				await withTx(t.pool, (tx) =>
					tryPoweredStart(tx, { machineId: a, toState: "booting" }),
				),
			).toBe(true);
			expect(await machineState(a)).toBe("booting");
			expect(
				await withTx(t.pool, (tx) =>
					tryPoweredStart(tx, { machineId: b, toState: "booting" }),
				),
			).toBe(false);
			expect(await machineState(b)).toBe("provisioning");
			expect((await ram(topo.nodeId)).poweredMb).toBe(4096);
		});

		it("counts machines that are still powered (deleting, power not yet stopped)", async () => {
			const topo = await createTopology(t.pool, { node: { ramCapMb: 4096 } });
			await insertMachine(t.pool, topo, {
				state: "deleting",
				memoryMb: 2048,
				powerObserved: "running",
			});
			await insertMachine(t.pool, topo, {
				state: "failed",
				memoryMb: 1024,
				powerObserved: "unknown",
			});
			const { machineId } = await insertStoppedWithOperation(t.pool, topo, {
				operation: { kind: "resume", state: "running" },
			});
			expect(
				await withTx(t.pool, (tx) =>
					tryPoweredStart(tx, { machineId, toState: "starting" }),
				),
			).toBe(false);
			expect(await machineState(machineId)).toBe("stopped");
		});

		it("does not count a stopped machine twice when its power is not observed stopped", async () => {
			const topo = await createTopology(t.pool, { node: { ramCapMb: 4096 } });
			await insertMachine(t.pool, topo, { state: "running", memoryMb: 2048 });
			const { machineId } = await insertStoppedWithOperation(t.pool, topo, {
				powerObserved: "unknown",
				operation: { kind: "recover", state: "running" },
			});
			// powered already includes this machine: 2048 + 2048 = cap
			expect((await ram(topo.nodeId)).poweredMb).toBe(4096);
			expect(
				await withTx(t.pool, (tx) =>
					tryPoweredStart(tx, { machineId, toState: "starting" }),
				),
			).toBe(true);
			expect(await machineState(machineId)).toBe("starting");
			expect((await ram(topo.nodeId)).poweredMb).toBe(4096);
		});

		it("is idempotent for a machine already in the target state", async () => {
			const topo = await createTopology(t.pool, { node: { ramCapMb: 2048 } });
			const id = await insertMachine(t.pool, topo, {
				state: "booting",
				memoryMb: 2048,
			});
			expect(
				await withTx(t.pool, (tx) =>
					tryPoweredStart(tx, { machineId: id, toState: "booting" }),
				),
			).toBe(true);
		});

		it("rejects a machine in a state it cannot start from", async () => {
			const topo = await createTopology(t.pool);
			const id = await insertMachine(t.pool, topo, { state: "running" });
			await expect(
				withTx(t.pool, (tx) =>
					tryPoweredStart(tx, { machineId: id, toState: "booting" }),
				),
			).rejects.toSatisfy((e) => isSbxError(e, "invalid_state"));
			await expect(
				withTx(t.pool, (tx) =>
					tryPoweredStart(tx, { machineId: id, toState: "starting" }),
				),
			).rejects.toSatisfy((e) => isSbxError(e, "invalid_state"));
		});

		it("unknown machine is not_found", async () => {
			await expect(
				withTx(t.pool, (tx) =>
					tryPoweredStart(tx, { machineId: randomUUID(), toState: "booting" }),
				),
			).rejects.toSatisfy((e) => isSbxError(e, "not_found"));
		});

		it("10 concurrent starts at cap 6144 start exactly three 2048 MB machines", async () => {
			const topo = await createTopology(t.pool, { node: { ramCapMb: 6144 } });
			const ids: string[] = [];
			for (let i = 0; i < 10; i++) {
				ids.push(
					await insertMachine(t.pool, topo, {
						state: "provisioning",
						memoryMb: 2048,
					}),
				);
			}
			const results = await Promise.all(
				ids.map((machineId) =>
					withTx(t.pool, (tx) =>
						tryPoweredStart(tx, { machineId, toState: "booting" }),
					),
				),
			);
			expect(results.filter(Boolean)).toHaveLength(3);
			expect((await ram(topo.nodeId)).poweredMb).toBe(6144);
		});
	});

	describe("checkQuota (S6 §8.5)", () => {
		const quota = {
			maxActiveSandboxes: 3,
			maxRamMb: 6144,
			maxSavedSnapshots: 2,
		};

		it("rejects the 4th active sandbox", async () => {
			const topo = await createTopology(t.pool);
			const teamId = randomUUID();
			for (const state of ["creating", "ready", "starting"]) {
				await insertSandbox(t.pool, topo, { teamId, state, memoryMb: 1024 });
			}
			const err = await withTx(t.pool, (tx) =>
				checkQuota(tx, teamId, quota, { addSandboxes: 1, addRamMb: 1024 }),
			).catch((e: unknown) => e);
			expect(isSbxError(err, "quota_exceeded")).toBe(true);
			expect(isSbxError(err) && err.details).toEqual({
				quota: "maxActiveSandboxes",
				limit: 3,
				current: 3,
			});
		});

		it("counts only creating, ready, starting and stopping sandboxes of the team", async () => {
			const topo = await createTopology(t.pool);
			const teamId = randomUUID();
			for (const state of [
				"ready",
				"stopping",
				"stopped",
				"error",
				"deleting",
				"deleted",
			]) {
				await insertSandbox(t.pool, topo, { teamId, state, memoryMb: 1024 });
			}
			// another team
			for (let i = 0; i < 3; i++) {
				await insertSandbox(t.pool, topo, {
					teamId: randomUUID(),
					state: "ready",
				});
			}
			await expect(
				withTx(t.pool, (tx) =>
					checkQuota(tx, teamId, quota, { addSandboxes: 1, addRamMb: 1024 }),
				),
			).resolves.toBeUndefined();
		});

		it("rejects when the team's RAM would exceed maxRamMb", async () => {
			const topo = await createTopology(t.pool);
			const teamId = randomUUID();
			await insertSandbox(t.pool, topo, {
				teamId,
				state: "ready",
				memoryMb: 2048,
			});
			await insertSandbox(t.pool, topo, {
				teamId,
				state: "creating",
				memoryMb: 2048,
			});
			const err = await withTx(t.pool, (tx) =>
				checkQuota(tx, teamId, quota, { addSandboxes: 1, addRamMb: 4096 }),
			).catch((e: unknown) => e);
			expect(isSbxError(err, "quota_exceeded")).toBe(true);
			expect(isSbxError(err) && err.details.quota).toBe("maxRamMb");
			await expect(
				withTx(t.pool, (tx) =>
					checkQuota(tx, teamId, quota, { addSandboxes: 1, addRamMb: 2048 }),
				),
			).resolves.toBeUndefined();
		});

		it("rejects a saved snapshot over maxSavedSnapshots", async () => {
			const topo = await createTopology(t.pool);
			const teamId = randomUUID();
			for (const state of ["ready", "creating", "deleted"]) {
				await t.pool.query(
					`INSERT INTO runtime.snapshots (kind, team_id, name, provider_id, node_id, storage_id, template_build_id, lv_id, state)
					 VALUES ('saved', $1, $2, $3, $4, $5, $6, $7, $8)`,
					[
						teamId,
						`snap-${state}`,
						topo.providerId,
						topo.nodeId,
						topo.storageId,
						topo.templateBuildId,
						randomUUID().replaceAll("-", ""),
						state,
					],
				);
			}
			const err = await withTx(t.pool, (tx) =>
				checkQuota(tx, teamId, quota, { addSavedSnapshots: 1 }),
			).catch((e: unknown) => e);
			expect(isSbxError(err, "quota_exceeded")).toBe(true);
			expect(isSbxError(err) && err.details).toEqual({
				quota: "maxSavedSnapshots",
				limit: 2,
				current: 2,
			});
		});

		it("does not check a dimension that is not being added", async () => {
			const topo = await createTopology(t.pool);
			const teamId = randomUUID();
			for (let i = 0; i < 4; i++) {
				await insertSandbox(t.pool, topo, { teamId, state: "ready" });
			}
			await expect(
				withTx(t.pool, (tx) => checkQuota(tx, teamId, quota, {})),
			).resolves.toBeUndefined();
		});
	});

	describe("locks", () => {
		async function blocked(
			first: (tx: Parameters<typeof lockNode>[0]) => Promise<void>,
			second: (tx: Parameters<typeof lockNode>[0]) => Promise<void>,
		): Promise<boolean> {
			let release: () => void = () => {};
			const held = new Promise<void>((r) => {
				release = r;
			});
			let locked: () => void = () => {};
			const isLocked = new Promise<void>((r) => {
				locked = r;
			});
			const holder = withTx(t.pool, async (tx) => {
				await first(tx);
				locked();
				await held;
			});
			await Promise.race([isLocked, holder]);
			try {
				await withTx(t.pool, async (tx) => {
					await tx.client.query("SET LOCAL lock_timeout = '200ms'");
					await second(tx);
				});
				return false;
			} catch (e) {
				if ((e as { code?: string }).code === "55P03") return true;
				throw e;
			} finally {
				release();
				await holder;
			}
		}

		it("lockNode serializes transactions on the same node only", async () => {
			const a = randomUUID();
			const b = randomUUID();
			expect(
				await blocked(
					(tx) => lockNode(tx, a),
					(tx) => lockNode(tx, a),
				),
			).toBe(true);
			expect(
				await blocked(
					(tx) => lockNode(tx, a),
					(tx) => lockNode(tx, b),
				),
			).toBe(false);
		});

		it("lockTeam and lockNode use separate key spaces", async () => {
			const id = randomUUID();
			expect(
				await blocked(
					(tx) => lockTeam(tx, id),
					(tx) => lockTeam(tx, id),
				),
			).toBe(true);
			expect(
				await blocked(
					(tx) => lockTeam(tx, id),
					(tx) => lockNode(tx, id),
				),
			).toBe(false);
		});
	});
});
