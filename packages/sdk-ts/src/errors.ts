// Errors of the SDK. Every API error body is
// {error: {code, message, retryable, details, requestId}} (S7 §5.5).

/** The request did not reach the API or the connection broke (status 0). */
export const NETWORK_ERROR = "network_error";
/** The response is an error without the API envelope (a proxy page, say). */
export const UNEXPECTED_RESPONSE = "unexpected_response";
/** No credentials found in the chain (S7 §7.6). */
export const NO_CREDENTIALS = "no_credentials";
/** No API URL: neither `baseUrl`, `SBX_API_URL` nor an `sbx` profile. */
export const NO_API_URL = "no_api_url";
/** `sbx auth token --json` failed or printed something unexpected. */
export const AUTH_COMMAND_FAILED = "auth_command_failed";
/** A Node/Bun-only helper (local paths, the system tar) used elsewhere. */
export const UNSUPPORTED_RUNTIME = "unsupported_runtime";
/** waitUntilReady / waitForOperation ran out of time. */
export const WAIT_TIMEOUT = "wait_timeout";
/** The tokenProvider option rejected or returned no token. */
export const TOKEN_PROVIDER_FAILED = "token_provider_failed";

export interface SbxErrorInit {
	status: number;
	code: string;
	message: string;
	retryable: boolean;
	details?: Record<string, unknown>;
	requestId?: string | null;
	/** Wait asked by the server (`Retry-After`), if any. */
	retryAfterMs?: number | null;
	cause?: unknown;
}

export class SbxError extends Error {
	/** HTTP status; 0 when there is no response (network, credentials). */
	readonly status: number;
	/** Stable snake_case code (S7 §5.5) or one of the SDK codes above. */
	readonly code: string;
	/** A repeat of the same request is safe and may succeed later. */
	readonly retryable: boolean;
	readonly details: Record<string, unknown>;
	readonly requestId: string | null;
	readonly retryAfterMs: number | null;

	constructor(init: SbxErrorInit) {
		super(
			init.message,
			init.cause === undefined ? undefined : { cause: init.cause },
		);
		this.name = "SbxError";
		this.status = init.status;
		this.code = init.code;
		this.retryable = init.retryable;
		this.details = init.details ?? {};
		this.requestId = init.requestId ?? null;
		this.retryAfterMs = init.retryAfterMs ?? null;
	}
}

/** The sandbox ended up in `error`, `deleting`, `deleted` or `stopped` while waiting for `ready`. */
export class SandboxFailedError extends SbxError {
	constructor(init: SbxErrorInit) {
		super(init);
		this.name = "SandboxFailedError";
	}
}

function isRecord(v: unknown): v is Record<string, unknown> {
	return typeof v === "object" && v !== null && !Array.isArray(v);
}

/** Parses `Retry-After` (delta seconds or an HTTP date) into milliseconds. */
export function parseRetryAfter(
	value: string | null,
	now = Date.now(),
): number | null {
	if (value === null || value.trim() === "") return null;
	const v = value.trim();
	if (/^\d+$/.test(v)) return Number(v) * 1000;
	const at = Date.parse(v);
	if (Number.isNaN(at)) return null;
	return Math.max(0, at - now);
}

/** Builds the SbxError for an error response; reads the body. */
export async function errorFromResponse(res: Response): Promise<SbxError> {
	const text = await res.text().catch(() => "");
	let body: unknown;
	try {
		body = JSON.parse(text);
	} catch {
		body = undefined;
	}
	const retryAfterMs = parseRetryAfter(res.headers.get("Retry-After"));
	const env = isRecord(body) ? body.error : undefined;
	if (
		isRecord(env) &&
		typeof env.code === "string" &&
		typeof env.retryable === "boolean"
	) {
		return new SbxError({
			status: res.status,
			code: env.code,
			message: typeof env.message === "string" ? env.message : env.code,
			retryable: env.retryable,
			details: isRecord(env.details) ? env.details : {},
			requestId:
				typeof env.requestId === "string"
					? env.requestId
					: res.headers.get("Request-Id"),
			retryAfterMs,
		});
	}
	const snippet = text.slice(0, 200).trim();
	return new SbxError({
		status: res.status,
		code: UNEXPECTED_RESPONSE,
		message: `HTTP ${res.status}${snippet ? `: ${snippet}` : ""}`,
		retryable: false,
		requestId: res.headers.get("Request-Id"),
		retryAfterMs,
	});
}

/** True for the rejection of an aborted fetch or wait. */
export function isAbortError(err: unknown): boolean {
	return (
		err instanceof Error &&
		(err.name === "AbortError" || err.name === "TimeoutError")
	);
}
