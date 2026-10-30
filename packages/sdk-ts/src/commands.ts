// Commands (S7 §9, §15.4): exec, run, start, follow and the Command handle.
//
// Resumable streams: `run` sends `POST /commands` with `mode: stream` and an
// Idempotency-Key, `follow` opens `GET .../stream`. After a break (network
// error, no line for 45 s, `error {retryable: true}`, `reconnect`) the stream
// is reopened with `GET .../stream` from the last offsets; the command is
// never started twice. There is no overall time limit while output arrives;
// 20 attempts in a row without new bytes end with the last error. Leaving
// the loop early (break) closes the connection and leaves the command running.

import type { CallOptions, ClientCore } from "./client.ts";
import { SbxError } from "./errors.ts";
import type { components } from "./gen/v1.d.ts";
import { newIdempotencyKey } from "./ids.ts";
import { ndjsonObjects } from "./ndjson.ts";
import {
	DEFAULT_RETRY_BUDGET_MS,
	isRetryable,
	retryDelayMs,
	sleep,
} from "./retry.ts";

export type CommandData = components["schemas"]["Command"];
export type Encoding = "utf8" | "base64";
export type OutputStream = "stdout" | "stderr" | "pty";

/** Byte offsets of the output streams (the next byte to read). */
export interface Offsets {
	stdoutOffset: number;
	stderrOffset: number;
	ptyOffset?: number;
}

/** Output: text for `utf8` (whole characters), bytes for `base64`. */
export interface OutputEvent<E extends Encoding = "utf8"> {
	type: OutputStream;
	data: E extends "base64" ? Uint8Array : string;
	/** Offset of the first byte of `data`. */
	offset: number;
	nextOffset: number;
}

/** The agent no longer has the bytes before `availableFrom` (retention). */
export interface TruncatedEvent {
	type: "truncated";
	stream: OutputStream;
	availableFrom: number;
}

/** The last event: the command ended and all its output was delivered. */
export interface ExitEvent extends Offsets {
	type: "exit";
	status: CommandData["status"];
	exitCode: number | null;
	signal: string | null;
	reason: string | null;
}

export type RunEvent<E extends Encoding = "utf8"> =
	| OutputEvent<E>
	| TruncatedEvent
	| ExitEvent;

/** The command fields of POST /commands (S7 §9.1), without command/argv/mode/encoding. */
export interface CommandSpec {
	cwd?: string | null;
	env?: Record<string, string>;
	user?: string;
	/** Process timeout (status `timed_out`); default none. */
	timeoutSeconds?: number | null;
	tags?: Record<string, string>;
}

export interface ExecOptions extends CommandSpec, CallOptions {}

export interface RunOptions<E extends Encoding = "utf8">
	extends CommandSpec,
		CallOptions {
	encoding?: E;
	/** Called once the command is known (before its first event). */
	onStart?: (command: Command) => void;
}

export interface StartOptions extends CommandSpec, CallOptions {
	/** Keep stdin open for `Command.input` (capability process.stdin). */
	stdin?: boolean;
}

export interface FollowOptions<E extends Encoding = "utf8">
	extends CallOptions {
	/** "start" (default): all output; "end": only new output; or offsets. */
	from?: "start" | "end" | Offsets;
	encoding?: E;
}

export interface ExecResult {
	/** The Command resource after the exit. */
	command: CommandData;
	/** The last 4 MiB of each stream (whole frames, starting on a character). */
	stdout: string;
	stderr: string;
	exitCode: number | null;
	/** Earlier output was dropped: read it with `Command.output`. */
	stdoutTruncated: boolean;
	stderrTruncated: boolean;
}

export interface OutputChunk {
	data: Uint8Array;
	offset: number;
	nextOffset: number;
	availableFrom: number;
	/** Size of the stream once it has ended, else null. */
	end: number | null;
	/** `offset` was below what the agent still has; reading began later. */
	truncated: boolean;
}

/** What a command needs from its sandbox. */
export interface SandboxRef {
	core: ClientCore;
	/** `sb_...` */
	id: string;
}

