// Output of a command from the agent to the client (S7 §9.4, §9.5, §9.7):
// `resumableAttach` of @umiak/agent-client over `agent.attach` splices the
// agent leg across reconnects (the client sees a pause); this module turns
// its events into NDJSON frames with offsets, decodes UTF-8 per stream on
// character boundaries, sends heartbeats after silence, ends the stream
// with `reconnect` after the max duration or when it is closed from outside
// (StreamClose: shutdown, revocation), and with `error` when the agent is
// gone. On `exit` the command row is completed (completeCommand).
import {
	AgentUnavailableError,
	type AttachOutput,
	type AttachView,
	resumableAttach,
} from "@umiak/agent-client";
import { type CommandResult, storableOutputTruncated } from "@umiak/core";
import { agentErrorToHttp, isAgentUnreachable } from "../agent/errors.ts";
import {
	type AgentAttachEvent,
	type AgentCommandInfo,
	type AgentExitInfo,
	type AgentExitReason,
	type AgentExitStatus,
	type AgentStream,
	streamSize,
} from "../agent/types.ts";
import type { ApiDeps } from "../deps.ts";
import { ApiError, validationError } from "../http/errors.ts";
import {
	type CommandExitStatus,
	type ErrorFrame,
	type ExitFrame,
	type Frame,
	type FrameOffsets,
	type OutputEncoding,
	type OutputFrame,
	StreamClose,
} from "./frames.ts";
import { Utf8StreamDecoder } from "./utf8.ts";

/** Timings of commands and streams; tests shorten them through deps. */
export interface CommandTimings {
	/** Wait of a `creating`/`starting` sandbox for ready (§9.1 step 2). */
	readyWaitMs: number;
	/** Heartbeat after this much silence (§9.7). */
	heartbeatMs: number;
	/** A stream ends with `reconnect {max_duration}` after this (§9.7). */
	maxDurationMs: number;
	/** Reopens of the agent attach without progress before giving up (default 20). */
	attachMaxAttempts?: number;
	/** Budget of a `Process/Get` that only enriches a read (default 5 s). */
	agentReadBudgetMs?: number;
}

export const DEFAULT_ATTACH_MAX_ATTEMPTS = 20;
export const DEFAULT_AGENT_READ_BUDGET_MS = 5_000;

/** `p`, or AgentUnavailableError once `ms` pass (the call is abandoned). */
export function withinBudget<T>(
	p: Promise<T>,
	ms: number,
	machineId: string,
): Promise<T> {
	return new Promise<T>((resolve, reject) => {
		const timer = setTimeout(
			() => reject(new AgentUnavailableError(machineId)),
			ms,
		);
		p.then(resolve, reject).finally(() => clearTimeout(timer));
	});
}

/**
 * Start offsets of `GET .../stream` (§9.5) and the PTY socket (§10.2): an
 * offset of a stream the command does not have is 400 (0 is ignored); an
 * offset past the stream's size (its end once exited, `streamSize`) is 416
 * like `/output`. Without the check
 * an exited command never reaches its end at such an offset and the attach
 * is reopened until it gives up. `param` names the offset in the message
 * (default `<stream>Offset`, the query of `/stream`).
 */
export async function checkStreamOffsets(
	deps: ApiDeps,
	machineId: string,
	commandId: string,
	pty: boolean,
	offsets: Partial<Record<AgentStream, number>>,
	param: (s: AgentStream) => string = (s) => `${s}Offset`,
): Promise<void> {
	const has = pty ? ["pty"] : ["stdout", "stderr"];
	const asked = (Object.keys(offsets) as AgentStream[]).filter(
		(s) => (offsets[s] ?? 0) > 0,
	);
	const foreign = asked.filter((s) => !has.includes(s));
	if (foreign.length > 0) {
		throw validationError(
			foreign.map((s) => ({
				path: `query.${param(s)}`,
				message: `this command has the streams ${has.join(", ")}`,
			})),
		);
	}
	if (asked.length === 0) return;
	let info: AgentCommandInfo;
	try {
		info = await withinBudget(
			deps.agent.get(machineId, commandId),
			readBudget(deps),
			machineId,
		);
	} catch (e) {
		throw agentErrorToHttp(e);
	}
	for (const s of asked) {
		const si = info.streams[s];
		const size = si === undefined ? 0 : streamSize(si);
		const offset = offsets[s] ?? 0;
		if (offset > size) {
			throw new ApiError(
				416,
				"range_not_satisfiable",
				`${param(s)} ${offset} is past the end of ${s} (${size} bytes so far)`,
				{ details: { stream: s, size } },
			);
		}
	}
}

