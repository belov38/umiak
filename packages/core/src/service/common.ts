import type { ConfigReader, TemplateOs } from "@umiak/config";
import type { Tx } from "@umiak/db";
import type pg from "pg";
import { notFound, sandboxBlocked } from "../errors.ts";
import { uuidv7 } from "../ids.ts";
import type { JobSender } from "../jobs.ts";
import type { Notifier } from "../notifier.ts";
import { hasOperatorRights, type Principal } from "../principal.ts";
import {
	type Operation,
	type OperationKind,
	operationFromRow,
	type Sandbox,
	sandboxFromRow,
} from "../rows.ts";
import type { KeyRing } from "../secrets.ts";
import type { RandomInt } from "../slug.ts";
import type { MachineState, SandboxState } from "../states.ts";

// Helpers shared by the SandboxService methods (this task and later ones).

export interface SandboxServiceDeps {
	pool: pg.Pool;
	config: ConfigReader;
	keys: KeyRing;
	jobs: JobSender;
	/** LISTEN connection for `waitForState`; without it, polling only. */
	notifier?: Notifier;
	/** Random source of generated slugs (tests). */
	slugRandom?: RandomInt;
	/** Fallback poll of `waitForState` (default 2000 ms, 500 ms without a notifier). */
	waitPollMs?: number;
	/** Warnings of the service (pino-compatible); none when absent. */
	log?: ServiceLogger;
}

/** The subset of a pino logger the service uses. */
export interface ServiceLogger {
	warn(obj: Record<string, unknown>, msg: string): void;
}

/** A pool, a pooled client or `tx.client`. */
export type Queryable = Pick<pg.PoolClient, "query">;

const UUID_RE =
	/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function isUuid(s: unknown): s is string {
	return typeof s === "string" && UUID_RE.test(s);
}

export async function loadOperation(
	q: Queryable,
	id: string,
): Promise<Operation | null> {
	if (!isUuid(id)) return null;
	const r = await q.query("SELECT * FROM runtime.operations WHERE id = $1", [
		id,
	]);
	return r.rows[0] ? operationFromRow(r.rows[0]) : null;
}

/** Pending/running operations of the sandboxes, by sandbox id. */
export async function activeOperations(
	q: Queryable,
	sandboxIds: string[],
): Promise<Map<string, Operation>> {
	const out = new Map<string, Operation>();
	if (sandboxIds.length === 0) return out;
	const r = await q.query(
		`SELECT * FROM runtime.operations
		 WHERE sandbox_id = ANY($1::uuid[]) AND state IN ('pending', 'running')`,
		[sandboxIds],
	);
	for (const row of r.rows) {
		const op = operationFromRow(row);
		out.set(op.sandboxId, op);
	}
	return out;
}

// biome-ignore lint/suspicious/noExplicitAny: rows of node-postgres are untyped
export type SandboxRow = Record<string, any> & {
	id: string;
	state: SandboxState;
	team_id: string;
};

export async function toSandbox(
	q: Queryable,
	row: SandboxRow,
): Promise<Sandbox> {
	const ops = await activeOperations(q, [row.id]);
	return sandboxFromRow(row, ops.get(row.id) ?? null);
}

export async function loadSandbox(
	q: Queryable,
	id: string,
): Promise<Sandbox | null> {
	if (!isUuid(id)) return null;
	const r = await q.query<SandboxRow>(
		"SELECT * FROM runtime.sandboxes WHERE id = $1",
		[id],
	);
	return r.rows[0] ? toSandbox(q, r.rows[0]) : null;
}

export interface FindSandboxOptions {
	/** `FOR UPDATE` (inside a transaction). */
	lock?: boolean;
	/**
	 * The caller changes the sandbox or works in its guest: a sandbox blocked
	 * by an operator is `forbidden` (`sandbox_blocked`) unless the principal
	 * is an operator (S8 C3). Inside a transaction with `lock` the check is
	 * exact. Without a lock (the api's agent paths: files, command input,
	 * PTYs) it is best-effort: a block that commits between this read and
	 * the agent call lets that one in-flight call through; open streams are
	 * closed by the block's NOTIFY.
	 */
	write?: boolean;
}

/**
 * The principal's team sandbox by id (UUID) or slug; another team's sandbox
 * is `not_found` (S7 §7.5), also when blocked.
 */
export async function findSandboxRow(
	q: Queryable,
	p: Principal,
	idOrSlug: string,
	opts: FindSandboxOptions = {},
): Promise<SandboxRow> {
	const row = await selectSandboxRow(q, idOrSlug, p.teamId, opts.lock);
	if (row === null) throw notFound("sandbox");
	if (opts.write) assertNotBlocked(p, row);
	return row;
}

/** A sandbox of any team by id or slug (operators, S8 C3); null if unknown. */
export async function selectSandboxRow(
	q: Queryable,
	idOrSlug: string,
	teamId: string | null,
	lock = false,
): Promise<SandboxRow | null> {
	if (typeof idOrSlug !== "string" || idOrSlug === "") return null;
	const byId = isUuid(idOrSlug);
	const r = await q.query<SandboxRow>(
		`SELECT * FROM runtime.sandboxes
		 WHERE ${byId ? "id" : "slug"} = $1 AND ($2::uuid IS NULL OR team_id = $2::uuid)
		 ${lock ? "FOR UPDATE" : ""}`,
		[idOrSlug, teamId],
	);
	return r.rows[0] ?? null;
}

