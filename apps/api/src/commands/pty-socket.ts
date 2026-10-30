// A PTY WebSocket connection (S7 §10.2, subprotocol sbx.pty.v1) after the
// upgrade.
//
// Server → client:
// - binary frames: consecutive bytes of the PTY output;
// - text frames (JSON): `attached {offset}` first, `truncated
//   {availableFrom}`, `exit` (the NDJSON exit frame), `error {code,
//   message, retryable, details, requestId, offset?}`, `reconnect {offset,
//   reason}`.
// Client → server: binary frames are input, text frames `{type: "resize",
// cols, rows}` (other types are ignored).
//
// Output follows the agent through `followCommand` (resumable attach,
// offsets). It is read only as fast as the socket drains: above
// `highWaterBytes` buffered, the attach is not read until the last frame
// is written. Input is coalesced for `inputCoalesceMs` and sent with one
// `inputSessionId` per connection and `seq` in order, one call at a time;
// a call the agent did not answer is repeated with the same seq (the agent
// drops repeats). Close codes: 1000 after exit, 1012 after `reconnect`
// (shutdown), 4401/4403/4404/4409/4416/4503 after an `error` frame, 1008
// for a malformed control frame, 1011 otherwise. An `offset` past the end
// of the output is refused before any attach (4416 range_not_satisfiable):
// an exited PTY would never reach it, and the attach would be reopened
// until it gave up. A ping goes out every `pingMs`;
// a peer that missed the previous one is dropped.
import { randomUUID } from "node:crypto";
import { z } from "@hono/zod-openapi";
import type { Command, Principal } from "@sbx/core";
import { type RawData, WebSocket } from "ws";
import {
	AgentCallError,
	agentErrorToHttp,
	agentUnavailableError,
	isAgentOutcomeUnknown,
} from "../agent/errors.ts";
import type { AuthContext } from "../auth/principal.ts";
import type { ApiDeps } from "../deps.ts";
import { type ApiError, notFoundError } from "../http/errors.ts";
import { resolveCommandRef } from "../map/command.ts";
import { resolveSandboxRef } from "../map/sandbox.ts";
import {
	checkStreamOffsets,
	DEFAULT_ATTACH_MAX_ATTEMPTS,
	followCommand,
} from "./attach.ts";
import type { ExitFrame } from "./frames.ts";
import { requireSameMachine } from "./run.ts";

export const PTY_SUBPROTOCOL = "sbx.pty.v1";

export interface PtyTimings {
	/** WebSocket ping interval (15 s). */
	pingMs: number;
	/** Input bytes are collected this long before Process/SendInput (5 ms). */
	inputCoalesceMs: number;
	/** Above this many buffered bytes the agent attach is not read (1 MiB). */
	highWaterBytes: number;
	/** Repeats of SendInput/Update while the agent is unreachable (30 s). */
	inputRetryMs: number;
}

export const DEFAULT_PTY_TIMINGS: PtyTimings = {
	pingMs: 15_000,
	inputCoalesceMs: 5,
	highWaterBytes: 1024 * 1024,
	inputRetryMs: 30_000,
};

/** At most this much input per Process/SendInput. */
export const PTY_INPUT_MAX_BATCH = 64 * 1024;
/** Above this much queued input the socket is not read (a large paste). */
export const PTY_INPUT_MAX_QUEUED = 1024 * 1024;
/** touchApiActivity of the sandbox at most this often while typing. */
export const PTY_TOUCH_INTERVAL_MS = 30_000;
export const PTY_MAX_SIZE = 1000;

/** WebSocket close codes of sbx.pty.v1. */
export const PTY_CLOSE = {
	exit: 1000,
	invalidMessage: 1008,
	internal: 1011,
	shutdown: 1012,
	unauthorized: 4401,
	forbidden: 4403,
	notFound: 4404,
	notReady: 4409,
	/** `offset` past the end of the output; final, like HTTP 416. */
	rangeNotSatisfiable: 4416,
	unavailable: 4503,
} as const;