/** Budget of a `Process/Get` that only enriches a read. */
export function readBudget(deps: ApiDeps): number {
	return deps.commandTimings.agentReadBudgetMs ?? DEFAULT_AGENT_READ_BUDGET_MS;
}

export const DEFAULT_COMMAND_TIMINGS: CommandTimings = {
	readyWaitMs: 60_000,
	heartbeatMs: 15_000,
	maxDurationMs: 3_600_000,
	attachMaxAttempts: DEFAULT_ATTACH_MAX_ATTEMPTS,
	agentReadBudgetMs: DEFAULT_AGENT_READ_BUDGET_MS,
};

/**
 * resumableAttach gave up after `attempts` reopens without progress. A
 * reattach is a read, so the stream ends with a retryable
 * `agent_unavailable` (§9.7 step 1).
 */
export class AttachGaveUpError extends Error {
	constructor(attempts: number, cause: unknown) {
		super(`the agent attach made no progress after ${attempts} attempts`, {
			cause,
		});
		this.name = "AttachGaveUpError";
	}
}

export type StreamOffsets = Record<AgentStream, number>;

export interface FollowOptions {
	/** Start each stream at max(availableFrom, size − tailBytes). */
	tailBytes?: number;
	/** False: what exists now, then the end (with `exit` if it has exited). */
	follow: boolean;
	encoding: OutputEncoding;
	/** Abort: the client is gone (end silently) or a StreamClose (final frame). */
	signal: AbortSignal;
	maxDurationMs: number;
	heartbeatMs: number;
	/** Request-Id of `error` frames. */
	requestId: string;
	/** See CommandTimings.attachMaxAttempts. */
	attachMaxAttempts?: number;
	/** A PTY command (one stream `pty`); else stdout and stderr. */
	pty?: boolean;
	/** The first frame, from the resolved start offsets (`attached`, `started`). */
	head?: (offsets: FrameOffsets) => Frame;
}

/** S3 exit status and reason → the command status (§9.5). */
export function commandStatus(
	status: AgentExitStatus,
	reason: AgentExitReason | null,
): CommandExitStatus {
	if (reason === "timeout") return "timed_out";
	if (reason === "start_failed") return "failed_to_start";
	return status;
}

type ExitEvent = Extract<AgentAttachEvent, { type: "exit" }>;

/**
 * The `completeCommand` result of an agent exit. `bytes` are the stream
 * ends; a PTY command keeps its one stream in `stdout_bytes`. The reason
 * and `outputTruncated` are stored too (read without the agent).
 */
export function commandResult(
	exit: AgentExitInfo,
	bytes: { stdout: number | null; stderr: number | null; pty: number | null },
	pty: boolean,
	endedAt: Date | null,
	outputTruncated: string | null,
): CommandResult {
	return {
		status: commandStatus(exit.status, exit.reason),
		exitCode: exit.code,
		signal: exit.signal,
		reason: exit.reason,
		// An odd value from the agent must not keep the status from being stored.
		outputTruncated: storableOutputTruncated(outputTruncated),
		stdoutBytes: pty ? bytes.pty : bytes.stdout,
		stderrBytes: pty ? 0 : bytes.stderr,
		...(endedAt === null ? {} : { endedAt }),
	};
}

/** `commandResult` of a `Process/Get` answer; null while it runs. */
export function commandResultOf(info: AgentCommandInfo): CommandResult | null {
	if (info.exit === null) return null;
	const end = (s: AgentStream) => {
		const x = info.streams[s];
		return x === undefined ? null : (x.end ?? x.size);
	};
	return commandResult(
		info.exit,
		{ stdout: end("stdout"), stderr: end("stderr"), pty: end("pty") },
		info.streams.pty !== undefined,
		info.endedAt,
		info.outputTruncated,
	);
}

