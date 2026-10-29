// Request body limits (S7 §5.11). One middleware per listener picks the
// limit by method and path; streamed file bodies have none.
import type { MiddlewareHandler } from "hono";
import { bodyLimit } from "hono/body-limit";
import type { ApiEnv } from "../deps.ts";
import { payloadTooLargeError } from "./errors.ts";

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
	["POST", /^\/internal\/v1\/agent-events$/, 16 * MiB],
];

export function bodyLimitFor(method: string, path: string): number | null {
	const m = method.toUpperCase();
	for (const [lm, re, limit] of LIMITS) {
		if (lm === m && re.test(path)) return limit;
	}
	return DEFAULT_BODY_LIMIT;
}

/** Refuses larger bodies with 413 payload_too_large (by Content-Length or while reading). */
export function bodyLimits(): MiddlewareHandler<ApiEnv> {
	const byLimit = new Map<number, MiddlewareHandler<ApiEnv>>();
	return (c, next) => {
		const limit = bodyLimitFor(c.req.method, c.req.path);
		if (limit === null) return next();
		let mw = byLimit.get(limit);
		if (!mw) {
			mw = bodyLimit({
				maxSize: limit,
				onError: () => {
					throw payloadTooLargeError(limit);
				},
			});
			byLimit.set(limit, mw);
		}
		return mw(c, next);
	};
}
