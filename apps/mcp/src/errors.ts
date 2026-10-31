// Tool errors (S11 7.6): API errors and mcp's own checks become a tool result
// with isError: true and a short key: value text the model can act on.
import type { CallToolResult } from "@modelcontextprotocol/server";
import { SbxError } from "@sbx/sdk";
import { safeLine } from "./output/sanitize.ts";

export interface ToolErrorInit {
	code: string;
	message: string;
	retryable?: boolean;
	hint?: string;
	details?: Record<string, unknown>;
	idempotencyKey?: string;
}

/** An error raised by mcp itself (argument checks, deadline, login). */
export class ToolError extends Error {
	code: string;
	retryable: boolean;
	hint?: string;
	details?: Record<string, unknown>;
	idempotencyKey?: string;

	constructor(init: ToolErrorInit) {
		super(init.message);
		this.name = "ToolError";
		this.code = init.code;
		this.retryable = init.retryable ?? false;
		if (init.hint !== undefined) this.hint = init.hint;
		if (init.details !== undefined) this.details = init.details;
		if (init.idempotencyKey !== undefined)
			this.idempotencyKey = init.idempotencyKey;
	}
}

export interface HintContext {
	/** Sandbox id (sb_...) the call was about, if any. */
	sandbox?: string;
	/** The server is pinned to one sandbox: no `sandbox` argument, no create/list/delete tools. */
	pinned?: boolean;
	details: Record<string, unknown>;
}

function str(v: unknown): string | undefined {
	return typeof v === "string" && v !== "" ? v : undefined;
}

/** A string of the API's details, made safe to show (it may come from the agent). */
function safeStr(v: unknown): string | undefined {
	const s = str(v);
	return s === undefined ? undefined : safeLine(s);
}

function num(v: unknown): number | undefined {
	return typeof v === "number" && Number.isFinite(v) ? v : undefined;
}

function retryIn(details: Record<string, unknown>): string {
	const s = num(details.retryAfterSeconds);
	return s === undefined ? "a few seconds" : `${s} seconds`;
}

function validationHint(details: Record<string, unknown>): string {
	const issues = Array.isArray(details.issues) ? details.issues : [];
	const parts: string[] = [];
	for (const issue of issues.slice(0, 5)) {
		if (typeof issue !== "object" || issue === null) continue;
		const { path, message } = issue as Record<string, unknown>;
		const m = safeStr(message);
		if (m === undefined) continue;
		const p = safeStr(path);
		parts.push(p === undefined ? m : `${p}: ${m}`);
	}
	return parts.length === 0
		? "fix the arguments and call again."
		: `fix the arguments (${parts.join("; ")}) and call again.`;
}

/** Advice for the model by error code; undefined when there is none. */
export function hintFor(code: string, ctx: HintContext): string | undefined {
	const { sandbox, details, pinned } = ctx;
	switch (code) {
		case "sandbox_not_ready":
			return pinned
				? "call sandbox_resume and retry."
				: `call sandbox_resume with sandbox="${sandbox ?? "sb_..."}" and retry.`;
		case "sandbox_starting":
			return `the sandbox is still starting; retry in ${retryIn(details)}.`;
		case "agent_unavailable":
			return `the agent in the sandbox does not answer; retry in ${retryIn(details)}.`;
		case "operation_in_progress": {
			const op = safeStr(details.operationId);
			return `another operation${op === undefined ? "" : ` (${op})`} is running on this sandbox; retry in ${retryIn(details)}.`;
		}
		case "desktop_not_ready":
			return `the desktop is still starting; retry in ${retryIn(details)}.`;
		case "desktop_busy":
			return `another desktop action is still running; retry in ${retryIn(details)}.`;
		case "streamer_unavailable":
			return `the desktop streamer did not start; retry in ${retryIn(details)}.`;
		case "rate_limited":
			return `too many requests; retry in ${retryIn(details)}.`;
		case "forbidden": {
			const scope = safeStr(details.requiredScope);
			return scope === undefined
				? undefined
				: `this key lacks the scope ${scope}; ask a human to grant it.`;
		}
		case "confirmation_required":
			return sandbox === undefined
				? "set confirm to the id of the sandbox (or the name of the snapshot) you delete."
				: `set confirm="${sandbox}" (the id of the sandbox to delete) and call again.`;
		case "quota_exceeded":
			return pinned
				? "call limits_get to see the quota; the team must stop sandboxes it no longer needs."
				: "call limits_get to see the quota, then sandbox_stop the sandboxes you no longer need.";
		case "path_not_found":
			return "call files_list on the parent directory to check the path.";
		case "not_found":
			return pinned
				? "check the id or name; if the bound sandbox itself is gone, the MCP server must be restarted with another --sandbox."
				: "check the id or name; sandbox_list shows the sandboxes of the team.";
		case "validation":
			return validationHint(details);
		case "snapshot_requires_stop":
			return "a running Windows sandbox is snapshotted only from a stopped VM; retry with force_stop: true to stop and restart the sandbox (running commands and sessions are interrupted).";
		case "idempotency_key_reused":
			return "this idempotency_key was used with different arguments; use a new idempotency_key.";
		case "desktop_unsupported":
			return "this sandbox has no desktop; use a template with the desktop capability.";
		case "invalid_action": {
			const index = num(details.index);
			const reason = safeStr(details.reason);
			return `${index === undefined ? "an action" : `action ${index}`} is invalid${reason === undefined ? "" : ` (${reason})`}; nothing was executed. Fix the action list and call again.`;
		}
		case "action_failed": {
			const index = num(details.index);
			const completed = num(details.completed);
			return `${index === undefined ? "an action" : `action ${index}`} failed${completed === undefined ? "" : ` after ${completed} completed`}; completed actions are not rolled back. Call computer_screenshot to see the screen, then continue.`;
		}
		case "not_logged_in":
			return "run `sbx login` in a terminal, then retry.";
		case "token_provider_failed":
			return "the access token could not be obtained; run `sbx login` in a terminal, then retry.";
		case "deadline_exceeded":
			return "the call ran out of time and the action may have started; call again (with the same idempotency_key, if one is shown) to attach to it.";
		default:
			return undefined;
	}
}