/** Tail kept by exec (S7 §9.2). */
export const EXEC_TAIL_BYTES = 4 * 1024 * 1024;
/** Attempts in a row without new bytes before a stream gives up (S7 §15.4). */
export const STREAM_MAX_FAILURES = 20;

const COMMANDS = "/v1/sandboxes/{sandbox}/commands";
const COMMAND = "/v1/sandboxes/{sandbox}/commands/{command}";

function toBody(cmd: string | string[]) {
	return typeof cmd === "string" ? { command: cmd } : { argv: cmd };
}

function specOf(o: CommandSpec): CommandSpec {
	const out: CommandSpec = {};
	if (o.cwd !== undefined) out.cwd = o.cwd;
	if (o.env !== undefined) out.env = o.env;
	if (o.user !== undefined) out.user = o.user;
	if (o.timeoutSeconds !== undefined) out.timeoutSeconds = o.timeoutSeconds;
	if (o.tags !== undefined) out.tags = o.tags;
	return out;
}

/** {signal, retryBudgetMs, idempotencyKey} of the options, nothing else. */
export function callOf(o: CallOptions = {}): CallOptions {
	const out: CallOptions = {};
	if (o.signal !== undefined) out.signal = o.signal;
	if (o.retryBudgetMs !== undefined) out.retryBudgetMs = o.retryBudgetMs;
	if (o.idempotencyKey !== undefined) out.idempotencyKey = o.idempotencyKey;
	return out;
}

/** A command of a sandbox (`cmd_...`). */
export class Command {
	readonly id: string;
	/** The last resource read, if any. */
	data: CommandData | null;
	readonly #sb: SandboxRef;

	constructor(sb: SandboxRef, id: string, data: CommandData | null = null) {
		this.#sb = sb;
		this.id = id;
		this.data = data;
	}

	get sandboxId(): string {
		return this.#sb.id;
	}

	#path() {
		return { path: { sandbox: this.#sb.id, command: this.id } };
	}

	/** GET the resource (live fields while the sandbox is ready). */
	async refresh(opts: CallOptions = {}): Promise<CommandData> {
		const { data } = await this.#sb.core.raw.GET(COMMAND, {
			params: this.#path(),
			...callOf(opts),
		});
		this.data = data;
		return data;
	}

	/** Output events from `from` until the exit, reattaching after breaks. */
	follow<E extends Encoding = "utf8">(
		opts: FollowOptions<E> = {},
	): AsyncIterable<RunEvent<E>> {
		const from = opts.from ?? "start";
		const offsets: Offsets =
			typeof from === "object"
				? { ...from }
				: { stdoutOffset: 0, stderrOffset: 0 };
		return streamEvents<E>(this.#sb, {
			encoding: (opts.encoding ?? "utf8") as E,
			offsets,
			commandId: this.id,
			...(from === "end" ? { tailBytes: 0 } : {}),
			call: callOf(opts),
		});
	}

	/** Waits for the exit (output is skipped). */
	async wait(opts: CallOptions = {}): Promise<ExitEvent> {
		for await (const ev of this.follow({ ...callOf(opts), from: "end" })) {
			if (ev.type === "exit") return ev;
		}
		throw new SbxError({
			status: 0,
			code: "unexpected_response",
			message: "the stream ended without exit",
			retryable: false,
		});
	}

	/** SIGTERM, then SIGKILL after `graceMs` (default 10 000). */
	async kill(
		opts: CallOptions & { graceMs?: number } = {},
	): Promise<CommandData> {
		const { data } = await this.#sb.core.raw.POST(`${COMMAND}/kill`, {
			params: this.#path(),
			body: opts.graceMs === undefined ? {} : { graceMs: opts.graceMs },
			...callOf(opts),
		});
		this.data = data;
		return data;
	}

	async signal(
		signal: components["schemas"]["CommandSignalRequest"]["signal"],
		opts: CallOptions = {},
	): Promise<CommandData> {
		const { data } = await this.#sb.core.raw.POST(`${COMMAND}/signal`, {
			params: this.#path(),
			body: { signal },
			...callOf(opts),
		});
		this.data = data;
		return data;
	}

	/**
	 * Writes to stdin (or the PTY). With `sessionId` and `seq` a repeat is
	 * applied once (and retried after network errors); without them it is not.
	 */
	async input(
		data: string | Uint8Array,
		opts: CallOptions & {
			closeStdin?: boolean;
			sessionId?: string;
			seq?: number;
		} = {},
	): Promise<void> {
		const body: components["schemas"]["CommandInputRequest"] =
			typeof data === "string"
				? { data, encoding: "utf8" }
				: { data: toBase64(data), encoding: "base64" };
		if (opts.closeStdin !== undefined) body.closeStdin = opts.closeStdin;
		if (opts.sessionId !== undefined) body.sessionId = opts.sessionId;
		if (opts.seq !== undefined) body.seq = opts.seq;
		await this.#sb.core.raw.POST(`${COMMAND}/input`, {
			params: this.#path(),
			body,
			...callOf(opts),
			// The api drops repeats of a (sessionId, seq): safe to repeat.
			...(opts.sessionId !== undefined && opts.seq !== undefined
				? { idempotencyKey: `${opts.sessionId}:${opts.seq}` }
				: {}),
		});
	}

	/** Raw bytes of one stream (GET .../output; `limit` up to 4 MiB). */
	async output(
		stream: OutputStream = "stdout",
		offset = 0,
		limit = 1024 * 1024,
		opts: CallOptions = {},
	): Promise<OutputChunk> {
		const { data, response } = await this.#sb.core.raw.GET(
			`${COMMAND}/output`,
			{
				params: { ...this.#path(), query: { stream, offset, limit } },
				parseAs: "arrayBuffer",
				...callOf(opts),
			},
		);
		const h = response.headers;
		const num = (name: string, dflt: number) => {
			const v = h.get(name);
			return v === null ? dflt : Number(v);
		};
		const bytes = new Uint8Array(
			(data as ArrayBuffer | undefined) ?? new ArrayBuffer(0),
		);
		const start = num("Sbx-Offset", offset);
		const end = h.get("Sbx-Stream-End");
		return {
			data: bytes,
			offset: start,
			nextOffset: num("Sbx-Next-Offset", start + bytes.length),
			availableFrom: num("Sbx-Available-From", 0),
			end: end === null ? null : Number(end),
			truncated: h.get("Sbx-Truncated") === "true",
		};
	}
}

