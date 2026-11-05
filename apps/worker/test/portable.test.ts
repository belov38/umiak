import { createHash, randomUUID } from "node:crypto";
import { createTestDatabase, type TestDatabase } from "@umiak/db/testing";
import type { NodeOps, PveClient } from "@umiak/pve";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { handleSandboxOp } from "../src/handlers/sandbox-op.ts";
import { FakeInfra } from "./fakes/infra.ts";
import { createWorld, type TestWorld } from "./fakes/world.ts";
import { opsEnv, row, stoppedSandbox } from "./helpers/ops.ts";

let db: TestDatabase;
beforeAll(async () => {
	db = await createTestDatabase();
});
afterAll(async () => {
	await db?.drop();
});

async function destination(w: TestWorld) {
	const nodeId = randomUUID(),
		storageId = randomUUID();
	await w.pool.query(
		"INSERT INTO runtime.nodes(id,provider_id,name,ram_cap_mb,node_agent_ref) VALUES($1,$2,$3,8192,'fake')",
		[nodeId, w.topo.providerId, `pve-${nodeId}`],
	);
	await w.pool.query(
		"INSERT INTO runtime.storages(id,provider_id,node_id,name,driver) VALUES($1,$2,$3,'local-lvm','lvmthin')",
		[storageId, w.topo.providerId, nodeId],
	);
	await w.pool.query(
		"INSERT INTO runtime.template_builds(template_slug,version,os,provider_id,node_id,storage_id,pve_vmid,disk_layout,hw,boot_timeout_s,status,source_build_id) SELECT template_slug,version,os,provider_id,$2,$3,600,disk_layout,hw,boot_timeout_s,'active',id FROM runtime.template_builds WHERE id=$1",
		[w.topo.templateBuildId, nodeId, storageId],
	);
	const infra = new FakeInfra({
		pool: w.pool,
		providerId: w.topo.providerId,
		clusterMacId: w.topo.clusterMacId,
		lifecycle: w.agentWorld,
	});
	w.registry.set(nodeId, infra);
	return { nodeId, storageId, infra };
}

