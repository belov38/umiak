import { AsyncLocalStorage } from "node:async_hooks";
// Cross-node disk ownership changes. Host actions are narrowly scoped node-agent
// RPCs; journals outlive worker attempts, and config locks outlive DB failures.
import { randomBytes } from "node:crypto";
import { lockNode, operationDeadline } from "@umiak/core";
import { withTx } from "@umiak/db";
import { relayVolume } from "@umiak/pve";
import type { WorkerCtx } from "./context.ts";
import { loadMachine, loadSnapshot } from "./db.ts";
import type { InfraDisk, NodeInfra } from "./ports.ts";
import { type Fenced, FencedOut, type StepFence } from "./steps.ts";

type Journal = {
	id: string;
	kind: string;
	source_id: string;
	source_node_id: string;
	target_node_id: string;
	target_storage_id: string;
	phase: string;
	progress: Record<string, number>;
	result: Record<string, unknown> | null;
};
const unfinished = "phase NOT IN ('done','cancelled')";

const portableScopes = new AsyncLocalStorage<Set<WorkerCtx["pool"]>>();
const portablePermits = new WeakMap<
	WorkerCtx["pool"],
	{ active: number; waiters: (() => void)[] }
>();
export async function withPortableLock<T>(
	ctx: WorkerCtx,
	key: string,
	fn: () => Promise<T>,
): Promise<T> {
	const scope = portableScopes.getStore();
	if (scope?.has(ctx.pool)) return portableLockInner(ctx, key, fn);
	const max = ctx.pool.options.max ?? 20;
	if (max < 6)
		throw new Error(
			"portable operations require a database pool of at least six connections",
		);
	const cap = Math.max(1, Math.floor((max - 2) / 4));
	let permits = portablePermits.get(ctx.pool);
	if (!permits) {
		permits = { active: 0, waiters: [] };
		portablePermits.set(ctx.pool, permits);
	}
	if (permits.active >= cap)
		await new Promise<void>((resolve) => permits.waiters.push(resolve));
	else permits.active++;
	const nested = new Set(scope);
	nested.add(ctx.pool);
	try {
		return await portableScopes.run(nested, () =>
			portableLockInner(ctx, key, fn),
		);
	} finally {
		const next = permits.waiters.shift();
		if (next) next();
		else permits.active--;
	}
}
async function portableLockInner<T>(
	ctx: WorkerCtx,
	key: string,
	fn: () => Promise<T>,
): Promise<T> {
	const client = await ctx.pool.connect();
	let lost = false;
	const onError = () => {
		lost = true;
	};
	client.on("error", onError);
	try {
		await client.query("SELECT pg_advisory_lock(hashtextextended($1,0))", [
			`portable:${key}`,
		]);
		const result = await fn();
		if (lost) throw new Error("portable operation lost its lock connection");
		return result;
	} finally {
		try {
			await client.query("SELECT pg_advisory_unlock(hashtextextended($1,0))", [
				`portable:${key}`,
			]);
			client.removeListener("error", onError);
			client.release();
		} catch {
			client.removeListener("error", onError);
			client.release(true);
		}
	}
}
function portable(infra: NodeInfra) {
	const p = infra.portable?.();
	if (!p) throw new Error("node adapter does not support portable disks");
	return p;
}
const lvName = (volume: string) => volume.split(":").at(-1) ?? volume;
async function journal(
	ctx: WorkerCtx,
	kind: string,
	id: string,
	source: string,
	target: string,
	storage: string,
): Promise<Journal> {
	const old = (
		await ctx.pool.query<Journal>(
			`SELECT * FROM runtime.volume_transfers WHERE kind=$1 AND source_id=$2 AND target_node_id=$3 AND ${unfinished} ORDER BY created_at DESC LIMIT 1`,
			[kind, id, target],
		)
	).rows[0];
	if (old) return old;
	return (
		await ctx.pool.query<Journal>(
			`INSERT INTO runtime.volume_transfers(id,kind,source_id,source_node_id,target_node_id,target_storage_id) VALUES($1,$2,$3,$4,$5,$6) RETURNING *`,
			[randomBytes(16).toString("hex"), kind, id, source, target, storage],
		)
	).rows[0] as Journal;
}
async function phase(
	ctx: WorkerCtx,
	j: Journal,
	next: string,
	result?: Record<string, unknown>,
) {
	await ctx.pool.query(
		"UPDATE runtime.volume_transfers SET phase=$2,result=COALESCE($3::jsonb,result),updated_at=now() WHERE id=$1",
		[j.id, next, result ? JSON.stringify(result) : null],
	);
	j.phase = next;
	if (result) j.result = result;
}
async function markVerified(
	fence: StepFence,
	j: Journal,
	result: Record<string, unknown>,
) {
	await fence.tx(async (tx) => {
		const r = await tx.client.query(
			"UPDATE runtime.volume_transfers SET phase='verified',result=$2,updated_at=now() WHERE id=$1 AND phase IN ('preparing','copying','verified')",
			[j.id, JSON.stringify(result)],
		);
		if (r.rowCount !== 1)
			throw new FencedOut("transfer was cancelled or committed");
	});
	j.phase = "verified";
	j.result = result;
}
async function markSwitching(fence: StepFence, j: Journal) {
	await fence.tx(async (tx) => {
		const r = await tx.client.query(
			"UPDATE runtime.volume_transfers SET phase='switching',updated_at=now() WHERE id=$1 AND phase IN ('verified','switching')",
			[j.id],
		);
		if (r.rowCount !== 1) throw new FencedOut("transfer switch was fenced");
	});
	j.phase = "switching";
}