/** `exec`: a stream command collected into the shape of a sync result. */
export async function execCommand(
	sb: SandboxRef,
	cmd: string | string[],
	opts: ExecOptions = {},
): Promise<ExecResult> {
	let command: Command | undefined;
	const tails = { stdout: new Tail(), stderr: new Tail() };
	let exit: ExitEvent | undefined;
	for await (const ev of runCommand(sb, cmd, {
		...opts,
		onStart: (c) => {
			command = c;
		},
	})) {
		if (ev.type === "exit") exit = ev;
		else if (ev.type === "truncated") {
			if (ev.stream !== "pty") tails[ev.stream].truncate();
		} else if (ev.type !== "pty") {
			tails[ev.type].push(ev.data, ev.nextOffset - ev.offset);
		}
	}
	if (exit === undefined || command === undefined) {
		throw new SbxError({
			status: 0,
			code: "unexpected_response",
			message: "the command stream ended without exit",
			retryable: false,
		});
	}
	const data = await command.refresh(callOf(opts));
	return {
		command: data,
		stdout: tails.stdout.text(),
		stderr: tails.stderr.text(),
		exitCode: exit.exitCode,
		stdoutTruncated: tails.stdout.truncated,
		stderrTruncated: tails.stderr.truncated,
	};
}

/** The last EXEC_TAIL_BYTES of a stream, by whole frames. */
class Tail {
	#pieces: { text: string; bytes: number }[] = [];
	#bytes = 0;
	truncated = false;

	push(text: string, bytes: number) {
		this.#pieces.push({ text, bytes });
		this.#bytes += bytes;
		while (this.#bytes > EXEC_TAIL_BYTES && this.#pieces.length > 1) {
			const first = this.#pieces.shift() as { bytes: number };
			this.#bytes -= first.bytes;
			this.truncated = true;
		}
	}