function bridge(
	w: TestWorld,
	target: FakeInfra,
	opts: {
		corrupt?: boolean;
		standardFull?: boolean;
		onWrite?: () => Promise<void>;
		crashOp?: string;
		crashNode?: string;
		crashAfterSwitch?: boolean;
	} = {},
) {
	const stores = new Map<
		FakeInfra,
		Map<string, { uuid: string; data: Buffer }>
	>([
		[w.infra, new Map()],
		[target, new Map()],
	]);
	const original = Buffer.alloc(512, 0x71);
	for (const [name, lv] of w.infra.lvs) {
		const vmid = name.match(/^vm-([0-9]+)-/)?.[1];
		if (vmid) lv.tags.push(`umiak-vm-${vmid}`);
	}
	let crashed = false;
	let verified = false;
	const events: string[] = [];
	for (const [name] of w.infra.lvs)
		stores
			.get(w.infra)
			?.set(name, { uuid: randomUUID(), data: Buffer.from(original) });
	for (const [infra, nodeName] of [
		[w.infra, "source"],
		[target, "target"],
	] as const) {
		const store = stores.get(infra) as Map<
			string,
			{ uuid: string; data: Buffer }
		>;
		const node: NodeOps = {
			close() {},
			async call<T>(op: string, raw?: object): Promise<T> {
				const a = raw as {
					name: string;
					volume: string;
					targetName: string;
					target: string;
					id: string;
					slot: string;
					offset: number;
					length: number;
					data: string;
					hashOnly: boolean;
					vmid: number;
					uuid: string;
				};
				for (const [name] of infra.lvs)
					if (!store.has(name))
						store.set(name, {
							uuid: randomUUID(),
							data: Buffer.from(original),
						});
				if (op === "volume.sendTo") {
					events.push("standardFull");
					await opts.onWrite?.();
					const origin = store.get(a.volume.split(":").at(-1) as string);
					if (!origin) throw Error("source missing");
					if (opts.corrupt) throw Error("in-stream checksum mismatch");
					const destination = nodeName === "source" ? target : w.infra;
					const destinationStore = stores.get(destination) as Map<
						string,
						{ uuid: string; data: Buffer }
					>;
					const uuid = randomUUID(),
						id = a.targetName.split("-")[2];
					destinationStore.set(a.targetName, {
						uuid,
						data: Buffer.from(origin.data),
					});
					destination.lvs.set(a.targetName, {
						name: a.targetName,
						tags: ["umiak", `umiak-snap-${id}`, `umiak-transfer-${id}`],
					});
					const header = Buffer.alloc(8);
					header.writeBigUInt64LE(512n);
					return {
						name: a.targetName,
						uuid,
						sourceUUID: origin.uuid,
						sizeBytes: 512,
						verified: true,
						sha256: createHash("sha256")
							.update(header)
							.update(origin.data)
							.digest("hex"),
						algorithm: "sha256-pvesm-raw+size-v1",
						wireBytes: 512,
						elapsedSeconds: 1,
					} as T;
				}
				if (op === "lv.list")
					return {
						lvs: [...infra.lvs].map(([name, lv]) => ({
							...lv,
							name,
							uuid: store.get(name)?.uuid,
							sizeBytes: 512,
						})),
					} as T;
				if (op === "lv.transferMap")
					return {
						sizeBytes: 512,
						ranges: [{ offset: 0, length: 512 }],
						next: 0,
					} as T;
				if (op === "lv.transferPrepare") {
					const name = `umiak-snap-${a.id}-${a.slot}`;
					if (!store.has(name)) {
						store.set(name, { uuid: randomUUID(), data: Buffer.alloc(512) });
						infra.lvs.set(name, {
							name,
							tags: ["umiak", `umiak-snap-${a.id}`, `umiak-transfer-${a.id}`],
						});
					}
					return { name } as T;
				}
				if (op === "lv.transferRead") {
					const bytes = store.get(a.name)?.data;
					if (!bytes) throw Error(`missing ${a.name}`);
					const b = bytes.subarray(a.offset, a.offset + a.length);
					return {
						sizeBytes: 512,
						sha256: createHash("sha256").update(b).digest("hex"),
						zero: b.every((v) => v === 0),
						...(!a.hashOnly ? { data: b.toString("base64") } : {}),
					} as T;
				}
				if (op === "lv.transferWrite") {
					events.push("write");
					await opts.onWrite?.();
					if (!opts.corrupt)
						Buffer.from(a.data, "base64").copy(
							store.get(a.name)?.data as Buffer,
							a.offset,
						);
					return {} as T;
				}
				if (op === "lv.transferPublish") {
					const b = store.get(a.name)?.data as Buffer;
					expect(b.equals(original)).toBe(true);
					verified = true;
					events.push("publish");
					store.set(a.target, { uuid: randomUUID(), data: Buffer.from(b) });
					infra.lvs.set(a.target, {
						name: a.target,
						tags: [
							"umiak",
							a.target.startsWith("umiak-snap-")
								? `umiak-snap-${a.target.split("-")[2]}`
								: `umiak-vm-${a.target.split("-")[1]}`,
							`umiak-transfer-${a.name.split("-")[2]}`,
						],
					});
					return {} as T;
				}
				if (op === "vm.transferSwitch") {
					expect(verified).toBe(true);
					events.push("switch");
					const vm = w.infra.vms.get(a.vmid);
					if (vm) {
						vm.tags.push(`umiak-move-${a.id}`);
						w.infra.vms.delete(a.vmid);
						target.vms.set(a.vmid, vm);
					}
					if (opts.crashAfterSwitch && !crashed) {
						crashed = true;
						throw Error("crash after config move");
					}
					return {} as T;
				}
				if (op === "vm.transferUnlock") return {} as T;
				if (op === "lv.transferRemove") {
					if (a.name.startsWith("vm-"))
						expect(verified || nodeName === "target").toBe(true);
					events.push(`remove:${nodeName}`);
					if (store.get(a.name)?.uuid === a.uuid) {
						store.delete(a.name);
						infra.lvs.delete(a.name);
					}
					return {} as T;
				}
				throw Error(op);
			},
		};
		if (opts.standardFull)
			node.sendVolume = <T>(args: object) =>
				node.call<T>("volume.sendTo", args);

		const invoke = node.call.bind(node);
		node.call = async <T>(op: string, args?: object): Promise<T> => {
			const value = await invoke<T>(op, args);
			if (
				opts.crashOp === op &&
				(!opts.crashNode || opts.crashNode === nodeName) &&
				!crashed
			) {
				crashed = true;
				throw Error(`crash after ${op}`);
			}
			return value;
		};

		const api = {
			async get(path: string) {
				const vm = infra.vms.get(Number(path.split("/").at(-2)));
				if (!vm) throw Error("missing config");
				return { tags: vm.tags.join(";") };
			},
		} as PveClient;
		Object.assign(infra, {
			portable: () => ({ node, api, name: nodeName, storage: "local-lvm" }),
		});
	}
	return {
		events,
		stores,
		original,
	};
}

