import { Code, ConnectError } from "@connectrpc/connect";
import { AgentUnavailableError, classifyByCode } from "./errors.js";

/** What resumableAttach needs to know about one attach event. */
export type AttachView =
	| { kind: "data"; stream: string; offset: bigint; data: Uint8Array }
	| { kind: "truncated"; stream: string; availableFrom: bigint }
	| { kind: "exit"; ends: Record<string, bigint> }
	| { kind: "other" };

/** Output of resumableAttach: spliced data, truncation marks, exit and other events. */
export type AttachOutput<E> =
	| { type: "data"; stream: string; offset: bigint; data: Uint8Array }
	| { type: "truncated"; stream: string; availableFrom: bigint }
	| { type: "exit"; event: E }
	| { type: "other"; event: E };

export interface ResumableAttachOptions<E> {
	/**
	 * Opens a stream from the given offsets (Run first, Attach after). Abort the
	 * call when the signal aborts: it is aborted when the stream is replaced.
	 */
	open: (
		offsets: Record<string, bigint>,
		signal: AbortSignal,
	) => AsyncIterable<E>;
	/** Maps a caller event to its attach meaning. */
	view: (ev: E) => AttachView;
	/** Start offsets per stream ("stdout", "stderr", "pty"); missing streams start at 0. */
	offsets: Record<string, bigint>;
	/** Stops the attach; the generator throws the signal's reason. */
	signal?: AbortSignal;
	/** Consecutive failures without progress before giving up. Default 20. */
	maxAttempts?: number;
}

const maxBackoffMs = 1000;

/**
 * Follows a command's output across reconnects (spec section 9.1). Per
 * stream: data at the expected offset is yielded; an overlap is trimmed (a
 * full duplicate is dropped); a gap aborts the current stream and reopens
 * from the expected offsets; truncated is yielded and moves the expected
 * offset to availableFrom. exit is yielded and ends the generator only when
 * every end equals the expected offset, otherwise the stream is reopened.
 * Retryable errors and a stream that ends without exit reopen from the
 * expected offsets; fatal errors and AgentUnavailableError (the routing
 * budget is spent) are thrown. Errors are classified by their Connect code
 * and connection state only (classifyByCode): Umiak-* metadata and details of
 * a stream error come from the agent's end-stream message, while the
 * gateway's own stream ends use Code.Unavailable.
 */
export async function* resumableAttach<E>(
	opts: ResumableAttachOptions<E>,
): AsyncGenerator<AttachOutput<E>> {
	const maxAttempts = opts.maxAttempts ?? 20;
	const expected: Record<string, bigint> = { ...opts.offsets };
	let failures = 0;
	let lastErr: unknown;

	for (;;) {
		throwIfAborted(opts.signal);
		if (failures >= maxAttempts) {
			throw (
				lastErr ??
				new ConnectError(
					`attach made no progress after ${failures} attempts`,
					Code.Internal,
				)
			);
		}
		if (failures > 1) {
			await sleep(
				Math.min(maxBackoffMs, 25 * 2 ** (failures - 2)),
				opts.signal,
			);
			throwIfAborted(opts.signal);
		}

		const ac = new AbortController();
		const onAbort = () => ac.abort(opts.signal?.reason);
		opts.signal?.addEventListener("abort", onAbort, { once: true });
		let it: AsyncIterator<E> | undefined;
		try {
			it = opts.open({ ...expected }, ac.signal)[Symbol.asyncIterator]();
			read: for (;;) {
				const r = await it.next();
				if (r.done) {
					break; // ended without exit: reopen
				}
				const ev = r.value;
				const v = opts.view(ev);
				switch (v.kind) {
					case "data": {
						const exp = expected[v.stream] ?? 0n;
						if (v.offset > exp) {
							break read; // gap: reopen from expected
						}
						const end = v.offset + BigInt(v.data.length);
						if (end <= exp) {
							continue; // already delivered
						}
						const data =
							v.offset === exp
								? v.data
								: v.data.subarray(Number(exp - v.offset));
						expected[v.stream] = end;
						failures = 0;
						lastErr = undefined;
						yield { type: "data", stream: v.stream, offset: exp, data };
						break;
					}
					case "truncated": {
						if (v.availableFrom > (expected[v.stream] ?? 0n)) {
							expected[v.stream] = v.availableFrom;
							failures = 0;
							lastErr = undefined;
						}
						yield {
							type: "truncated",
							stream: v.stream,
							availableFrom: v.availableFrom,
						};
						break;
					}
					case "exit": {
						const complete = Object.entries(v.ends).every(
							([s, e]) => (expected[s] ?? 0n) === e,
						);
						if (!complete) {
							break read; // output still missing: reopen
						}
						yield { type: "exit", event: ev };
						return;
					}
					default:
						yield { type: "other", event: ev };
				}
			}
		} catch (err) {
			throwIfAborted(opts.signal);
			if (
				err instanceof AgentUnavailableError ||
				classifyByCode(err) === "fatal"
			) {
				throw err;
			}
			lastErr = err;
		} finally {
			opts.signal?.removeEventListener("abort", onAbort);
			ac.abort();
			await it?.return?.().catch(() => {});
		}
		failures++;
	}
}

function throwIfAborted(signal: AbortSignal | undefined): void {
	if (signal?.aborted) {
		throw signal.reason;
	}
}

function sleep(ms: number, signal: AbortSignal | undefined): Promise<void> {
	return new Promise((resolve) => {
		const done = () => {
			clearTimeout(timer);
			signal?.removeEventListener("abort", done);
			resolve();
		};
		const timer = setTimeout(done, ms);
		signal?.addEventListener("abort", done, { once: true });
	});
}
