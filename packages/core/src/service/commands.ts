import { ulid } from "ulid";
import {
	notFound,
	sandboxNotReady,
	type ValidationIssue,
	validation,
} from "../errors.ts";
import type { Principal } from "../principal.ts";
import {
	type Command,
	type CommandMode,
	type CommandStatus,
	commandFromRow,
} from "../rows.ts";
import {
	findSandboxRow,
	isUuid,
	type Queryable,
	type SandboxRow,
	type SandboxServiceDeps,
} from "./common.ts";
import { checkKnownKeys, checkSeconds, isPlainObject } from "./validate.ts";

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

export interface CommandSpec {
	cmd: string;
	cwd?: string | null;
	/** Only the names are stored; values never leave the request. */
	env?: Record<string, string>;
	mode: CommandMode;
	timeoutSeconds?: number | null;
	requestId?: string | null;
}

export interface CommandResult {
	status: Exclude<CommandStatus, "starting" | "running">;
	exitCode?: number | null;
	signal?: string | null;
	stdoutBytes?: number | null;
	stderrBytes?: number | null;
	/** Default now. */
	endedAt?: Date;
}

export interface AgentTarget {
	machineId: string;
	/** From `tunnel.tunnel_sessions`; empty without a session. */
	capabilities: string[];
}

const SPEC_KEYS = ["cmd", "cwd", "env", "mode", "timeoutSeconds", "requestId"];
const RESULT_KEYS = [
	"status",
	"exitCode",
	"signal",
	"stdoutBytes",
	"stderrBytes",
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
	if (typeof spec.cmd !== "string" || spec.cmd.length === 0) {
		issues.push({ path: "cmd", message: "must be a non-empty string" });
	} else if (spec.cmd.includes("\0")) {
		issues.push({ path: "cmd", message: "must not contain NUL" });
	}
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

/** Inserts the `starting` row before `Process/Start`; the id is the agent's commandId. */
export async function createCommand(
	deps: SandboxServiceDeps,
	p: Principal,
	idOrSlug: string,
	spec: CommandSpec,
): Promise<Command> {
	validateSpec(spec);
	const row = await findSandboxRow(deps.pool, p, idOrSlug);
	const machineId = readyTarget(row);
	const r = await deps.pool.query(
		`INSERT INTO runtime.commands
		   (id, sandbox_id, machine_id, cmd, cwd, env_keys, mode, timeout_seconds, status,
		    boot_id, created_by, request_id)
		 VALUES ($1, $2, $3, $4, $5, $6, $7, $8, 'starting',
		         (SELECT boot_id FROM tunnel.tunnel_sessions WHERE machine_id = $3), $9, $10)
		 RETURNING *`,
		[
			ulid(),
			row.id,
			machineId,
			truncateUtf8(spec.cmd, COMMAND_CMD_MAX_BYTES),
			spec.cwd ?? null,
			Object.keys(spec.env ?? {}),
			spec.mode,
			spec.timeoutSeconds ?? null,
			p.userId,
			spec.requestId ?? null,
		],
	);
	return commandFromRow(r.rows[0]);
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
		result.endedAt !== undefined &&
		!(result.endedAt instanceof Date && !Number.isNaN(result.endedAt.getTime()))
	) {
		issues.push({ path: "endedAt", message: "must be a Date" });
	}
	if (issues.length > 0) throw validation(issues);
}

/**
 * Writes a terminal status unless the command already has one. Unknown ids
 * are `not_found`; a command that is already terminal is left unchanged.
 */
export async function completeCommand(
	q: Queryable,
	commandId: string,
	result: CommandResult,
): Promise<void> {
	validateResult(result);
	const r = await q.query(
		`UPDATE runtime.commands
		 SET status = $2, exit_code = $3, signal = $4, stdout_bytes = $5, stderr_bytes = $6,
		     ended_at = COALESCE($7::timestamptz, now())
		 WHERE id = $1 AND status IN ('starting', 'running')`,
		[
			commandId,
			result.status,
			result.exitCode ?? null,
			result.signal ?? null,
			result.stdoutBytes ?? null,
			result.stderrBytes ?? null,
			result.endedAt ?? null,
		],
	);
	if (r.rowCount === 0) {
		const exists = await q.query(
			"SELECT 1 FROM runtime.commands WHERE id = $1",
			[commandId],
		);
		if (exists.rowCount === 0) throw notFound("command");
	}
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
