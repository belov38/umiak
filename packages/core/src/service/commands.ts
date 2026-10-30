import { withTx } from "@sbx/db";
import { ulid } from "ulid";
import { requestHash } from "../canonical.ts";
import {
	idempotencyKeyReused,
	notFound,
	sandboxNotReady,
	type ValidationIssue,
	validation,
} from "../errors.ts";
import { claimIdempotencyKey } from "../idempotency.ts";
import { idempotencyPrincipal, type Principal } from "../principal.ts";
import {
	COMMAND_EXIT_REASONS,
	type Command,
	type CommandExitReason,
	type CommandMode,
	type CommandStatus,
	commandFromRow,
	isOutputTruncatedReason,
	OUTPUT_TRUNCATED_MAX_CHARS,
	type Page,
} from "../rows.ts";
import {
	findSandboxRow,
	isUuid,
	type Queryable,
	type SandboxRow,
	type SandboxServiceDeps,
} from "./common.ts";
import { decodeCursor, encodeCursor } from "./cursor.ts";
import {
	checkKnownKeys,
	checkLabels,
	checkSeconds,
	isPlainObject,
} from "./validate.ts";

// Agent target, command rows and API activity (S6 §5.8, §12, §14.1). S7
// writes the command row before `Process/Start`; its status is completed by
// S7 (stream) or by the machine-events handler, and a terminal status is
// never overwritten.

export const COMMAND_MODES: readonly CommandMode[] = [
	"sync",
	"stream",
	"detached",
	"pty",
];
export const TERMINAL_COMMAND_STATUSES: readonly CommandStatus[] = [
	"exited",
	"killed",
	"timed_out",
	"lost",
	"failed_to_start",
];
/** `commands.cmd` keeps the first 64 KiB (S6 §5.8). */
export const COMMAND_CMD_MAX_BYTES = 64 * 1024;
const CWD_MAX_CHARS = 4096;
const REQUEST_ID_MAX_CHARS = 255;
/** `last_api_call_at` is written at most this often (S6 §12). */
export const API_ACTIVITY_THROTTLE_SECONDS = 30;
/** Idempotency scope of `POST /commands` (S7 §9.3). */
export const COMMAND_SCOPE = "commands.create";
export const COMMAND_DEFAULT_USER = "user";
const USER_MAX_CHARS = 64;
const ARGV_MAX_ITEMS = 4096;
const COMMAND_STATUSES: readonly CommandStatus[] = [
	"starting",
	"running",
	...TERMINAL_COMMAND_STATUSES,
];
const LIST_DEFAULT_LIMIT = 50;
const LIST_MAX_LIMIT = 200;

export interface CommandSpec {
	cmd: string;
	cwd?: string | null;
	/** Only the names are stored; values never leave the request. */
	env?: Record<string, string>;
	mode: CommandMode;
	timeoutSeconds?: number | null;
	requestId?: string | null;
	/** Guest user; default `user`. */
	user?: string;
	/** Program and arguments without a shell; with it, `cmd` may be empty. */
	argv?: string[] | null;
	tags?: Record<string, string>;
}

export interface CommandListFilter {
	status?: CommandStatus[];
	mode?: CommandMode;
	/** 1-200, default 50. */
	limit?: number;
}

export interface CommandResult {
	status: Exclude<CommandStatus, "starting" | "running">;
	exitCode?: number | null;
	signal?: string | null;
	stdoutBytes?: number | null;
	stderrBytes?: number | null;
	/** Why it ended (S3 `ExitReason` in lower case). */
	reason?: CommandExitReason | null;
	/**
	 * "disk_full" when the agent dropped output. Also recorded on a command
	 * that has ended already (and has none yet): it can arrive later.
	 */
	outputTruncated?: string | null;
	/** Default now. */
	endedAt?: Date;
}

export interface AgentTarget {
	machineId: string;
	/** From `tunnel.tunnel_sessions`; empty without a session. */
	capabilities: string[];
}

const SPEC_KEYS = [
	"cmd",
	"cwd",
	"env",
	"mode",
	"timeoutSeconds",
	"requestId",
	"user",
	"argv",
	"tags",
];
const RESULT_KEYS = [
	"status",
	"exitCode",
	"signal",
	"stdoutBytes",
	"stderrBytes",
	"reason",
	"outputTruncated",
	"endedAt",
];