	/** Output before a gap is not part of the tail. */
	truncate() {
		this.#pieces = [];
		this.#bytes = 0;
		this.truncated = true;
	}

	text() {
		return this.#pieces.map((p) => p.text).join("");
	}
}

/** `run`: POST /commands in stream mode, then the resumable stream. */
export function runCommand<E extends Encoding = "utf8">(
	sb: SandboxRef,
	cmd: string | string[],
	opts: RunOptions<E> = {},
): AsyncIterable<RunEvent<E>> {
	const encoding = (opts.encoding ?? "utf8") as E;
	// One key for every POST of this run: the command starts at most once.
	const idempotencyKey = opts.idempotencyKey ?? newIdempotencyKey();
	const call = { ...callOf(opts), idempotencyKey };
	return streamEvents<E>(sb, {
		encoding,
		offsets: { stdoutOffset: 0, stderrOffset: 0 },
		call,
		...(opts.onStart ? { onStart: opts.onStart } : {}),
		async start(signal, retryBudgetMs) {
			const { data, response } = await sb.core.raw.POST(COMMANDS, {
				params: { path: { sandbox: sb.id } },
				body: {
					...toBody(cmd),
					...specOf(opts),
					mode: "stream" as const,
					encoding,
				},
				parseAs: "stream" as const,
				...call,
				signal,
				retryBudgetMs,
			});
			const body = data as ReadableStream<Uint8Array> | null | undefined;
			if (body === null || body === undefined) {
				throw new SbxError({
					status: response.status,
					code: "unexpected_response",
					message: "POST /commands answered without a stream",
					retryable: false,
				});
			}
			return { body, commandId: response.headers.get("Sbx-Command-Id") };
		},
	});
}

/** `start`: a detached command (POST /commands, mode detached). */
export async function startCommand(
	sb: SandboxRef,
	cmd: string | string[],
	opts: StartOptions = {},
): Promise<Command> {
	const { data } = await sb.core.raw.POST(COMMANDS, {
		params: { path: { sandbox: sb.id } },
		body: {
			...toBody(cmd),
			...specOf(opts),
			...(opts.stdin === undefined ? {} : { stdin: opts.stdin }),
			mode: "detached" as const,
		},
		...callOf(opts),
		idempotencyKey: opts.idempotencyKey ?? newIdempotencyKey(),
	});
	const c = data as CommandData;
	return new Command(sb, c.id, c);
}

interface StreamPlan<E extends Encoding> {
	encoding: E;
	/** Mutated as output arrives. */
	offsets: Offsets;
	call: CallOptions;
	/** Known for follow; for run it comes from the first answer. */
	commandId?: string;
	/** First /stream only: start each stream this many bytes before its end. */
	tailBytes?: number;
	/**
	 * Opens the first stream (run: POST /commands) with the transport budget
	 * left of the start phase.
	 */
	start?: (
		signal: AbortSignal,
		retryBudgetMs: number,
	) => Promise<{ body: ReadableStream<Uint8Array>; commandId: string | null }>;
	onStart?: (command: Command) => void;
}

const OFFSET_KEY = {
	stdout: "stdoutOffset",
	stderr: "stderrOffset",
	pty: "ptyOffset",
} as const;

type Frame = Record<string, unknown> & { type?: unknown };

/** The resumable stream behind run and follow. */
function streamEvents<E extends Encoding>(
	sb: SandboxRef,
	plan: StreamPlan<E>,
): AsyncIterable<RunEvent<E>> {
	return {
		[Symbol.asyncIterator]: () => resumable(sb, plan),
	};
}