interface ErrorFields {
	code: string;
	message: string;
	retryable: boolean;
	retryAfterSeconds?: number;
	hint?: string;
	idempotencyKey?: string;
	requestId?: string;
}

function errorName(err: unknown): string | undefined {
	return typeof err === "object" && err !== null && "name" in err
		? str((err as { name: unknown }).name)
		: undefined;
}

function fieldsOf(err: unknown): {
	fields: ErrorFields;
	details: Record<string, unknown>;
} {
	if (err instanceof ToolError) {
		const details = err.details ?? {};
		return {
			details,
			fields: {
				code: err.code,
				message: err.message,
				retryable: err.retryable,
				...(err.hint !== undefined ? { hint: err.hint } : {}),
				...(err.idempotencyKey !== undefined
					? { idempotencyKey: err.idempotencyKey }
					: {}),
			},
		};
	}
	if (err instanceof SbxError) {
		const seconds =
			err.retryAfterMs === null
				? num(err.details.retryAfterSeconds)
				: Math.ceil(err.retryAfterMs / 1000);
		return {
			details: err.details,
			fields: {
				code: err.code,
				message: err.message,
				retryable: err.retryable,
				...(seconds !== undefined ? { retryAfterSeconds: seconds } : {}),
				...(err.requestId !== null ? { requestId: err.requestId } : {}),
			},
		};
	}
	const name = errorName(err);
	if (name === "AbortError" || name === "TimeoutError") {
		return {
			details: {},
			fields: {
				code: "deadline_exceeded",
				message: "the call did not finish in time",
				retryable: true,
			},
		};
	}
	// Never the message or the stack of an unknown error.
	return {
		details: {},
		fields: { code: "internal", message: "internal error", retryable: false },
	};
}

export interface ErrorResultExtra {
	/** Key to show when the error carries none (unknown outcome, S11 7.4). */
	idempotencyKey?: string;
	/** Sandbox id the call was about, for hints. */
	sandbox?: string;
	/** Pinned mode: hints name no hidden tool and no `sandbox` argument. */
	pinned?: boolean;
}

/** The tool result for an error: `key: value` lines, `isError: true`. */
export function errorResult(
	err: unknown,
	extra: ErrorResultExtra = {},
): CallToolResult {
	const { fields, details } = fieldsOf(err);
	const hint =
		fields.hint ??
		hintFor(fields.code, {
			...(extra.sandbox !== undefined ? { sandbox: extra.sandbox } : {}),
			...(extra.pinned === true ? { pinned: true } : {}),
			details: {
				...(fields.retryAfterSeconds !== undefined
					? { retryAfterSeconds: fields.retryAfterSeconds }
					: {}),
				...details,
			},
		});
	const idempotencyKey = fields.idempotencyKey ?? extra.idempotencyKey;

	// Every value may carry API or agent text: one safe line each, and the
	// message capped (the hint is built here from capped parts).
	const lines = [
		`error: ${safeLine(fields.code)}`,
		`message: ${safeLine(fields.message)}`,
		`retryable: ${fields.retryable}`,
	];
	if (fields.retryAfterSeconds !== undefined)
		lines.push(`retry_after: ${fields.retryAfterSeconds}`);
	if (hint !== undefined)
		lines.push(`hint: ${safeLine(hint, Number.POSITIVE_INFINITY)}`);
	if (idempotencyKey !== undefined)
		lines.push(`idempotency_key: ${safeLine(idempotencyKey)}`);
	if (fields.requestId !== undefined)
		lines.push(`request_id: ${safeLine(fields.requestId)}`);
	return { content: [{ type: "text", text: lines.join("\n") }], isError: true };
}
