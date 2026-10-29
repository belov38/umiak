// Agent errors (S3 §11.1, §9) and their public form (S7 §5.5).
import { AgentOutdatedError, AgentUnavailableError } from "@sbx/agent-client";
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

/**
 * Maps an error of an AgentApi call to the public error. Unknown agent
 * codes are 502 agent_error with `details.agentCode`; ApiError passes
 * through; anything else maps like `toHttpError` (500 internal).
 */
export function agentErrorToHttp(e: unknown): ApiError {
	if (e instanceof ApiError) return e;
	if (e instanceof AgentUnavailableError) {
		return new ApiError(
			503,
			"agent_unavailable",
			"the sandbox agent is not reachable right now; retry later",
			{ retryable: true },
		);
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
			opts.headers = { "Sbx-Upload-Offset": String(e.details.offset) };
		}
		return new ApiError(status, e.code, e.message, opts);
	}
	switch (e.code) {
		case "command_not_found":
			return new ApiError(404, "not_found", "command not found");
		case "not_found":
			return new ApiError(404, "not_found", e.message);
		case "failed_precondition":
			// Generic: stdin closed or not enabled, resize of a non-PTY command,
			// a non-empty directory without recursive, a chunk after commit.
			return new ApiError(409, "invalid_state", e.message, {
				details: { agentCode: e.code },
			});
		case "permission_denied":
			return new ApiError(403, "path_forbidden", e.message);
		case "invalid_argument":
			return validationError([{ path: "", message: e.message }]);
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