const CLOSE_BY_STATUS: Record<number, number> = {
	401: PTY_CLOSE.unauthorized,
	403: PTY_CLOSE.forbidden,
	404: PTY_CLOSE.notFound,
	409: PTY_CLOSE.notReady,
	416: PTY_CLOSE.rangeNotSatisfiable,
	503: PTY_CLOSE.unavailable,
};

const CLOSE_BY_CODE: Record<string, number> = {
	unauthorized: PTY_CLOSE.unauthorized,
	forbidden: PTY_CLOSE.forbidden,
	not_found: PTY_CLOSE.notFound,
	sandbox_not_ready: PTY_CLOSE.notReady,
	invalid_state: PTY_CLOSE.notReady,
	range_not_satisfiable: PTY_CLOSE.rangeNotSatisfiable,
	agent_unavailable: PTY_CLOSE.unavailable,
};

/** The close code after an error frame. */
export function ptyCloseCode(code: string, status?: number): number {
	return (
		(status === undefined ? undefined : CLOSE_BY_STATUS[status]) ??
		CLOSE_BY_CODE[code] ??
		PTY_CLOSE.internal
	);
}

/** `{cols, rows}` of a resize (control frame and POST .../resize). */
export const ptySize = {
	cols: z.int().min(1).max(PTY_MAX_SIZE),
	rows: z.int().min(1).max(PTY_MAX_SIZE),
};
const ResizeMessage = z.object({ type: z.literal("resize"), ...ptySize });

/**
 * The PTY command of the path (404 unless a PTY of the sandbox) and its
 * machine. A PTY is input to the guest: 403 `sandbox_blocked` on a blocked
 * sandbox (S8 C3).
 */
export async function ptyTarget(
	deps: ApiDeps,
	p: Principal,
	params: { sandbox: string; command: string },
): Promise<{ command: Command; machineId: string }> {
	const command = await deps.svc.getCommand(
		p,
		resolveSandboxRef(params.sandbox),
		resolveCommandRef(params.command),
	);
	if (command.mode !== "pty") throw notFoundError("pty");
	const { machineId } = await deps.svc.resolveAgentTarget(
		p,
		command.sandboxId,
		{
			write: true,
		},
	);
	requireSameMachine(command, machineId);
	return { command, machineId };
}

export interface PtyConnection {
	auth: AuthContext;
	/** Path parameters. */
	sandbox: string;
	command: string;
	/** Output from this offset (default 0)... */
	offset?: number;
	/** ...or this many bytes before the end (scrollback). */
	tailBytes?: number;
	/** Request-Id of the upgrade, in error frames. */
	requestId: string;
	/** Aborted by the StreamRegistry with a StreamClose (revocation, shutdown). */
	closed: AbortSignal;
	/** Leaves the StreamRegistry (idempotent). */
	unregister(): void;
}

type ErrorInfo = Pick<
	ApiError,
	"code" | "message" | "retryable" | "details"
> & { status?: number };

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/**
 * Serves an accepted PTY socket until it closes. Never throws: failures
 * become an `error` frame and a close code.
 */
