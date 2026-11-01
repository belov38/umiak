import { randomUUID } from "node:crypto";
import { chmodSync, mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createTestDatabase, type TestDatabase } from "@sbx/db/testing";
import {
	formatSmbios1,
	NodeOpsError,
	OwnerMismatchError,
	PveApi,
	PveApiError,
	PveTaskError,
	SshNodeOps,
} from "@sbx/pve";
import { FakeNode, FakePve, TEMPLATE_CONFIG } from "@sbx/pve/testing";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import {
	loadNodeTopology,
	PveInfraRegistry,
	pveClientsFromSecrets,
} from "../src/adapters/pve-infra.ts";
import { QuiesceFailed } from "../src/ops/snapshot-step.ts";
import {
	type InfraSmbios,
	isPermanent,
	isRetryable,
	type NodeInfra,
} from "../src/ports.ts";
import { FencedOut } from "../src/steps.ts";
import { createTopology, type Topology } from "./fakes/world.ts";

let db: TestDatabase;

beforeAll(async () => {
	db = await createTestDatabase();
});

afterAll(async () => {
	await db?.drop();
});

const SIZE = { vcpu: 2, memoryMb: 2048 };

/** A caller without a fence to re-check. */
const noFence = async () => {};

function smbiosFor(machineId: string): InfraSmbios {
	return {
		uuid: machineId,
		serial: `sbx1:${machineId}:${Buffer.alloc(32, 7).toString("base64url")}`,
	};
}

async function nodeName(nodeId: string): Promise<string> {
	const r = await db.pool.query<{ name: string }>(
		"SELECT name FROM runtime.nodes WHERE id = $1",
		[nodeId],
	);
	return r.rows[0]?.name ?? "";
}

async function leases(providerId: string) {
	const r = await db.pool.query<{
		vmid: number;
		mac: string;
		state: string;
		machine_id: string | null;
		purpose: string;
	}>(
		"SELECT vmid, mac, state, machine_id, purpose FROM runtime.vmid_leases WHERE provider_id = $1 ORDER BY vmid",
		[providerId],
	);
	return r.rows;
}

interface Env {
	topo: Topology;
	name: string;
	api: FakePve;
	node: FakeNode;
	registry: PveInfraRegistry;
	infra: NodeInfra;
	factoryCalls: number;
}

async function setup(
	o: {
		env?: Record<string, string>;
		vmLockSleep?: (ms: number) => Promise<void>;
	} = {},
): Promise<Env> {
	const topo = await createTopology(db.pool);
	const name = await nodeName(topo.nodeId);
	const api = new FakePve([], { node: name });
	// The template is visible in the pool: the anchor of "missing" detection.
	api.vms.set(599, {
		config: { ...TEMPLATE_CONFIG },
		status: "stopped",
		firewall: { rules: [], ipsets: {} },
	});
	const node = new FakeNode();
	const env = { topo, name, api, node, factoryCalls: 0 } as Env;
	env.registry = new PveInfraRegistry(db.pool, {
		...(o.vmLockSleep ? { vmLockSleep: o.vmLockSleep } : {}),
		secretsDir: "/nonexistent",
		...(o.env ? { env: o.env } : {}),
		clients: () => {
			env.factoryCalls += 1;
			return { api, node };
		},
	});
	env.infra = await env.registry.forNode(topo.nodeId);
	return env;
}

