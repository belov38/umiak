// NDJSON frames of command streams (S7 §9.5) and the streaming response:
// one JSON object per line, written (and flushed) frame by frame, pulled
// only as fast as the client reads.
import type { Context } from "hono";
import type { ApiEnv } from "../deps.ts";

export type OutputStream = "stdout" | "stderr" | "pty";
export type OutputEncoding = "utf8" | "base64";
export type CommandExitStatus =
	| "exited"
	| "killed"
	| "timed_out"
	| "lost"
	| "failed_to_start";

/** Offsets of the last frame per stream; `ptyOffset` only for PTY commands. */
export interface FrameOffsets {
	stdoutOffset: number;
	stderrOffset: number;
	ptyOffset?: number;
}

export type StartedFrame = {
	type: "started";
	commandId: string;
	pid: number | null;
	encoding: OutputEncoding;
	replayed?: boolean;
};
export type AttachedFrame = {
	type: "attached";
	commandId: string;
	encoding: OutputEncoding;
} & FrameOffsets;
export type OutputFrame = {
	type: OutputStream;
	offset: number;
	nextOffset: number;
	/** Text (utf8) or base64 of exactly the bytes [offset, nextOffset). */
	data: string;
};
export type TruncatedFrame = {
	type: "truncated";
	stream: OutputStream;
	availableFrom: number;
};
export type HeartbeatFrame = { type: "heartbeat" };
export type ReconnectReason = "max_duration" | "server_shutdown";
export type ReconnectFrame = {
	type: "reconnect";
	reason: ReconnectReason;
} & FrameOffsets;
export type ExitFrame = {
	type: "exit";
	status: CommandExitStatus;
	exitCode: number | null;
	signal: string | null;
	reason: string | null;
	/** "disk_full" when the agent dropped output; null otherwise. */
	outputTruncated: string | null;
} & FrameOffsets;
export type ErrorFrame = {
	type: "error";
	code: string;
	message: string;
	retryable: boolean;
	requestId: string;
} & FrameOffsets;

export type Frame =
	| StartedFrame
	| AttachedFrame
	| OutputFrame
	| TruncatedFrame
	| HeartbeatFrame
	| ReconnectFrame
	| ExitFrame
	| ErrorFrame;

/**
 * What closes an open stream from outside (StreamRegistry): an `error` or a
 * `reconnect` frame without offsets and requestId; the stream adds them.
 */
export type CloseFrame =
	| { type: "error"; code: string; message: string; retryable: boolean }
	| { type: "reconnect"; reason: ReconnectReason };

/** Abort reason of a stream closed with a final frame. */
export class StreamClose extends Error {
	readonly frame: CloseFrame;

	constructor(frame: CloseFrame) {
		super(
			frame.type === "error"
				? `stream closed: ${frame.code}`
				: `stream closed: ${frame.reason}`,
		);
		this.name = "StreamClose";
		this.frame = frame;
	}
}

export const NDJSON_CONTENT_TYPE = "application/x-ndjson";

const NDJSON_HEADERS = {
	"Content-Type": NDJSON_CONTENT_TYPE,
	"Cache-Control": "no-store",
	"X-Accel-Buffering": "no",
};

/**
 * A 200 NDJSON response of `frames`. Frames are produced on demand (the
 * client's read speed is the backpressure). `onCancel` runs when the client
 * goes away, before the iterator is returned: abort the producer there, an
 * async generator busy in an await only returns at its next yield.
 */
export function ndjsonResponse(
	c: Context<ApiEnv>,
	frames: AsyncIterable<Frame>,
	headers: Record<string, string> = {},
	onCancel?: () => void,
): Response {
	const it = frames[Symbol.asyncIterator]();
	const enc = new TextEncoder();
	const body = new ReadableStream<Uint8Array>(
		{
			async pull(ctrl) {
				try {
					const r = await it.next();
					if (r.done) ctrl.close();
					else ctrl.enqueue(enc.encode(`${JSON.stringify(r.value)}\n`));
				} catch (e) {
					ctrl.error(e);
				}
			},
			cancel() {
				onCancel?.();
				void it.return?.()?.catch(() => {});
			},
		},
		{ highWaterMark: 0 },
	);
	return c.body(body, 200, { ...NDJSON_HEADERS, ...headers });
}