async function diskRows(
	ctx: WorkerCtx,
	kind: "machine" | "snapshot",
	id: string,
): Promise<InfraDisk[]> {
	return (
		await ctx.pool.query<{
			slot: InfraDisk["slot"];
			volume: string;
			size_bytes: string | null;
			options: Record<string, string>;
		}>(
			`SELECT slot,volume,size_bytes,options FROM runtime.disks WHERE ${kind}_id=$1 AND state='active' ORDER BY slot`,
			[id],
		)
	).rows.map((d) => ({
		slot: d.slot,
		volume: d.volume,
		...(d.size_bytes ? { sizeBytes: Number(d.size_bytes) } : {}),
		options: d.options ?? {},
	}));
}
async function matchingBases(
	ctx: WorkerCtx,
	templateBuildId: string,
	sourceNode: string,
	targetNode: string,
) {
	const rows = (
		await ctx.pool.query<{
			node_id: string;
			pve_vmid: number;
			disk_layout: Record<string, { index?: string }>;
			checksums: Record<string, { sha256: string; algorithm: string }> | null;
		}>(
			`SELECT tb.node_id,tb.pve_vmid,tb.disk_layout,tb.checksums FROM runtime.template_builds tb WHERE tb.node_id=ANY($2::uuid[]) AND tb.status<>'retired' AND COALESCE(tb.source_build_id,tb.id)=(SELECT COALESCE(source_build_id,id) FROM runtime.template_builds WHERE id=$1) ORDER BY tb.created_at DESC`,
			[templateBuildId, [sourceNode, targetNode]],
		)
	).rows;
	return {
		source: rows.find((r) => r.node_id === sourceNode),
		target: rows.find((r) => r.node_id === targetNode),
	};
}

