import { type Tx, withTx } from "@umiak/db";
import {
	invalidState,
	notFound,
	operatorRequired,
	type ValidationIssue,
	validation,
} from "../errors.ts";
import { hasOperatorRights, type Principal } from "../principal.ts";
import {
	BLOCK_REASONS,
	type BlockReason,
	type HostedPort,
	hostedPortFromRow,
	type Sandbox,
} from "../rows.ts";
import {
	insertSandboxEvent,
	type Queryable,
	type SandboxRow,
	type SandboxServiceDeps,
	selectSandboxRow,
	toSandbox,
} from "./common.ts";
import { validatePort } from "./ports.ts";
import { checkKnownKeys, isPlainObject } from "./validate.ts";

// Operator blocks (S8 §17.1 C3, §17.2 S4). Only an operator's browser session
// blocks and unblocks; the sandbox is found in any team (no Umiak-Team needed).
// A sandbox block makes every route of the sandbox `blocked` and leaves the
// team only reads, stop and delete (`findSandboxRow({write})`); a port block
// blocks its route and PUT/rotate/DELETE of the port (`ports.ts`). The
// triggers notify `umiak_routes` (0201 for hosted ports, 0204 for sandboxes);
// a sandbox block also notifies `umiak_ssh_revoke` and `umiak_identity`, an unblock
// `umiak_identity` (below).
// Each change is a `sandbox_events` row with `{reason, note, by}`.

export const BLOCK_NOTE_MAX_CHARS = 500;

export interface BlockInput {
	reason: BlockReason;
	/** Up to 500 characters; kept in the event only. */
	note?: string;
}

export interface UnblockInput {
	note?: string;
}

function checkNote(note: unknown, issues: ValidationIssue[]): void {
	if (note === undefined) return;
	if (typeof note !== "string" || note.length > BLOCK_NOTE_MAX_CHARS) {
		issues.push({
			path: "note",
			message: `must be a string of at most ${BLOCK_NOTE_MAX_CHARS} characters`,
		});
	}
}

function validateBlock(input: BlockInput): void {
	if (!isPlainObject(input as unknown)) {
		throw validation([{ path: "", message: "must be an object" }]);
	}
	const issues: ValidationIssue[] = [];
	checkKnownKeys(
		input as unknown as Record<string, unknown>,
		["reason", "note"],
		issues,
	);
	if (!BLOCK_REASONS.includes(input.reason)) {
		issues.push({
			path: "reason",
			message: `must be one of ${BLOCK_REASONS.join(", ")}`,
		});
	}
	checkNote(input.note, issues);
	if (issues.length > 0) throw validation(issues);
}

function validateUnblock(input: UnblockInput): void {
	if (!isPlainObject(input as unknown)) {
		throw validation([{ path: "", message: "must be an object" }]);
	}
	const issues: ValidationIssue[] = [];
	checkKnownKeys(input as unknown as Record<string, unknown>, ["note"], issues);
	checkNote(input.note, issues);
	if (issues.length > 0) throw validation(issues);
}

function requireOperator(p: Principal): void {
	if (!hasOperatorRights(p)) throw operatorRequired();
}

/** The sandbox of any team, locked. */
async function lockAnySandbox(
	q: Queryable,
	idOrSlug: string,
): Promise<SandboxRow> {
	const row = await selectSandboxRow(q, idOrSlug, null, true);
	if (row === null) throw notFound("sandbox");
	return row;
}

function eventData(
	reason: string | null,
	note: string | undefined,
	p: Principal,
	extra: Record<string, unknown> = {},
): Record<string, unknown> {
	return { ...extra, reason, note: note ?? null, by: p.userId };
}

export async function blockSandbox(
	deps: SandboxServiceDeps,
	p: Principal,
	idOrSlug: string,
	input: BlockInput,
): Promise<Sandbox> {
	requireOperator(p);
	validateBlock(input);
	return withTx(deps.pool, async (tx) => {
		const row = await lockAnySandbox(tx.client, idOrSlug);
		if (row.state === "deleted") throw invalidState(row.state);
		if (row.blocked === true && row.block_reason === input.reason) {
			return toSandbox(tx.client, row);
		}
		const r = await tx.client.query<SandboxRow>(
			`UPDATE runtime.sandboxes
			 SET blocked = true, block_reason = $2, blocked_at = now(), blocked_by = $3,
			     version = version + 1
			 WHERE id = $1 RETURNING *`,
			[row.id, input.reason, p.userId],
		);
		const updated = r.rows[0];
		if (!updated) throw new Error("block: sandbox row vanished under lock");
		await insertSandboxEvent(tx, {
			sandboxId: row.id,
			type: "blocked",
			reason: input.reason,
			data: eventData(input.reason, input.note, p),
		});
		// Open sessions end at once (S8 §11), delivered after the commit:
		// '' makes the gateway recheck every SSH session (ssh/authorize
		// denies a blocked sandbox, S4 §9.5); 'sandboxes:<id>' makes every api
		// close the sandbox's exec streams and PTY sockets (StreamRegistry).
		await tx.client.query(
			`SELECT pg_notify('umiak_ssh_revoke', ''),
			        pg_notify('umiak_identity', 'sandboxes:' || $1::text)`,
			[row.id],
		);
		return toSandbox(tx.client, updated);
	});
}

