import { ENVIRONMENT_AAD_PREFIX } from "@sbx/auth";
import { DELETE_RETRY_LIMIT, requestSystemDelete, SbxError } from "@sbx/core";
import { withTx } from "@sbx/db";
import type { WorkerCtx } from "../context.ts";
import { lockSandboxRow } from "../db.ts";

// Controller `cleanup` (S6 §15.4, every 10 min). Each part is idempotent and
// works in bounded batches; what is left goes to the next run.
//
// Every part runs in its own try/catch (log + `sbx_cleanup_failed_total{part}`),
// so one failure does not skip the others.
//
// Retention: idempotency keys past `expires_at`; processed agent and synthetic
// events older than 7 days; commands older than 90 days; sandbox_events older
// than 90 days; S7 port SSO codes (`port_auth_codes`, S7 §12.2) older than a
// day, once S7's migration has created the table; `deleted` sandbox
// tombstones older than 30 days, with the rows that only exist for them
// (machines in `deleted` and their disks, operations, events, commands,
// ports, the `deleted` fork_source snapshots they consumed).
//
// Backstops: fork_source snapshots in `ready`/`failed` whose consumer is in
// `error`/`deleted` (or gone), and any fork_source older than 1 h that is not
// `deleted` (a `creating` one only when its source has no active fork) →
// `deleting` + `snapshot-op delete`; a `deleting` one older than 1 h gets its
// job again (singleton: a duplicate is dropped).
//
// System deletes (core `requestSystemDelete`, no principal): `error` sandboxes
// without live machines or disks after `errorRetentionDays` (event reason
// `error_retention`); `stopped` sandboxes after `stoppedRetentionDays` when set
// (event reason `retention`). Never with an active operation.
//
// Key rotation (§13.1): `sandbox_secrets` rows with a key version other than
// the ring's current one are decrypted and encrypted again, in batches, each
// under its sandbox row lock (lock order: sandbox row first). Team
// environments (`runtime.environments`, S8 §10.3) the same way, each under
// its own row lock; their revision and update time stay (same content). The
// gauge `sbx_secrets_old_key_rows` reports what is left in both tables
// (0 = the old key can go).

export const AGENT_EVENTS_RETENTION_DAYS = 7;
export const COMMANDS_RETENTION_DAYS = 90;
export const SANDBOX_EVENTS_RETENTION_DAYS = 90;
export const TOMBSTONE_RETENTION_DAYS = 30;
export const FORK_SOURCE_MAX_AGE_S = 3600;
export const PORT_AUTH_CODES_RETENTION_HOURS = 24;
const BATCH = 500;
const TOMBSTONE_BATCH = 100;
const REENCRYPT_BATCH = 100;
const REENCRYPT_MAX_BATCHES = 10;

export const CLEANUP_PARTS = [
	"idempotency_keys",
	"agent_events",
	"synthetic_events",
	"commands",
	"sandbox_events",
	"port_auth_codes",
	"tombstones",
	"fork_sources",
	"retention",
	"reencrypt",
] as const;
export type CleanupPart = (typeof CLEANUP_PARTS)[number];

export interface CleanupResult {
	idempotencyKeys: number;
	agentEvents: number;
	syntheticEvents: number;
	commands: number;
	sandboxEvents: number;
	portAuthCodes: number;
	tombstones: number;
	forkSources: string[];
	errorDeletes: string[];
	retentionDeletes: string[];
	/** sandbox_secrets rows re-encrypted with the current key. */
	reencrypted: number;
	reencryptFailed: number;
	/** runtime.environments rows re-encrypted with the current key. */
	environmentsReencrypted: number;
	environmentsReencryptFailed: number;
	/** Parts that threw in this run (logged, `sbx_cleanup_failed_total{part}`). */
	failed: CleanupPart[];
}