async function copyDisks(
	ctx: WorkerCtx,
	fence: StepFence,
	j: Journal,
	sourceDisks: InfraDisk[],
	templateBuildId: string,
	finalNames: (disk: InfraDisk) => string,
): Promise<InfraDisk[]> {
	const src = portable(await ctx.infra.forNode(j.source_node_id));
	const dst = portable(await ctx.infra.forNode(j.target_node_id));
	const all = await src.node.call<{ name: string; sizeBytes: number }[]>(
		"lv.list",
		{ tags: ["umiak"] },
	);
	const bases = await matchingBases(
		ctx,
		templateBuildId,
		j.source_node_id,
		j.target_node_id,
	);
	const copied: InfraDisk[] = [];
	for (const disk of sourceDisks) {
		await fence.check();
		const name = lvName(disk.volume);
		const size = all.find((l) => l.name === name)?.sizeBytes ?? disk.sizeBytes;
		if (!size) throw new Error("portable source disk size unavailable");
		const a = bases.source?.checksums?.[disk.slot],
			b = bases.target?.checksums?.[disk.slot];
		const identical =
			a && b && a.sha256 === b.sha256 && a.algorithm === b.algorithm;
		const sourceBase = identical
			? `base-${bases.source?.pve_vmid}-disk-${bases.source?.disk_layout[disk.slot]?.index ?? 0}`
			: undefined;
		const targetBase = identical
			? `base-${bases.target?.pve_vmid}-disk-${bases.target?.disk_layout[disk.slot]?.index ?? 0}`
			: "";
		const staging = await dst.node.call<{ name: string }>(
			"lv.transferPrepare",
			{ id: j.id, slot: disk.slot, sizeBytes: size, base: targetBase },
		);
		await relayVolume({
			source: src.node,
			target: dst.node,
			sourceName: name,
			targetName: staging.name,
			sizeBytes: size,
			verifiedBytes: j.progress[disk.slot] ?? 0,
			...(sourceBase && a ? { sourceBase, baseChecksum: a.sha256 } : {}),
			onProgress: async (p) => {
				await fence.check();
				j.progress[disk.slot] = p.verifiedBytes;
				j.progress.verifiedBytes = p.verifiedBytes;
				j.progress.totalBytes = p.totalBytes;
				await ctx.pool.query(
					"UPDATE runtime.volume_transfers SET progress=$2,phase='copying',updated_at=now() WHERE id=$1 AND phase IN ('preparing','copying')",
					[j.id, JSON.stringify(j.progress)],
				);
				if ("id" in fence) {
					const id = (fence as Fenced).id;
					const deadline = new Date(Date.now() + 300000);
					await ctx.pool.query(
						"UPDATE runtime.operations SET progress=progress || $2::jsonb,deadline_at=$3 WHERE id=$1 AND attempt=$4 AND state='running'",
						[
							id,
							JSON.stringify({
								phase: "moving",
								targetNode: dst.name,
								targetNodeId: j.target_node_id,
								slot: disk.slot,
								...p,
							}),
							deadline,
							(fence as Fenced).attempt,
						],
					);
					(fence as Fenced).op.deadlineAt = deadline;
				}
			},
		});
		await fence.check();
		const final = finalNames(disk);
		await dst.node.call("lv.transferPublish", {
			name: staging.name,
			target: final,
		});
		copied.push({
			...disk,
			sizeBytes: size,
			volume: `${dst.storage}:${final}`,
		});
	}
	// Copy heartbeats use a short inactivity budget. Boot gets the normal OS-specific
	// lifecycle budget again, including Windows resume and first-boot specialization.
	if ("id" in fence) {
		const opFence = fence as Fenced;
		await opFence.tx(async (tx) => {
			const os =
				(
					await tx.client.query<{ os: "linux" | "windows" }>(
						"SELECT tb.os FROM runtime.sandboxes s JOIN runtime.template_builds tb ON tb.id=s.template_build_id WHERE s.id=$1",
						[opFence.sandboxId],
					)
				).rows[0]?.os ?? "linux";
			const budget = operationDeadline(opFence.op.kind, os);
			if (budget !== null)
				await tx.client.query(
					"UPDATE runtime.operations SET deadline_at=now()+($2::int*interval '1 millisecond') WHERE id=$1",
					[opFence.id, budget],
				);
		});
		await opFence.check();
	}
	return copied;
}
async function removeOwned(
	ctx: WorkerCtx,
	nodeId: string,
	predicate: (lv: { name: string; tags: string[] }) => boolean,
	expected?: Record<string, string>,
) {
	const node = portable(await ctx.infra.forNode(nodeId));
	const lvs = await node.node.call<
		{ name: string; uuid: string; tags: string[] }[]
	>("lv.list", { tags: ["umiak"] });
	for (const lv of lvs.filter(predicate)) {
		if (expected && expected[lv.name] !== lv.uuid) continue;
		if (!lv.uuid) throw new Error("cannot clean a volume without its LVM UUID");
		await node.node.call("lv.transferRemove", { name: lv.name, uuid: lv.uuid });
	}
}

