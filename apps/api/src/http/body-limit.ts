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

/**
 * Refuses larger bodies with 413 payload_too_large: by Content-Length, or
 * while reading a body without one (it is read here, then handed on). A
 * body that breaks while it is read is 400 validation, not 500.
 */
export function bodyLimits(): MiddlewareHandler<ApiEnv> {
	return async (c, next) => {
		const limit = bodyLimitFor(c.req.method, c.req.path);
		const raw = c.req.raw;
		if (limit === null || raw.body === null) return next();
		const length = raw.headers.get("content-length");
		if (length !== null && !raw.headers.has("transfer-encoding")) {
			if (Number.parseInt(length, 10) > limit) {
				throw payloadTooLargeError(limit);
			}
			return next();
		}
		const reader = raw.body.getReader();
		const chunks: Uint8Array[] = [];
		let size = 0;
		for (;;) {
			let r: ReadableStreamReadResult<Uint8Array>;
			try {
				r = await reader.read();
			} catch {
				throw incompleteBodyError();
			}
			if (r.done) break;
			size += r.value.byteLength;
			if (size > limit) {
				await reader.cancel().catch(() => {});
				throw payloadTooLargeError(limit);
			}
			chunks.push(r.value);
		}
		const body = new ReadableStream<Uint8Array>({
			start(ctrl) {
				for (const chunk of chunks) ctrl.enqueue(chunk);
				ctrl.close();
			},
		});
		const init: RequestInit & { duplex: "half" } = { body, duplex: "half" };
		c.req.raw = new Request(raw, init);
		return next();
	};
}
