// Error envelope of every listener (S7 §5.5):
//   {"error": {code, message, retryable, details, requestId}} + Request-Id
// Routes throw ApiError (or a core SbxError); `toHttpError` maps anything
// thrown to an ApiError and `renderError` renders it.
import { encodeUuid } from "@sbx/auth";
import { isSbxError, isUuid, type SbxError } from "@sbx/core";
import type { Context, ErrorHandler, NotFoundHandler } from "hono";
import { HTTPException } from "hono/http-exception";
import type { Logger } from "pino";
import type { z } from "zod";
import type { ApiEnv } from "../deps.ts";
import { REQUEST_ID_HEADER } from "./request-id.ts";

export interface ApiErrorOptions {
	retryable?: boolean;
	details?: Record<string, unknown>;
	/** Extra response headers (`Retry-After` is added for 429/503 anyway). */
	headers?: Record<string, string>;
	cause?: unknown;
}

export class ApiError extends Error {
	readonly status: number;
	readonly code: string;
	readonly retryable: boolean;
	readonly details: Record<string, unknown>;
	readonly headers: Record<string, string> | undefined;

	constructor(
		status: number,
		code: string,
		message: string,
		opts: ApiErrorOptions = {},
	) {
		super(
			message,
			opts.cause === undefined ? undefined : { cause: opts.cause },
		);
		this.name = "ApiError";
		this.status = status;
		this.code = code;
		this.retryable = opts.retryable ?? false;
		this.details = opts.details ?? {};
		this.headers = opts.headers;
	}
}

// --- factories ---

export interface Issue {
	path: string;
	message: string;
}

export function validationError(issues: Issue[]): ApiError {
	const first = issues[0];
	const message = first
		? `${first.path === "" ? "request" : first.path}: ${first.message}${issues.length > 1 ? ` (and ${issues.length - 1} more)` : ""}`
		: "the request is invalid";
	return new ApiError(400, "validation", message, { details: { issues } });
}

/** `target` is where zod looked: `json` (body), `query`, `param`, `header`. */
export function zodValidationError(target: string, err: z.ZodError): ApiError {
	const prefix = target === "json" ? "" : `${target}.`;
	return validationError(
		err.issues.map((i) => {
			// Unknown keys are reported on the object; name them in the path.
			const keys = i.code === "unrecognized_keys" ? [i.keys.join(",")] : [];
			const path = [...i.path, ...keys].map(String).join(".");
			return {
				path: `${prefix}${path}`.replace(/\.$/, ""),
				message: i.message,
			};
		}),
	);
}

export function notFoundError(what = "resource"): ApiError {
	return new ApiError(404, "not_found", `${what} not found`);
}

export function invalidJsonError(): ApiError {
	return new ApiError(
		400,
		"invalid_json",
		"the request body is not valid JSON",
	);
}

export function payloadTooLargeError(limitBytes: number): ApiError {
	return new ApiError(
		413,
		"payload_too_large",
		`the request body exceeds ${limitBytes} bytes`,
		{ details: { limitBytes } },
	);
}

export function methodNotAllowedError(allow: string[]): ApiError {
	return new ApiError(
		405,
		"method_not_allowed",
		`method not allowed; this path accepts ${allow.join(", ")}`,
		{ details: { allow }, headers: { Allow: allow.join(", ") } },
	);
}

export function internalError(): ApiError {
	return new ApiError(
		500,
		"internal",
		"internal error; retry later or report the request id",
	);
}

// --- mapping ---

/** Core codes (S6 `SbxError`) to HTTP (S7 §5.5). Others become 500 internal. */
const CORE_STATUS: Record<string, number> = {
	not_found: 404,
	invalid_state: 409,
	operation_in_progress: 409,
	out_of_capacity: 503,
	quota_exceeded: 403,
	idempotency_key_reused: 409,
	template_unavailable: 422,
	snapshot_not_found: 404,
	sandbox_not_ready: 409,
	recover_rate_limited: 429,
	validation: 400,
	slug_taken: 409,
	snapshot_name_taken: 409,
	agent_unavailable: 503,
	// S8 C3: details.reason operator_required, sandbox_blocked, port_blocked.
	forbidden: 403,
};