/** Each part runs on its own: a failure is logged and counted, the rest goes on. */
export async function runCleanup(ctx: WorkerCtx): Promise<CleanupResult> {
	const res: CleanupResult = {
		idempotencyKeys: 0,
		agentEvents: 0,
		syntheticEvents: 0,
		commands: 0,
		sandboxEvents: 0,
		portAuthCodes: 0,
		tombstones: 0,
		forkSources: [],
		errorDeletes: [],
		retentionDeletes: [],
		reencrypted: 0,
		reencryptFailed: 0,
		environmentsReencrypted: 0,
		environmentsReencryptFailed: 0,
		failed: [],
	};
	const part = async (name: CleanupPart, fn: () => Promise<void>) => {
		try {
			await fn();
		} catch (err) {
			res.failed.push(name);
			ctx.metrics.inc("sbx_cleanup_failed_total", { part: name });
			ctx.log.error(
				{ part: name, err: err instanceof Error ? err.message : String(err) },
				"cleanup part failed",
			);
		}
	};

	await part("idempotency_keys", async () => {
		res.idempotencyKeys = await deleteBatched(
			ctx,
			`DELETE FROM runtime.idempotency_keys WHERE ctid IN (
			   SELECT ctid FROM runtime.idempotency_keys WHERE expires_at < now() LIMIT ${BATCH})`,
		);
	});
	await part("agent_events", async () => {
		res.agentEvents = await deleteBatched(
			ctx,
			`DELETE FROM runtime.agent_events WHERE ctid IN (
			   SELECT ctid FROM runtime.agent_events
			   WHERE processed_at IS NOT NULL
			     AND received_at < now() - make_interval(days => ${AGENT_EVENTS_RETENTION_DAYS})
			   LIMIT ${BATCH})`,
		);
	});
	await part("synthetic_events", async () => {
		res.syntheticEvents = await deleteBatched(
			ctx,
			`DELETE FROM runtime.agent_synthetic_events WHERE ctid IN (
			   SELECT ctid FROM runtime.agent_synthetic_events
			   WHERE processed_at IS NOT NULL
			     AND received_at < now() - make_interval(days => ${AGENT_EVENTS_RETENTION_DAYS})
			   LIMIT ${BATCH})`,
		);
	});
	await part("commands", async () => {
		res.commands = await deleteBatched(
			ctx,
			`DELETE FROM runtime.commands WHERE id IN (
			   SELECT id FROM runtime.commands
			   WHERE created_at < now() - make_interval(days => ${COMMANDS_RETENTION_DAYS})
			   LIMIT ${BATCH})`,
		);
	});
	await part("sandbox_events", async () => {
		res.sandboxEvents = await deleteBatched(
			ctx,
			`DELETE FROM runtime.sandbox_events WHERE id IN (
			   SELECT id FROM runtime.sandbox_events
			   WHERE created_at < now() - make_interval(days => ${SANDBOX_EVENTS_RETENTION_DAYS})
			   LIMIT ${BATCH})`,
		);
	});
	await ctx.pool.query(
		"DELETE FROM runtime.desktop_tickets WHERE created_at<now()-interval '1 day'",
	);
	await part("port_auth_codes", async () => {
		// The table belongs to S7 (migration 0301) and may not exist yet.
		const t = await ctx.pool.query<{ ok: boolean }>(
			"SELECT to_regclass('runtime.port_auth_codes') IS NOT NULL AS ok",
		);
		if (t.rows[0]?.ok !== true) return;
		res.portAuthCodes = await deleteBatched(
			ctx,
			`DELETE FROM runtime.port_auth_codes WHERE ctid IN (
			   SELECT ctid FROM runtime.port_auth_codes
			   WHERE created_at < now() - make_interval(hours => ${PORT_AUTH_CODES_RETENTION_HOURS})
			   LIMIT ${BATCH})`,
		);
	});
	await part("tombstones", async () => {
		res.tombstones = await purgeTombstones(ctx);
	});
	await part("fork_sources", async () => {
		res.forkSources = await retireForkSourceLeftovers(ctx);
	});
	await part("retention", async () => {
		const d = await ctx.config.defaults();
		res.errorDeletes = await systemDeletes(
			ctx,
			`s.state = 'error'
			 AND s.state_changed_at < now() - make_interval(days => $1)
			 AND NOT EXISTS (SELECT 1 FROM runtime.machines m
			                 WHERE m.sandbox_id = s.id AND m.state <> 'deleted')
			 AND NOT EXISTS (SELECT 1 FROM runtime.disks dk JOIN runtime.machines m ON m.id = dk.machine_id
			                 WHERE m.sandbox_id = s.id AND dk.state <> 'deleted')`,
			d.errorRetentionDays,
			"error_retention",
		);
		if (d.stoppedRetentionDays !== null) {
			res.retentionDeletes = await systemDeletes(
				ctx,
				`s.state = 'stopped'
				 AND COALESCE(s.stopped_at, s.state_changed_at) < now() - make_interval(days => $1)`,
				d.stoppedRetentionDays,
				"retention",
			);
		}
	});
	await part("reencrypt", async () => {
		const current = ctx.keys.currentVersion;
		const enc = await reencryptRows(ctx, SANDBOX_SECRETS, current);
		res.reencrypted = enc.done;
		res.reencryptFailed = enc.failed;
		const envs = await reencryptRows(ctx, ENVIRONMENTS, current);
		res.environmentsReencrypted = envs.done;
		res.environmentsReencryptFailed = envs.failed;
		const left = await ctx.pool.query<{ n: number }>(
			`SELECT (SELECT count(*) FROM runtime.sandbox_secrets WHERE key_version <> $1)::int
			      + (SELECT count(*) FROM runtime.environments WHERE key_version <> $1)::int AS n`,
			[current],
		);
		ctx.metrics.set("sbx_secrets_old_key_rows", left.rows[0]?.n ?? 0);
	});
	ctx.log.info({ ...res }, "cleanup done");
	return res;
}

