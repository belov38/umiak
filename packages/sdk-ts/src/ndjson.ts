// NDJSON reader of the command streams (S7 §9.5): one JSON object per line.
// A broken connection, a line that is not JSON, or no data for `idleTimeoutMs`
// (S7 §9.7: 45 s without lines; the api sends a heartbeat line after 15 s of
// silence, so a live stream never goes that long without a byte) are all
// SbxError `network_error` with `retryable: true`: the stream may be reopened
// from its offsets. Leaving the loop early cancels the body.

import { NETWORK_ERROR, SbxError } from "./errors.ts";

export interface NdjsonOptions {
	idleTimeoutMs: number;
	signal?: AbortSignal;
}

function broken(message: string, cause?: unknown): SbxError {
	return new SbxError({
		status: 0,
		code: NETWORK_ERROR,
		message,
		retryable: true,
		...(cause === undefined ? {} : { cause }),
	});
}

/** The parsed objects of an NDJSON body, in order. */
export async function* ndjsonObjects(
	body: ReadableStream<Uint8Array>,
	opts: NdjsonOptions,
): AsyncGenerator<Record<string, unknown>> {
	const reader = body.getReader();
	const decoder = new TextDecoder();
	let buf = "";
	let finished = false;
	try {
		for (;;) {
			const nl = buf.indexOf("\n");
			if (nl >= 0) {
				const line = buf.slice(0, nl).trim();
				buf = buf.slice(nl + 1);
				if (line === "") continue;
				let v: unknown;
				try {
					v = JSON.parse(line);
				} catch (err) {
					throw broken("stream line is not JSON", err);
				}
				if (typeof v === "object" && v !== null && !Array.isArray(v)) {
					yield v as Record<string, unknown>;
				}
				continue;
			}
			const r = await readWithin(reader, opts);
			if (r.done) {
				finished = true;
				buf += decoder.decode();
				if (buf.trim() !== "") throw broken("stream ended inside a line");
				return;
			}
			buf += decoder.decode(r.value, { stream: true });
		}
	} finally {
		if (!finished) await reader.cancel().catch(() => {});
		reader.releaseLock();
	}
}

/** reader.read() that fails after the idle timeout or on abort. */
function readWithin(
	reader: ReadableStreamDefaultReader<Uint8Array>,
	opts: NdjsonOptions,
): Promise<ReadableStreamReadResult<Uint8Array>> {
	const { signal } = opts;
	return new Promise((resolve, reject) => {
		if (signal?.aborted) {
			reject(signal.reason);
			return;
		}
		const timer = setTimeout(() => {
			cleanup();
			reject(
				broken(`no stream line for ${opts.idleTimeoutMs} ms: connection dead`),
			);
		}, opts.idleTimeoutMs);
		const onAbort = () => {
			cleanup();
			reject(signal?.reason);
		};
		const cleanup = () => {
			clearTimeout(timer);
			signal?.removeEventListener("abort", onAbort);
		};
		signal?.addEventListener("abort", onAbort, { once: true });
		reader.read().then(
			(r) => {
				cleanup();
				resolve(r);
			},
			(err: unknown) => {
				cleanup();
				if (signal?.aborted) reject(signal.reason);
				else reject(broken(`stream broke: ${errText(err)}`, err));
			},
		);
	});
}

function errText(e: unknown): string {
	return e instanceof Error ? e.message : String(e);
}