/** Seconds of `Retry-After` when a 429/503 has no hint of its own. */
export const DEFAULT_RETRY_AFTER_SECONDS = 5;

/**
 * `Retry-After` of `server_shutting_down`. A stopping instance is out of the
 * balancer (readiness false), so it only sees requests on reused keep-alive
 * connections; its answer closes the connection and the retry, on a new
 * connection, reaches a healthy instance at once.
 */
export const SHUTTING_DOWN_RETRY_AFTER_SECONDS = 1;

/**
 * Maps anything thrown to an ApiError. `pool_exhausted` is not part of the
 * contract (no warm pool in the MVP) and maps to 500 like any unknown code;
 * so does an Error that is not an ApiError or SbxError.
 */
export function toHttpError(e: unknown): ApiError {
	if (e instanceof ApiError) return e;
	if (isSbxError(e)) {
		const status = CORE_STATUS[e.code];
		if (status === undefined) return internalError();
		return publicCoreError(status, e);
	}
	if (e instanceof HTTPException) return fromHttpException(e);
	// A worker-side machine state check that surfaced through a core call.
	if (
		e instanceof Error &&
		(e as { code?: unknown }).code === "machine_state_conflict"
	) {
		return new ApiError(409, "invalid_state", e.message, {
			details: { reason: "machine_state_conflict" },
		});
	}
	return internalError();
}

/**
 * Details of core errors carry UUIDs and internal operations: operation ids
 * become `op_...`, and an active internal `reprovision` is not named.
 */
function publicCoreError(status: number, e: SbxError): ApiError {
	const details: Record<string, unknown> = { ...e.details };
	let message = e.message;
	if (e.code === "operation_in_progress" && details.kind === "reprovision") {
		delete details.operationId;
		delete details.kind;
		message = "the platform is repairing this sandbox; retry after it finishes";
	}
	if (isUuid(details.operationId)) {
		details.operationId = encodeUuid("operation", details.operationId);
	}
	return new ApiError(status, e.code, message, {
		retryable: e.retryable,
		details,
	});
}

/**
 * Hono's own exceptions (validators, body limits, media type checks, and
 * middleware that throws HTTPException) by status.
 */
function fromHttpException(e: HTTPException): ApiError {
	switch (e.status) {
		case 400:
			return /malformed json/i.test(e.message)
				? invalidJsonError()
				: validationError([{ path: "", message: e.message }]);
		case 401:
			return new ApiError(401, "unauthorized", "authentication required");
		case 403:
			return new ApiError(403, "forbidden", "access denied");
		case 404:
			return notFoundError();
		case 429:
			return new ApiError(
				429,
				"rate_limited",
				"too many requests; retry later",
				{
					retryable: true,
				},
			);
		case 413:
			return new ApiError(
				413,
				"payload_too_large",
				"the request body is too large",
			);
		case 415:
			return validationError([
				{ path: "header.content-type", message: "must be application/json" },
			]);
		default:
			return internalError();
	}
}

// --- rendering ---

export interface ErrorRenderOptions {
	/** Internal listener: also `code` at the top level (gateway S4 reads it). */
	topLevelCode?: boolean;
}

export function errorBody(
	e: ApiError,
	requestId: string,
	o: ErrorRenderOptions = {},
): Record<string, unknown> {
	const body: Record<string, unknown> = {
		error: {
			code: e.code,
			message: e.message,
			retryable: e.retryable,
			details: e.details,
			requestId,
		},
	};
	if (o.topLevelCode) body.code = e.code;
	return body;
}

