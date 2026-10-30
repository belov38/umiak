// Request body limits (S7 §5.11). One middleware per listener picks the
// limit by method and path; streamed file bodies have none.
import type { MiddlewareHandler } from "hono";
import type { ApiEnv } from "../deps.ts";
import {
	type ApiError,
	payloadTooLargeError,
	validationError,
} from "./errors.ts";

const MiB = 1024 * 1024;

export const DEFAULT_BODY_LIMIT = MiB;

/** Limit in bytes, null for no limit. First match wins. */
const LIMITS: [method: string, path: RegExp, limit: number | null][] = [
	["PUT", /^\/v1\/sandboxes\/[^/]+\/files\/content$/, null],
	["PUT", /^\/v1\/sandboxes\/[^/]+\/files\/archive$/, null],
	["PUT", /^\/v1\/sandboxes\/[^/]+\/files\/uploads\/[^/]+$/, 8 * MiB],
	["POST", /^\/v1\/sandboxes$/, 12 * MiB],
	["POST", /^\/v1\/sandboxes\/[^/]+\/(fork|resume)$/, 12 * MiB],
	["PUT", /^\/v1\/sandboxes\/[^/]+\/env$/, 12 * MiB],
	["PATCH", /^\/v1\/sandboxes\/[^/]+\/env$/, 12 * MiB],
	["POST", /^\/v1\/environments$/, 12 * MiB],
	["PATCH", /^\/v1\/environments\/[^/]+$/, 12 * MiB],
	["POST", /^\/internal\/v1\/agent-events$/, 16 * MiB],
];

export function bodyLimitFor(method: string, path: string): number | null {
	const m = method.toUpperCase();
	for (const [lm, re, limit] of LIMITS) {
		if (lm === m && re.test(path)) return limit;
	}
	return DEFAULT_BODY_LIMIT;
}

/** The client stopped sending (disconnect, broken stream) mid-body. */
export function incompleteBodyError(): ApiError {
	return validationError([
		{ path: "body", message: "the request body ended before it was complete" },
	]);
}

/** A bounded body must arrive within this (the request timeout of non-streaming routes). */
export const BODY_TIMEOUT_MS = 60_000;

function bodyTimeoutError(ms: number): ApiError {
	return validationError([
		{
			path: "body",
			message: `the request body did not arrive within ${Math.round(ms / 1000)} s`,
		},
	]);
}

export interface BodyLimitOptions {
	/** Default BODY_TIMEOUT_MS. */
	timeoutMs?: number;
}

/**
 * Refuses larger bodies with 413 payload_too_large: by Content-Length at
 * once, else while the handler reads the body. The body is not read here:
 * it is passed through a counting stream, so nothing is buffered before
 * authentication (which runs before the handler). A bounded body must
 * arrive within `timeoutMs`; a body that breaks or stalls is 400
 * validation, not 500. Routes without a limit (streamed files) have no
 * timeout either: their uploads may take long.
 */
export function bodyLimits(
	o: BodyLimitOptions = {},
): MiddlewareHandler<ApiEnv> {
	const timeoutMs = o.timeoutMs ?? BODY_TIMEOUT_MS;
	return async (c, next) => {
		const limit = bodyLimitFor(c.req.method, c.req.path);
		const raw = c.req.raw;
		if (limit === null || raw.body === null) return next();
		const length = raw.headers.get("content-length");
		if (length !== null && !raw.headers.has("transfer-encoding")) {
			if (Number.parseInt(length, 10) > limit) {
				throw payloadTooLargeError(limit);
			}
		}
		const source = raw.body.getReader();
		// The first failure of the body; the answer once the handler is done.
		let failure: ApiError | null = null;
		let timer: NodeJS.Timeout | undefined;
		let size = 0;
		const fail = (ctrl: ReadableStreamDefaultController, e: ApiError) => {
			failure ??= e;
			clearTimeout(timer);
			source.cancel().catch(() => {});
			try {
				ctrl.error(failure);
			} catch {
				// already closed or errored
			}
		};
		const body = new ReadableStream<Uint8Array>({
			start(ctrl) {
				timer = setTimeout(
					() => fail(ctrl, bodyTimeoutError(timeoutMs)),
					timeoutMs,
				);
				timer.unref();
			},
			async pull(ctrl) {
				let r: ReadableStreamReadResult<Uint8Array>;
				try {
					r = await source.read();
				} catch {
					return fail(ctrl, incompleteBodyError());
				}
				if (failure !== null) return;
				if (r.done) {
					clearTimeout(timer);
					ctrl.close();
					return;
				}
				size += r.value.byteLength;
				if (size > limit) return fail(ctrl, payloadTooLargeError(limit));
				ctrl.enqueue(r.value);
			},
			cancel(reason) {
				clearTimeout(timer);
				return source.cancel(reason);
			},
		});
		const init: RequestInit & { duplex: "half" } = { body, duplex: "half" };
		c.req.raw = new Request(raw, init);
		try {
			await next();
		} finally {
			clearTimeout(timer);
		}
		// Whatever the handler made of the failed read (a JSON parse error,
		// a broken agent upload), the answer is the body's failure.
		if (failure !== null) throw failure;
	};
}