describe("PveInfraRegistry", () => {
	it("a running Windows snapshot needs an explicit crashConsistent, also with an agent-only preparation hook", async () => {
		const e = await setup();
		const m = randomUUID();
		const vm = await e.infra.create({
			machineId: m,
			templateVmid: 599,
			size: SIZE,
			smbios: smbiosFor(m),
		});
		const config = e.api.vms.get(vm.vmid)?.config;
		if (!config) throw new Error("fake VM missing");
		config.ostype = "win11";
		await e.infra.start(vm.vmid, { expectedOwner: m, beforeAct: noFence });
		e.api.agentUp = false;
		const hook = {
			freeze: async () => {
				trace.push("agent.prepare");
			},
			thaw: async () => {
				trace.push("agent.restore");
			},
		};
		const trace: string[] = [];
		for (const o of [{}, { hook }]) {
			await expect(
				e.infra.snapshot(vm.vmid, {
					lvId: randomUUID().replaceAll("-", ""),
					...o,
				}),
			).rejects.toMatchObject({
				code: "snapshot_requires_stop",
				retryable: false,
			});
		}
		expect(trace).toEqual([]);
		const first = await e.infra.snapshot(vm.vmid, {
			lvId: randomUUID().replaceAll("-", ""),
			crashConsistent: true,
		});
		expect(first.consistency).toBe("crash");
		const second = await e.infra.snapshot(vm.vmid, {
			lvId: randomUUID().replaceAll("-", ""),
			crashConsistent: true,
			hook: {
				freeze: async () => {
					trace.push("agent.prepare");
				},
				thaw: async () => {
					trace.push("agent.restore");
				},
			},
		});
		expect(second.consistency).toBe("crash");
		expect(trace).toEqual(["agent.prepare", "agent.restore"]);
		expect(e.api.calls.filter((c) => c.path.includes("/agent/"))).toHaveLength(
			0,
		);
	});
	it("retries the stop inside delete while releasing the power lock between attempts", async () => {
		let key = "";
		let elapsed = 0;
		const e = await setup({
			vmLockSleep: async (ms) => {
				elapsed += ms;
				if (elapsed >= 30_000) delete e.api.fail[key];
			},
		});
		const m = randomUUID();
		const vm = await e.infra.create({
			machineId: m,
			templateVmid: 599,
			size: SIZE,
			smbios: smbiosFor(m),
		});
		await e.infra.start(vm.vmid, { expectedOwner: m, beforeAct: noFence });
		key = `POST /nodes/${e.name}/qemu/${vm.vmid}/status/stop`;
		e.api.fail[key] = new PveTaskError(
			"upid",
			"can't lock file 'vm' - got timeout",
		);
		await e.infra.delete(vm.vmid, { expectedOwner: m });
		expect(elapsed).toBe(30_000);
		expect(e.api.vms.has(vm.vmid)).toBe(false);
	});

	it("retries stop past qmeventd's 30 second window and rechecks its fence", async () => {
		let elapsed = 0;
		const e = await setup({
			vmLockSleep: async (ms) => {
				elapsed += ms;
			},
		});
		const m = randomUUID();
		const vm = await e.infra.create({
			machineId: m,
			templateVmid: 599,
			size: SIZE,
			smbios: smbiosFor(m),
		});
		await e.infra.start(vm.vmid, { expectedOwner: m, beforeAct: noFence });
		const key = `POST /nodes/${e.name}/qemu/${vm.vmid}/status/stop`;
		e.api.fail[key] = new PveTaskError(
			"upid",
			"can't lock file '/var/lock/qemu-server/lock.conf' - got timeout",
		);
		let checks = 0;
		await e.infra.stop(vm.vmid, {
			expectedOwner: m,
			beforeAct: async () => {
				checks++;
				if (elapsed > 30_000) delete e.api.fail[key];
			},
		});
		expect(elapsed).toBe(40_000);
		expect(checks).toBeGreaterThanOrEqual(5);
		expect(await e.infra.status(vm.vmid)).toBe("stopped");
	});

	it("does not retry a stop after its executor is fenced out", async () => {
		let stale = false;
		const e = await setup({
			vmLockSleep: async () => {
				stale = true;
			},
		});
		const m = randomUUID();
		const vm = await e.infra.create({
			machineId: m,
			templateVmid: 599,
			size: SIZE,
			smbios: smbiosFor(m),
		});
		await e.infra.start(vm.vmid, { expectedOwner: m, beforeAct: noFence });
		const path = `/nodes/${e.name}/qemu/${vm.vmid}/status/stop`;
		e.api.fail[`POST ${path}`] = new PveTaskError(
			"upid",
			"can't lock file 'vm' - got timeout",
		);
		await expect(
			e.infra.stop(vm.vmid, {
				expectedOwner: m,
				beforeAct: async () => {
					if (stale) throw new FencedOut("superseded during lock retry");
				},
			}),
		).rejects.toBeInstanceOf(FencedOut);
		expect(
			e.api.calls.filter((c) => c.method === "POST" && c.path === path),
		).toHaveLength(1);
		expect(await e.infra.status(vm.vmid)).toBe("running");
	});

	it("rechecks ownership before retrying a stop on a recycled VMID", async () => {
		let recycle!: () => Promise<void>;
		let changed = false;
		const e = await setup({
			vmLockSleep: async () => {
				if (!changed) {
					changed = true;
					await recycle();
				}
			},
		});
		const m = randomUUID();
		const vm = await e.infra.create({
			machineId: m,
			templateVmid: 599,
			size: SIZE,
			smbios: smbiosFor(m),
		});
		await e.infra.start(vm.vmid, { expectedOwner: m, beforeAct: noFence });
		const path = `/nodes/${e.name}/qemu/${vm.vmid}/status/stop`;
		e.api.fail[`POST ${path}`] = new PveTaskError(
			"upid",
			"can't lock file 'vm' - got timeout",
		);
		recycle = async () => {
			delete e.api.fail[`POST ${path}`];
			await db.pool.query(
				"UPDATE runtime.vmid_leases SET machine_id = $3 WHERE provider_id = $1 AND vmid = $2",
				[e.topo.providerId, vm.vmid, randomUUID()],
			);
		};
		await expect(
			e.infra.stop(vm.vmid, { expectedOwner: m }),
		).rejects.toBeInstanceOf(OwnerMismatchError);
		expect(
			e.api.calls.filter((c) => c.method === "POST" && c.path === path),
		).toHaveLength(1);
		expect(await e.infra.status(vm.vmid)).toBe("running");
	});
	it("hard-stops a guest after failed thaw and allows a normal start", async () => {
		const e = await setup();
		const m = randomUUID();
		const vm = await e.infra.create({
			machineId: m,
			templateVmid: 599,
			size: SIZE,
			smbios: smbiosFor(m),
		});
		await e.infra.start(vm.vmid, { expectedOwner: m, beforeAct: noFence });
		const err = await e.infra
			.snapshot(vm.vmid, {
				lvId: randomUUID().replaceAll("-", ""),
				hook: {
					freeze: async () => {},
					thaw: async () => {
						throw new Error("QGA dead");
					},
				},
			})
			.catch((x: unknown) => x);
		expect(err).toBeInstanceOf(QuiesceFailed);
		expect((err as Error).message).toMatch(/hard-stopped/);
		expect(await e.infra.status(vm.vmid)).toBe("stopped");
		await e.infra.start(vm.vmid, { expectedOwner: m, beforeAct: noFence });
		expect(await e.infra.status(vm.vmid)).toBe("running");
	});
	it("builds the clients of a node once and caches them", async () => {
		const e = await setup();
		expect(await e.registry.forNode(e.topo.nodeId)).toBe(e.infra);
		expect(e.factoryCalls).toBe(1);
		expect(e.infra.vmidRange).toEqual({ min: 500, max: 598 });
		expect(e.infra.templateVmids).toEqual([599]);
	});

	it("an unknown node is an error", async () => {
		const e = await setup();
		await expect(e.registry.forNode(randomUUID())).rejects.toThrow(/node/);
	});

	it("records a template lease for the active template", async () => {
		const e = await setup();
		expect(await leases(e.topo.providerId)).toEqual([
			expect.objectContaining({ vmid: 599, purpose: "template" }),
		]);
	});
});