/** Repeats a bounded DELETE until it removes nothing; returns the total. */
async function deleteBatched(ctx: WorkerCtx, sql: string): Promise<number> {
	let total = 0;
	for (;;) {
		const r = await ctx.pool.query(sql);
		const n = r.rowCount ?? 0;
		total += n;
		if (n < BATCH) return total;
	}
}

/**
 * Tombstones older than 30 days whose machines are all `deleted`. Rows are
 * removed children first (FKs: disks → machines, disks/machines → snapshots).
 */
async function purgeTombstones(ctx: WorkerCtx): Promise<number> {
	let total = 0;
	for (;;) {
		const n = await withTx(ctx.pool, async (tx) => {
			const r = await tx.client.query<{ id: string }>(
				`SELECT s.id FROM runtime.sandboxes s
				 WHERE s.state = 'deleted'
				   AND s.deleted_at < now() - make_interval(days => ${TOMBSTONE_RETENTION_DAYS})
				   AND NOT EXISTS (SELECT 1 FROM runtime.machines m
				                   WHERE m.sandbox_id = s.id AND m.state <> 'deleted')
				 ORDER BY s.deleted_at LIMIT ${TOMBSTONE_BATCH}
				 FOR UPDATE SKIP LOCKED`,
			);
			const ids = r.rows.map((x) => x.id);
			if (ids.length === 0) return 0;
			const q = (sql: string) => tx.client.query(sql, [ids]);
			await q(
				`DELETE FROM runtime.disks WHERE machine_id IN (
				   SELECT id FROM runtime.machines WHERE sandbox_id = ANY($1::uuid[]))`,
			);
			await q(
				"DELETE FROM runtime.machines WHERE sandbox_id = ANY($1::uuid[])",
			);
			// Consumed fork sources of these sandboxes, once nothing references them.
			const snaps = await tx.client.query<{ id: string }>(
				`SELECT sn.id FROM runtime.snapshots sn
				 WHERE sn.kind = 'fork_source' AND sn.state = 'deleted'
				   AND sn.consumer_sandbox_id = ANY($1::uuid[])
				   AND NOT EXISTS (SELECT 1 FROM runtime.machines m WHERE m.origin_snapshot_id = sn.id)
				 FOR UPDATE OF sn`,
				[ids],
			);
			const snapIds = snaps.rows.map((x) => x.id);
			await tx.client.query(
				"DELETE FROM runtime.disks WHERE snapshot_id = ANY($1::uuid[])",
				[snapIds],
			);
			await tx.client.query(
				"DELETE FROM runtime.snapshots WHERE id = ANY($1::uuid[])",
				[snapIds],
			);
			for (const table of [
				"operations",
				"sandbox_events",
				"commands",
				"hosted_ports",
				"sandbox_secrets",
			]) {
				await q(
					`DELETE FROM runtime.${table} WHERE sandbox_id = ANY($1::uuid[])`,
				);
			}
			await q("DELETE FROM runtime.sandboxes WHERE id = ANY($1::uuid[])");
			return ids.length;
		});
		total += n;
		if (n < TOMBSTONE_BATCH) return total;
	}
}