describe("journaled cold move", () => {
	for (const crash of [false, true])
		it(`keeps identity/content and safely retries config switch crash=${crash}`, async () => {
			const w = await createWorld(db);
			const e = opsEnv(w);
			const s = await stoppedSandbox(w, e);
			const target = await destination(w);
			await w.pool.query(
				"UPDATE runtime.template_builds SET os='windows' WHERE id=$1",
				[w.topo.templateBuildId],
			);
			const m = await row(w, "machines", s.machineId);
			const vmid = Number(m.vmid);
			const vm = w.infra.vms.get(vmid);
			const data = bridge(w, target.infra, { crashAfterSwitch: crash });
			await w.pool.query(
				"UPDATE runtime.nodes SET state='cordoned' WHERE id=$1",
				[w.topo.nodeId],
			);
			const op = await e.svc.resume(e.p, s.sandboxId);
			expect(op.progress.phase).toBe("moving");
			if (crash) {
				await expect(
					handleSandboxOp(w.ctx, { operationId: op.id }),
				).rejects.toThrow("crash after config move");
				expect((await row(w, "machines", s.machineId)).node_id).toBe(
					w.topo.nodeId,
				);
				expect(w.infra.lvs.has(`vm-${vmid}-disk-0`)).toBe(true);
			}
			expect(await handleSandboxOp(w.ctx, { operationId: op.id })).toBe(
				"succeeded",
			);
			await w.agentWorld.settled();
			const after = await row(w, "machines", s.machineId);
			expect(
				new Date(
					(await row(w, "operations", op.id)).deadline_at as string,
				).getTime() - Date.now(),
			).toBeGreaterThan(14 * 60_000);
			expect(after.node_id).toBe(target.nodeId);
			expect(after.vmid).toBe(vmid);
			expect(after.mac).toBe(m.mac);
			expect(target.infra.vms.get(vmid)).toBe(vm);
			expect(w.infra.vms.has(vmid)).toBe(false);
			expect(w.infra.lvs.has(`vm-${vmid}-disk-0`)).toBe(false);
			expect(data.events.indexOf("switch")).toBeGreaterThan(
				data.events.indexOf("publish"),
			);
			expect(
				(
					await w.pool.query(
						"SELECT phase FROM runtime.volume_transfers WHERE source_id=$1",
						[s.machineId],
					)
				).rows[0]?.phase,
			).toBe("done");
		});
	it("retains the source and never switches when target readback is corrupt", async () => {
		const w = await createWorld(db);
		const e = opsEnv(w);
		const s = await stoppedSandbox(w, e);
		const target = await destination(w);
		const data = bridge(w, target.infra, { corrupt: true });
		await w.pool.query(
			"UPDATE runtime.nodes SET state='cordoned' WHERE id=$1",
			[w.topo.nodeId],
		);
		const op = await e.svc.resume(e.p, s.sandboxId);
		await expect(
			handleSandboxOp(w.ctx, { operationId: op.id }),
		).rejects.toThrow(/readback/);
		expect((await row(w, "machines", s.machineId)).node_id).toBe(w.topo.nodeId);
		expect(data.events).not.toContain("switch");
		expect(data.events).not.toContain("remove:source");
	});
});

