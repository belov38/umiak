import type { WorkerCtx } from "./context.ts";

export function sleep(ms: number): Promise<void> {
	return new Promise((resolve) => setTimeout(resolve, Math.max(0, ms)));
}

/** A wait ran out of time. Permanent unless the caller passes its own error. */
export class WaitTimeout extends Error {
	readonly retryable: boolean = false;
	readonly code: string = "wait_timeout";
	constructor(what: string, timeoutMs: number) {
		super(`${what}: not done within ${timeoutMs} ms`);
		this.name = "WaitTimeout";
	}
}

export interface WaitOptions {
	timeoutMs: number;
	pollMs: number;
	/** For the default timeout message. */
	what?: string;
	/** Error thrown on timeout (default `WaitTimeout`). */
	timeoutError?: () => Error;
}

/**
 * Polls `cond` until it returns a value other than `undefined`. Every
 * `timing.supersedeCheckMs` it calls `fence.check()`, so a superseded or
 * taken-over executor leaves the wait with `FencedOut` (S6 §7.1).
 */
export async function waitUntil<T>(
	ctx: Pick<WorkerCtx, "timing">,
	fence: { check(): Promise<unknown> },
	cond: () => Promise<T | undefined>,
	opts: WaitOptions,
): Promise<T> {
	const started = Date.now();
	const deadline = started + opts.timeoutMs;
	let lastCheck = started;
	for (;;) {
		const v = await cond();
		if (v !== undefined) return v;
		const now = Date.now();
		if (now >= deadline) {
			throw opts.timeoutError
				? opts.timeoutError()
				: new WaitTimeout(opts.what ?? "wait", opts.timeoutMs);
		}
		if (now - lastCheck >= ctx.timing.supersedeCheckMs) {
			await fence.check();
			lastCheck = Date.now();
		}
		await sleep(Math.min(opts.pollMs, deadline - Date.now()));
	}
}
