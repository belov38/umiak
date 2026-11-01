import { Code, ConnectError } from "@connectrpc/connect";
import { ErrorDetailSchema } from "@umiak/proto";
import {
	CODE_AGENT_OUTDATED,
	CODE_AGENT_UNAVAILABLE,
	CODE_MACHINE_MOVED,
	HEADER_ERROR_CODE,
	HEADER_INSTANCE_URL,
} from "./constants.js";

/**
 * The machine's agent could not be reached within the wait budget
 * (waitForAgentMs or maxAttempts). The API answers 503; callers may retry.
 */
export class AgentUnavailableError extends ConnectError {
	/** Always true: the caller may retry the same request later. */
	readonly retryable = true;

	constructor(
		readonly machineId: string,
		cause?: unknown,
	) {
		super(
			`machine ${machineId}: agent unavailable`,
			Code.Unavailable,
			undefined,
			[
				{
					desc: ErrorDetailSchema,
					value: { code: CODE_AGENT_UNAVAILABLE, retryable: true },
				},
			],
			cause,
		);
		// name stays "ConnectError": ConnectError's instanceof check (used by
		// connect-es to pass errors through unchanged) requires it.
	}

	/** Plain prototype check (ConnectError's own check is structural). */
	static override [Symbol.hasInstance](v: unknown): boolean {
		return Function.prototype[Symbol.hasInstance].call(
			AgentUnavailableError,
			v,
		);
	}
}

/** The agent lacks a capability the call needs. The API answers 409 agent_outdated. */
export class AgentOutdatedError extends ConnectError {
	constructor(
		readonly machineId: string,
		readonly capability: string,
	) {
		super(
			`machine ${machineId}: agent lacks capability ${capability}`,
			Code.FailedPrecondition,
			undefined,
			[
				{
					desc: ErrorDetailSchema,
					value: { code: CODE_AGENT_OUTDATED, retryable: false },
				},
			],
		);
		// name stays "ConnectError": ConnectError's instanceof check (used by
		// connect-es to pass errors through unchanged) requires it.
	}

	/** Plain prototype check (ConnectError's own check is structural). */
	static override [Symbol.hasInstance](v: unknown): boolean {
		return Function.prototype[Symbol.hasInstance].call(AgentOutdatedError, v);
	}
}

const connectionCode = /^(E[A-Z]+|ERR_HTTP2_.*)$/;

/**
 * True for a ConnectError (or a raw error) caused by a Node network or HTTP/2
 * error, e.g. ECONNREFUSED, ECONNRESET or ERR_HTTP2_STREAM_ERROR. The cause
 * chain is followed a few levels deep.
 */
export function isConnectionError(err: unknown): boolean {
	let e: unknown = err;
	for (let depth = 0; depth < 5 && e != null; depth++) {
		if (typeof e === "object") {
			const code = (e as { code?: unknown }).code;
			if (typeof code === "string" && connectionCode.test(code)) {
				return true;
			}
			e = (e as { cause?: unknown }).cause;
		} else {
			return false;
		}
	}
	return false;
}

/**
 * How the routing layer treats an error:
 * - "moved": the machine is served by another instance (421, machine_moved);
 * - "unavailable": no instance serves it right now (503, agent_unavailable, Code.Unavailable);
 * - "retry": a connection error (reset, refused, listener cancel);
 * - "fatal": everything else (InvalidArgument, NotFound, PermissionDenied,
 *   FailedPrecondition, DeadlineExceeded, caller abort, ...).
 */
export type Classification = "moved" | "unavailable" | "retry" | "fatal";

/**
 * Classifies an error from a call through the gateway. The gateway's
 * Umiak-Error-Code header (error metadata) wins, then the ErrorDetail, then the
 * Connect code. Pass the caller's signal: Canceled is a connection error
 * (a listener reset) unless that signal is aborted.
 */
export function classify(err: unknown, signal?: AbortSignal): Classification {
	if (signal?.aborted) {
		return "fatal";
	}
	if (!(err instanceof ConnectError)) {
		return isConnectionError(err) ? "retry" : "fatal";
	}
	const code = gatewayCode(err);
	if (code === CODE_MACHINE_MOVED) {
		return "moved";
	}
	if (code === CODE_AGENT_UNAVAILABLE) {
		return "unavailable";
	}
	if (isConnectionError(err)) {
		return "retry";
	}
	switch (err.code) {
		case Code.Unavailable:
			return "unavailable";
		case Code.Canceled:
			return "retry";
		default:
			return "fatal";
	}
}

/**
 * Classifies an error by its Connect code and connection state only,
 * ignoring Umiak-Error-Code and the ErrorDetail: for a 421 whose hint the
 * registry did not confirm, which is then not a gateway's answer, and for
 * errors of a started stream (the route watch, resumableAttach), whose
 * metadata and details come from the agent's end-stream message.
 */
export function classifyByCode(
	err: unknown,
	signal?: AbortSignal,
): Exclude<Classification, "moved"> {
	if (signal?.aborted) {
		return "fatal";
	}
	if (isConnectionError(err)) {
		return "retry";
	}
	if (!(err instanceof ConnectError)) {
		return "fatal";
	}
	switch (err.code) {
		case Code.Unavailable:
			return "unavailable";
		case Code.Canceled:
			return "retry";
		default:
			return "fatal";
	}
}

/** The gateway error code from Umiak-Error-Code metadata or the ErrorDetail. */
function gatewayCode(err: ConnectError): string | undefined {
	const header = err.metadata.get(HEADER_ERROR_CODE);
	if (header !== null && header !== "") {
		return header;
	}
	return detail(err)?.code || undefined;
}

function detail(err: ConnectError) {
	try {
		return err.findDetails(ErrorDetailSchema)[0];
	} catch {
		return undefined;
	}
}

/** The owning instance URL of a machine_moved error, if the gateway sent one. */
export function movedInstanceUrl(err: unknown): string | undefined {
	if (!(err instanceof ConnectError)) {
		return undefined;
	}
	const header = err.metadata.get(HEADER_INSTANCE_URL);
	if (header !== null && header !== "") {
		return header;
	}
	return detail(err)?.instanceUrl || undefined;
}