async function* resumable<E extends Encoding>(
	sb: SandboxRef,
	plan: StreamPlan<E>,
): AsyncGenerator<RunEvent<E>> {
	const { signal } = plan.call;
	const { offsets } = plan;
	let commandId = plan.commandId;
	let tailBytes = plan.tailBytes;
	let failures = 0;
	let lastError: unknown;
	// Until the command id is known, every attempt is a (keyed) POST: the
	// start phase as a whole is bounded by the call's retry budget.
	const startBudget = plan.call.retryBudgetMs ?? DEFAULT_RETRY_BUDGET_MS;
	const startedAt = Date.now();
	for (;;) {
		signal?.throwIfAborted();
		const attempt = new AbortController();
		const onAbort = () => attempt.abort(signal?.reason);
		signal?.addEventListener("abort", onAbort, { once: true });
		let progressed = false;
		let reconnect = false;
		try {
			let body: ReadableStream<Uint8Array>;
			if (commandId === undefined) {
				if (!plan.start) throw new Error("no command to stream");
				const left = Math.max(0, startBudget - (Date.now() - startedAt));
				const r = await plan.start(attempt.signal, left);
				body = r.body;
				if (r.commandId !== null) {
					commandId = r.commandId;
					plan.onStart?.(new Command(sb, commandId));
				}
			} else {
				body = await openStream(sb, commandId, offsets, plan.encoding, {
					signal: attempt.signal,
					tailBytes,
				});
			}
			for await (const f of ndjsonObjects(body, {
				idleTimeoutMs: sb.core.streamIdleTimeoutMs,
				signal: attempt.signal,
			}) as AsyncGenerator<Frame>) {
				switch (f.type) {
					case "started":
						if (commandId === undefined && typeof f.commandId === "string") {
							commandId = f.commandId;
							plan.onStart?.(new Command(sb, commandId));
						}
						break;
					case "attached":
						setOffsets(offsets, f);
						// From here on, reattach from the offsets.
						tailBytes = undefined;
						break;
					case "stdout":
					case "stderr":
					case "pty": {
						const key = OFFSET_KEY[f.type];
						const at = offsets[key] ?? 0;
						const start = Number(f.offset);
						const next = Number(f.nextOffset);
						if (next <= at) break; // already delivered
						let data = decode(String(f.data), plan.encoding);
						if (start !== at) {
							// base64 frames can be cut at the tracked byte; a utf8 frame
							// cannot (its text is not bytes), and a gap is never right.
							if (start > at || plan.encoding !== "base64") {
								throw protocolError(
									`${f.type} frame at ${start}, expected ${at}`,
								);
							}
							data = (data as Uint8Array).subarray(at - start) as typeof data;
						}
						offsets[key] = next;
						progressed = true;
						failures = 0;
						yield {
							type: f.type,
							data,
							offset: at,
							nextOffset: next,
						} as OutputEvent<E>;
						break;
					}
					case "truncated": {
						const stream = f.stream as OutputStream;
						const from = Number(f.availableFrom);
						offsets[OFFSET_KEY[stream]] = from;
						progressed = true;
						failures = 0;
						yield { type: "truncated", stream, availableFrom: from };
						break;
					}
					case "exit":
						yield exitEvent(f);
						return;
					case "reconnect":
						setOffsets(offsets, f);
						reconnect = true;
						lastError = new SbxError({
							status: 0,
							code: "network_error",
							message: `the api asked to reconnect (${String(f.reason)})`,
							retryable: true,
						});
						break;
					case "error": {
						const err = frameError(f);
						if (!err.retryable) throw err;
						lastError = err;
						break;
					}
					default:
						// heartbeat and frame types this SDK does not know
						break;
				}
				if (reconnect || f.type === "error") break;
			}
			if (lastError === undefined) {
				lastError = new SbxError({
					status: 0,
					code: "network_error",
					message: "the command stream ended without exit",
					retryable: true,
				});
			}
		} catch (err) {
			if (signal?.aborted) throw signal.reason;
			// Both the keyed POST and GET /stream are safe to repeat, so a proxy
			// 502/503/504/429 without the envelope is retried too.
			if (!(err instanceof SbxError) || !isRetryable(err, true)) throw err;
			lastError = err;
		} finally {
			signal?.removeEventListener("abort", onAbort);
			attempt.abort();
		}
		if (!progressed) failures += 1;
		if (failures >= STREAM_MAX_FAILURES) throw lastError;
		const wait =
			reconnect && failures <= 1
				? 0
				: retryDelayMs(lastError, Math.max(0, failures - 1));
		if (
			commandId === undefined &&
			(startBudget <= 0 || Date.now() + wait - startedAt > startBudget)
		) {
			throw lastError;
		}
		lastError = undefined;
		if (wait > 0) await sleep(wait, signal);
	}
}

