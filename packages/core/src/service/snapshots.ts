import { withTx } from "@sbx/db";
import { requestHash } from "../canonical.ts";
import { checkQuota } from "../capacity.ts";
import { operationDeadline } from "../deadlines.ts";
import {
	idempotencyKeyReused,
	notFound,
	operationInProgress,
	snapshotNotFound,
	validation,
} from "../errors.ts";
import { claimIdempotencyKey } from "../idempotency.ts";
import { uuidv7 } from "../ids.ts";
import { idempotencyPrincipal, type Principal } from "../principal.ts";
import { DELETE_RETRY_LIMIT } from "../queues.ts";
import {
	type Operation,
	type SavedSnapshot,
	snapshotFromRow,
} from "../rows.ts";
import { sandboxNext } from "../states.ts";
import {
	activeOperation,
	buildOs,
	findSandboxRow,
	insertOperation,
	loadOperation,
	machineInfo,
	type Queryable,
	type SandboxServiceDeps,
	sendSandboxOp,
} from "./common.ts";

// Saved snapshots (S6 §7.8, S7 §12 "Saved snapshots"). Save inserts the
// snapshot row `creating` (with `pending_name`) and a `save_snapshot`
// operation on the source; the worker takes the snapshot and, once it is
// ready, moves the name from the replaced snapshot. Delete frees the name at
// once (`deleting`) and leaves the LV to the `snapshot-op` job.

export const SNAPSHOT_SCOPE = "snapshots.create";

/** S7: `^[a-z0-9][a-z0-9-]{0,62}$`. */
const SNAPSHOT_NAME_RE = /^[a-z0-9][a-z0-9-]{0,62}$/;

export interface SaveSnapshotResult {
	snapshot: SavedSnapshot;
	operation: Operation;
}

function validateSnapshotName(name: unknown): asserts name is string {
	if (typeof name !== "string" || !SNAPSHOT_NAME_RE.test(name)) {
		throw validation([
			{ path: "name", message: "must match ^[a-z0-9][a-z0-9-]{0,62}$" },
		]);
	}
}

async function loadSaveResult(
	q: Queryable,
	operationId: string,
): Promise<SaveSnapshotResult> {
	const operation = await loadOperation(q, operationId);
	if (operation === null) throw notFound("operation");
	const r = await q.query("SELECT * FROM runtime.snapshots WHERE id = $1", [
		operation.request.snapshotId,
	]);
	if (!r.rows[0]) throw notFound("snapshot");
	return { snapshot: snapshotFromRow(r.rows[0]), operation };
}

export async function saveSnapshot(
	deps: SandboxServiceDeps,
	p: Principal,
	idOrSlug: string,
	name: string,
	idemKey?: string,
): Promise<SaveSnapshotResult> {
	validateSnapshotName(name);
	// The sandbox is part of the idempotency hash (S7 §20.2 item 11).
	const sourceId = (await findSandboxRow(deps.pool, p, idOrSlug)).id;
	const snapshotId = uuidv7();
	const operationId = uuidv7();

	return withTx(deps.pool, async (tx) => {
		if (idemKey !== undefined) {
			const claim = await claimIdempotencyKey(tx, {
				principalId: idempotencyPrincipal(p),
				scope: SNAPSHOT_SCOPE,
				key: idemKey,
				requestHash: requestHash(SNAPSHOT_SCOPE, { sandbox: sourceId, name }),
				sandboxId: sourceId,
				operationId,
			});
			if (claim.kind === "replay") {
				const res = await loadSaveResult(tx.client, claim.operationId ?? "");
				if (res.snapshot.teamId !== p.teamId) throw idempotencyKeyReused();
				return res;
			}
		}

		const src = await findSandboxRow(tx.client, p, sourceId, { lock: true });
		const active = await activeOperation(tx.client, src.id);
		if (active !== null) throw operationInProgress(active);
		sandboxNext(src.state, "save_snapshot");
		const machine = await machineInfo(tx.client, src.machine_id);
		if (machine === null) throw notFound("source machine");

		const quota = await deps.config.teamQuota(p.teamId);
		await checkQuota(tx, p.teamId, quota, {
			addSavedSnapshots: 1,
			replacingSavedName: name,
		});

		await tx.client.query(
			`INSERT INTO runtime.snapshots
			   (id, kind, team_id, pending_name, source_sandbox_id, source_machine_id,
			    provider_id, node_id, storage_id, template_build_id, lv_id, state)
			 VALUES ($1, 'saved', $2, $3, $4, $5, $6, $7, $8, $9, $10, 'creating')`,
			[
				snapshotId,
				p.teamId,
				name,
				src.id,
				machine.id,
				src.provider_id,
				src.node_id,
				machine.storageId,
				src.template_build_id,
				snapshotId.replaceAll("-", ""),
			],
		);
		const os = await buildOs(tx.client, src.template_build_id);
		await insertOperation(tx, {
			id: operationId,
			sandboxId: src.id,
			kind: "save_snapshot",
			request: { name, snapshotId },
			principal: p,
			deadlineMs: operationDeadline("save_snapshot", os),
		});
		await sendSandboxOp(tx, deps.jobs, operationId, src.id);
		return loadSaveResult(tx.client, operationId);
	});
}

/**
 * The team's `ready` saved snapshot of this name → `deleting` (the name is
 * free at once) and a `snapshot-op delete` job. Locks only the snapshot row
 * (lock order contract: no team lock).
 */
export async function deleteSavedSnapshot(
	deps: SandboxServiceDeps,
	p: Principal,
	name: string,
): Promise<void> {
	if (typeof name !== "string" || !SNAPSHOT_NAME_RE.test(name)) {
		throw snapshotNotFound(String(name));
	}
	await withTx(deps.pool, async (tx) => {
		const r = await tx.client.query<{ id: string }>(
			`SELECT id FROM runtime.snapshots
			 WHERE team_id = $1 AND kind = 'saved' AND name = $2 AND state = 'ready'
			 FOR UPDATE`,
			[p.teamId, name],
		);
		const id = r.rows[0]?.id;
		if (id === undefined) throw snapshotNotFound(name);
		await tx.client.query(
			`UPDATE runtime.snapshots SET state = 'deleting', version = version + 1
			 WHERE id = $1`,
			[id],
		);
		await deps.jobs.send(
			tx,
			"snapshot-op",
			{ snapshotId: id, action: "delete" },
			{ singletonKey: id, retryLimit: DELETE_RETRY_LIMIT },
		);
	});
}

/**
 * The team's saved snapshots in `ready` and `creating` (the expected name is
 * `pendingName`), newest first. `failed` within a day is S7 §20.2 item 6.
 */
export async function listSavedSnapshots(
	deps: SandboxServiceDeps,
	p: Principal,
): Promise<SavedSnapshot[]> {
	const r = await deps.pool.query(
		`SELECT * FROM runtime.snapshots
		 WHERE team_id = $1 AND kind = 'saved' AND state IN ('ready', 'creating')
		 ORDER BY created_at DESC, id DESC`,
		[p.teamId],
	);
	return r.rows.map(snapshotFromRow);
}