export async function runPtySocket(
	deps: ApiDeps,
	ws: WebSocket,
	conn: PtyConnection,
): Promise<void> {
	const t = deps.ptyTimings;
	const gone = new AbortController();
	const stop = AbortSignal.any([conn.closed, gone.signal]);
	const stopped = new Promise<void>((r) => {
		if (stop.aborted) r();
		else stop.addEventListener("abort", () => r(), { once: true });
	});
	let closing = false;

	const sendText = (f: object) => {
		if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(f));
	};
	/** Our close: the registry slot is free at once (closeAll waits for it). */
	const end = (code: number, reason = "") => {
		if (closing) return;
		closing = true;
		conn.unregister();
		gone.abort();
		if (ws.readyState === WebSocket.OPEN) ws.close(code, reason);
		else ws.terminate();
	};
	const fail = (e: ErrorInfo, offset?: number, close?: number) => {
		sendText({
			type: "error",
			code: e.code,
			message: e.message,
			retryable: e.retryable,
			details: e.details,
			requestId: conn.requestId,
			...(offset === undefined ? {} : { offset }),
		});
		end(close ?? ptyCloseCode(e.code, e.status));
	};

	let alive = true;
	const ping = setInterval(() => {
		// Paused by input backpressure: pongs wait in the unread socket.
		if (writer.paused) alive = true;
		if (!alive) {
			ws.terminate();
			return;
		}
		alive = false;
		if (ws.readyState === WebSocket.OPEN) ws.ping();
	}, t.pingMs);
	const writer = new PtyWriter(deps, t, (e) => fail(e), {
		pause: () => ws.pause(),
		resume: () => ws.resume(),
	});
	// Typing keeps the sandbox from idle-stopping (touch at most every 30 s).
	let sandboxId: string | null = null;
	let touchedAt = 0;
	const touch = () => {
		if (sandboxId === null) return;
		const now = Date.now();
		if (now - touchedAt < PTY_TOUCH_INTERVAL_MS) return;
		touchedAt = now;
		void deps.svc.touchApiActivity(sandboxId).catch((err: unknown) => {
			deps.log.warn(
				{ err, requestId: conn.requestId },
				"touchApiActivity failed",
			);
		});
	};
	ws.on("pong", () => {
		alive = true;
	});
	ws.on("error", () => {});
	ws.on("close", () => {
		clearInterval(ping);
		closing = true;
		conn.unregister();
		gone.abort();
		writer.closed();
	});
	ws.on("message", (data: RawData, isBinary: boolean) => {
		alive = true;
		if (closing) return;
		if (isBinary) {
			writer.push(rawBytes(data));
			touch();
			return;
		}
		const m = controlMessage(rawBytes(data).toString("utf8"));
		if (m === null) return;
		if ("error" in m) {
			fail(
				{
					code: "validation",
					message: m.error,
					retryable: false,
					details: {},
				},
				undefined,
				PTY_CLOSE.invalidMessage,
			);
			return;
		}
		writer.resize(m.cols, m.rows);
	});

	let target: { command: Command; machineId: string };
	try {
		target = await ptyTarget(deps, conn.auth.principal, conn);
		// tailBytes wins over offset and never resolves past the end.
		if (conn.tailBytes === undefined && (conn.offset ?? 0) > 0) {
			await checkStreamOffsets(
				deps,
				target.machineId,
				target.command.id,
				true,
				{ pty: conn.offset ?? 0 },
				() => "offset",
			);
		}
	} catch (e) {
		const h = agentErrorToHttp(e);
		if (h.status >= 500) {
			deps.log.error(
				{ err: e, requestId: conn.requestId },
				"pty connect failed",
			);
		}
		fail(h);
		return;
	}
	if (closing) return;
	const { command, machineId } = target;
	sandboxId = command.sandboxId;
	touch();
	writer.ready(machineId, command.id);

	let offset = conn.offset ?? 0;
	const frames = followCommand(
		deps,
		machineId,
		command.id,
		{ pty: offset },
		{
			follow: true,
			encoding: "base64",
			signal: stop,
			// A terminal stays open as long as it is used (no max_duration).
			maxDurationMs: Number.POSITIVE_INFINITY,
			heartbeatMs: deps.commandTimings.heartbeatMs,
			attachMaxAttempts:
				deps.commandTimings.attachMaxAttempts ?? DEFAULT_ATTACH_MAX_ATTEMPTS,
			requestId: conn.requestId,
			pty: true,
			...(conn.tailBytes === undefined ? {} : { tailBytes: conn.tailBytes }),
			head: (o) => ({
				type: "attached",
				commandId: command.id,
				encoding: "base64",
				...o,
			}),
		},
	);
	try {
		for await (const f of frames) {
			switch (f.type) {
				case "attached":
					offset = f.ptyOffset ?? offset;
					sendText({ type: "attached", offset });
					break;
				case "pty": {
					// Closing (terminated, our close): stop reading the agent now,
					// the close event may come only after many pulled frames.
					if (ws.readyState !== WebSocket.OPEN) return;
					offset = f.nextOffset;
					const bytes = Buffer.from(f.data, "base64");
					// Written to the kernel: everything sent before it has drained.
					const written = new Promise<void>((r) => ws.send(bytes, () => r()));
					if (ws.bufferedAmount > t.highWaterBytes) {
						await Promise.race([written, stopped]);
					}
					break;
				}
				case "truncated":
					offset = f.availableFrom;
					sendText({ type: "truncated", availableFrom: f.availableFrom });
					break;
				case "exit":
					sendText(f satisfies ExitFrame);
					end(PTY_CLOSE.exit);
					return;
				case "reconnect":
					sendText({
						type: "reconnect",
						offset: f.ptyOffset ?? offset,
						reason: f.reason,
					});
					end(PTY_CLOSE.shutdown);
					return;
				case "error":
					fail(
						{
							code: f.code,
							message: f.message,
							retryable: f.retryable,
							details: {},
						},
						f.ptyOffset ?? offset,
					);
					return;
				default:
					// heartbeat: the WebSocket has its own ping.
					break;
			}
		}
	} catch (e) {
		deps.log.error({ err: e, requestId: conn.requestId }, "pty output failed");
		fail(agentErrorToHttp(e), offset);
	}
}