/** The first `maxBytes` of `s` in UTF-8, never splitting a character. */
export function truncateUtf8(s: string, maxBytes: number): string {
	const buf = Buffer.from(s, "utf8");
	if (buf.length <= maxBytes) return s;
	let end = maxBytes;
	// Back off continuation bytes (10xxxxxx) to the start of a character.
	while (end > 0 && ((buf[end] ?? 0) & 0xc0) === 0x80) end--;
	return buf.subarray(0, end).toString("utf8");
}

function readyTarget(row: SandboxRow): string {
	if (row.state !== "ready" || row.machine_id === null) {
		throw sandboxNotReady(row.state);
	}
	return row.machine_id;
}

export async function resolveAgentTarget(
	deps: SandboxServiceDeps,
	p: Principal,
	idOrSlug: string,
): Promise<AgentTarget> {
	const row = await findSandboxRow(deps.pool, p, idOrSlug);
	const machineId = readyTarget(row);
	// NULL until the agent reports its capabilities: none known yet.
	const s = await deps.pool.query<{ capabilities: string[] | null }>(
		"SELECT capabilities FROM tunnel.tunnel_sessions WHERE machine_id = $1",
		[machineId],
	);
	return { machineId, capabilities: s.rows[0]?.capabilities ?? [] };
}

function validateSpec(spec: CommandSpec): void {
	if (!isPlainObject(spec as unknown)) {
		throw validation([{ path: "", message: "must be an object" }]);
	}
	const issues: ValidationIssue[] = [];
	checkKnownKeys(spec as unknown as Record<string, unknown>, SPEC_KEYS, issues);
	const hasArgv = spec.argv !== undefined && spec.argv !== null;
	if (typeof spec.cmd !== "string" || (spec.cmd.length === 0 && !hasArgv)) {
		issues.push({ path: "cmd", message: "must be a non-empty string" });
	} else if (spec.cmd.includes("\0")) {
		issues.push({ path: "cmd", message: "must not contain NUL" });
	}
	if (
		hasArgv &&
		(!Array.isArray(spec.argv) ||
			spec.argv.length === 0 ||
			spec.argv.length > ARGV_MAX_ITEMS ||
			!spec.argv.every((a) => typeof a === "string" && !a.includes("\0")))
	) {
		issues.push({
			path: "argv",
			message: `must be 1 to ${ARGV_MAX_ITEMS} strings without NUL`,
		});
	}
	if (
		spec.user !== undefined &&
		(typeof spec.user !== "string" ||
			spec.user.length === 0 ||
			spec.user.length > USER_MAX_CHARS ||
			// biome-ignore lint/suspicious/noControlCharactersInRegex: rejects control characters
			/[\x00-\x1f\x7f]/.test(spec.user))
	) {
		issues.push({
			path: "user",
			message: `must be a user name of 1 to ${USER_MAX_CHARS} characters`,
		});
	}
	if (spec.tags !== undefined) checkLabels("tags", spec.tags, issues);
	if (
		spec.cwd !== undefined &&
		spec.cwd !== null &&
		(typeof spec.cwd !== "string" ||
			spec.cwd.length > CWD_MAX_CHARS ||
			spec.cwd.includes("\0"))
	) {
		issues.push({
			path: "cwd",
			message: `must be a string of at most ${CWD_MAX_CHARS} characters`,
		});
	}
	if (spec.env !== undefined && !isPlainObject(spec.env)) {
		issues.push({ path: "env", message: "must be an object" });
	}
	if (!COMMAND_MODES.includes(spec.mode)) {
		issues.push({
			path: "mode",
			message: `must be one of ${COMMAND_MODES.join(", ")}`,
		});
	}
	if (spec.timeoutSeconds !== undefined) {
		checkSeconds("timeoutSeconds", spec.timeoutSeconds, issues, {
			nullable: true,
		});
	}
	if (
		spec.requestId !== undefined &&
		spec.requestId !== null &&
		(typeof spec.requestId !== "string" ||
			spec.requestId.length > REQUEST_ID_MAX_CHARS)
	) {
		issues.push({ path: "requestId", message: "must be a short string" });
	}
	if (issues.length > 0) throw validation(issues);
}