describe("tunnel URL in smbios family (S5 section 14)", () => {
	it("create and fork write family=sbxt1:<SBX_TUNNEL_URL> into smbios1", async () => {
		const url = "wss://tunnel.example.com/v1/connect";
		const e = await setup({ env: { SBX_TUNNEL_URL: url } });
		const m = randomUUID();
		const smbios = smbiosFor(m);
		const vm = await e.infra.create({
			machineId: m,
			templateVmid: 599,
			size: { vcpu: 2, memoryMb: 2048 },
			smbios,
		});
		expect(e.api.vms.get(vm.vmid)?.config.smbios1).toBe(
			formatSmbios1({ ...smbios, family: `sbxt1:${url}` }),
		);

		const lvId = randomUUID().replaceAll("-", "");
		const snap = await e.infra.snapshot(vm.vmid, { lvId });
		const child = randomUUID();
		const forked = await e.infra.fork({
			machineId: child,
			snapshot: {
				lvId,
				sourceVmid: vm.vmid,
				disks: snap.disks,
				hw: snap.hw,
			},
			smbios: smbiosFor(child),
		});
		expect(forked.vmid).not.toBe(vm.vmid);
		expect(e.api.vms.get(forked.vmid)?.config.smbios1).toBe(
			formatSmbios1({ ...smbiosFor(child), family: `sbxt1:${url}` }),
		);
	});

	it("without SBX_TUNNEL_URL there is no family", async () => {
		const e = await setup({ env: {} });
		const m = randomUUID();
		const vm = await e.infra.create({
			machineId: m,
			templateVmid: 599,
			size: { vcpu: 2, memoryMb: 2048 },
			smbios: smbiosFor(m),
		});
		expect(e.api.vms.get(vm.vmid)?.config.smbios1).not.toContain("family=");
	});

	it("an invalid SBX_TUNNEL_URL fails at start", () => {
		expect(
			() =>
				new PveInfraRegistry(db.pool, {
					secretsDir: "/nonexistent",
					env: { SBX_TUNNEL_URL: "http://plain" },
					clients: () => {
						throw new Error("unused");
					},
				}),
		).toThrow(/SBX_TUNNEL_URL/);
	});
});

