// Request body limits (S7 §5.11, §23.3). One middleware per listener picks
// the limit and the timeout by method and path; streamed file bodies have
// neither. Bounded bodies must arrive within a total deadline, except upload
// chunks: a slow but steady client may take long over one, so a stall (no
// new bytes while the handler waits for them) ends it, and a cap of 10 min
// from the first read keeps a trickle from holding it open for ever.
import type { MiddlewareHandler } from "hono";
import type { ApiEnv } from "../deps.ts";
import { ApiError, payloadTooLargeError, validationError } from "./errors.ts";

const MiB = 1024 * 1024;

export const DEFAULT_BODY_LIMIT = MiB;

/** How long a bounded body may take: in all, or between bytes. */
type BodyTimeout = "total" | "idle";

/** Limit in bytes, null for no limit (and no timeout). First match wins. */
const LIMITS: [
	method: string,
	path: RegExp,
	limit: number | null,
	timeout?: BodyTimeout,
][] = [
	["PUT", /^\/v1\/sandboxes\/[^/]+\/files\/content$/, null],
	["PUT", /^\/v1\/sandboxes\/[^/]+\/files\/archive$/, null],
	["PUT", /^\/v1\/sandboxes\/[^/]+\/files\/uploads\/[^/]+$/, 8 * MiB, "idle"],
	["POST", /^\/v1\/sandboxes$/, 12 * MiB],
	["POST", /^\/v1\/sandboxes\/[^/]+\/(fork|resume)$/, 12 * MiB],
	["PUT", /^\/v1\/sandboxes\/[^/]+\/env$/, 12 * MiB],
	["PATCH", /^\/v1\/sandboxes\/[^/]+\/env$/, 12 * MiB],
	["POST", /^\/v1\/environments$/, 12 * MiB],
	["PATCH", /^\/v1\/environments\/[^/]+$/, 12 * MiB],
	["POST", /^\/internal\/v1\/agent-events$/, 16 * MiB],
];

function bodyRule(
	method: string,
	path: string,
): { limit: number | null; timeout: BodyTimeout } {
	const m = method.toUpperCase();
	for (const [lm, re, limit, timeout] of LIMITS) {
		if (lm === m && re.test(path))
			return { limit, timeout: timeout ?? "total" };
	}
	return { limit: DEFAULT_BODY_LIMIT, timeout: "total" };
}

export function bodyLimitFor(method: string, path: string): number | null {
	return bodyRule(method, path).limit;
}

/** The client stopped sending (disconnect, broken stream) mid-body. */
export function incompleteBodyError(): ApiError {
	return validationError([
		{ path: "body", message: "the request body ended before it was complete" },
	]);
}

/** A bounded body must arrive within this (the request timeout of non-streaming routes). */
export const BODY_TIMEOUT_MS = 60_000;
/** An upload chunk fails after this long without new bytes while it is read. */
export const BODY_IDLE_TIMEOUT_MS = 30_000;
/** An upload chunk fails this long after its first read, however steady. */
export const UPLOAD_CHUNK_TIMEOUT_MS = 600_000;

function bodyTimeoutError(ms: number): ApiError {
	return validationError([
		{
			path: "body",
			message: `the request body did not arrive within ${Math.round(ms / 1000)} s`,
		},
	]);
}

/**
 * A stalled upload chunk: nothing of it reached the sandbox, and a chunk PUT
 * is guarded by its offset, so a repeat is safe (the SDK resumes from HEAD).
 * The connection is closed: the rest of the body would never come.
 */
function bodyIdleError(ms: number): ApiError {
	const s = Math.round(ms / 1000);
	return chunkTimeoutError(`no bytes of the request body arrived for ${s} s`, {
		idleTimeoutSeconds: s,
	});
}

/** An upload chunk that took longer than its cap: as bodyIdleError. */
function chunkCapError(ms: number): ApiError {
	const s = Math.round(ms / 1000);
	return chunkTimeoutError(`the request body did not arrive within ${s} s`, {
		timeoutSeconds: s,
	});
}

function chunkTimeoutError(
	what: string,
	details: Record<string, number>,
): ApiError {
	return new ApiError(
		408,
		"request_timeout",
		`${what}; resume the upload from the offset of HEAD .../uploads/{upload}`,
		{ retryable: true, details, headers: { Connection: "close" } },
	);
}