async function insertCommand(
	q: Queryable,
	p: Principal,
	row: SandboxRow,
	spec: CommandSpec,
	id: string,
): Promise<Command> {
	const machineId = readyTarget(row);
	const r = await q.query(
		`INSERT INTO runtime.commands
		   (id, sandbox_id, machine_id, cmd, cwd, env_keys, mode, timeout_seconds, status,
		    boot_id, created_by, request_id, "user", argv, tags, created_by_key)
		 VALUES ($1, $2, $3, $4, $5, $6, $7, $8, 'starting',
		         (SELECT boot_id FROM tunnel.tunnel_sessions WHERE machine_id = $3), $9, $10,
		         $11, $12::jsonb, $13::jsonb, $14)
		 RETURNING *`,
		[
			id,
			row.id,
			machineId,
			truncateUtf8(spec.cmd, COMMAND_CMD_MAX_BYTES),
			spec.cwd ?? null,
			Object.keys(spec.env ?? {}),
			spec.mode,
			spec.timeoutSeconds ?? null,
			p.userId,
			spec.requestId ?? null,
			spec.user ?? COMMAND_DEFAULT_USER,
			spec.argv === undefined || spec.argv === null
				? null
				: JSON.stringify(spec.argv),
			JSON.stringify(spec.tags ?? {}),
			p.apiKeyId ?? null,
		],
	);
	return commandFromRow(r.rows[0]);
}

/** Inserts the `starting` row before `Process/Start`; the id is the agent's commandId. */
export async function createCommand(
	deps: SandboxServiceDeps,
	p: Principal,
	idOrSlug: string,
	spec: CommandSpec,
): Promise<Command> {
	validateSpec(spec);
	const row = await findSandboxRow(deps.pool, p, idOrSlug);
	return insertCommand(deps.pool, p, row, spec, ulid());
}

async function loadCommand(
	q: Queryable,
	sandboxId: string,
	commandId: unknown,
): Promise<Command | null> {
	if (typeof commandId !== "string" || commandId === "") return null;
	const r = await q.query(
		"SELECT * FROM runtime.commands WHERE id = $1 AND sandbox_id = $2",
		[commandId, sandboxId],
	);
	return r.rows[0] ? commandFromRow(r.rows[0]) : null;
}

/**
 * `createCommand` under an Idempotency-Key (S7 §9.3, scope `commands.create`).
 * The key row (`response = {commandId}`) is written first in the transaction;
 * a repeat with the same sandbox and body returns the stored command whatever
 * the sandbox state is now. Another sandbox or body is `idempotency_key_reused`.
 * `requestBody` is the full request body (hashed with a key, never stored).
 */
export async function createCommandWithKey(
	deps: SandboxServiceDeps,
	p: Principal,
	idOrSlug: string,
	spec: CommandSpec,
	idemKey: string,
	requestBody: unknown,
): Promise<{ command: Command; replayed: boolean }> {
	validateSpec(spec);
	const sandboxId = (await findSandboxRow(deps.pool, p, idOrSlug)).id;
	const commandId = ulid();
	return withTx(deps.pool, async (tx) => {
		const claim = await claimIdempotencyKey(tx, {
			principalId: idempotencyPrincipal(p),
			scope: COMMAND_SCOPE,
			key: idemKey,
			requestHash: requestHash(deps.keys, COMMAND_SCOPE, {
				sandbox: sandboxId,
				body: requestBody,
			}),
			sandboxId,
			response: { commandId },
		});
		if (claim.kind === "replay") {
			// The hash covers the sandbox, so a match is the same sandbox; the
			// checks below only guard against a row that does not fit.
			const command =
				claim.sandboxId === sandboxId
					? await loadCommand(tx.client, sandboxId, claim.response?.commandId)
					: null;
			if (command === null) throw idempotencyKeyReused();
			return { command, replayed: true };
		}
		const row = await findSandboxRow(tx.client, p, sandboxId);
		const command = await insertCommand(tx.client, p, row, spec, commandId);
		return { command, replayed: false };
	});
}

/** `starting` → `running` with the agent's pid; any other status is left as is. */
export async function markCommandRunning(
	q: Queryable,
	commandId: string,
	pid: number | null,
): Promise<void> {
	if (
		pid !== null &&
		(!Number.isSafeInteger(pid) || pid < 0 || pid > 2 ** 31 - 1)
	) {
		throw validation([
			{ path: "pid", message: "must be a non-negative integer" },
		]);
	}
	const r = await q.query(
		`UPDATE runtime.commands
		 SET status = 'running', pid = $2, started_at = COALESCE(started_at, now())
		 WHERE id = $1 AND status = 'starting'`,
		[commandId, pid],
	);
	if (r.rowCount === 0) {
		const exists = await q.query(
			"SELECT 1 FROM runtime.commands WHERE id = $1",
			[commandId],
		);
		if (exists.rowCount === 0) throw notFound("command");
	}
}