/** Internal events of both sources (resumable and one-shot). */
type Ev =
	| { type: "data"; stream: AgentStream; offset: number; data: Uint8Array }
	| { type: "truncated"; stream: AgentStream; availableFrom: number }
	| { type: "exit"; exit: ExitEvent }
	| { type: "other" };

function view(ev: AgentAttachEvent): AttachView {
	switch (ev.type) {
		case "data":
			return {
				kind: "data",
				stream: ev.stream,
				offset: BigInt(ev.offset),
				data: ev.data,
			};
		case "truncated":
			return {
				kind: "truncated",
				stream: ev.stream,
				availableFrom: BigInt(ev.availableFrom),
			};
		case "exit":
			return {
				kind: "exit",
				ends: {
					stdout: BigInt(ev.stdoutEnd),
					stderr: BigInt(ev.stderrEnd),
					pty: BigInt(ev.ptyEnd),
				},
			};
		default:
			return { kind: "other" };
	}
}

function fromOutput(o: AttachOutput<AgentAttachEvent>): Ev {
	switch (o.type) {
		case "data":
			return {
				type: "data",
				stream: o.stream as AgentStream,
				offset: Number(o.offset),
				data: o.data,
			};
		case "truncated":
			return {
				type: "truncated",
				stream: o.stream as AgentStream,
				availableFrom: Number(o.availableFrom),
			};
		case "exit":
			return { type: "exit", exit: o.event as ExitEvent };
		default:
			return { type: "other" };
	}
}

function fromEvent(ev: AgentAttachEvent): Ev {
	switch (ev.type) {
		case "data":
		case "truncated":
			return ev;
		case "exit":
			return { type: "exit", exit: ev };
		default:
			return { type: "other" };
	}
}

async function* source(
	deps: ApiDeps,
	machineId: string,
	commandId: string,
	start: StreamOffsets,
	follow: boolean,
	signal: AbortSignal,
	maxAttempts: number,
): AsyncGenerator<Ev> {
	if (!follow) {
		const req = {
			commandId,
			stdoutOffset: start.stdout,
			stderrOffset: start.stderr,
			ptyOffset: start.pty,
			follow: false,
		};
		for await (const ev of deps.agent.attach(machineId, req, signal)) {
			yield fromEvent(ev);
		}
		return;
	}
	// Opens since the last progress: a fatal error fails the first one, so
	// an error after maxAttempts of them is resumableAttach giving up.
	let opens = 0;
	const it = resumableAttach<AgentAttachEvent>({
		maxAttempts,
		open: (o, sig) => {
			opens++;
			return deps.agent.attach(
				machineId,
				{
					commandId,
					stdoutOffset: Number(o.stdout ?? 0n),
					stderrOffset: Number(o.stderr ?? 0n),
					ptyOffset: Number(o.pty ?? 0n),
				},
				sig,
			);
		},
		view,
		offsets: {
			stdout: BigInt(start.stdout),
			stderr: BigInt(start.stderr),
			pty: BigInt(start.pty),
		},
		signal,
	});
	try {
		for await (const o of it) {
			if (o.type === "data" || o.type === "truncated") opens = 0;
			yield fromOutput(o);
		}
	} catch (e) {
		if (!signal.aborted && opens >= maxAttempts && !isAgentUnreachable(e)) {
			throw new AttachGaveUpError(opens, e);
		}
		throw e;
	}
}

type Wake =
	| { kind: "event"; r: IteratorResult<Ev> }
	| { kind: "failed"; error: unknown }
	| { kind: "heartbeat" }
	| { kind: "deadline" }
	| { kind: "aborted" };