export interface BodyLimitOptions {
	/** Total deadline of bounded bodies; default BODY_TIMEOUT_MS. */
	timeoutMs?: number;
	/** Stall timeout of upload chunks; default BODY_IDLE_TIMEOUT_MS. */
	idleTimeoutMs?: number;
	/** Cap of an upload chunk from its first read; default UPLOAD_CHUNK_TIMEOUT_MS. */
	chunkTimeoutMs?: number;
}

/**
 * Refuses larger bodies with 413 payload_too_large: by Content-Length at
 * once, else while the handler reads the body. The body is not read here:
 * it is passed through a counting stream, so nothing is buffered before
 * authentication (which runs before the handler). A bounded body must
 * arrive within `timeoutMs`, else 400 validation; a body that breaks is 400
 * validation too, not 500. An upload chunk has no request deadline: it fails
 * with 408 request_timeout (retryable) when the handler waits for bytes for
 * `idleTimeoutMs` and none come, or `chunkTimeoutMs` after the handler first
 * read it. Routes without a limit (streamed files) have no timeout either:
 * their uploads may take long.
 */
export function bodyLimits(
	o: BodyLimitOptions = {},
): MiddlewareHandler<ApiEnv> {
	const timeoutMs = o.timeoutMs ?? BODY_TIMEOUT_MS;
	const idleTimeoutMs = o.idleTimeoutMs ?? BODY_IDLE_TIMEOUT_MS;
	const chunkTimeoutMs = o.chunkTimeoutMs ?? UPLOAD_CHUNK_TIMEOUT_MS;
	return async (c, next) => {
		const { limit, timeout } = bodyRule(c.req.method, c.req.path);
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
		// The cap of an upload chunk, from its first read.
		let cap: NodeJS.Timeout | undefined;
		let size = 0;
		const fail = (ctrl: ReadableStreamDefaultController, e: ApiError) => {
			failure ??= e;
			clearTimeout(timer);
			clearTimeout(cap);
			source.cancel().catch(() => {});
			try {
				ctrl.error(failure);
			} catch {
				// already closed or errored
			}
		};
		const arm = (
			ctrl: ReadableStreamDefaultController,
			e: ApiError,
			ms: number,
		) => {
			timer = setTimeout(() => fail(ctrl, e), ms);
			timer.unref?.();
		};
		// Idle mode reads the source only when the handler reads
		// (highWaterMark 0), so the idle timer runs only while the handler
		// waits for the client, not while it waits for the sandbox.
		const body = new ReadableStream<Uint8Array>(
			{
				start(ctrl) {
					if (timeout === "total") {
						arm(ctrl, bodyTimeoutError(timeoutMs), timeoutMs);
					}
				},
				async pull(ctrl) {
					if (timeout === "idle") {
						if (cap === undefined) {
							cap = setTimeout(
								() => fail(ctrl, chunkCapError(chunkTimeoutMs)),
								chunkTimeoutMs,
							);
							cap.unref?.();
						}
						arm(ctrl, bodyIdleError(idleTimeoutMs), idleTimeoutMs);
					}
					let r: ReadableStreamReadResult<Uint8Array>;
					try {
						r = await source.read();
					} catch {
						return fail(ctrl, incompleteBodyError());
					}
					if (timeout === "idle") clearTimeout(timer);
					if (failure !== null) return;
					if (r.done) {
						clearTimeout(timer);
						clearTimeout(cap);
						ctrl.close();
						return;
					}
					size += r.value.byteLength;
					if (size > limit) return fail(ctrl, payloadTooLargeError(limit));
					ctrl.enqueue(r.value);
				},
				cancel(reason) {
					clearTimeout(timer);
					clearTimeout(cap);
					return source.cancel(reason);
				},
			},
			{ highWaterMark: timeout === "idle" ? 0 : 1 },
		);
		const init: RequestInit & { duplex: "half" } = { body, duplex: "half" };
		c.req.raw = new Request(raw, init);
		try {
			await next();
		} finally {
			clearTimeout(timer);
			clearTimeout(cap);
		}
		// Whatever the handler made of the failed read (a JSON parse error,
		// a broken agent upload), the answer is the body's failure.
		if (failure !== null) throw failure;
	};
}