/** `sandbox_blocked` unless the sandbox is not blocked or `p` is an operator. */
export function assertNotBlocked(p: Principal, row: SandboxRow): void {
	if (row.blocked === true && !hasOperatorRights(p)) throw sandboxBlocked();
}

export interface NewOperation {
	id?: string;
	sandboxId: string;
	kind: OperationKind;
	/** Non-secret parameters only (S6 §13.1). */
	request: Record<string, unknown>;
	/** null: no principal (system operation). */
	principal: Principal | null;
	/** `operationDeadline(...)`; null for delete. */
	deadlineMs: number | null;
	parentOperationId?: string | null;
}

/** Inserts a `pending` operation; the active-operation index rejects a second one. */
export async function insertOperation(
	tx: Tx,
	op: NewOperation,
): Promise<string> {
	const id = op.id ?? uuidv7();
	await tx.client.query(
		`INSERT INTO runtime.operations
		   (id, sandbox_id, kind, state, request, requested_by, requested_by_key,
		    parent_operation_id, deadline_at)
		 VALUES ($1, $2, $3, 'pending', $4, $5, $6, $7,
		         CASE WHEN $8::bigint IS NULL THEN NULL
		              ELSE now() + make_interval(secs => $8::bigint / 1000.0) END)`,
		[
			id,
			op.sandboxId,
			op.kind,
			JSON.stringify(op.request),
			op.principal?.userId ?? null,
			op.principal?.apiKeyId ?? null,
			op.parentOperationId ?? null,
			op.deadlineMs,
		],
	);
	return id;
}

export interface NewSandboxEvent {
	sandboxId: string;
	type: string;
	fromState?: string | null;
	toState?: string | null;
	reason?: string | null;
	data?: Record<string, unknown> | null;
}

export async function insertSandboxEvent(
	tx: Tx,
	ev: NewSandboxEvent,
): Promise<void> {
	await tx.client.query(
		`INSERT INTO runtime.sandbox_events (id, sandbox_id, type, from_state, to_state, reason, data)
		 VALUES ($1, $2, $3, $4, $5, $6, $7)`,
		[
			uuidv7(),
			ev.sandboxId,
			ev.type,
			ev.fromState ?? null,
			ev.toState ?? null,
			ev.reason ?? null,
			ev.data === undefined || ev.data === null
				? null
				: JSON.stringify(ev.data),
		],
	);
}

/** The pending/running operation of one sandbox. */
export async function activeOperation(
	q: Queryable,
	sandboxId: string,
): Promise<Operation | null> {
	const ops = await activeOperations(q, [sandboxId]);
	return ops.get(sandboxId) ?? null;
}

/** `FOR UPDATE` of a sandbox row by id, without a team check (system callers). */
export async function lockSandboxById(
	tx: Tx,
	sandboxId: string,
): Promise<SandboxRow> {
	if (!isUuid(sandboxId)) throw notFound("sandbox");
	const r = await tx.client.query<SandboxRow>(
		"SELECT * FROM runtime.sandboxes WHERE id = $1 FOR UPDATE",
		[sandboxId],
	);
	const row = r.rows[0];
	if (!row) throw notFound("sandbox");
	return row;
}

/** OS of a template build (deadlines, S6 §7.9); the build row always exists. */
export async function buildOs(
	q: Queryable,
	templateBuildId: string,
): Promise<TemplateOs> {
	const r = await q.query<{ os: TemplateOs }>(
		"SELECT os FROM runtime.template_builds WHERE id = $1",
		[templateBuildId],
	);
	const os = r.rows[0]?.os;
	if (os === undefined) throw notFound("template build");
	return os;
}

export interface MachineInfo {
	id: string;
	state: MachineState;
	memoryMb: number;
	storageId: string;
}

/** The sandbox's current machine (plain read, no lock). */
export async function machineInfo(
	q: Queryable,
	machineId: string | null,
): Promise<MachineInfo | null> {
	if (machineId === null) return null;
	const r = await q.query<{
		id: string;
		state: MachineState;
		memory_mb: number;
		storage_id: string;
	}>(
		"SELECT id, state, memory_mb, storage_id FROM runtime.machines WHERE id = $1",
		[machineId],
	);
	const m = r.rows[0];
	if (!m) return null;
	return {
		id: m.id,
		state: m.state,
		memoryMb: m.memory_mb,
		storageId: m.storage_id,
	};
}

/** `sandbox-op {operationId}` with `singletonKey = sandboxId` (S6 §7.1). */
export async function sendSandboxOp(
	tx: Tx,
	jobs: JobSender,
	operationId: string,
	sandboxId: string,
): Promise<void> {
	await jobs.send(
		tx,
		"sandbox-op",
		{ operationId },
		{ singletonKey: sandboxId },
	);
}

/** Loads an operation that this transaction has just written. */
export async function mustLoadOperation(
	q: Queryable,
	id: string,
): Promise<Operation> {
	const op = await loadOperation(q, id);
	if (op === null) throw notFound("operation");
	return op;
}