function nextWake(
	pending: Promise<IteratorResult<Ev>>,
	heartbeatInMs: number,
	deadlineInMs: number,
	signal: AbortSignal,
): Promise<Wake> {
	return new Promise((resolve) => {
		const timers: NodeJS.Timeout[] = [];
		const done = (w: Wake) => {
			for (const t of timers) clearTimeout(t);
			signal.removeEventListener("abort", onAbort);
			resolve(w);
		};
		const onAbort = () => done({ kind: "aborted" });
		if (signal.aborted) return done({ kind: "aborted" });
		signal.addEventListener("abort", onAbort, { once: true });
		timers.push(
			setTimeout(() => done({ kind: "heartbeat" }), Math.max(0, heartbeatInMs)),
		);
		if (Number.isFinite(deadlineInMs)) {
			timers.push(
				setTimeout(() => done({ kind: "deadline" }), Math.max(0, deadlineInMs)),
			);
		}
		pending.then(
			(r) => done({ kind: "event", r }),
			(error: unknown) => done({ kind: "failed", error }),
		);
	});
}

/** The error frame of a failed attach (§9.7 step 1: agent gone → retryable). */
function errorOf(
	e: unknown,
): Pick<ErrorFrame, "code" | "message" | "retryable"> {
	if (isAgentUnreachable(e) || e instanceof AttachGaveUpError) {
		return {
			code: "agent_unavailable",
			message:
				"the sandbox agent is not reachable right now; reattach with these offsets",
			retryable: true,
		};
	}
	const h = agentErrorToHttp(e);
	return { code: h.code, message: h.message, retryable: h.retryable };
}

/**
 * Frames of a command from `offsets` (S7 §9.5). Without `head` the first
 * frame is output. The last frame is `exit`, `reconnect` or `error`; a
 * stream with `follow: false` may also just end; a client abort ends it
 * silently.
 */