async function openStream(
	sb: SandboxRef,
	commandId: string,
	offsets: Offsets,
	encoding: Encoding,
	o: { signal: AbortSignal; tailBytes: number | undefined },
): Promise<ReadableStream<Uint8Array>> {
	const query: Record<string, unknown> = {
		stdoutOffset: offsets.stdoutOffset,
		stderrOffset: offsets.stderrOffset,
		follow: "true",
		encoding,
	};
	if (offsets.ptyOffset !== undefined) query.ptyOffset = offsets.ptyOffset;
	if (o.tailBytes !== undefined) {
		query.tailBytes = o.tailBytes;
		delete query.stdoutOffset;
		delete query.stderrOffset;
	}
	const { data } = await sb.core.raw.GET(`${COMMAND}/stream`, {
		params: { path: { sandbox: sb.id, command: commandId }, query },
		parseAs: "stream",
		signal: o.signal,
		// The stream loop counts attempts itself (S7 §15.4).
		retryBudgetMs: 0,
	});
	if (data === null || data === undefined) {
		throw new SbxError({
			status: 0,
			code: "network_error",
			message: "GET /stream answered without a body",
			retryable: true,
		});
	}
	return data;
}

function setOffsets(offsets: Offsets, f: Frame) {
	if (typeof f.stdoutOffset === "number") offsets.stdoutOffset = f.stdoutOffset;
	if (typeof f.stderrOffset === "number") offsets.stderrOffset = f.stderrOffset;
	if (typeof f.ptyOffset === "number") offsets.ptyOffset = f.ptyOffset;
}

function exitEvent(f: Frame): ExitEvent {
	const ev: ExitEvent = {
		type: "exit",
		status: f.status as CommandData["status"],
		exitCode: typeof f.exitCode === "number" ? f.exitCode : null,
		signal: typeof f.signal === "string" ? f.signal : null,
		reason: typeof f.reason === "string" ? f.reason : null,
		stdoutOffset: Number(f.stdoutOffset ?? 0),
		stderrOffset: Number(f.stderrOffset ?? 0),
	};
	if (typeof f.ptyOffset === "number") ev.ptyOffset = f.ptyOffset;
	return ev;
}

/** Frames that do not fit the offsets: reattach from the tracked offsets. */
function protocolError(message: string): SbxError {
	return new SbxError({
		status: 0,
		code: "protocol_error",
		message: `command stream: ${message}`,
		retryable: true,
	});
}

/** An `error` frame (NDJSON or PTY) as SbxError (status 0: the answer itself was 200/101). */
export function frameError(f: Record<string, unknown>): SbxError {
	const code = typeof f.code === "string" ? f.code : "internal";
	return new SbxError({
		status: 0,
		code,
		message: typeof f.message === "string" ? f.message : code,
		retryable: f.retryable === true,
		details:
			typeof f.details === "object" && f.details !== null
				? (f.details as Record<string, unknown>)
				: {},
		requestId: typeof f.requestId === "string" ? f.requestId : null,
	});
}

function decode<E extends Encoding>(
	data: string,
	encoding: E,
): E extends "base64" ? Uint8Array : string {
	return (encoding === "base64" ? fromBase64(data) : data) as never;
}

type Base64Uint8Array = typeof Uint8Array & {
	fromBase64?: (s: string) => Uint8Array;
};
type Base64Bytes = Uint8Array & { toBase64?: () => string };

export function fromBase64(s: string): Uint8Array {
	const native = (Uint8Array as Base64Uint8Array).fromBase64;
	if (native) return native(s);
	const bin = atob(s);
	const out = new Uint8Array(bin.length);
	for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
	return out;
}

export function toBase64(b: Uint8Array): string {
	const native = (b as Base64Bytes).toBase64;
	if (native) return native.call(b);
	let bin = "";
	for (let i = 0; i < b.length; i += 0x8000) {
		bin += String.fromCharCode(...b.subarray(i, i + 0x8000));
	}
	return btoa(bin);
}