describe("PveNodeInfra lifecycle", () => {
	let e: Env;
	beforeEach(async () => {
		e = await setup();
	});

	it("create, start, status, snapshot, delete; the lease lives in Postgres", async () => {
		const machineId = randomUUID();
		const smbios = smbiosFor(machineId);
		const vm = await e.infra.create({
			machineId,
			templateVmid: 599,
			size: { vcpu: 3, memoryMb: 3072 },
			smbios,
		});
		expect(vm.vmid).toBe(500);
		expect(vm.disks).toEqual([
			{
				slot: "scsi0",
				volume: "local-lvm:vm-500-disk-0",
				options: { discard: "on", iothread: "1", ssd: "1" },
			},
		]);
		const cfg = e.api.vms.get(500)?.config ?? {};
		expect(cfg.smbios1).toBe(formatSmbios1(smbios));
		expect(cfg.cores).toBe("3");
		expect(cfg.memory).toBe("3072");
		expect(await leases(e.topo.providerId)).toContainEqual(
			expect.objectContaining({
				vmid: 500,
				mac: vm.mac,
				state: "active",
				machine_id: machineId,
			}),
		);
		expect(await e.infra.leaseOf(machineId)).toEqual({
			vmid: 500,
			mac: vm.mac,
		});
		expect(await e.infra.vmSize(500)).toEqual({ vcpu: 3, memoryMb: 3072 });

		expect(await e.infra.status(500)).toBe("stopped");
		await e.infra.start(500, { expectedOwner: machineId, beforeAct: noFence });
		expect(await e.infra.status(500)).toBe("running");
		expect(await e.infra.qgaPing(500)).toBe(true);
		expect(await e.infra.qgaExec(500, ["true"])).toEqual({ exitCode: 0 });

		const lvId = randomUUID().replaceAll("-", "");
		const snap = await e.infra.snapshot(500, { lvId });
		expect(snap.consistency).toBe("quiesced");
		expect(snap.disks).toEqual([
			{
				slot: "scsi0",
				volume: `local-lvm:sbx-snap-${lvId}-scsi0`,
				options: { discard: "on", iothread: "1", ssd: "1" },
			},
		]);
		expect(snap.hw).toMatchObject({ cores: "3", memory: "3072" });
		expect(e.api.paths()).toContain(
			`POST /nodes/${e.name}/qemu/500/agent/fsfreeze-freeze`,
		);
		expect((await e.infra.listLvs()).map((l) => l.name)).toContain(
			`sbx-snap-${lvId}-scsi0`,
		);

		await e.infra.delete(500, { expectedOwner: machineId });
		expect(e.api.vms.has(500)).toBe(false);
		expect(await e.infra.status(500)).toBe("missing");
		expect(await e.infra.leaseOf(machineId)).toBeUndefined();
		expect(
			(await leases(e.topo.providerId)).filter((l) => l.vmid === 500),
		).toEqual([]);
	});

	it("a snapshot with an external hook uses it and not QGA; stopped is powered_off", async () => {
		const m = randomUUID();
		const { vmid } = await e.infra.create({
			machineId: m,
			templateVmid: 599,
			size: SIZE,
			smbios: smbiosFor(m),
		});
		const stopped = await e.infra.snapshot(vmid, {
			lvId: randomUUID().replaceAll("-", ""),
		});
		expect(stopped.consistency).toBe("powered_off");

		await e.infra.start(vmid, { expectedOwner: m, beforeAct: noFence });
		const hookCalls: string[] = [];
		const snap = await e.infra.snapshot(vmid, {
			lvId: randomUUID().replaceAll("-", ""),
			hook: {
				freeze: async () => {
					hookCalls.push("freeze");
				},
				thaw: async () => {
					hookCalls.push("thaw");
				},
			},
		});
		expect(snap.consistency).toBe("quiesced");
		expect(hookCalls).toEqual(["freeze", "thaw"]);
		expect(e.api.paths().some((p) => p.includes("fsfreeze"))).toBe(false);
	});

	it("qgaFreezeHook freezes and thaws through QGA; an already thawed guest is a QuiesceFailed", async () => {
		const m = randomUUID();
		const { vmid } = await e.infra.create({
			machineId: m,
			templateVmid: 599,
			size: SIZE,
			smbios: smbiosFor(m),
		});
		await e.infra.start(vmid, { expectedOwner: m, beforeAct: noFence });
		const freeze = `POST /nodes/${e.name}/qemu/${vmid}/agent/fsfreeze-freeze`;
		const thaw = `POST /nodes/${e.name}/qemu/${vmid}/agent/fsfreeze-thaw`;

		// Thaw without a freeze does nothing.
		const idle = e.infra.qgaFreezeHook(vmid);
		await idle.thaw();
		expect(e.api.paths()).not.toContain(thaw);

		const clean = e.infra.qgaFreezeHook(vmid);
		await clean.freeze();
		expect(e.api.guestFrozen).toBe(true);
		await clean.thaw();
		expect(e.api.guestFrozen).toBe(false);
		await clean.thaw();
		expect(e.api.paths().filter((p) => p === thaw)).toHaveLength(1);

		// VSS released the writers by itself: the thaw is not an error for QGA,
		// but the snapshot is not consistent. The outcome is kept for retries.
		const late = e.infra.qgaFreezeHook(vmid);
		await late.freeze();
		e.api.guestFrozen = false;
		await expect(late.thaw()).rejects.toBeInstanceOf(QuiesceFailed);
		await expect(late.thaw()).rejects.toBeInstanceOf(QuiesceFailed);
		expect(e.api.paths().filter((p) => p === freeze)).toHaveLength(2);
		expect(e.api.paths().filter((p) => p === thaw)).toHaveLength(1);
	});

	it("qgaFreezeHook: a freeze that returns after a thaw request is thawed by the next thaw", async () => {
		const m = randomUUID();
		const { vmid } = await e.infra.create({
			machineId: m,
			templateVmid: 599,
			size: SIZE,
			smbios: smbiosFor(m),
		});
		await e.infra.start(vmid, { expectedOwner: m, beforeAct: noFence });
		const freezePath = `/nodes/${e.name}/qemu/${vmid}/agent/fsfreeze-freeze`;
		const api = e.api;
		const post = api.post.bind(api);
		let release = () => {};
		const gate = new Promise<void>((r) => {
			release = r;
		});
		// VSS takes effect only after S1 gave up waiting for the freeze.
		api.post = (async (path: string, params?: never) => {
			if (path === freezePath) await gate;
			return post(path, params);
		}) as typeof api.post;
		const hook = e.infra.qgaFreezeHook(vmid);
		const pending = hook.freeze();
		await hook.thaw();
		release();
		await pending;
		expect(api.guestFrozen).toBe(true);
		// S1 thaws again once the late freeze returns (lvmthin #freeze).
		await hook.thaw();
		expect(api.guestFrozen).toBe(false);
	});

	it("qgaFreezeHook: a thaw call that fails because VSS thawed meanwhile is a QuiesceFailed", async () => {
		const m = randomUUID();
		const { vmid } = await e.infra.create({
			machineId: m,
			templateVmid: 599,
			size: SIZE,
			smbios: smbiosFor(m),
		});
		await e.infra.start(vmid, { expectedOwner: m, beforeAct: noFence });
		const hook = e.infra.qgaFreezeHook(vmid);
		await hook.freeze();
		// fsfreeze-status still says frozen; VSS gives up between it and the thaw call.
		const api = e.api;
		Object.defineProperty(
			api.fail,
			`POST /nodes/${e.name}/qemu/${vmid}/agent/fsfreeze-thaw`,
			{
				get() {
					api.guestFrozen = false;
					return new PveApiError(500, "guest-fsfreeze-thaw failed");
				},
			},
		);
		await expect(hook.thaw()).rejects.toBeInstanceOf(QuiesceFailed);
	});

	it("a QGA snapshot whose guest thawed by itself is a QuiesceFailed and leaves no LV", async () => {
		const m = randomUUID();
		const { vmid } = await e.infra.create({
			machineId: m,
			templateVmid: 599,
			size: SIZE,
			smbios: smbiosFor(m),
		});
		await e.infra.start(vmid, { expectedOwner: m, beforeAct: noFence });
		const lvId = randomUUID().replaceAll("-", "");
		e.node.handlers["lv.snapshot"] = (a) => {
			const items = a.items as { name: string; tags: string[] }[];
			for (const it of items) e.node.lvs.push({ name: it.name, tags: it.tags });
			e.api.guestFrozen = false;
			e.api.fail[`POST /nodes/${e.name}/qemu/${vmid}/agent/fsfreeze-thaw`] =
				new PveApiError(500, "guest-fsfreeze-thaw failed");
			return { created: items.map((i) => i.name) };
		};
		const err = await e.infra.snapshot(vmid, { lvId }).catch((x: unknown) => x);
		expect((err as { code?: string }).code).toBe("quiesce_failed");
		expect(
			(await e.infra.listLvs()).filter((l) => l.name.includes(lvId)),
		).toEqual([]);
	});

	it("QGA down during a running snapshot is a permanent quiesce_failed", async () => {
		const m = randomUUID();
		const { vmid } = await e.infra.create({
			machineId: m,
			templateVmid: 599,
			size: SIZE,
			smbios: smbiosFor(m),
		});
		await e.infra.start(vmid, { expectedOwner: m, beforeAct: noFence });
		e.api.agentUp = false;
		const err = await e.infra
			.snapshot(vmid, { lvId: randomUUID().replaceAll("-", "") })
			.catch((x: unknown) => x);
		expect((err as { code?: string }).code).toBe("quiesce_failed");
		expect(isPermanent(err)).toBe(true);
		expect(await e.infra.qgaPing(vmid)).toBe(false);
	});

	it("fork from a snapshot, then delete the snapshot", async () => {
		const src = randomUUID();
		const { vmid } = await e.infra.create({
			machineId: src,
			templateVmid: 599,
			size: { vcpu: 4, memoryMb: 4096 },
			smbios: smbiosFor(src),
		});
		const lvId = randomUUID().replaceAll("-", "");
		const snap = await e.infra.snapshot(vmid, { lvId });
		const child = randomUUID();
		const forked = await e.infra.fork({
			machineId: child,
			snapshot: { lvId, sourceVmid: vmid, disks: snap.disks, hw: snap.hw },
			smbios: smbiosFor(child),
		});
		expect(forked.vmid).not.toBe(vmid);
		const cfg = e.api.vms.get(forked.vmid)?.config ?? {};
		expect(cfg.cores).toBe("4");
		expect(cfg.smbios1).toBe(formatSmbios1(smbiosFor(child)));
		const forkLv = e.node.calls.find(
			(c) =>
				c.op === "lv.snapshot" &&
				JSON.stringify(c.args).includes(`vm-${forked.vmid}-disk-0`),
		);
		expect(JSON.stringify(forkLv?.args)).toContain(`sbx-snap-${lvId}-scsi0`);
		expect(await e.infra.leaseOf(child)).toEqual({
			vmid: forked.vmid,
			mac: forked.mac,
		});

		await e.infra.deleteSnapshot({
			lvId,
			sourceVmid: vmid,
			disks: [],
			hw: {},
		});
		expect(
			(await e.infra.listLvs()).filter((l) =>
				l.tags.includes(`sbx-snap-${lvId}`),
			),
		).toEqual([]);
	});

	it("shutdown: stopped, or timeout when the VM still runs", async () => {
		const m = randomUUID();
		const { vmid } = await e.infra.create({
			machineId: m,
			templateVmid: 599,
			size: SIZE,
			smbios: smbiosFor(m),
		});
		await e.infra.start(vmid, { expectedOwner: m, beforeAct: noFence });
		expect(await e.infra.shutdown(vmid, 30, { expectedOwner: m })).toBe(
			"stopped",
		);
		await e.infra.start(vmid, { expectedOwner: m, beforeAct: noFence });
		e.api.fail[`POST /nodes/${e.name}/qemu/${vmid}/status/shutdown`] =
			new PveTaskError("UPID:x", "VM quit/powerdown failed - got timeout");
		expect(await e.infra.shutdown(vmid, 1, { expectedOwner: m })).toBe(
			"timeout",
		);
		expect(await e.infra.status(vmid)).toBe("running");
		await e.infra.stop(vmid, { expectedOwner: m });
		expect(await e.infra.status(vmid)).toBe("stopped");
	});

	it("shutdown that hit the VM lock is repeated, not reported as a guest timeout", async () => {
		let key = "";
		let slept = 0;
		const e = await setup({
			vmLockSleep: async (ms) => {
				slept += ms;
				if (slept >= 10_000) delete e.api.fail[key];
			},
		});
		const m = randomUUID();
		const { vmid } = await e.infra.create({
			machineId: m,
			templateVmid: 599,
			size: SIZE,
			smbios: smbiosFor(m),
		});
		await e.infra.start(vmid, { expectedOwner: m, beforeAct: noFence });
		key = `POST /nodes/${e.name}/qemu/${vmid}/status/shutdown`;
		// As on pve right after a hard stop and a start (qmeventd holds the lock).
		e.api.fail[key] = new PveTaskError(
			"UPID:x",
			`can't lock file '/var/lock/qemu-server/lock-${vmid}.conf' - got timeout`,
		);
		let fenceChecks = 0;
		expect(
			await e.infra.shutdown(vmid, 300, {
				expectedOwner: m,
				beforeAct: async () => {
					fenceChecks += 1;
				},
			}),
		).toBe("stopped");
		expect(slept).toBe(10_000);
		expect(fenceChecks).toBeGreaterThan(1);
		expect(await e.infra.status(vmid)).toBe("stopped");
	});

	it("configure sets cores and memory", async () => {
		const m = randomUUID();
		const { vmid } = await e.infra.create({
			machineId: m,
			templateVmid: 599,
			size: SIZE,
			smbios: smbiosFor(m),
		});
		await e.infra.configure(vmid, { vcpu: 6, memoryMb: 6144 });
		expect(await e.infra.vmSize(vmid)).toEqual({ vcpu: 6, memoryMb: 6144 });
	});

	it("status: missing only when the VM is not listed; paused from qmpstatus", async () => {
		expect(await e.infra.status(555)).toBe("missing");
		const m = randomUUID();
		const { vmid } = await e.infra.create({
			machineId: m,
			templateVmid: 599,
			size: SIZE,
			smbios: smbiosFor(m),
		});
		const vm = e.api.vms.get(vmid);
		if (vm) vm.status = "paused";
		expect(await e.infra.status(vmid)).toBe("paused");
		// A listed VM whose status cannot be read is an error, not "missing".
		e.api.fail[`GET /nodes/${e.name}/qemu/${vmid}/status/current`] =
			new PveApiError(403, "Permission check failed");
		await expect(e.infra.status(vmid)).rejects.toThrow(/Permission/);
	});

	it("status: an unanchored listing (lost pool ACL) is a transient error, not missing", async () => {
		e.api.vms.delete(599);
		const err = await e.infra.status(555).catch((x: unknown) => x);
		expect((err as { code?: string }).code).toBe("pve_listing_unverified");
		expect(isRetryable(err)).toBe(true);
	});

	it("status: another leased VM in the listing is an anchor too", async () => {
		e.api.vms.delete(599);
		const m = randomUUID();
		await e.infra.create({
			machineId: m,
			templateVmid: 599,
			size: SIZE,
			smbios: smbiosFor(m),
		});
		expect(await e.infra.status(555)).toBe("missing");
	});

	it("status: a failing /cluster/resources rethrows", async () => {
		e.api.fail["GET /cluster/resources"] = new PveApiError(
			500,
			"GET /cluster/resources: proxy loop",
		);
		const err = await e.infra.status(555).catch((x: unknown) => x);
		expect(String(err)).toMatch(/proxy loop/);
		expect(isRetryable(err)).toBe(true);
	});

	it("a delete that fails on traces stays releasing and a retry finishes", async () => {
		const m = randomUUID();
		const { vmid } = await e.infra.create({
			machineId: m,
			templateVmid: 599,
			size: SIZE,
			smbios: smbiosFor(m),
		});
		e.api.keepIpamOnDelete = true;
		const err = await e.infra
			.delete(vmid, { expectedOwner: m })
			.catch((x: unknown) => x);
		expect((err as { code?: string }).code).toBe("traces_remain");
		expect(isRetryable(err)).toBe(true);
		expect(
			(await leases(e.topo.providerId)).find((l) => l.vmid === vmid)?.state,
		).toBe("releasing");
		expect(await e.infra.leaseOf(m)).toEqual({
			vmid,
			mac: expect.any(String),
		});

		// The IPAM entry goes away (Proxmox catches up); the repeated delete finishes.
		e.api.ipam = e.api.ipam.filter((x) => x.vmid !== vmid);
		await e.infra.delete(vmid, { expectedOwner: m });
		expect(
			(await leases(e.topo.providerId)).filter((l) => l.vmid === vmid),
		).toEqual([]);
	});

	it("sbx-node busy during delete is transient; the VM survives and a retry finishes", async () => {
		const m = randomUUID();
		const { vmid } = await e.infra.create({
			machineId: m,
			templateVmid: 599,
			size: SIZE,
			smbios: smbiosFor(m),
		});
		await e.infra.start(vmid, { expectedOwner: m, beforeAct: noFence });
		e.node.fail["dhcp.release"] = new NodeOpsError(
			"dhcp.release",
			"busy",
			"leases file is being rewritten",
		);
		const err = await e.infra
			.delete(vmid, { expectedOwner: m })
			.catch((x: unknown) => x);
		expect((err as { code?: string }).code).toBe("node_busy");
		expect(isRetryable(err)).toBe(true);
		expect(e.api.vms.has(vmid)).toBe(true);
		expect(
			(await leases(e.topo.providerId)).find((l) => l.vmid === vmid)?.state,
		).toBe("releasing");

		delete e.node.fail["dhcp.release"];
		await e.infra.delete(vmid, { expectedOwner: m });
		expect(e.api.vms.has(vmid)).toBe(false);
		expect(await e.infra.leaseOf(m)).toBeUndefined();
	});

	it("delete refuses a template and tolerates a missing VM", async () => {
		const err = await e.infra
			.delete(599, { expectedOwner: null })
			.catch((x: unknown) => x);
		expect(String(err)).toMatch(/template/);
		expect(isPermanent(err)).toBe(true);

		const m = randomUUID();
		const { vmid } = await e.infra.create({
			machineId: m,
			templateVmid: 599,
			size: SIZE,
			smbios: smbiosFor(m),
		});
		e.api.vms.delete(vmid);
		e.api.ipam = e.api.ipam.filter((x) => x.vmid !== vmid);
		e.node.lvs = e.node.lvs.filter((l) => !l.name.startsWith(`vm-${vmid}-`));
		await e.infra.delete(vmid, { expectedOwner: m });
		expect(await e.infra.leaseOf(m)).toBeUndefined();
	});

	it("power operations for another owner are refused before Proxmox is touched", async () => {
		const m = randomUUID();
		const { vmid } = await e.infra.create({
			machineId: m,
			templateVmid: 599,
			size: SIZE,
			smbios: smbiosFor(m),
		});
		await e.infra.start(vmid, { expectedOwner: m, beforeAct: noFence });
		e.api.calls.length = 0;
		const other = { expectedOwner: randomUUID(), beforeAct: noFence };
		for (const call of [
			() => e.infra.start(vmid, other),
			() => e.infra.stop(vmid, other),
			() => e.infra.shutdown(vmid, 5, other),
			() => e.infra.delete(vmid, other),
			() => e.infra.delete(vmid, { expectedOwner: null }),
		]) {
			const err = await call().catch((x: unknown) => x);
			expect(err).toBeInstanceOf(OwnerMismatchError);
			expect(isPermanent(err)).toBe(true);
		}
		expect(e.api.calls.filter((c) => c.method !== "GET")).toEqual([]);
		expect(e.api.vms.get(vmid)?.status).toBe("running");
		expect(
			(await leases(e.topo.providerId)).find((l) => l.vmid === vmid)?.state,
		).toBe("active");
	});

	it("delete with expectedOwner null removes an orphan VM that has no lease", async () => {
		e.api.vms.set(570, {
			config: { tags: "sbx" },
			status: "running",
			firewall: { rules: [], ipsets: {} },
		});
		await e.infra.delete(570, { expectedOwner: null });
		expect(e.api.vms.has(570)).toBe(false);
	});

	it("start re-checks the caller's fence after waiting for the power lock (M3)", async () => {
		const m = randomUUID();
		const { vmid } = await e.infra.create({
			machineId: m,
			templateVmid: 599,
			size: SIZE,
			smbios: smbiosFor(m),
		});
		// Another worker holds the node's power lock.
		const holder = await db.pool.connect();
		const key = `power:${e.topo.nodeId}`;
		await holder.query("SELECT pg_advisory_lock(hashtextextended($1, 0))", [
			key,
		]);
		let fenced = false;
		const fencedOut = new FencedOut("attempt 1 fenced out");
		const start = e.infra
			.start(vmid, {
				expectedOwner: m,
				beforeAct: async () => {
					if (fenced) throw fencedOut;
				},
			})
			.catch((x: unknown) => x);
		const deadline = Date.now() + 5000;
		for (;;) {
			const r = await db.pool.query<{ n: number }>(
				`SELECT count(*)::int AS n FROM pg_locks
				 WHERE locktype = 'advisory' AND NOT granted
				   AND database = (SELECT oid FROM pg_database WHERE datname = current_database())`,
			);
			if ((r.rows[0]?.n ?? 0) > 0) break;
			if (Date.now() > deadline) throw new Error("start never waited");
			await new Promise((res) => setTimeout(res, 5));
		}
		// Superseded while it waited.
		fenced = true;
		await holder.query("SELECT pg_advisory_unlock(hashtextextended($1, 0))", [
			key,
		]);
		holder.release();
		expect(await start).toBe(fencedOut);
		expect(e.api.paths().some((p) => p.endsWith("/status/start"))).toBe(false);
		expect(e.api.vms.get(vmid)?.status).toBe("stopped");
	});

	it("stop and shutdown run the caller's beforeAct under the power lock; its error cancels them unchanged", async () => {
		const m = randomUUID();
		const { vmid } = await e.infra.create({
			machineId: m,
			templateVmid: 599,
			size: SIZE,
			smbios: smbiosFor(m),
		});
		await e.infra.start(vmid, { expectedOwner: m, beforeAct: noFence });
		e.api.calls.length = 0;
		const changed = new Error("machine changed");
		const abort = {
			expectedOwner: m,
			beforeAct: async () => {
				throw changed;
			},
		};
		expect(
			await e.infra.shutdown(vmid, 5, abort).catch((x: unknown) => x),
		).toBe(changed);
		expect(await e.infra.stop(vmid, abort).catch((x: unknown) => x)).toBe(
			changed,
		);
		expect(e.api.calls.filter((c) => c.method !== "GET")).toEqual([]);
		expect(e.api.vms.get(vmid)?.status).toBe("running");
		let ran = 0;
		await e.infra.stop(vmid, {
			expectedOwner: m,
			beforeAct: async () => {
				ran++;
			},
		});
		expect(ran).toBe(1);
		expect(e.api.vms.get(vmid)?.status).toBe("stopped");
	});

	it("create again for the same machine reuses its lease and never rolls it back", async () => {
		const m = randomUUID();
		const first = await e.infra.create({
			machineId: m,
			templateVmid: 599,
			size: SIZE,
			smbios: smbiosFor(m),
		});
		const err = await e.infra
			.create({
				machineId: m,
				templateVmid: 599,
				size: SIZE,
				smbios: smbiosFor(m),
			})
			.catch((x: unknown) => x);
		expect(isRetryable(err)).toBe(true);
		expect(e.api.vms.has(first.vmid)).toBe(true);
		expect(await e.infra.leaseOf(m)).toEqual({
			vmid: first.vmid,
			mac: first.mac,
		});
	});

	it("errors that echo smbios1 leave the adapter scrubbed, without the original", async () => {
		const m = randomUUID();
		const smbios = smbiosFor(m);
		const secret = Buffer.from(smbios.serial).toString("base64");
		e.api.fail[`POST /nodes/${e.name}/qemu`] = new PveApiError(
			400,
			`POST /nodes/${e.name}/qemu: Parameter verification failed.`,
			{ smbios1: `value '${formatSmbios1(smbios)}' does not look valid` },
		);
		const err = (await e.infra
			.create({ machineId: m, templateVmid: 599, size: SIZE, smbios })
			.catch((x: unknown) => x)) as Error;
		expect(err.message).toContain("Parameter verification failed");
		expect(err.message).not.toContain(secret);
		expect(err.message).not.toContain(smbios.serial);
		expect(err.cause).toBeUndefined();
		expect(isPermanent(err)).toBe(true);
	});

	it("listVms: this node only, with pool, tags, status and template", async () => {
		const m = randomUUID();
		const { vmid } = await e.infra.create({
			machineId: m,
			templateVmid: 599,
			size: SIZE,
			smbios: smbiosFor(m),
		});
		e.api.vms.set(599, {
			config: { ...TEMPLATE_CONFIG },
			status: "stopped",
			firewall: { rules: [], ipsets: {} },
		});
		e.api.vms.set(570, {
			config: { tags: "sbx;extra" },
			status: "running",
			firewall: { rules: [], ipsets: {} },
		});
		e.api.vms.set(571, {
			config: { tags: "sbx" },
			node: "elsewhere",
			status: "running",
			firewall: { rules: [], ipsets: {} },
		});
		const vms = await e.infra.listVms();
		expect(vms.map((v) => v.vmid).sort()).toEqual([vmid, 570, 599].sort());
		expect(vms.find((v) => v.vmid === vmid)).toEqual({
			vmid,
			status: "stopped",
			pool: "sandbox",
			tags: ["sbx"],
			template: false,
		});
		expect(vms.find((v) => v.vmid === 570)?.tags).toEqual(["sbx", "extra"]);
		expect(vms.find((v) => v.vmid === 599)?.template).toBe(true);
	});

	it("listLvs and removeLvs go through sbx-node", async () => {
		e.node.lvs.push(
			{ name: "sbx-snap-aa-scsi0", tags: ["sbx", "sbx-snap-aa"] },
			{ name: "vm-590-disk-0", tags: ["sbx", "sbx-vm-590"] },
		);
		expect(await e.infra.listLvs()).toEqual([
			{ name: "sbx-snap-aa-scsi0", tags: ["sbx", "sbx-snap-aa"] },
			{ name: "vm-590-disk-0", tags: ["sbx", "sbx-vm-590"] },
		]);
		await e.infra.removeLvs(["vm-590-disk-0"]);
		await e.infra.removeLvs([]);
		expect(e.node.lvs.map((l) => l.name)).toEqual(["sbx-snap-aa-scsi0"]);
		expect(e.node.ops().filter((o) => o === "lv.remove")).toHaveLength(1);
	});
});