function rawBytes(data: RawData): Buffer {
	if (Buffer.isBuffer(data)) return data;
	if (Array.isArray(data)) return Buffer.concat(data);
	return Buffer.from(data);
}

/** A control frame: a resize, null to ignore, or why it is malformed. */
function controlMessage(
	text: string,
): { cols: number; rows: number } | { error: string } | null {
	let v: unknown;
	try {
		v = JSON.parse(text);
	} catch {
		return { error: "a text frame must be a JSON object" };
	}
	if (typeof v !== "object" || v === null || Array.isArray(v)) {
		return { error: "a text frame must be a JSON object" };
	}
	const type = (v as { type?: unknown }).type;
	if (type !== "resize") {
		return typeof type === "string"
			? null
			: { error: "a control frame needs a string `type`" };
	}
	const r = ResizeMessage.safeParse(v);
	if (!r.success) {
		return {
			error: `resize needs integer cols and rows from 1 to ${PTY_MAX_SIZE}`,
		};
	}
	return { cols: r.data.cols, rows: r.data.rows };
}

/**
 * Input and resizes of one connection, in order, one agent call at a time.
 * Calls the agent did not answer are repeated (same seq) for
 * `inputRetryMs`; after that the connection fails with agent_unavailable.
 * After the exit of the command, input is dropped (the exit frame follows).
 */
class PtyWriter {
	readonly #deps: ApiDeps;
	readonly #t: PtyTimings;
	readonly #fail: (e: ErrorInfo) => void;
	readonly #session = randomUUID();
	readonly #flow: { pause(): void; resume(): void };
	#seq = 0;
	/** Input chunks from #head on; #queued bytes in all. */
	#queue: Buffer[] = [];
	#head = 0;
	#queued = 0;
	#paused = false;
	#size: { cols: number; rows: number } | null = null;
	#timer: NodeJS.Timeout | null = null;
	#busy = false;
	#target: { machineId: string; commandId: string } | null = null;
	#done = false;
	#gone = false;

	constructor(
		deps: ApiDeps,
		t: PtyTimings,
		fail: (e: ErrorInfo) => void,
		flow: { pause(): void; resume(): void },
	) {
		this.#deps = deps;
		this.#t = t;
		this.#fail = fail;
		this.#flow = flow;
	}

	/** The socket is not read until the queued input drains. */
	get paused(): boolean {
		return this.#paused;
	}