export async function unblockSandbox(
	deps: SandboxServiceDeps,
	p: Principal,
	idOrSlug: string,
	input: UnblockInput = {},
): Promise<Sandbox> {
	requireOperator(p);
	validateUnblock(input);
	return withTx(deps.pool, async (tx) => {
		const row = await lockAnySandbox(tx.client, idOrSlug);
		if (row.blocked !== true) return toSandbox(tx.client, row);
		const r = await tx.client.query<SandboxRow>(
			`UPDATE runtime.sandboxes
			 SET blocked = false, block_reason = NULL, blocked_at = NULL, blocked_by = NULL,
			     version = version + 1
			 WHERE id = $1 RETURNING *`,
			[row.id],
		);
		const updated = r.rows[0];
		if (!updated) throw new Error("unblock: sandbox row vanished under lock");
		await insertSandboxEvent(tx, {
			sandboxId: row.id,
			type: "unblocked",
			reason: row.block_reason,
			data: eventData(row.block_reason, input.note, p),
		});
		// The api desktop monitor lifts the block's revocation with a new epoch
		// right away instead of on its next 5 s tick (S10 §13.2); the stream
		// registry rechecks the block and closes nothing.
		await tx.client.query(
			`SELECT pg_notify('umiak_identity', 'sandboxes:' || $1::text)`,
			[row.id],
		);
		return toSandbox(tx.client, updated);
	});
}

/** The live hosted port of a sandbox of any team, under the sandbox lock. */
async function lockedPort(
	tx: Tx,
	idOrSlug: string,
	port: number,
): Promise<{ sandbox: SandboxRow; hp: HostedPort }> {
	const sandbox = await lockAnySandbox(tx.client, idOrSlug);
	const r = await tx.client.query(
		`SELECT * FROM runtime.hosted_ports
		 WHERE sandbox_id = $1 AND port = $2 AND deleted_at IS NULL`,
		[sandbox.id, port],
	);
	if (!r.rows[0]) throw notFound("hosted port");
	return { sandbox, hp: hostedPortFromRow(r.rows[0]) };
}

export async function blockPort(
	deps: SandboxServiceDeps,
	p: Principal,
	idOrSlug: string,
	port: number,
	input: BlockInput,
): Promise<HostedPort> {
	requireOperator(p);
	validatePort(port);
	validateBlock(input);
	return withTx(deps.pool, async (tx) => {
		const { sandbox, hp } = await lockedPort(tx, idOrSlug, port);
		if (hp.blocked && hp.blockReason === input.reason) return hp;
		const r = await tx.client.query(
			`UPDATE runtime.hosted_ports
			 SET blocked = true, block_reason = $2, blocked_at = now(), blocked_by = $3
			 WHERE id = $1 RETURNING *`,
			[hp.id, input.reason, p.userId],
		);
		await insertSandboxEvent(tx, {
			sandboxId: sandbox.id,
			type: "port_blocked",
			reason: input.reason,
			data: eventData(input.reason, input.note, p, { port }),
		});
		return hostedPortFromRow(r.rows[0]);
	});
}

export async function unblockPort(
	deps: SandboxServiceDeps,
	p: Principal,
	idOrSlug: string,
	port: number,
	input: UnblockInput = {},
): Promise<HostedPort> {
	requireOperator(p);
	validatePort(port);
	validateUnblock(input);
	return withTx(deps.pool, async (tx) => {
		const { sandbox, hp } = await lockedPort(tx, idOrSlug, port);
		if (!hp.blocked) return hp;
		const r = await tx.client.query(
			`UPDATE runtime.hosted_ports
			 SET blocked = false, block_reason = NULL, blocked_at = NULL, blocked_by = NULL
			 WHERE id = $1 RETURNING *`,
			[hp.id],
		);
		await insertSandboxEvent(tx, {
			sandboxId: sandbox.id,
			type: "port_unblocked",
			reason: hp.blockReason,
			data: eventData(hp.blockReason, input.note, p, { port }),
		});
		return hostedPortFromRow(r.rows[0]);
	});
}