async function clearStaging(ctx: WorkerCtx, j: Journal) {
	await removeOwned(
		ctx,
		j.target_node_id,
		(l) =>
			l.tags.includes(`umiak-transfer-${j.id}`) &&
			l.name.startsWith(`umiak-snap-${j.id}-`),
	);
}

async function cleanupCommitted(ctx: WorkerCtx, j: Journal) {
	if (j.kind === "machine") {
		const result = j.result as {
			sourceDisks: InfraDisk[];
			vmid: number;
			machineId: string;
			sourceUUIDs: Record<string, string>;
		};
		const target = portable(await ctx.infra.forNode(j.target_node_id));
		await target.node
			.call("vm.transferUnlock", {
				vmid: result.vmid,
				id: j.id,
				machineId: result.machineId,
			})
			.catch(async (error) => {
				const m = await loadMachine(ctx.pool, j.source_id);
				if (m && m.state !== "deleted" && m.state !== "deleting") throw error;
			});
		const names = new Set(result.sourceDisks.map((d) => lvName(d.volume)));
		await removeOwned(
			ctx,
			j.source_node_id,
			(l) => names.has(l.name) && l.tags.includes(`umiak-vm-${result.vmid}`),
			result.sourceUUIDs,
		);
		await removeOwned(ctx, j.source_node_id, (l) =>
			l.tags.includes(`umiak-snap-${j.id}`),
		);
	} else if (j.kind === "snapshot") {
		const result = j.result as {
			sourceDisks: InfraDisk[];
			lvId: string;
			sourceUUIDs: Record<string, string>;
		};
		const names = new Set(result.sourceDisks.map((d) => lvName(d.volume)));
		await removeOwned(
			ctx,
			j.source_node_id,
			(l) => names.has(l.name) && l.tags.includes(`umiak-snap-${result.lvId}`),
			result.sourceUUIDs,
		);
	}
	await clearStaging(ctx, j);
	await phase(ctx, j, "done");
}
async function abortCopy(ctx: WorkerCtx, j: Journal) {
	await removeOwned(ctx, j.target_node_id, (l) =>
		l.tags.includes(`umiak-transfer-${j.id}`),
	);
	if (j.kind === "machine")
		await removeOwned(ctx, j.source_node_id, (l) =>
			l.tags.includes(`umiak-snap-${j.id}`),
		);
	await phase(ctx, j, "cancelled");
	await ctx.pool.query(
		"DELETE FROM runtime.move_reservations WHERE machine_id=$1",
		[j.source_id],
	);
}

