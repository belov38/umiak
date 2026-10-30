// Retry policy of the SDK transport (S7 §15.4).
//
// - GET/HEAD/PUT/DELETE, and any request with an Idempotency-Key, are repeated
//   on network errors and on 502/503/504/429 without the API envelope.
// - An API error is repeated when its body says `retryable: true` (any method);
//   `retryable: false` is never repeated.
// - Backoff 0.5 s × 2 up to 8 s with full jitter; a longer `Retry-After`
//   wins (a zero or past one never makes a zero-wait loop).
// - All waits of one call fit in `budgetMs` (default 60 s): when the next wait
//   would end past the budget, the last error is thrown.
// - `signal` aborts the wait at once with its reason (AbortError by default).

import { isAbortError, SbxError, UNEXPECTED_RESPONSE } from "./errors.ts";

export const DEFAULT_RETRY_BUDGET_MS = 60_000;
const BASE_DELAY_MS = 500;
const MAX_DELAY_MS = 8_000;
const IDEMPOTENT_METHODS = new Set(["GET", "HEAD", "PUT", "DELETE"]);
const TRANSIENT_STATUSES = new Set([429, 502, 503, 504]);

export interface RetryOptions {
	method: string;
	/** The request carries an Idempotency-Key (or is otherwise safe to repeat). */
	idempotent?: boolean;
	signal?: AbortSignal | undefined;
	/** Total time for waits between attempts; default 60 s. */
	budgetMs?: number | undefined;
	/** Source of jitter in [0, 1); for tests. */
	random?: () => number;
}

/** A request is safe to repeat after an unknown outcome: idempotent method or a key. */
export function isSafeToRepeat(method: string, keyed: boolean): boolean {
	return keyed || IDEMPOTENT_METHODS.has(method.toUpperCase());
}

/** Full-jitter delay before retry number `retry` (0-based). */
export function backoffMs(retry: number, random: () => number = Math.random) {
	const cap = Math.min(MAX_DELAY_MS, BASE_DELAY_MS * 2 ** retry);
	return random() * cap;
}

/** Whether a request that failed with `err` may be repeated. */
export function isRetryable(err: unknown, safeToRepeat: boolean): boolean {
	if (isAbortError(err)) return false;
	if (!(err instanceof SbxError)) return safeToRepeat;
	if (err.code === UNEXPECTED_RESPONSE) {
		return safeToRepeat && TRANSIENT_STATUSES.has(err.status);
	}
	return err.retryable;
}

/** Runs `fn` and repeats it on failures allowed by the policy above. */
export async function withRetry<T>(
	fn: (attempt: number) => Promise<T>,
	opts: RetryOptions,
): Promise<T> {
	const { signal } = opts;
	const budget = opts.budgetMs ?? DEFAULT_RETRY_BUDGET_MS;
	const safe = isSafeToRepeat(opts.method, opts.idempotent === true);
	const start = Date.now();
	for (let attempt = 0; ; attempt++) {
		signal?.throwIfAborted();
		try {
			return await fn(attempt);
		} catch (err) {
			if (signal?.aborted) throw signal.reason;
			if (!isRetryable(err, safe)) throw err;
			const wait = retryDelayMs(err, attempt, opts.random);
			if (budget <= 0 || Date.now() + wait - start > budget) throw err;
			await sleep(wait, signal);
		}
	}
}

/** The wait before retry number `retry`: the backoff, or a longer Retry-After. */
export function retryDelayMs(
	err: unknown,
	retry: number,
	random: () => number = Math.random,
): number {
	const hint = err instanceof SbxError ? err.retryAfterMs : null;
	return Math.max(hint ?? 0, backoffMs(retry, random));
}

/** `p`, or a rejection with the abort reason as soon as `signal` aborts. */
export function abortable<T>(p: Promise<T>, signal?: AbortSignal): Promise<T> {
	if (!signal) return p;
	if (signal.aborted) return Promise.reject(signal.reason);
	return new Promise<T>((resolve, reject) => {
		const onAbort = () => reject(signal.reason);
		signal.addEventListener("abort", onAbort, { once: true });
		p.then(
			(v) => {
				signal.removeEventListener("abort", onAbort);
				resolve(v);
			},
			(e: unknown) => {
				signal.removeEventListener("abort", onAbort);
				reject(e);
			},
		);
	});
}

/** Waits `ms`; rejects with the abort reason as soon as `signal` aborts. */
export function sleep(ms: number, signal?: AbortSignal): Promise<void> {
	return new Promise((resolve, reject) => {
		if (signal?.aborted) {
			reject(signal.reason);
			return;
		}
		const onAbort = () => {
			clearTimeout(timer);
			reject(signal?.reason);
		};
		const timer = setTimeout(() => {
			signal?.removeEventListener("abort", onAbort);
			resolve();
		}, ms);
		signal?.addEventListener("abort", onAbort, { once: true });
	});
}
