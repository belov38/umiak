// Agent errors (S3 §11.1, §9) and their public form (S7 §5.5).
import {
	AgentOutdatedError,
	AgentUnavailableError,
	isConnectionError,
} from "@umiak/agent-client";
import {
	ApiError,
	type ApiErrorOptions,
	toHttpError,
	validationError,
} from "../http/errors.ts";

/**
 * The agent answered with an error code: an ErrorDetail code of a Connect
 * call or the `code` of a `/files` JSON error. `details` holds public
 * extras only (`offset` of upload_offset_mismatch, `entriesWritten` of an
 * archive upload); `status` is the HTTP status of a `/files` answer.
 */
export class AgentCallError extends Error {
	readonly code: string;
	readonly details: Record<string, unknown>;
	readonly status: number | undefined;

	constructor(
		code: string,
		message: string,
		details: Record<string, unknown> = {},
		status?: number,
	) {
		super(message);
		this.name = "AgentCallError";
		this.code = code;
		this.details = details;
		this.status = status;
	}
}

/** Agent codes that keep their name in the public API, by status. */
const SAME_CODE: Record<string, number> = {
	path_not_found: 404,
	upload_not_found: 404,
	not_directory: 409,
	is_directory: 409,
	cross_device: 409,
	already_exists: 409,
	command_exited: 409,
	upload_offset_mismatch: 409,
	payload_too_large: 413,
	range_not_satisfiable: 416,
	checksum_mismatch: 422,
	invalid_path: 400,
	no_space: 507,
};

// Connect codes (connectrpc Code) that mean the transport, not the agent,
// failed; the classifyByCode semantics of @umiak/agent-client.
const CONNECT_CANCELED = 1;
const CONNECT_DEADLINE_EXCEEDED = 4;
const CONNECT_UNAVAILABLE = 14;

/**
 * ErrorDetail codes the real agent sends only with Connect Unavailable
 * (services/guest-agent/internal/errs): the agent is busy for a moment, so
 * the call is retried like an unreachable agent, never answered 502.
 */
const UNAVAILABLE_DETAILS = new Set([
	"quiesced",
	"shim_unavailable",
	"store_busy",
	"identity_not_ready",
]);

function connectCode(e: unknown): unknown {
	if (!(e instanceof Error) || e.name !== "ConnectError") return undefined;
	return (e as { code?: unknown }).code;
}

/**
 * The agent could not be reached or the transport failed, so the outcome of
 * the call is unknown: AgentUnavailableError, a connection error (reset,
 * refused), a Connect error with code Unavailable (any detail), or Canceled
 * without a caller abort (a listener reset), or an AgentCallError with an
 * Unavailable-only detail code. Application codes (InvalidArgument,
 * NotFound, FailedPrecondition, DeadlineExceeded, ...) are answers, not
 * outages. Mirrors `classifyByCode` of @umiak/agent-client (not exported).
 */
export function isAgentUnreachable(e: unknown, signal?: AbortSignal): boolean {
	if (signal?.aborted) return false;
	if (e instanceof AgentUnavailableError || isConnectionError(e)) return true;
	if (e instanceof AgentCallError) return UNAVAILABLE_DETAILS.has(e.code);
	if (e instanceof AgentOutdatedError) return false;
	const code = connectCode(e);
	return code === CONNECT_UNAVAILABLE || code === CONNECT_CANCELED;
}

/**
 * A mutating call (Start, Signal, SendInput without a session, the
 * Filesystem mutations) may or may not have taken effect: the agent is
 * unreachable, or the call ran out of time (DeadlineExceeded) after the
 * agent may have acted on it.
 */
export function isAgentOutcomeUnknown(
	e: unknown,
	signal?: AbortSignal,
): boolean {
	if (signal?.aborted) return false;
	return (
		isAgentUnreachable(e) ||
		connectCode(e) === CONNECT_DEADLINE_EXCEEDED ||
		(e instanceof AgentCallError && e.code === "deadline_exceeded")
	);
}

/**
 * 503 agent_unavailable of a mutation without an idempotency key whose
 * outcome is unknown (S7 §5.5): not retryable, `details.outcome: "unknown"`
 * plus `details`. `what` completes "the sandbox agent is not reachable
 * and ...".
 */
export function unknownOutcomeError(
	what: string,
	details: Record<string, unknown> = {},
): ApiError {
	return new ApiError(
		503,
		"agent_unavailable",
		`the sandbox agent is not reachable and ${what}; check before repeating`,
		{ retryable: false, details: { ...details, outcome: "unknown" } },
	);
}

/**
 * The public error of a failed mutation that a repeat would apply twice
 * (no idempotency key reaches the agent): an unknown outcome
 * (isAgentOutcomeUnknown) is `unknownOutcomeError`, anything else maps
 * like `agentErrorToHttp`.
 */
export function agentMutationErrorToHttp(
	e: unknown,
	what: string,
	details: Record<string, unknown> = {},
): ApiError {
	if (!(e instanceof ApiError) && isAgentOutcomeUnknown(e)) {
		return unknownOutcomeError(what, details);
	}
	return agentErrorToHttp(e);
}

/** 503 agent_unavailable (retryable) for an unreachable agent. */
export function agentUnavailableError(): ApiError {
	return new ApiError(
		503,
		"agent_unavailable",
		"the sandbox agent is not reachable right now; retry later",
		{ retryable: true },
	);
}