/** Called while holding the machine's portable session lock, also by delete. */
export async function ensureMachineMove(
	ctx: WorkerCtx,
	fence: Fenced,
	abort = false,
): Promise<void> {
	const sandbox = (
		await ctx.pool.query<{ machine_id: string | null }>(
			"SELECT machine_id FROM runtime.sandboxes WHERE id=$1",
			[fence.sandboxId],
		)
	).rows[0];
	if (!sandbox?.machine_id) return;
	const m = await loadMachine(ctx.pool, sandbox.machine_id);
	if (!m) return;
	let j = (
		await ctx.pool.query<Journal>(
			`SELECT * FROM runtime.volume_transfers WHERE kind='machine' AND source_id=$1 AND ${unfinished} ORDER BY created_at DESC LIMIT 1`,
			[m.id],
		)
	).rows[0];
	const reservation = (
		await ctx.pool.query<{ node_id: string; storage_id: string }>(
			"SELECT node_id,storage_id FROM runtime.move_reservations WHERE machine_id=$1 AND operation_id=$2",
			[m.id, fence.id],
		)
	).rows[0];
	if (j?.phase === "committed") {
		await cleanupCommitted(ctx, j).catch((e) => {
			if (fence.op.kind === "delete") throw e;
			ctx.log.warn(
				{ transferId: j?.id, err: String(e) },
				"portable cleanup deferred",
			);
		});

		j = undefined;
	}
	if (j && ["verified", "switching"].includes(j.phase)) {
		const target = portable(await ctx.infra.forNode(j.target_node_id));
		const config = await target.api
			.get<Record<string, string | number>>(
				`/nodes/${target.name}/qemu/${m.vmid}/config`,
			)
			.catch(() => null);
		if (
			config &&
			String(config.tags ?? "")
				.split(/[;, ]/)
				.includes(`umiak-move-${j.id}`)
		) {
			await commitMachine(ctx, j);
			await cleanupCommitted(ctx, j).catch((e) => {
				if (fence.op.kind === "delete") throw e;
				ctx.log.warn(
					{ transferId: j?.id, err: String(e) },
					"portable cleanup deferred",
				);
			});

			return;
		}
	}
	if (j?.phase === "switching") {
		const result = j.result as { vmid: number; machineId: string };
		const src = portable(await ctx.infra.forNode(j.source_node_id));
		const dst = portable(await ctx.infra.forNode(j.target_node_id));
		await src.node.call("vm.transferSwitch", {
			vmid: result.vmid,
			machineId: result.machineId,
			target: dst.name,
			storage: dst.storage,
			id: j.id,
		});
		await commitMachine(ctx, j);
		await cleanupCommitted(ctx, j);
		return;
	}

	if (
		j &&
		(!reservation ||
			reservation.node_id !== j.target_node_id ||
			abort ||
			fence.op.kind === "delete")
	) {
		await abortCopy(ctx, j);
		j = undefined;
	}
	if (!reservation || abort || fence.op.kind === "delete") {
		if (abort || fence.op.kind === "delete")
			await ctx.pool.query(
				"DELETE FROM runtime.move_reservations WHERE machine_id=$1",
				[m.id],
			);
		return;
	}
	if (!j)
		j = await journal(
			ctx,
			"machine",
			m.id,
			m.node_id,
			reservation.node_id,
			reservation.storage_id,
		);
	if (m.vmid === null || m.state !== "stopped")
		throw new Error("cold move requires a stopped machine with a VMID");
	const source = await ctx.infra.forNode(j.source_node_id);
	const sourceDisks = await diskRows(ctx, "machine", m.id);
	const sourceLVs = await portable(source).node.call<
		{ name: string; uuid: string }[]
	>("lv.list", { tags: ["umiak"] });
	const sourceUUIDs =
		(j.result?.sourceUUIDs as Record<string, string> | undefined) ??
		Object.fromEntries(
			sourceDisks.map((d) => [
				lvName(d.volume),
				sourceLVs.find((l) => l.name === lvName(d.volume))?.uuid ?? "",
			]),
		);
	if (Object.values(sourceUUIDs).some((v) => !v))
		throw new Error("source LV UUID unavailable");

	if (sourceDisks.length === 0) throw new Error("cold move has no disks");
	if (!["verified", "switching"].includes(j.phase)) {
		const existing = await source.listLvs();
		const snapNames = sourceDisks.map((d) => `umiak-snap-${j?.id}-${d.slot}`);
		if (
			!snapNames.every((name) =>
				existing.some(
					(l) => l.name === name && l.tags.includes(`umiak-snap-${j?.id}`),
				),
			)
		) {
			if (existing.some((l) => snapNames.includes(l.name)))
				await removeOwned(ctx, j.source_node_id, (l) =>
					l.tags.includes(`umiak-snap-${j?.id}`),
				);
			await source.snapshot(m.vmid, {
				lvId: j.id,
				expectedOwner: m.id,
				beforeAct: () => fence.check(),
			});
		}
		const snapshots = sourceDisks.map((d) => ({
			...d,
			volume: `umiak-snap-${j?.id}-${d.slot}`,
		}));
		const targetDisks = await copyDisks(
			ctx,
			fence,
			j,
			snapshots,
			m.template_build_id,
			(d) => lvName(sourceDisks.find((s) => s.slot === d.slot)?.volume ?? ""),
		);
		await fence.check();
		await markVerified(fence, j, {
			sourceDisks,
			sourceUUIDs,
			targetDisks,
			vmid: m.vmid,
			machineId: m.id,
		});
	}
	await fence.check();
	await markSwitching(fence, j);
	const src = portable(source),
		dst = portable(await ctx.infra.forNode(j.target_node_id));
	await src.node.call("vm.transferSwitch", {
		vmid: m.vmid,
		target: dst.name,
		storage: dst.storage,
		id: j.id,
		machineId: m.id,
	});
	// After the atomic PVE switch, finish identity bookkeeping even if delete
	// superseded resume. Delete holds this same resource lock and will see target.
	await commitMachine(ctx, j);
	await cleanupCommitted(ctx, j).catch((e) =>
		ctx.log.warn(
			{ transferId: j?.id, err: String(e) },
			"portable cleanup deferred",
		),
	);
}
async function commitMachine(ctx: WorkerCtx, j: Journal) {
	const result = j.result as { targetDisks: InfraDisk[]; machineId: string };
	await withTx(ctx.pool, async (tx) => {
		await tx.client.query(
			"SELECT id FROM runtime.sandboxes WHERE machine_id=$1 FOR UPDATE",
			[j.source_id],
		);
		for (const id of [j.source_node_id, j.target_node_id].sort())
			await lockNode(tx, id);
		await tx.client.query(
			"UPDATE runtime.machines SET node_id=$2,storage_id=$3,template_build_id=COALESCE((SELECT tb.id FROM runtime.template_builds tb WHERE tb.node_id=$2 AND tb.status<>'retired' AND COALESCE(tb.source_build_id,tb.id)=(SELECT COALESCE(source_build_id,id) FROM runtime.template_builds WHERE id=runtime.machines.template_build_id) ORDER BY tb.created_at DESC LIMIT 1),template_build_id),version=version+1 WHERE id=$1",
			[j.source_id, j.target_node_id, j.target_storage_id],
		);
		await tx.client.query(
			"UPDATE runtime.sandboxes SET node_id=$2,template_build_id=(SELECT template_build_id FROM runtime.machines WHERE id=$1),version=version+1 WHERE machine_id=$1",
			[j.source_id, j.target_node_id],
		);
		for (const d of result.targetDisks)
			await tx.client.query(
				"UPDATE runtime.disks SET volume=$2,storage_id=$3 WHERE machine_id=$1 AND slot=$4 AND state='active'",
				[j.source_id, d.volume, j.target_storage_id, d.slot],
			);
		await tx.client.query(
			"DELETE FROM runtime.move_reservations WHERE machine_id=$1",
			[j.source_id],
		);
		await tx.client.query(
			"UPDATE runtime.volume_transfers SET phase='committed',updated_at=now() WHERE id=$1",
			[j.id],
		);
	});
	j.phase = "committed";
	const dst = portable(await ctx.infra.forNode(j.target_node_id));
	const vmid = (j.result as { vmid: number }).vmid;
	await dst.node.call("vm.transferUnlock", {
		vmid,
		id: j.id,
		machineId: j.source_id,
	});
}