export async function* followCommand(
	deps: ApiDeps,
	machineId: string,
	commandId: string,
	offsets: Partial<StreamOffsets>,
	opts: FollowOptions,
): AsyncGenerator<Frame> {
	const streams: AgentStream[] = opts.pty ? ["pty"] : ["stdout", "stderr"];
	const start: StreamOffsets = {
		stdout: offsets.stdout ?? 0,
		stderr: offsets.stderr ?? 0,
		pty: offsets.pty ?? 0,
	};
	// Offsets of the frames sent (the client's); `agentAt` is where the next
	// agent byte starts (ahead by the bytes a decoder holds).
	const sent: StreamOffsets = { ...start };
	const agentAt: StreamOffsets = { ...start };
	const offsetsNow = (): FrameOffsets => ({
		stdoutOffset: sent.stdout,
		stderrOffset: sent.stderr,
		...(opts.pty ? { ptyOffset: sent.pty } : {}),
	});
	const fail = (e: unknown): ErrorFrame => ({
		type: "error",
		...errorOf(e),
		requestId: opts.requestId,
		...offsetsNow(),
	});

	if (opts.tailBytes !== undefined) {
		try {
			const info = await deps.agent.get(machineId, commandId);
			for (const s of streams) {
				const si = info.streams[s];
				if (si === undefined) continue;
				// From the end of an exited command: leftovers may write past it.
				const size = streamSize(si);
				const from = Math.max(si.availableFrom, size - opts.tailBytes);
				start[s] = sent[s] = agentAt[s] = Math.max(Math.min(from, size), 0);
			}
		} catch (e) {
			if (opts.head) yield opts.head(offsetsNow());
			yield fail(e);
			return;
		}
	}
	if (opts.head) yield opts.head(offsetsNow());

	const decoders = new Map<AgentStream, Utf8StreamDecoder>();
	const decoder = (s: AgentStream) => {
		let d = decoders.get(s);
		if (d === undefined) {
			d = new Utf8StreamDecoder();
			decoders.set(s, d);
		}
		return d;
	};
	const outputFrame = (
		s: AgentStream,
		data: Uint8Array,
	): OutputFrame | null => {
		const offset = sent[s];
		if (opts.encoding === "base64") {
			if (data.length === 0) return null;
			sent[s] = offset + data.length;
			return {
				type: s,
				offset,
				nextOffset: sent[s],
				data: Buffer.from(data).toString("base64"),
			};
		}
		const r = decoder(s).push(data);
		if (r.consumed === 0) return null;
		sent[s] = offset + r.consumed;
		return { type: s, offset, nextOffset: sent[s], data: r.text };
	};

	const inner = new AbortController();
	const onAbort = () => inner.abort(opts.signal.reason);
	// Closed already (before the first frame): the loop sends the close frame.
	if (opts.signal.aborted) onAbort();
	else opts.signal.addEventListener("abort", onAbort, { once: true });
	const src = source(
		deps,
		machineId,
		commandId,
		start,
		opts.follow,
		inner.signal,
		opts.attachMaxAttempts ?? DEFAULT_ATTACH_MAX_ATTEMPTS,
	);
	const deadline = Date.now() + opts.maxDurationMs;
	let lastFrameAt = Date.now();
	let pending: Promise<IteratorResult<Ev>> | null = null;
	try {
		for (;;) {
			if (pending === null) {
				pending = src.next();
				// Settles after an abort too, maybe while this generator waits
				// at a yield: never an unhandled rejection.
				pending.catch(() => {});
			}
			const now = Date.now();
			const w = await nextWake(
				pending,
				lastFrameAt + opts.heartbeatMs - now,
				deadline - now,
				inner.signal,
			);
			if (w.kind === "heartbeat") {
				lastFrameAt = Date.now();
				yield { type: "heartbeat" };
				continue;
			}
			if (w.kind === "deadline") {
				// The agent leg stops now, not when the client reads past the end.
				inner.abort();
				yield { type: "reconnect", reason: "max_duration", ...offsetsNow() };
				return;
			}
			if (w.kind === "aborted") {
				const reason = opts.signal.reason;
				if (reason instanceof StreamClose) {
					const f = reason.frame;
					yield f.type === "error"
						? { ...f, requestId: opts.requestId, ...offsetsNow() }
						: { ...f, ...offsetsNow() };
				}
				return;
			}
			if (w.kind === "failed") {
				yield fail(w.error);
				return;
			}
			pending = null;
			if (w.r.done) return;
			const ev = w.r.value;
			if (ev.type === "data") {
				agentAt[ev.stream] = ev.offset + ev.data.length;
				const f = outputFrame(ev.stream, ev.data);
				if (f !== null) {
					lastFrameAt = Date.now();
					yield f;
				}
			} else if (ev.type === "truncated") {
				const s = ev.stream;
				if (ev.availableFrom > sent[s]) {
					// Held bytes of a cut character are gone with the rest.
					decoders.get(s)?.reset();
					agentAt[s] = Math.max(agentAt[s], ev.availableFrom);
					sent[s] = agentAt[s];
					lastFrameAt = Date.now();
					yield { type: "truncated", stream: s, availableFrom: sent[s] };
				}
			} else if (ev.type === "exit") {
				for (const s of streams) {
					const d = decoders.get(s);
					if (d === undefined || d.pending === 0) continue;
					const offset = sent[s];
					sent[s] = offset + d.pending;
					yield { type: s, offset, nextOffset: sent[s], data: d.flush() };
				}
				yield await exitFrame(deps, commandId, ev.exit, opts.pty === true);
				return;
			}
		}
	} finally {
		opts.signal.removeEventListener("abort", onAbort);
		inner.abort();
		void src.return(undefined).catch(() => {});
	}
}

async function exitFrame(
	deps: ApiDeps,
	commandId: string,
	e: ExitEvent,
	pty: boolean,
): Promise<ExitFrame> {
	const status = commandStatus(e.status, e.reason);
	try {
		await deps.svc.completeCommand(
			commandId,
			commandResult(
				e,
				{ stdout: e.stdoutEnd, stderr: e.stderrEnd, pty: e.ptyEnd },
				pty,
				e.endedAt,
				e.outputTruncated,
			),
		);
	} catch (err) {
		deps.log.warn(
			{ err: err instanceof Error ? err.message : String(err), commandId },
			"completeCommand failed",
		);
	}
	return {
		type: "exit",
		status,
		exitCode: e.code,
		signal: e.signal,
		reason: e.reason,
		outputTruncated: e.outputTruncated,
		stdoutOffset: e.stdoutEnd,
		stderrOffset: e.stderrEnd,
		...(pty ? { ptyOffset: e.ptyEnd } : {}),
	};
}
