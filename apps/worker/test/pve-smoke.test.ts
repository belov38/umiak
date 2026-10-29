// Opt-in smoke test of the real Proxmox adapter (PveInfraRegistry) against the
// host `pve`. Skipped unless SBX_PVE_SMOKE=1, so `pnpm -r test` stays offline.
// It creates at most two 2 GB VMs at a time in the provider's VMID range,
// deletes everything it created and checks that the world is unchanged.
//
//   SBX_PVE_SMOKE=1 pnpm --filter @sbx/worker exec vitest run test/pve-smoke.test.ts
//
// Env: SBX_SECRETS_DIR (default ~/.config/sbx), SBX_NODE_SSH_HOST (default
// 100.64.10.2), SBX_PVE_TOKEN_ID (adapter default).
import { randomBytes, randomUUID } from "node:crypto";
import { homedir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { StaticConfigReader } from "@sbx/config";
import { type JobSender, KeyRing } from "@sbx/core";
import { dbOf } from "@sbx/db";
import { createTestDatabase, type TestDatabase } from "@sbx/db/testing";
import { type NodeOps, type PveClient, s2SerialPayload } from "@sbx/pve";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { UnavailableAgentPort } from "../src/adapters/agent-unavailable.ts";
import {
	PveInfraRegistry,
	pveClientsFromSecrets,
} from "../src/adapters/pve-infra.ts";
import { runAdmin } from "../src/admin/commands.ts";
import {
	DEFAULT_TIMING,
	RecordingMetrics,
	type WorkerCtx,
} from "../src/context.ts";
import { runReconcile } from "../src/controllers/reconcile.ts";
import {
	type GatewayPort,
	type InfraSize,
	type InfraSmbios,
	type InfraSnapshotRef,
	type InfraVm,
	isRetryable,
	type NodeInfra,
} from "../src/ports.ts";
import { testLogger } from "./helpers/worker.ts";

const SMOKE = process.env.SBX_PVE_SMOKE === "1";
const CONFIG_FILE = fileURLToPath(
	new URL("../../../deploy/compose/config/sbx.yaml", import.meta.url),
);
const SECRETS_DIR =
	process.env.SBX_SECRETS_DIR ?? join(homedir(), ".config", "sbx");
const SSH_HOST = process.env.SBX_NODE_SSH_HOST ?? "100.64.10.2";
const TEMPLATE_VMID = 599;
const SIZE: InfraSize = { vcpu: 2, memoryMb: 2048 };
/** Host rule: at most 2 sandbox VMs of 2 GB running at once. */
const MAX_RUNNING = 2;
const STEP_TIMEOUT = 15 * 60_000;

// --- world diff (same logic as apps/bench/src/world.ts) ----------------------

type World = Record<string, unknown>;

function rows(v: unknown): string[] {
	if (Array.isArray(v)) return v.map((x) => JSON.stringify(x)).sort();
	if (v && typeof v === "object") {
		return Object.entries(v as Record<string, unknown>)
			.flatMap(([k, x]) =>
				Array.isArray(x) || (x && typeof x === "object")
					? rows(x).map((r) => `${k}: ${r}`)
					: [`${k}: ${JSON.stringify(x)}`],
			)
			.sort();
	}
	return [JSON.stringify(v)];
}

function diffWorld(before: World, after: World): string[] {
	const out: string[] = [];
	const keys = new Set([...Object.keys(before), ...Object.keys(after)]);
	for (const k of [...keys].sort()) {
		if (k === "search") continue;
		const a = new Set(rows(before[k]));
		const b = new Set(rows(after[k]));
		for (const r of a) if (!b.has(r)) out.push(`${k}: - ${r}`);
		for (const r of b) if (!a.has(r)) out.push(`${k}: + ${r}`);
	}
	return out;
}

// --- state -------------------------------------------------------------------

let db: TestDatabase;
let registry: PveInfraRegistry;
let infra: NodeInfra;
let nodeOps: NodeOps | undefined;
let pveApi: PveClient | undefined;
let nodeId: string;
let worldBefore: World;
let vmsBefore: InfraVm[];
let lvsBefore: string[];

/** Every machine id handed to create/fork (their leases find partial VMs). */
const machineIds: string[] = [];
const vmids = new Set<number>();
/** Every VMID and snapshot id this run ever created (for the final LV check). */
const createdVmids = new Set<number>();
const createdLvIds = new Set<string>();
/** Snapshots that exist on the host, keyed by lvId. */
const snapshots = new Map<string, InfraSnapshotRef>();
const timings: { step: string; ms: number }[] = [];
const remains: string[] = [];

const log = (s: string) =>
	process.stderr.write(
		`[pve-smoke ${new Date().toISOString().slice(11, 19)}] ${s}\n`,
	);

async function timed<T>(step: string, fn: () => Promise<T>): Promise<T> {
	const t0 = performance.now();
	try {
		return await fn();
	} finally {
		const ms = Math.round(performance.now() - t0);
		timings.push({ step, ms });
		log(`${step}: ${ms} ms`);
	}
}

const inRange = (vmid: number) => vmid >= 500 && vmid <= 598;

function smbios(machineId: string): InfraSmbios {
	// The serial carries a bootstrap secret: never log it.
	return {
		uuid: randomUUID(),
		serial: s2SerialPayload(machineId, randomBytes(32)),
	};
}

async function until<T>(
	what: string,
	fn: () => Promise<T>,
	ok: (v: T) => boolean,
	timeoutMs = 120_000,
): Promise<T> {
	const end = Date.now() + timeoutMs;
	for (;;) {
		const v = await fn();
		if (ok(v)) return v;
		if (Date.now() > end)
			throw new Error(`${what}: timed out (last ${String(v)})`);
		await new Promise((r) => setTimeout(r, 1000));
	}
}

/** Sandbox VMs that run, by status/current (authoritative per VM). */
async function runningSandboxVms(): Promise<number[]> {
	const listed = (await infra.listVms()).filter((v) => inRange(v.vmid));
	const raw = await (pveApi as PveClient).get<
		{ vmid: number; status?: string }[]
	>("/cluster/resources", { type: "vm" });
	log(
		`listVms in range: ${JSON.stringify(listed.map((v) => [v.vmid, v.status]))}, raw: ${JSON.stringify(raw.filter((r) => inRange(r.vmid)).map((r) => [r.vmid, r.status]))}`,
	);
	const out: number[] = [];
	for (const v of listed)
		if ((await infra.status(v.vmid)) !== "stopped") out.push(v.vmid);
	return out;
}

async function assertRoomFor(n: number): Promise<void> {
	const running = await runningSandboxVms();
	if (running.length + n > MAX_RUNNING)
		throw new Error(
			`refusing to start ${n} VM(s): already running ${running.join(",")}`,
		);
}

async function createVm(label: string): Promise<number> {
	const machineId = randomUUID();
	machineIds.push(machineId);
	const vm = await timed(`create ${label}`, () =>
		infra.create({
			machineId,
			templateVmid: TEMPLATE_VMID,
			size: SIZE,
			smbios: smbios(machineId),
		}),
	);
	vmids.add(vm.vmid);
	createdVmids.add(vm.vmid);
	expect(inRange(vm.vmid)).toBe(true);
	log(`${label} = VM ${vm.vmid}`);
	return vm.vmid;
}

async function deleteVm(label: string, vmid: number): Promise<void> {
	await timed(`delete ${label}`, async () => {
		for (let attempt = 1; ; attempt++) {
			try {
				await infra.delete(vmid);
				break;
			} catch (err) {
				// A retried delete is safe (the lease stays `releasing`).
				if (!isRetryable(err) || attempt >= 3) throw err;
				log(`delete ${vmid} attempt ${attempt} failed (transient): ${err}`);
				await new Promise((r) => setTimeout(r, 5000));
			}
		}
	});
	vmids.delete(vmid);
}

/**
 * Deletes everything this run created that is still tracked: VMs that are
 * not snapshot sources, then snapshots, then the rest. Records what remains.
 */
async function cleanup(): Promise<void> {
	if (!infra) return;
	for (const id of machineIds) {
		const l = await infra.leaseOf(id).catch(() => undefined);
		if (l) vmids.add(l.vmid);
	}
	const sources = new Set([...snapshots.values()].map((s) => s.sourceVmid));
	const del = async (v: number) => {
		try {
			await deleteVm(`cleanup ${v}`, v);
		} catch (e) {
			remains.push(`VM ${v}: ${e}`);
		}
	};
	for (const v of [...vmids].filter((x) => !sources.has(x))) await del(v);
	for (const [id, ref] of [...snapshots]) {
		try {
			await infra.deleteSnapshot(ref);
			snapshots.delete(id);
		} catch (e) {
			remains.push(`snapshot ${id} of VM ${ref.sourceVmid}: ${e}`);
		}
	}
	for (const v of [...vmids].filter((x) => sources.has(x))) await del(v);
}

describe.skipIf(!SMOKE)("real pve adapter smoke", () => {
	beforeAll(async () => {
		db = await createTestDatabase();
		const { log: logger } = testLogger("warn");
		const err: unknown[] = [];
		const code = await runAdmin(["bootstrap"], {
			pool: db.pool,
			out: () => {},
			err: (l) => err.push(l),
			config: () => StaticConfigReader.fromFile(CONFIG_FILE),
			log: logger,
		});
		expect(err).toEqual([]);
		expect(code).toBe(0);
		const n = await db.pool.query<{ id: string }>(
			"SELECT id FROM runtime.nodes WHERE name = 'pve'",
		);
		nodeId = n.rows[0]?.id ?? "";
		expect(nodeId).not.toBe("");

		const env = { ...process.env, SBX_NODE_SSH_HOST: SSH_HOST };
		const factory = pveClientsFromSecrets(SECRETS_DIR, env);
		registry = new PveInfraRegistry(db.pool, {
			secretsDir: SECRETS_DIR,
			env,
			clients: async (t) => {
				const c = await factory(t);
				nodeOps = c.node;
				pveApi = c.api;
				return c;
			},
		});
		infra = await registry.forNode(nodeId);
		expect(infra.templateVmids).toEqual([TEMPLATE_VMID]);
		expect(infra.vmidRange).toEqual({ min: 500, max: 598 });

		// 1. World before.
		worldBefore = await (nodeOps as NodeOps).call<World>("inventory");
		vmsBefore = await infra.listVms();
		lvsBefore = (await infra.listLvs()).map((l) => l.name).sort();
		log(
			`before: ${vmsBefore.length} VMs visible (${vmsBefore.map((v) => v.vmid).join(",")}), ${lvsBefore.length} sbx LVs`,
		);
		// A leftover sandbox VM would break the RAM cap and the world check.
		expect(vmsBefore.filter((v) => inRange(v.vmid))).toEqual([]);
	}, STEP_TIMEOUT);

	afterAll(async () => {
		try {
			await cleanup();
		} finally {
			log(`timings: ${JSON.stringify(timings)}`);
			if (remains.length > 0) log(`REMAINS ON HOST: ${remains.join("; ")}`);
			await registry?.close();
			await db?.drop();
		}
	}, STEP_TIMEOUT);

	let a: number | undefined;

	it(
		"create, start (power lock), shutdown",
		async () => {
			a = await createVm("A");
			expect(await infra.status(a)).toBe("stopped");
			const size = await infra.vmSize(a);
			expect(size).toEqual(SIZE);

			await assertRoomFor(1);
			const vmA = a;
			await timed("start A", () => infra.start(vmA));
			expect(await infra.status(vmA)).toBe("running");

			const r = await timed("shutdown A (60 s)", () => infra.shutdown(vmA, 60));
			log(`shutdown A: ${r}`);
			if (r === "timeout") await timed("stop A", () => infra.stop(vmA));
			await until(
				"A stopped",
				() => infra.status(vmA),
				(s) => s === "stopped",
			);
		},
		STEP_TIMEOUT,
	);

	it(
		"snapshot while stopped, fork, configure, delete",
		async () => {
			expect(a).toBeDefined();
			const vmA = a as number;
			const lvId = randomBytes(16).toString("hex");
			createdLvIds.add(lvId);
			const snap = await timed("snapshot A", () =>
				infra.snapshot(vmA, { lvId }),
			);
			const ref: InfraSnapshotRef = {
				lvId,
				sourceVmid: vmA,
				disks: snap.disks,
				hw: snap.hw,
			};
			snapshots.set(lvId, ref);
			expect(snap.consistency).toBe("powered_off");
			expect(snap.disks.length).toBeGreaterThan(0);
			const snapLvs = (await infra.listLvs()).filter((l) =>
				l.tags.includes(`sbx-snap-${lvId}`),
			);
			expect(snapLvs.length).toBe(snap.disks.length);

			const machineB = randomUUID();
			machineIds.push(machineB);
			const b = await timed("fork B", () =>
				infra.fork({
					machineId: machineB,
					snapshot: ref,
					size: SIZE,
					smbios: smbios(machineB),
				}),
			);
			vmids.add(b.vmid);
			createdVmids.add(b.vmid);
			log(`B = VM ${b.vmid} (fork of snapshot of ${vmA})`);
			expect(inRange(b.vmid)).toBe(true);
			expect(b.vmid).not.toBe(vmA);
			expect(await infra.status(b.vmid)).toBe("stopped");
			expect(await infra.leaseOf(machineB)).toEqual({
				vmid: b.vmid,
				mac: b.mac,
			});

			expect(await infra.vmSize(b.vmid)).toEqual(SIZE);
			await timed("configure B", () => infra.configure(b.vmid, SIZE));
			expect(await infra.vmSize(b.vmid)).toEqual(SIZE);

			await deleteVm("B", b.vmid);
			expect(await infra.status(b.vmid)).toBe("missing");
			expect(await infra.leaseOf(machineB)).toBeUndefined();

			await timed("deleteSnapshot", () => infra.deleteSnapshot(ref));
			snapshots.delete(lvId);
			expect(
				(await infra.listLvs()).filter((l) =>
					l.tags.includes(`sbx-snap-${lvId}`),
				),
			).toEqual([]);

			await deleteVm("A", vmA);
			expect(await infra.status(vmA)).toBe("missing");
		},
		STEP_TIMEOUT,
	);

	it(
		"power lock: two concurrent starts on one node, concurrent deletes",
		async () => {
			const [c, d] = await timed("create C+D (parallel)", () =>
				Promise.all([createVm("C"), createVm("D")]),
			);
			expect(c).not.toBe(d);
			await assertRoomFor(2);
			const spans: { vmid: number; t0: number; t1: number }[] = [];
			const t0 = Date.now();
			await timed("start C+D (concurrent)", () =>
				Promise.all(
					[c, d].map(async (v) => {
						const s = Date.now();
						await infra.start(v);
						spans.push({ vmid: v, t0: s - t0, t1: Date.now() - t0 });
					}),
				),
			);
			log(`start spans (ms from launch): ${JSON.stringify(spans)}`);
			expect(await infra.status(c)).toBe("running");
			expect(await infra.status(d)).toBe("running");
			const running = await runningSandboxVms();
			expect(running.sort()).toEqual([c, d].sort());

			await timed("delete C+D (concurrent)", () =>
				Promise.all([deleteVm("C", c), deleteVm("D", d)]),
			);
			expect(await infra.status(c)).toBe("missing");
			expect(await infra.status(d)).toBe("missing");
		},
		STEP_TIMEOUT,
	);

	it(
		"reconcile dry run plans nothing destructive",
		async () => {
			// Precondition: no sandbox VM of ours (a failed step above may leave one).
			await cleanup();
			expect((await infra.listVms()).filter((v) => inRange(v.vmid))).toEqual(
				[],
			);
			const metrics = new RecordingMetrics();
			const { log: logger } = testLogger("warn");
			const ctx: WorkerCtx = {
				pool: db.pool,
				db: dbOf(db.pool),
				jobs: {
					send: async () => {
						throw new Error("dry run sends no jobs");
					},
				} as JobSender,
				config: StaticConfigReader.fromFile(CONFIG_FILE),
				keys: KeyRing.fromObject({
					current: 1,
					keys: { "1": randomBytes(32).toString("base64") },
				}),
				infra: registry,
				agent: new UnavailableAgentPort(),
				gateway: {
					rotateToken: async () => {
						throw new Error("no gateway");
					},
				} satisfies GatewayPort,
				timing: DEFAULT_TIMING,
				log: logger,
				metrics,
				reconcileDryRun: true,
			};
			const actions = await timed("reconcile dry run", () =>
				runReconcile(ctx, { dryRun: true }),
			);
			log(`reconcile actions: ${JSON.stringify(actions)}`);
			expect(metrics.count("sbx_reconcile_failed_total")).toBe(0);
			expect(actions.filter((x) => x.applied)).toEqual([]);
			const touches = (x: { target: string }) => {
				const m = /^vm:(\d+)$/.exec(x.target);
				return (
					m !== null && (Number(m[1]) === TEMPLATE_VMID || Number(m[1]) < 500)
				);
			};
			expect(actions.filter(touches)).toEqual([]);
			expect(actions).toEqual([]);
		},
		STEP_TIMEOUT,
	);

	it(
		"leases freed and world after equals world before",
		async () => {
			await cleanup();
			expect(remains).toEqual([]);
			const leases = await db.pool.query<{ vmid: number; state: string }>(
				`SELECT vmid, state FROM runtime.vmid_leases
				 WHERE purpose = 'machine' OR machine_id = ANY($1::uuid[])`,
				[machineIds],
			);
			expect(leases.rows).toEqual([]);

			const worldAfter = await (nodeOps as NodeOps).call<World>("inventory");
			const diff = diffWorld(worldBefore, worldAfter);
			log(`world diff: ${diff.length === 0 ? "empty" : diff.join(" | ")}`);
			expect(diff).toEqual([]);

			const vmsAfter = await infra.listVms();
			expect(vmsAfter.filter((v) => inRange(v.vmid))).toEqual([]);
			expect(vmsAfter.map((v) => v.vmid).sort()).toEqual(
				vmsBefore.map((v) => v.vmid).sort(),
			);
			const lvs = await infra.listLvs();
			const ourTags = new Set([
				...[...createdVmids].map((v) => `sbx-vm-${v}`),
				...[...createdLvIds].map((id) => `sbx-snap-${id}`),
			]);
			expect(lvs.filter((l) => l.tags.some((t) => ourTags.has(t)))).toEqual([]);
			expect(lvs.map((l) => l.name).sort()).toEqual(lvsBefore);
		},
		STEP_TIMEOUT,
	);
});