/** The sandbox row for command reads: any state but `deleted` (S7 §9.1). */
async function readableSandbox(
	deps: SandboxServiceDeps,
	p: Principal,
	idOrSlug: string,
): Promise<SandboxRow> {
	const row = await findSandboxRow(deps.pool, p, idOrSlug);
	if (row.state === "deleted") throw notFound("sandbox");
	return row;
}

/** A command of this sandbox; another sandbox's command is `not_found`. */
export async function getCommand(
	deps: SandboxServiceDeps,
	p: Principal,
	idOrSlug: string,
	commandId: string,
): Promise<Command> {
	const row = await readableSandbox(deps, p, idOrSlug);
	const command = await loadCommand(deps.pool, row.id, commandId);
	if (command === null) throw notFound("command");
	return command;
}

/** Commands of the sandbox, newest first (`created_at DESC, id DESC`). */
export async function listCommands(
	deps: SandboxServiceDeps,
	p: Principal,
	idOrSlug: string,
	filter: CommandListFilter = {},
	cursor?: string,
): Promise<Page<Command>> {
	if (!isPlainObject(filter as unknown)) {
		throw validation([{ path: "filter", message: "must be an object" }]);
	}
	const issues: ValidationIssue[] = [];
	checkKnownKeys(
		filter as Record<string, unknown>,
		["status", "mode", "limit"],
		issues,
	);
	const limit = filter.limit ?? LIST_DEFAULT_LIMIT;
	if (!Number.isInteger(limit) || limit < 1 || limit > LIST_MAX_LIMIT) {
		issues.push({
			path: "limit",
			message: `must be an integer in 1..${LIST_MAX_LIMIT}`,
		});
	}
	if (
		filter.status !== undefined &&
		(!Array.isArray(filter.status) ||
			!filter.status.every((s) => COMMAND_STATUSES.includes(s)))
	) {
		issues.push({ path: "status", message: "unknown command status" });
	}
	if (filter.mode !== undefined && !COMMAND_MODES.includes(filter.mode)) {
		issues.push({
			path: "mode",
			message: `must be one of ${COMMAND_MODES.join(", ")}`,
		});
	}
	if (issues.length > 0) throw validation(issues);
	const after = cursor === undefined ? null : decodeCursor(cursor, isCommandId);
	const row = await readableSandbox(deps, p, idOrSlug);

	const where = ["c.sandbox_id = $1"];
	const args: unknown[] = [row.id];
	const arg = (v: unknown): string => {
		args.push(v);
		return `$${args.length}`;
	};
	if (filter.status !== undefined && filter.status.length > 0) {
		where.push(`c.status = ANY(${arg(filter.status)}::text[])`);
	}
	if (filter.mode !== undefined) where.push(`c.mode = ${arg(filter.mode)}`);
	if (after !== null) {
		where.push(
			`(c.created_at, c.id) < ((${arg(after.c)}::timestamp AT TIME ZONE 'UTC'), ${arg(after.id)}::text)`,
		);
	}
	const r = await deps.pool.query(
		`SELECT c.*, to_char(c.created_at AT TIME ZONE 'UTC', 'YYYY-MM-DD HH24:MI:SS.US') AS cursor_ts
		 FROM runtime.commands c
		 WHERE ${where.join(" AND ")}
		 ORDER BY c.created_at DESC, c.id DESC
		 LIMIT ${arg(limit + 1)}`,
		args,
	);
	const rows = r.rows.slice(0, limit);
	const last = rows.at(-1);
	return {
		data: rows.map(commandFromRow),
		nextCursor:
			r.rows.length > limit && last !== undefined
				? encodeCursor({ c: last.cursor_ts, id: last.id })
				: null,
	};
}

/** Command ids are ULIDs; any short id without odd characters is accepted. */
function isCommandId(s: unknown): s is string {
	return typeof s === "string" && /^[0-9A-Za-z_-]{1,128}$/.test(s);
}