/** `Retry-After` seconds of a 429/503: the error's hint, else the default. */
export function retryAfterSecondsOf(e: ApiError): number {
	const hint = e.details.retryAfterSeconds;
	if (typeof hint === "number" && Number.isFinite(hint) && hint > 0) {
		return Math.ceil(hint);
	}
	return e.code === "server_shutting_down"
		? SHUTTING_DOWN_RETRY_AFTER_SECONDS
		: DEFAULT_RETRY_AFTER_SECONDS;
}

/** Renders an ApiError: envelope, Request-Id, `Retry-After` on 429/503. */
export function renderError(
	c: Context<ApiEnv>,
	e: ApiError,
	o: ErrorRenderOptions = {},
): Response {
	let err = e;
	const headers: Record<string, string> = { ...(e.headers ?? {}) };
	if (e.status === 429 || e.status === 503) {
		const hint = e.details.retryAfterSeconds;
		const shuttingDown = e.code === "server_shutting_down";
		const seconds = retryAfterSecondsOf(e);
		if (hint !== seconds) {
			err = new ApiError(e.status, e.code, e.message, {
				retryable: e.retryable,
				details: { ...e.details, retryAfterSeconds: seconds },
			});
		}
		headers["Retry-After"] = String(seconds);
		if (shuttingDown) headers.Connection = "close";
	}
	const requestId = c.var.requestId;
	headers[REQUEST_ID_HEADER] = requestId;
	c.set("errorCode", err.code);
	return c.json(errorBody(err, requestId, o), err.status as 400, headers);
}

/** `app.onError`: maps, logs 500s with the cause, renders. */
export function onErrorHandler(
	log: Logger,
	o: ErrorRenderOptions = {},
): ErrorHandler<ApiEnv> {
	return (err, c) => {
		const e = toHttpError(err);
		if (e.status >= 500 && e.code === "internal") {
			log.error(
				{
					requestId: c.var.requestId,
					clientRequestId: c.var.clientRequestId,
					err: err instanceof Error ? err.message : String(err),
					stack: err instanceof Error ? err.stack : undefined,
					code: (err as { code?: unknown } | null)?.code,
				},
				"request failed",
			);
		}
		return renderError(c, e, o);
	};
}

/**
 * `app.notFound`: 405 when the path exists with other methods, 404
 * otherwise. `routes` is the app's route list (`app.routes`).
 */
export function notFoundHandler(
	routes: () => readonly { method: string; path: string }[],
	o: ErrorRenderOptions = {},
): NotFoundHandler<ApiEnv> {
	let cached: { n: number; list: { method: string; re: RegExp }[] } | null =
		null;
	return (c) => {
		const all = routes();
		if (cached?.n !== all.length) {
			cached = {
				n: all.length,
				list: all
					.filter((r) => r.method !== "ALL")
					.map((r) => ({ method: r.method, re: pathPattern(r.path) })),
			};
		}
		const allow = new Set(
			cached.list.filter((r) => r.re.test(c.req.path)).map((r) => r.method),
		);
		// Hono answers HEAD with the GET handler.
		if (allow.has("GET")) allow.add("HEAD");
		const e =
			allow.size > 0
				? methodNotAllowedError([...allow].sort())
				: new ApiError(
						404,
						"not_found",
						`no route for ${c.req.method} ${c.req.path}`,
					);
		return renderError(c, e, o);
	};
}

/**
 * Hono route path (`/v1/sandboxes/:sandbox`, `*`) to a RegExp. Strict like
 * Hono's router: a trailing slash is another path.
 */
function pathPattern(path: string): RegExp {
	const src = path
		.split("/")
		.map((seg) => {
			if (seg === "*") return ".*";
			const m = /^:[^{]+(\{(.+)\})?\??$/.exec(seg);
			if (m) return m[2] ?? "[^/]+";
			return seg.replace(/[.*+?^$()|[\]\\{}]/g, "\\$&");
		})
		.join("/");
	return new RegExp(`^${src}$`);
}