/**
 * Maps an error of an AgentApi call to the public error.
 *
 * Contract for the AgentApi implementation over Connect (ConnectAgentApi,
 * S3 §11.1): keep Connect errors with code Unavailable, Canceled or
 * DeadlineExceeded as they are (ConnectError or AgentUnavailableError);
 * turn any other Connect error into AgentCallError(detail code, message)
 * with the ErrorDetail code (or the lower-case Connect code without a
 * detail: `invalid_argument`, `failed_precondition`, ...). The mapping:
 *
 * | Agent error | Public |
 * |---|---|
 * | unreachable, Connect Unavailable (any detail: quiesced, shim_unavailable, store_busy, identity_not_ready), Canceled | 503 agent_unavailable, retryable (mutations: unknown outcome, see isAgentOutcomeUnknown) |
 * | Connect DeadlineExceeded | 503 agent_unavailable, retryable (unkeyed mutations: unknown outcome, agentMutationErrorToHttp) |
 * | path_not_found, upload_not_found | 404, same code |
 * | command_not_found, not_found | 404 not_found |
 * | permission_denied | 403 path_forbidden |
 * | not_directory, is_directory, cross_device, already_exists, command_exited, upload_offset_mismatch | 409, same code |
 * | failed_precondition, too_many_commands, command_running | 409 invalid_state |
 * | not_claimed | 409 sandbox_not_ready |
 * | shim_outdated, unimplemented, AgentOutdatedError | 409 agent_outdated |
 * | request_id_reused | 409 idempotency_key_reused (the requestId derives from the key) |
 * | invalid_argument, user_not_found | 400 validation |
 * | invalid_path | 400 invalid_path |
 * | payload_too_large | 413, range_not_satisfiable 416, checksum_mismatch 422, no_space 507 (same code) |
 * | anything else | 502 agent_error with details.agentCode |
 *
 * ApiError passes through; a non-agent error maps like `toHttpError`
 * (500 internal). Start is classified in commands/run.ts first: only the
 * codes the agent sends before it launches anything (invalid_argument,
 * user_not_found, already_exists, too_many_commands, not_claimed, ...)
 * mark the command `failed_to_start`; any other error of a Start
 * (`internal`, `unknown`, an unknown code, `already_exists` on a keyed
 * replay) is an unknown outcome or follows the existing command.
 */
export function agentErrorToHttp(e: unknown): ApiError {
	if (e instanceof ApiError) return e;
	if (isAgentUnreachable(e) || isAgentOutcomeUnknown(e)) {
		return agentUnavailableError();
	}
	if (e instanceof AgentOutdatedError) {
		return new ApiError(
			409,
			"agent_outdated",
			`the sandbox agent does not support ${e.capability}; recreate the sandbox from a newer template`,
			{ details: { capability: e.capability } },
		);
	}
	if (!(e instanceof AgentCallError)) return toHttpError(e);

	const status = SAME_CODE[e.code];
	if (status !== undefined) {
		const opts: ApiErrorOptions = { details: { ...e.details } };
		if (
			e.code === "upload_offset_mismatch" &&
			typeof e.details.offset === "number"
		) {
			opts.headers = { "Umiak-Upload-Offset": String(e.details.offset) };
		}
		return new ApiError(status, e.code, e.message, opts);
	}
	switch (e.code) {
		case "desktop_unsupported":
			return new ApiError(422, e.code, e.message);
		case "desktop_not_ready":
		case "desktop_busy":
			return new ApiError(409, e.code, e.message, {
				retryable: true,
				headers: { "Retry-After": "2" },
			});
		case "invalid_action":
			return new ApiError(400, e.code, e.message, { details: e.details });
		case "action_failed":
			return new ApiError(422, e.code, e.message, { details: e.details });
		case "streamer_failed":
			return new ApiError(503, "streamer_unavailable", e.message, {
				retryable: true,
			});
		case "clipboard_unavailable":
			return new ApiError(503, e.code, e.message, { retryable: true });
		case "command_not_found":
			return new ApiError(404, "not_found", "command not found");
		case "not_found":
			return new ApiError(404, "not_found", e.message);
		case "failed_precondition":
		case "command_running":
			// Generic: stdin closed or not enabled, resize of a non-PTY command,
			// a non-empty directory without recursive, a chunk after commit.
			return new ApiError(409, "invalid_state", e.message, {
				details: { agentCode: e.code },
			});
		case "not_claimed":
			return new ApiError(
				409,
				"sandbox_not_ready",
				"the sandbox agent is not set up for this sandbox yet; retry once the sandbox is ready",
				{ details: { agentCode: e.code } },
			);
		case "shim_outdated":
		case "unimplemented":
			return new ApiError(
				409,
				"agent_outdated",
				`the sandbox agent cannot do this (${e.code}); recreate the sandbox from a newer template`,
				{ details: { agentCode: e.code } },
			);
		case "request_id_reused":
			return new ApiError(
				409,
				"idempotency_key_reused",
				"the sandbox agent saw this request id with a different request; use a new Idempotency-Key",
				{ details: { agentCode: e.code } },
			);
		case "permission_denied":
			return new ApiError(403, "path_forbidden", e.message);
		case "invalid_argument":
			return validationError([{ path: "", message: e.message }]);
		case "user_not_found":
			return validationError([{ path: "user", message: e.message }]);
		case "too_many_commands":
			return new ApiError(
				409,
				"invalid_state",
				"too many commands are running in this sandbox; wait for some to finish",
				{ details: { reason: "too_many_commands" } },
			);
		default:
			return new ApiError(
				502,
				"agent_error",
				`the sandbox agent returned an unexpected error (${e.code})`,
				{ details: { agentCode: e.code } },
			);
	}
}