/** Snapshot callers hold the snapshot lock until their local clone completes. */
export async function ensureSnapshotLocal(
	ctx: WorkerCtx,
	fence: StepFence,
	snapshotId: string,
	targetNode: string,
	storageId: string,
): Promise<void> {
	const snapshot = await loadSnapshot(ctx.pool, snapshotId);
	if (!snapshot) throw new Error("snapshot missing");
	if (snapshot.node_id === targetNode) return;
	const original = (
		await ctx.pool.query<{ template_build_id: string }>(
			"SELECT template_build_id FROM runtime.snapshots WHERE id=$1",
			[snapshotId],
		)
	).rows[0];
	if (!original) throw new Error("snapshot missing template identity");
	const j = await journal(
		ctx,
		"snapshot",
		snapshotId,
		snapshot.node_id,
		targetNode,
		storageId,
	);
	const sourceDisks = await diskRows(ctx, "snapshot", snapshotId);
	const src = portable(await ctx.infra.forNode(j.source_node_id));
	const sourceLVs = await src.node.call<{ name: string; uuid: string }[]>(
		"lv.list",
		{ tags: ["umiak"] },
	);
	const sourceUUIDs =
		(j.result?.sourceUUIDs as Record<string, string> | undefined) ??
		Object.fromEntries(
			sourceDisks.map((d) => [
				lvName(d.volume),
				sourceLVs.find((l) => l.name === lvName(d.volume))?.uuid ?? "",
			]),
		);
	if (Object.values(sourceUUIDs).some((v) => !v))
		throw new Error("source snapshot UUID unavailable");

	if (!["verified", "committed"].includes(j.phase)) {
		const targetDisks = await copyDisks(
			ctx,
			fence,
			j,
			sourceDisks,
			original.template_build_id,
			(d) => lvName(d.volume),
		);
		await fence.check();
		await markVerified(fence, j, {
			sourceDisks,
			sourceUUIDs,
			targetDisks,
			lvId: snapshot.lv_id,
		});
	}
	if (j.phase !== "committed")
		await fence.tx(async (tx) => {
			const row = (
				await tx.client.query(
					"SELECT state FROM runtime.snapshots WHERE id=$1 FOR UPDATE",
					[snapshotId],
				)
			).rows[0];
			if (row?.state !== "ready")
				throw new Error("snapshot is no longer ready for transfer");
			const result = j.result as { targetDisks: InfraDisk[] };
			await tx.client.query(
				"UPDATE runtime.snapshots SET node_id=$2,storage_id=$3,version=version+1 WHERE id=$1",
				[snapshotId, targetNode, storageId],
			);
			for (const d of result.targetDisks)
				await tx.client.query(
					"UPDATE runtime.disks SET volume=$2,storage_id=$3 WHERE snapshot_id=$1 AND slot=$4 AND state='active'",
					[snapshotId, d.volume, storageId, d.slot],
				);
			await tx.client.query(
				"UPDATE runtime.volume_transfers SET phase='committed',updated_at=now() WHERE id=$1",
				[j.id],
			);
			j.phase = "committed";
		});
	await cleanupCommitted(ctx, j).catch((e) =>
		ctx.log.warn(
			{ transferId: j.id, err: String(e) },
			"snapshot cleanup deferred",
		),
	);
}