describe("pveClientsFromSecrets", () => {
	const KNOWN = (host: string) =>
		`${host} ssh-ed25519 ${Buffer.from("fake-host-key").toString("base64")}\n`;

	function writeSecrets(dir: string, host = "sbx-node") {
		mkdirSync(dir, { recursive: true });
		writeFileSync(join(dir, "pve-token"), "token-secret\n");
		chmodSync(join(dir, "pve-token"), 0o600);
		writeFileSync(
			join(dir, "pve-root-ca.pem"),
			"-----BEGIN CERTIFICATE-----\n",
		);
		writeFileSync(join(dir, "sbx-node_ed25519"), "private key");
		chmodSync(join(dir, "sbx-node_ed25519"), 0o600);
		writeFileSync(join(dir, "known_hosts"), KNOWN(host));
	}

	it("reads <secretsDir>/<secret_ref>/ files and builds PveApi and SshNodeOps", async () => {
		const topo = await createTopology(db.pool);
		const t = await loadNodeTopology(db.pool, topo.nodeId);
		const root = mkdtempSync(join(tmpdir(), "sbx-secrets-"));
		writeSecrets(join(root, t.secretRef));
		const c = await pveClientsFromSecrets(root, {})(t);
		expect(c.api).toBeInstanceOf(PveApi);
		expect(c.node).toBeInstanceOf(SshNodeOps);
		c.close?.();
	});

	it("falls back to files directly in secretsDir when the secret_ref dir is absent", async () => {
		const topo = await createTopology(db.pool);
		const t = await loadNodeTopology(db.pool, topo.nodeId);
		const root = mkdtempSync(join(tmpdir(), "sbx-secrets-"));
		writeSecrets(root);
		const c = await pveClientsFromSecrets(root, {})(t);
		expect(c.api).toBeInstanceOf(PveApi);
		c.close?.();
	});

	it("rejects a token file readable by others", async () => {
		const topo = await createTopology(db.pool);
		const t = await loadNodeTopology(db.pool, topo.nodeId);
		const root = mkdtempSync(join(tmpdir(), "sbx-secrets-"));
		writeSecrets(root);
		chmodSync(join(root, "pve-token"), 0o644);
		await expect(async () =>
			pveClientsFromSecrets(root, {})(t),
		).rejects.toThrow(/mode 600/);
	});

	it("SBX_NODE_SSH_HOST overrides node_agent_ref as the SSH host", async () => {
		const topo = await createTopology(db.pool);
		const t = await loadNodeTopology(db.pool, topo.nodeId);
		const root = mkdtempSync(join(tmpdir(), "sbx-secrets-"));
		writeSecrets(root, "pve.example.ts.net");
		await expect(async () =>
			pveClientsFromSecrets(root, {})(t),
		).rejects.toThrow(/no pinned host key for sbx-node/);
		const c = await pveClientsFromSecrets(root, {
			SBX_NODE_SSH_HOST: "pve.example.ts.net",
		})(t);
		expect(c.node).toBeInstanceOf(SshNodeOps);
		c.close?.();
	});
});