function validateResult(result: CommandResult): void {
	if (!isPlainObject(result as unknown)) {
		throw validation([{ path: "", message: "must be an object" }]);
	}
	const issues: ValidationIssue[] = [];
	checkKnownKeys(
		result as unknown as Record<string, unknown>,
		RESULT_KEYS,
		issues,
	);
	if (!TERMINAL_COMMAND_STATUSES.includes(result.status)) {
		issues.push({
			path: "status",
			message: `must be one of ${TERMINAL_COMMAND_STATUSES.join(", ")}`,
		});
	}
	for (const k of ["exitCode", "stdoutBytes", "stderrBytes"] as const) {
		const v = result[k];
		if (v !== undefined && v !== null && !Number.isSafeInteger(v)) {
			issues.push({ path: k, message: "must be an integer" });
		}
	}
	if (
		result.reason !== undefined &&
		result.reason !== null &&
		!COMMAND_EXIT_REASONS.includes(result.reason)
	) {
		issues.push({
			path: "reason",
			message: `must be one of ${COMMAND_EXIT_REASONS.join(", ")}`,
		});
	}
	if (
		result.outputTruncated !== undefined &&
		result.outputTruncated !== null &&
		!isOutputTruncatedReason(result.outputTruncated)
	) {
		issues.push({ path: "outputTruncated", message: OUTPUT_TRUNCATED_RULE });
	}
	if (
		result.endedAt !== undefined &&
		!(result.endedAt instanceof Date && !Number.isNaN(result.endedAt.getTime()))
	) {
		issues.push({ path: "endedAt", message: "must be a Date" });
	}
	if (issues.length > 0) throw validation(issues);
}

const OUTPUT_TRUNCATED_RULE = `must be a reason of 1 to ${OUTPUT_TRUNCATED_MAX_CHARS} characters`;

/**
 * Writes a terminal status unless the command already has one. Unknown ids
 * are `not_found`; a command that is already terminal keeps its status and
 * reason, and only gets `outputTruncated` if it has none yet.
 */
export async function completeCommand(
	q: Queryable,
	commandId: string,
	result: CommandResult,
): Promise<void> {
	validateResult(result);
	const outputTruncated = result.outputTruncated ?? null;
	const r = await q.query(
		`UPDATE runtime.commands
		 SET status = $2, exit_code = $3, signal = $4, stdout_bytes = $5, stderr_bytes = $6,
		     ended_at = COALESCE($7::timestamptz, now()), reason = $8,
		     output_truncated = COALESCE(output_truncated, $9)
		 WHERE id = $1 AND status IN ('starting', 'running')`,
		[
			commandId,
			result.status,
			result.exitCode ?? null,
			result.signal ?? null,
			result.stdoutBytes ?? null,
			result.stderrBytes ?? null,
			result.endedAt ?? null,
			result.reason ?? null,
			outputTruncated,
		],
	);
	if (r.rowCount !== 0) return;
	if (outputTruncated !== null) {
		await markOutputTruncated(q, commandId, outputTruncated);
		return;
	}
	const exists = await q.query("SELECT 1 FROM runtime.commands WHERE id = $1", [
		commandId,
	]);
	if (exists.rowCount === 0) throw notFound("command");
}

/**
 * Records that the agent dropped output of the command (`output.truncated`,
 * S3), whatever its status; the first reason stays. Unknown ids are
 * `not_found`.
 */
export async function markOutputTruncated(
	q: Queryable,
	commandId: string,
	reason: string,
): Promise<void> {
	if (!isOutputTruncatedReason(reason)) {
		throw validation([{ path: "reason", message: OUTPUT_TRUNCATED_RULE }]);
	}
	const r = await q.query(
		`UPDATE runtime.commands SET output_truncated = $2
		 WHERE id = $1 AND output_truncated IS NULL`,
		[commandId, reason],
	);
	if (r.rowCount !== 0) return;
	const exists = await q.query("SELECT 1 FROM runtime.commands WHERE id = $1", [
		commandId,
	]);
	if (exists.rowCount === 0) throw notFound("command");
}

/**
 * `starting` → `failed_to_start` in one conditional UPDATE: the first
 * writer wins, a command already running or ended is not touched.
 */
export async function failCommandStart(
	q: Queryable,
	commandId: string,
): Promise<void> {
	await q.query(
		`UPDATE runtime.commands
		 SET status = 'failed_to_start', reason = 'start_failed', ended_at = now()
		 WHERE id = $1 AND status = 'starting'`,
		[commandId],
	);
}

/** `last_api_call_at = now()` at most once per 30 s per sandbox (S6 §12). */
export async function touchApiActivity(
	q: Queryable,
	sandboxId: string,
): Promise<void> {
	if (!isUuid(sandboxId)) return;
	await q.query(
		`UPDATE runtime.sandboxes SET last_api_call_at = now()
		 WHERE id = $1
		   AND (last_api_call_at IS NULL
		        OR last_api_call_at < now() - make_interval(secs => $2::int))`,
		[sandboxId, API_ACTIVITY_THROTTLE_SECONDS],
	);
}