/** fork_source backstop (§7.7, §15.4). Locks only snapshot rows (no team lock). */
async function retireForkSourceLeftovers(ctx: WorkerCtx): Promise<string[]> {
	return withTx(ctx.pool, async (tx) => {
		const r = await tx.client.query<{ id: string; state: string }>(
			`SELECT sn.id, sn.state FROM runtime.snapshots sn
			 LEFT JOIN runtime.sandboxes c ON c.id = sn.consumer_sandbox_id
			 WHERE sn.kind = 'fork_source' AND (
			   (sn.state IN ('ready', 'failed')
			     AND (c.id IS NULL OR c.state IN ('error', 'deleted')))
			   OR (sn.state <> 'deleted'
			     AND sn.created_at < now() - make_interval(secs => ${FORK_SOURCE_MAX_AGE_S})
			     AND (sn.state <> 'creating' OR NOT EXISTS (
			       SELECT 1 FROM runtime.operations o
			       WHERE o.sandbox_id = sn.source_sandbox_id AND o.kind = 'fork'
			         AND o.state IN ('pending', 'running'))))
			 )
			 ORDER BY sn.created_at LIMIT ${BATCH}
			 FOR UPDATE OF sn SKIP LOCKED`,
		);
		for (const { id, state } of r.rows) {
			if (state !== "deleting") {
				await tx.client.query(
					`UPDATE runtime.snapshots SET state = 'deleting', version = version + 1
					 WHERE id = $1`,
					[id],
				);
			}
			await ctx.jobs.send(
				tx,
				"snapshot-op",
				{ snapshotId: id, action: "delete" },
				{ singletonKey: id, retryLimit: DELETE_RETRY_LIMIT },
			);
		}
		if (r.rows.length > 0) {
			ctx.log.warn(
				{ snapshots: r.rows.map((x) => x.id) },
				"cleanup: leftover fork_source snapshots to delete",
			);
		}
		return r.rows.map((x) => x.id);
	});
}

/**
 * Sandboxes matching `cond` (alias `s`, `$1` = days) with no active
 * operation: `requestSystemDelete` each, after a re-check under its row lock.
 */
async function systemDeletes(
	ctx: WorkerCtx,
	cond: string,
	days: number,
	reason: string,
): Promise<string[]> {
	const where = `${cond}
		AND NOT EXISTS (SELECT 1 FROM runtime.operations o
		                WHERE o.sandbox_id = s.id AND o.state IN ('pending', 'running'))`;
	const r = await ctx.pool.query<{ id: string }>(
		`SELECT s.id FROM runtime.sandboxes s WHERE ${where} ORDER BY s.id LIMIT ${BATCH}`,
		[days],
	);
	const out: string[] = [];
	for (const { id } of r.rows) {
		try {
			const op = await withTx(ctx.pool, async (tx) => {
				const ok = await tx.client.query(
					`SELECT 1 FROM runtime.sandboxes s WHERE s.id = $2 AND ${where} FOR UPDATE OF s`,
					[days, id],
				);
				if (ok.rowCount !== 1) return null;
				return requestSystemDelete(tx, ctx.jobs, id, reason);
			});
			if (op === null) continue;
			out.push(id);
			ctx.metrics.inc("sbx_cleanup_delete_total", { reason });
			ctx.log.info(
				{ sandboxId: id, operationId: op.id, reason },
				"cleanup: sandbox deleted",
			);
		} catch (err) {
			if (!(err instanceof SbxError)) throw err;
			ctx.log.warn(
				{ sandboxId: id, code: err.code },
				"cleanup: delete skipped",
			);
		}
	}
	return out;
}

/** A table of encrypted rows the key rotation walks. */
interface EncryptedTable {
	/** For logs. */
	what: string;
	/** Ids of rows on an old key version ($1 current, $2 ids to skip). */
	pending: string;
	/** Re-encrypts one row under its locks; false when nothing was left to do. */
	one(ctx: WorkerCtx, id: string, current: number): Promise<boolean>;
}