/** Reconciliation retries post-commit source cleanup; it never discards unverified data. */
export async function reconcilePortableCleanup(ctx: WorkerCtx) {
	const rows = (
		await ctx.pool.query<Journal>(
			"SELECT * FROM runtime.volume_transfers WHERE kind IN ('machine','snapshot') AND phase='committed' ORDER BY created_at LIMIT 32",
		)
	).rows;
	for (const j of rows)
		await withPortableLock(ctx, `${j.kind}:${j.source_id}`, () =>
			cleanupCommitted(ctx, j),
		).catch((e) =>
			ctx.log.warn(
				{ transferId: j.id, err: String(e) },
				"portable cleanup pending",
			),
		);
	const abandoned = (
		await ctx.pool.query<Journal>(
			`SELECT v.* FROM runtime.volume_transfers v WHERE v.kind IN ('machine','snapshot') AND v.phase IN ('preparing','copying','verified') AND NOT EXISTS(SELECT 1 FROM runtime.machines m JOIN runtime.operations o ON o.sandbox_id=m.sandbox_id AND o.state IN ('pending','running') WHERE (v.kind='machine' AND m.id=v.source_id) OR (v.kind='snapshot' AND m.origin_snapshot_id=v.source_id AND m.node_id=v.target_node_id)) ORDER BY v.created_at LIMIT 32`,
		)
	).rows;
	for (const j of abandoned)
		await withPortableLock(ctx, `${j.kind}:${j.source_id}`, async () => {
			const active = (
				await ctx.pool.query(
					"SELECT 1 FROM runtime.machines m JOIN runtime.operations o ON o.sandbox_id=m.sandbox_id AND o.state IN ('pending','running') WHERE m.id=$1 OR m.origin_snapshot_id=$1 LIMIT 1",
					[j.source_id],
				)
			).rowCount;
			if (!active) await abortCopy(ctx, j);
		}).catch((e) =>
			ctx.log.warn(
				{ transferId: j.id, err: String(e) },
				"abandoned transfer cleanup deferred",
			),
		);
}