	push(b: Buffer): void {
		if (this.#done || b.length === 0) return;
		this.#queue.push(b);
		this.#queued += b.length;
		if (!this.#paused && this.#queued >= PTY_INPUT_MAX_QUEUED) {
			this.#paused = true;
			this.#flow.pause();
		}
		this.#schedule(this.#t.inputCoalesceMs);
	}

	resize(cols: number, rows: number): void {
		if (this.#done) return;
		this.#size = { cols, rows };
		this.#schedule(0);
	}

	ready(machineId: string, commandId: string): void {
		this.#target = { machineId, commandId };
		this.#schedule(this.#t.inputCoalesceMs);
	}

	/** The socket closed: what was received is still sent, without repeats. */
	closed(): void {
		this.#gone = true;
		if (this.#timer !== null) {
			clearTimeout(this.#timer);
			this.#timer = null;
			void this.#drain();
		}
	}

	#schedule(ms: number): void {
		if (this.#target === null || this.#busy || this.#done) return;
		if (this.#queued === 0 && this.#size === null) return;
		if (this.#timer !== null) {
			if (ms > 0) return;
			clearTimeout(this.#timer);
		}
		this.#timer = setTimeout(() => {
			this.#timer = null;
			void this.#drain();
		}, ms);
	}

	async #drain(): Promise<void> {
		const target = this.#target;
		if (this.#busy || target === null) return;
		this.#busy = true;
		try {
			while (!this.#done) {
				const size = this.#size;
				if (size !== null) {
					this.#size = null;
					await this.#call(() =>
						this.#deps.agent.update(target.machineId, {
							commandId: target.commandId,
							...size,
						}),
					);
					continue;
				}
				const data = this.#take();
				if (data === null) break;
				const seq = ++this.#seq;
				await this.#call(() =>
					this.#deps.agent.sendInput(target.machineId, {
						commandId: target.commandId,
						inputSessionId: this.#session,
						seq,
						data,
						closeStdin: false,
					}),
				);
			}
		} finally {
			this.#busy = false;
		}
	}

	/** The next batch: only the leading chunks it needs (at most 64 KiB). */
	#take(): Buffer | null {
		if (this.#queued === 0) return null;
		const parts: Buffer[] = [];
		let n = 0;
		while (this.#head < this.#queue.length && n < PTY_INPUT_MAX_BATCH) {
			const chunk = this.#queue[this.#head] as Buffer;
			const room = PTY_INPUT_MAX_BATCH - n;
			if (chunk.length <= room) {
				parts.push(chunk);
				this.#head++;
				n += chunk.length;
			} else {
				parts.push(chunk.subarray(0, room));
				this.#queue[this.#head] = chunk.subarray(room);
				n += room;
			}
		}
		// Drop consumed slots now and then (amortized O(1) per chunk).
		if (this.#head === this.#queue.length) {
			this.#queue = [];
			this.#head = 0;
		} else if (this.#head > 1024 && this.#head * 2 > this.#queue.length) {
			this.#queue = this.#queue.slice(this.#head);
			this.#head = 0;
		}
		this.#queued -= n;
		this.#resumeBelowMark();
		return parts.length === 1 ? (parts[0] as Buffer) : Buffer.concat(parts, n);
	}

	#resumeBelowMark(): void {
		if (this.#paused && this.#queued < PTY_INPUT_MAX_QUEUED) {
			this.#paused = false;
			this.#flow.resume();
		}
	}

	async #call(fn: () => Promise<unknown>): Promise<void> {
		const deadline = Date.now() + this.#t.inputRetryMs;
		let delay = 50;
		for (;;) {
			try {
				await fn();
				return;
			} catch (e) {
				if (e instanceof AgentCallError && e.code === "command_exited") {
					this.#stop();
					return;
				}
				// Repeats carry the same seq: the agent applies them once.
				const unreachable = isAgentOutcomeUnknown(e);
				if (unreachable && !this.#gone && Date.now() + delay < deadline) {
					await sleep(delay);
					delay = Math.min(delay * 2, 1000);
					// Closed meanwhile: what was received is sent once, never repeated.
					if (this.#gone) {
						this.#stop();
						return;
					}
					continue;
				}
				this.#stop();
				if (!this.#gone) {
					this.#fail(
						unreachable ? agentUnavailableError() : agentErrorToHttp(e),
					);
				}
				return;
			}
		}
	}

	#stop(): void {
		this.#done = true;
		this.#queue = [];
		this.#head = 0;
		this.#queued = 0;
		this.#resumeBelowMark();
		this.#size = null;
		if (this.#timer !== null) clearTimeout(this.#timer);
		this.#timer = null;
	}
}