for (const kind of ["fork", "saved"] as const)
	it(`moves ${kind} snapshot under home-node pressure before cloning`, async () => {
		const w = await createWorld(db);
		const e = opsEnv(w);
		const source = await stoppedSandbox(w, e);
		const target = await destination(w);
		bridge(w, target.infra);
		let snapshotId: string | undefined;
		if (kind === "saved") {
			const saved = await e.svc.saveSnapshot(
				e.p,
				source.sandboxId,
				"portable-base",
			);
			expect(
				await handleSandboxOp(w.ctx, { operationId: saved.operation.id }),
			).toBe("succeeded");
			snapshotId = saved.snapshot.id;
		}
		await w.pool.query(
			"UPDATE runtime.nodes SET state='cordoned' WHERE id=$1",
			[w.topo.nodeId],
		);
		const result =
			kind === "fork"
				? await e.svc.fork(e.p, source.sandboxId, {})
				: await e.svc.create(e.p, { from: { snapshot: "portable-base" } });
		if ("sourceOperation" in result)
			expect(
				await handleSandboxOp(w.ctx, {
					operationId: (result.sourceOperation as { id: string }).id,
				}),
			).toBe("succeeded");
		expect(
			await handleSandboxOp(w.ctx, { operationId: result.operation.id }),
		).toBe("succeeded");
		await w.agentWorld.settled();
		expect((await row(w, "sandboxes", result.sandbox.id)).node_id).toBe(
			target.nodeId,
		);
		expect((await row(w, "sandboxes", source.sandboxId)).node_id).toBe(
			w.topo.nodeId,
		);
		if (snapshotId)
			expect((await row(w, "snapshots", snapshotId)).node_id).toBe(
				target.nodeId,
			);
		expect(
			(
				await w.pool.query(
					"SELECT phase FROM runtime.volume_transfers WHERE kind='snapshot' AND target_node_id=$1",
					[target.nodeId],
				)
			).rows[0]?.phase,
		).toBe("done");
	});

it("delete preempts an unverified copy without ever publishing or starting target", async () => {
	const w = await createWorld(db);
	const e = opsEnv(w);
	const source = await stoppedSandbox(w, e);
	const target = await destination(w);
	let deletion: { id: string } | undefined;
	const data = bridge(w, target.infra, {
		onWrite: async () => {
			deletion = await e.svc.delete(e.p, source.sandboxId);
		},
	});
	await w.pool.query("UPDATE runtime.nodes SET state='cordoned' WHERE id=$1", [
		w.topo.nodeId,
	]);
	const op = await e.svc.resume(e.p, source.sandboxId);
	expect(await handleSandboxOp(w.ctx, { operationId: op.id })).toBe(
		"fenced_out",
	);
	if (!deletion) throw Error("delete was not requested");
	expect(await handleSandboxOp(w.ctx, { operationId: deletion.id })).toBe(
		"succeeded",
	);
	expect(data.events).not.toContain("publish");
	expect(data.events).not.toContain("switch");
	expect(target.infra.vms.size).toBe(0);
	expect(target.infra.lvs.size).toBe(0);
	expect((await row(w, "sandboxes", source.sandboxId)).state).toBe("deleted");
});

for (const boundary of [
	"lv.transferPrepare",
	"lv.transferWrite",
	"lv.transferPublish",
	"vm.transferUnlock",
] as const)
	it(`replays journal after ${boundary}`, async () => {
		const w = await createWorld(db);
		const e = opsEnv(w);
		const source = await stoppedSandbox(w, e);
		const target = await destination(w);
		bridge(w, target.infra, { crashOp: boundary, crashNode: "target" });
		await w.pool.query(
			"UPDATE runtime.nodes SET state='cordoned' WHERE id=$1",
			[w.topo.nodeId],
		);
		const op = await e.svc.resume(e.p, source.sandboxId);
		await expect(
			handleSandboxOp(w.ctx, { operationId: op.id }),
		).rejects.toThrow(`crash after ${boundary}`);
		expect(await handleSandboxOp(w.ctx, { operationId: op.id })).toBe(
			"succeeded",
		);
		await w.agentWorld.settled();
		expect((await row(w, "machines", source.machineId)).node_id).toBe(
			target.nodeId,
		);
		expect(
			(
				await w.pool.query(
					"SELECT phase FROM runtime.volume_transfers WHERE source_id=$1",
					[source.machineId],
				)
			).rows[0]?.phase,
		).toBe("done");
	});

it("uses the standard full stream when no identical base is available", async () => {
	const w = await createWorld(db);
	const e = opsEnv(w);
	const source = await stoppedSandbox(w, e);
	const target = await destination(w);
	const data = bridge(w, target.infra, { standardFull: true });
	await w.pool.query("UPDATE runtime.nodes SET state='cordoned' WHERE id=$1", [
		w.topo.nodeId,
	]);
	const op = await e.svc.resume(e.p, source.sandboxId);
	expect(await handleSandboxOp(w.ctx, { operationId: op.id })).toBe(
		"succeeded",
	);
	expect(data.events).toContain("standardFull");
	expect((await row(w, "machines", source.machineId)).node_id).toBe(
		target.nodeId,
	);
});