const SANDBOX_SECRETS: EncryptedTable = {
	what: "sandbox secrets",
	pending: `SELECT sandbox_id AS id FROM runtime.sandbox_secrets
	          WHERE key_version <> $1 AND NOT (sandbox_id = ANY($2::uuid[]))
	          ORDER BY sandbox_id LIMIT ${REENCRYPT_BATCH}`,
	one: reencryptSandboxSecrets,
};

const ENVIRONMENTS: EncryptedTable = {
	what: "environment",
	pending: `SELECT id FROM runtime.environments
	          WHERE key_version <> $1 AND NOT (id = ANY($2::uuid[]))
	          ORDER BY id LIMIT ${REENCRYPT_BATCH}`,
	one: reencryptEnvironment,
};

/** §13.1 key rotation: re-encrypts rows of an old key version with the current one. */
async function reencryptRows(
	ctx: WorkerCtx,
	table: EncryptedTable,
	current: number,
): Promise<{ done: number; failed: number }> {
	const failed = new Set<string>();
	let done = 0;
	for (let b = 0; b < REENCRYPT_MAX_BATCHES; b++) {
		const r = await ctx.pool.query<{ id: string }>(table.pending, [
			current,
			[...failed],
		]);
		if (r.rows.length === 0) break;
		for (const { id } of r.rows) {
			try {
				if (await table.one(ctx, id, current)) done += 1;
			} catch (err) {
				failed.add(id);
				ctx.metrics.inc("sbx_secrets_reencrypt_failed_total");
				ctx.log.error(
					{ id, err: err instanceof Error ? err.message : String(err) },
					`cleanup: ${table.what} re-encryption failed`,
				);
			}
		}
	}
	return { done, failed: failed.size };
}

async function reencryptSandboxSecrets(
	ctx: WorkerCtx,
	sandboxId: string,
	current: number,
): Promise<boolean> {
	return withTx(ctx.pool, async (tx) => {
		// Lock order: the sandbox row first (writers of secrets hold it too).
		await lockSandboxRow(tx, sandboxId);
		const r = await tx.client.query<{
			key_version: number;
			nonce: Buffer;
			ciphertext: Buffer;
		}>(
			`SELECT key_version, nonce, ciphertext FROM runtime.sandbox_secrets
			 WHERE sandbox_id = $1 FOR UPDATE`,
			[sandboxId],
		);
		const row = r.rows[0];
		if (row === undefined || row.key_version === current) return false;
		const sets = ctx.keys.decrypt(sandboxId, {
			keyVersion: row.key_version,
			nonce: row.nonce,
			ciphertext: row.ciphertext,
		});
		const blob = ctx.keys.encrypt(sandboxId, sets);
		await tx.client.query(
			`UPDATE runtime.sandbox_secrets
			 SET key_version = $2, nonce = $3, ciphertext = $4, updated_at = now()
			 WHERE sandbox_id = $1`,
			[sandboxId, blob.keyVersion, blob.nonce, blob.ciphertext],
		);
		return true;
	});
}

// The blob is opaque here: decrypted and encrypted again as bytes, with the
// AAD of PgEnvironmentStore (@sbx/auth). Writers of an environment lock its
// row (SELECT ... FOR UPDATE), so a concurrent patch waits or wins.
async function reencryptEnvironment(
	ctx: WorkerCtx,
	id: string,
	current: number,
): Promise<boolean> {
	return withTx(ctx.pool, async (tx) => {
		const r = await tx.client.query<{
			key_version: number;
			nonce: Buffer;
			ciphertext: Buffer;
		}>(
			`SELECT key_version, nonce, ciphertext FROM runtime.environments
			 WHERE id = $1 FOR UPDATE`,
			[id],
		);
		const row = r.rows[0];
		if (row === undefined || row.key_version === current) return false;
		const plain = ctx.keys.decryptFor(ENVIRONMENT_AAD_PREFIX, id, {
			keyVersion: row.key_version,
			nonce: row.nonce,
			ciphertext: row.ciphertext,
		});
		const blob = ctx.keys.encryptFor(ENVIRONMENT_AAD_PREFIX, id, plain);
		await tx.client.query(
			`UPDATE runtime.environments SET key_version = $2, nonce = $3, ciphertext = $4
			 WHERE id = $1`,
			[id, blob.keyVersion, blob.nonce, blob.ciphertext],
		);
		return true;
	});
}
