// Command tools (S11 8.3, 9.1-9.3, 10.2): exec_run, exec_start, exec_output,
// exec_list, exec_kill. Output is read as bytes (base64 frames, /output) and
// decoded here, so every offset given to the model is an exact byte offset
// on a character boundary.
import type { CallToolResult } from "@modelcontextprotocol/server";
import {
	type Command,
	type CommandData,
	type ExitEvent,
	SbxError,
} from "@sbx/sdk";
import { z } from "zod";
import type { ToolContext } from "../context.ts";
import { RESPONSE_MARGIN_MS } from "../deadline.ts";
import { hintFor, ToolError } from "../errors.ts";
import { splitBudget, truncationNote } from "../output/budget.ts";
import { fenceUntrusted } from "../output/fence.ts";
import { type ByteSpan, fittingWindow, shownChars } from "../output/fit.ts";
import { toolText } from "../output/result.ts";
import { safeLine } from "../output/sanitize.ts";
import { ByteTail } from "../output/tail.ts";
import type { Window } from "../output/utf8.ts";
import { defineTool } from "../registry.ts";
import {
	keyFor,
	outcomeUnknown,
	unknownOutcomeError,
	withUnknownOutcome,
} from "./keyed.ts";
import { REPLAYED_LINE, resolveSandboxId } from "./sandbox-view.ts";
import {
	envShape,
	idempotencyKeyShape,
	MAX_SECONDS,
	MAX_WAIT_SECONDS,
} from "./shapes.ts";
import { compact } from "./view.ts";

const COMMANDS_PATH = "/v1/sandboxes/{sandbox}/commands";
const COMMAND_PATH = `${COMMANDS_PATH}/{command}`;

/** Output budget of exec_run and exec_output, both streams together (S11 9.2). */
export const DEFAULT_OUTPUT_BYTES = 16_384;
export const MAX_OUTPUT_BYTES = 65_536;
/** Below this a window could hold nothing but a split character. */
const MIN_OUTPUT_BYTES = 1_024;
/**
 * Sanitized characters of the fenced output, both streams together: control
 * bytes are written as escapes, so the byte windows are shortened until they
 * fit this (the header and notes come on top, under the 80 000 of a response).
 */
const OUTPUT_CHARS_BUDGET = 70_000;
const DEFAULT_RUN_TIMEOUT_SECONDS = 600;
const DEFAULT_RUN_WAIT_SECONDS = 30;
/** stdio cancel of exec_run: SIGTERM, then SIGKILL after this (S11 10.2). */
export const KILL_GRACE_MS = 5_000;
/** exec_kill with SIGTERM (S11 8.3). */
export const SIGTERM_GRACE_MS = 10_000;
const PROGRESS_EVERY_MS = 5_000;
/** A wait over before the command is named: how long to wait for its started frame. */
const STARTED_GRACE_MS = 1_000;
/** exec_output keeps reading this long after the first new chunk. */
const SETTLE_MS = 500;
/**
 * exec_output ends its wait this long before the deadline: up to three reads
 * follow it (the status, then each stream), and a slow API must not turn the
 * answer into deadline_exceeded.
 */
const READS_MARGIN_MS = 5_000;
const LIST_COMMAND_CHARS = 200;

type Stream = "stdout" | "stderr";
const STREAMS: readonly Stream[] = ["stdout", "stderr"];
/** Fence labels are constants: nothing from the sandbox goes into them. */
const LABEL: Record<Stream, string> = {
	stdout: "stream=stdout",
	stderr: "stream=stderr",
};

const RUNNING_STATUSES = new Set(["starting", "running"]);

// Field descriptions are terse: tools/list has a budget (S11 7.1). The API
// checks lengths itself (command up to 256 KiB, cwd, user).
const commandShape = z.string().describe("Shell command, up to 256 KiB");
const cwdShape = z
	.string()
	.optional()
	.describe("Working directory (default: home)");
const userShape = z
	.string()
	.optional()
	.describe("Guest user (default: login user)");
const commandEnvShape = envShape.describe(
	"Non-secret env vars; args show in client logs",
);
const commandKeyShape = idempotencyKeyShape.describe(
	"Unique per run (a UUID); reuse only to retry",
);
const commandIdShape = z.string().describe("Command id (cmd_...)");
const outputBytesShape = z
	.number()
	.int()
	.min(MIN_OUTPUT_BYTES)
	.max(MAX_OUTPUT_BYTES)
	.optional()
	.describe(`Max output bytes (default ${DEFAULT_OUTPUT_BYTES})`);
/** Stream offsets: an explicit bound keeps MAX_SAFE_INTEGER out of the schema. */
const MAX_OFFSET = 2 ** 48;

function timeoutShape(description: string) {
	return z
		.number()
		.int()
		.min(0)
		.max(MAX_SECONDS)
		.optional()
		.describe(description);
}

function streamView(w: Window, availableFrom?: number) {
	return {
		size: w.size,
		from: w.from,
		to: w.to,
		...(availableFrom === undefined ? {} : { available_from: availableFrom }),
	};
}

/**
 * Decodes both streams and shortens them on a character boundary until the
 * sanitized text fits OUTPUT_CHARS_BUDGET, split like the byte budget: from
 * the start for a tail, from the end when reading forward. Offsets then match
 * what the model gets.
 */
function fitStreams(
	spans: Record<Stream, ByteSpan>,
	keep: "head" | "tail",
): Record<Stream, Window> {
	const full = {
		stdout: fittingWindow(spans.stdout, Number.POSITIVE_INFINITY, keep),
		stderr: fittingWindow(spans.stderr, Number.POSITIVE_INFINITY, keep),
	};
	const chars = splitBudget(OUTPUT_CHARS_BUDGET, {
		stdout: shownChars(full.stdout),
		stderr: shownChars(full.stderr),
	});
	return {
		stdout: fittingWindow(spans.stdout, chars.stdout, keep),
		stderr: fittingWindow(spans.stderr, chars.stderr, keep),
	};
}

/** The fenced blocks of the non-empty windows, or nothing. */
function fencedOutput(windows: Record<Stream, Window>): string[] {
	const blocks = STREAMS.filter((s) => windows[s].text !== "").map((s) => ({
		label: LABEL[s],
		text: windows[s].text,
	}));
	return blocks.length === 0 ? [] : [fenceUntrusted(blocks)];
}

function answer(
	header: Record<string, unknown>,
	notes: string[],
	windows: Record<Stream, Window>,
): CallToolResult {
	return toolText(header, [
		...(notes.length > 0 ? [notes.join("\n")] : []),
		...fencedOutput(windows),
	]);
}

function continueHint(id: string, offsets: Record<Stream, number>): string {
	return `still running: call exec_output with command_id=${id}, stdout_offset=${offsets.stdout}, stderr_offset=${offsets.stderr}, wait_seconds=50`;
}

/** SIGTERM to a command whose exec_run the client cancelled; never throws. */
async function killOnCancel(ctx: ToolContext, command: Command): Promise<void> {
	try {
		// The call's signal is already aborted: the kill gets its own short one.
		await command.kill({
			graceMs: KILL_GRACE_MS,
			signal: AbortSignal.timeout(KILL_GRACE_MS),
			retryBudgetMs: 0,
		});
	} catch (err) {
		ctx.log.warn(
			{ commandId: command.id, reason: String(err) },
			"kill after cancel failed",
		);
	}
}

export const execRun = defineTool({
	name: "exec_run",
	title: "Run a command",
	description:
		"Runs a command (bash -lc on Linux, PowerShell on Windows) and waits up to wait_seconds. No stdin: use non-interactive flags (-y). Still running: returns command_id for exec_output. timeout_seconds default 600 (0 = none). Over HTTP, cancelling may leave the command running; use exec_list and exec_kill.",
	toolset: "core",
	scopes: ["commands:exec"],
	annotations: {
		readOnlyHint: false,
		destructiveHint: false,
		idempotentHint: false,
		openWorldHint: true,
	},
	sandboxArg: true,
	shape: {
		command: commandShape,
		cwd: cwdShape,
		env: commandEnvShape,
		user: userShape,
		timeout_seconds: timeoutShape(
			`Seconds; default ${DEFAULT_RUN_TIMEOUT_SECONDS}, 0 = none`,
		),
		wait_seconds: z
			.number()
			.int()
			.min(0)
			.max(MAX_WAIT_SECONDS)
			.optional()
			.describe(`Seconds to wait (default ${DEFAULT_RUN_WAIT_SECONDS})`),
		max_output_bytes: outputBytesShape,
		idempotency_key: commandKeyShape,
	},
	async handler(args, ctx) {
		// The key is scoped by the sandbox id (an id and a slug key alike); the
		// handle costs no request, so commands:exec is the only scope needed.
		const sandboxId = await resolveSandboxId(ctx, args.sandbox);
		const { modelKey, apiKey } = keyFor(
			"exec_run",
			args.idempotency_key,
			sandboxId,
		);
		const sb = ctx.sbx().sandboxes.handle(args.sandbox);
		const max = args.max_output_bytes ?? DEFAULT_OUTPUT_BYTES;
		const tails: Record<Stream, ByteTail> = {
			stdout: new ByteTail(max),
			stderr: new ByteTail(max),
		};
		let command: Command | undefined;
		let replayed = false;
		let exit: ExitEvent | undefined;
		const started = Date.now();

		// Ending the wait aborts the stream only: the command keeps running.
		// The wait never cuts the keyed POST: until the API names the command
		// only the call budget does (`stop`), so a retry with the key attaches.
		const stop = new AbortController();
		const end = () => stop.abort(new DOMException("wait over", "TimeoutError"));
		let waitOver = false;
		let grace: ReturnType<typeof setTimeout> | undefined;
		const budget = setTimeout(
			end,
			Math.max(0, ctx.deadline.remainingMs() - RESPONSE_MARGIN_MS),
		);
		const timer = setTimeout(
			() => {
				waitOver = true;
				if (command !== undefined) end();
			},
			ctx.deadline.waitMs(args.wait_seconds ?? DEFAULT_RUN_WAIT_SECONDS),
		);
		const progress = setInterval(() => {
			const bytes = tails.stdout.to + tails.stderr.to;
			void ctx.progress(
				Math.round((Date.now() - started) / 100) / 10,
				undefined,
				`${bytes} bytes of output so far`,
			);
		}, PROGRESS_EVERY_MS);
		const timeout = args.timeout_seconds ?? DEFAULT_RUN_TIMEOUT_SECONDS;
		try {
			for await (const ev of sb.run(args.command, {
				...compact({ cwd: args.cwd, env: args.env, user: args.user }),
				timeoutSeconds: timeout === 0 ? null : timeout,
				encoding: "base64",
				idempotencyKey: apiKey,
				signal: AbortSignal.any([ctx.call.signal, stop.signal]),
				retryBudgetMs: ctx.call.retryBudgetMs,
				onStart: (c) => {
					command = c;
					// The wait is over: answer once the started frame (replayed)
					// is read, or shortly if it does not come.
					if (waitOver) grace = setTimeout(end, STARTED_GRACE_MS);
				},
				onStarted: (s) => {
					replayed = s.replayed;
					if (waitOver) end();
				},
			})) {
				if (ev.type === "exit") {
					exit = ev;
					break;
				}
				if (ev.type === "truncated") {
					if (ev.stream !== "pty") tails[ev.stream].truncate(ev.availableFrom);
				} else if (ev.type !== "pty") {
					tails[ev.type].push(ev.data, ev.nextOffset);
				}
			}
		} catch (err) {
			if (ctx.deadline.cancelled()) {
				// stdio cancel only: stdin close and HTTP leave the command alone.
				if (command !== undefined && ctx.cancelledByClient()) {
					await killOnCancel(ctx, command);
				}
				throw err;
			}
			const stopped = stop.signal.aborted || ctx.deadline.expired();
			if (command === undefined) {
				if (stopped || outcomeUnknown(err, ctx)) {
					throw unknownOutcomeError(modelKey);
				}
				throw err;
			}
			if (!stopped) {
				// 401 and bugs go to the call wrapper (re-login, the log).
				if (!(err instanceof SbxError) || err.status === 401) throw err;
				throw lostStream(err, args.sandbox, command.id, modelKey);
			}
		} finally {
			clearTimeout(budget);
			clearTimeout(timer);
			clearTimeout(grace);
			clearInterval(progress);
		}
		if (command === undefined) {
			// The stream ended before the API named the command: cannot happen
			// with a conforming API, but never answer without the key.
			throw unknownOutcomeError(modelKey);
		}
		return runAnswer(command.id, tails, max, {
			exit,
			replayed,
			durationMs: Date.now() - started,
			modelKey,
		});
	},
});

/**
 * The command started but its output stream failed for good: the API's
 * error (retryable and the hint of its code as they are) plus where to read on.
 */
function lostStream(
	err: SbxError,
	sandbox: string,
	id: string,
	modelKey: string,
): ToolError {
	const hint = hintFor(err.code, { sandbox, details: err.details });
	const readOn = `command ${id} was started; read its output with exec_output command_id=${id}.`;
	return new ToolError({
		code: err.code,
		message: err.message,
		retryable: err.retryable,
		hint: hint === undefined ? readOn : `${hint} Then ${readOn}`,
		details: err.details,
		idempotencyKey: modelKey,
	});
}

function runAnswer(
	id: string,
	tails: Record<Stream, ByteTail>,
	max: number,
	o: {
		exit: ExitEvent | undefined;
		replayed: boolean;
		durationMs: number;
		modelKey: string;
	},
): CallToolResult {
	const held = {
		stdout: tails.stdout.to - tails.stdout.from,
		stderr: tails.stderr.to - tails.stderr.from,
	};
	const budget = splitBudget(max, held);
	const span = (s: Stream): ByteSpan => {
		const all = tails[s].bytes();
		const take = all.subarray(all.length - budget[s]);
		const from = tails[s].to - take.length;
		return {
			bytes: take,
			offset: from,
			size: tails[s].to,
			atStart: from === 0,
			final: o.exit !== undefined,
		};
	};
	const windows = fitStreams(
		{ stdout: span("stdout"), stderr: span("stderr") },
		"tail",
	);
	const notes: string[] = [];
	if (o.replayed) notes.push(REPLAYED_LINE);
	for (const s of STREAMS) {
		const note = truncationNote(s, { ...windows[s], mode: "tail" });
		if (note !== null) notes.push(note);
	}
	const header: Record<string, unknown> = {
		command_id: id,
		status: o.exit?.status ?? "running",
		exit_code: o.exit?.exitCode,
		signal: o.exit?.signal,
		// The wall time of this call; a replay attached to an older command.
		duration_ms: o.exit !== undefined && !o.replayed ? o.durationMs : undefined,
		stdout: streamView(windows.stdout),
		stderr: streamView(windows.stderr),
	};
	if (o.exit === undefined) {
		const offsets = { stdout: windows.stdout.to, stderr: windows.stderr.to };
		header.stdout_offset = offsets.stdout;
		header.stderr_offset = offsets.stderr;
		notes.push(continueHint(id, offsets));
	} else if (o.exit.outputTruncated !== null) {
		notes.push(
			`the agent dropped output (${safeLine(o.exit.outputTruncated)})`,
		);
	}
	if (o.replayed) header.replayed = true;
	header.idempotency_key = o.modelKey;
	return answer(header, notes, windows);
}

export const execStart = defineTool({
	name: "exec_start",
	title: "Start a command",
	description:
		"Starts a command in the background. For dev servers, watchers, long jobs: read output with exec_output, expose ports with port_expose.",
	toolset: "core",
	scopes: ["commands:exec"],
	annotations: {
		readOnlyHint: false,
		destructiveHint: false,
		idempotentHint: false,
		openWorldHint: true,
	},
	sandboxArg: true,
	shape: {
		command: commandShape,
		cwd: cwdShape,
		env: commandEnvShape,
		user: userShape,
		timeout_seconds: timeoutShape("Seconds; default none"),
		idempotency_key: commandKeyShape,
	},
	async handler(args, ctx) {
		const sandboxId = await resolveSandboxId(ctx, args.sandbox);
		const { modelKey, apiKey } = keyFor(
			"exec_start",
			args.idempotency_key,
			sandboxId,
		);
		const timeout =
			args.timeout_seconds === 0 ? undefined : args.timeout_seconds;
		const r = await withUnknownOutcome(ctx, modelKey, () =>
			ctx.sbx().raw.POST(COMMANDS_PATH, {
				params: { path: { sandbox: args.sandbox } },
				body: {
					command: args.command,
					...compact({
						cwd: args.cwd,
						env: args.env,
						user: args.user,
						timeoutSeconds: timeout,
					}),
					mode: "detached",
				},
				idempotencyKey: apiKey,
				...ctx.call,
			}),
		);
		const c = r.data as CommandData;
		const replayed = r.response.headers.get("Idempotency-Replayed") === "true";
		const notes = replayed ? [REPLAYED_LINE] : [];
		notes.push(
			`read its output with exec_output command_id=${c.id}; stop it with exec_kill.`,
		);
		return toolText(
			{
				command_id: c.id,
				pid: c.pid,
				status: c.status,
				exit_code: c.exitCode,
				replayed: replayed ? true : undefined,
				idempotency_key: modelKey,
			},
			[notes.join("\n")],
		);
	},
});

interface Chunk {
	data: Uint8Array;
	offset: number;
	nextOffset: number;
	availableFrom: number;
	/** Size of the stream once it ended, else null. */
	end: number | null;
}

/** GET .../output: raw bytes of one stream from `offset`. */
async function readOutput(
	ctx: ToolContext,
	path: { sandbox: string; command: string },
	stream: Stream,
	offset: number,
	limit: number,
): Promise<Chunk> {
	const { data, response } = await ctx.sbx().raw.GET(`${COMMAND_PATH}/output`, {
		params: { path, query: { stream, offset, limit } },
		parseAs: "arrayBuffer",
		...ctx.call,
	});
	const bytes = new Uint8Array((data as ArrayBuffer | undefined) ?? []);
	const h = response.headers;
	const num = (name: string, dflt: number) => {
		const v = h.get(name);
		return v === null ? dflt : Number(v);
	};
	const start = num("Sbx-Offset", offset);
	const end = h.get("Sbx-Stream-End");
	return {
		data: bytes,
		offset: start,
		nextOffset: num("Sbx-Next-Offset", start + bytes.length),
		availableFrom: num("Sbx-Available-From", 0),
		end: end === null ? null : Number(end),
	};
}

async function getCommand(
	ctx: ToolContext,
	path: { sandbox: string; command: string },
): Promise<CommandData> {
	const { data } = await ctx.sbx().raw.GET(COMMAND_PATH, {
		params: { path },
		...ctx.call,
	});
	return data;
}

interface StreamState {
	size: number;
	availableFrom: number;
	/** Size once the stream ended, else null. */
	end: number | null;
}

function streamState(c: CommandData, s: Stream): StreamState {
	const info = c.streams?.[s];
	return {
		size: info?.sizeBytes ?? 0,
		availableFrom: info?.availableFromBytes ?? 0,
		end: info?.endBytes ?? null,
	};
}

/**
 * Waits until the command has output past `offsets` (then SETTLE_MS more,
 * to collect what follows) or exits, at most until `endsAt` (epoch ms).
 * Never throws because time is up: the caller answers with the state as it is.
 */
async function waitForOutput(
	ctx: ToolContext,
	sandbox: string,
	commandId: string,
	offsets: Record<Stream, number>,
	endsAt: number,
): Promise<void> {
	const waitMs = endsAt - Date.now();
	if (waitMs <= 0) return;
	const sb = ctx.sbx().sandboxes.handle(sandbox);
	const stop = new AbortController();
	const timer = setTimeout(() => stop.abort(), waitMs);
	let settle: ReturnType<typeof setTimeout> | undefined;
	try {
		for await (const ev of sb.command(commandId).follow({
			from: { stdoutOffset: offsets.stdout, stderrOffset: offsets.stderr },
			encoding: "base64",
			signal: AbortSignal.any([ctx.call.signal, stop.signal]),
			retryBudgetMs: ctx.call.retryBudgetMs,
		})) {
			if (ev.type === "exit") return;
			settle ??= setTimeout(() => stop.abort(), SETTLE_MS);
		}
	} catch (err) {
		if (ctx.deadline.cancelled()) throw err;
		if (stop.signal.aborted || ctx.deadline.expired()) return;
		throw err;
	} finally {
		clearTimeout(timer);
		clearTimeout(settle);
	}
}

export const execOutput = defineTool({
	name: "exec_output",
	title: "Read output",
	description:
		"Reads output and status: the tail, or with the previous answer's offsets the next bytes. wait_seconds waits for new output or exit. done: true when exited and all read.",
	toolset: "core",
	scopes: ["commands:read"],
	annotations: {
		readOnlyHint: true,
		destructiveHint: false,
		idempotentHint: true,
		openWorldHint: false,
	},
	sandboxArg: true,
	shape: {
		command_id: commandIdShape,
		stdout_offset: z
			.number()
			.int()
			.min(0)
			.max(MAX_OFFSET)
			.optional()
			.describe("Previous answer's; omit both for the tail"),
		stderr_offset: z
			.number()
			.int()
			.min(0)
			.max(MAX_OFFSET)
			.optional()
			.describe("Previous answer's"),
		max_bytes: outputBytesShape,
		wait_seconds: z
			.number()
			.int()
			.min(0)
			.max(MAX_WAIT_SECONDS)
			.optional()
			.describe("Seconds to wait (default 0)"),
	},
	async handler(args, ctx) {
		// The wait is measured from the start of the call, requests included,
		// and ends early enough for the reads after it (S11 7.5).
		const waitEndsAt =
			Date.now() +
			Math.max(
				0,
				Math.min(
					ctx.deadline.waitMs(args.wait_seconds ?? 0),
					ctx.deadline.remainingMs() - READS_MARGIN_MS,
				),
			);
		const path = { sandbox: args.sandbox, command: args.command_id };
		const max = args.max_bytes ?? DEFAULT_OUTPUT_BYTES;
		const forward =
			args.stdout_offset !== undefined || args.stderr_offset !== undefined;
		if (
			forward &&
			(args.stdout_offset === undefined || args.stderr_offset === undefined)
		) {
			// The missing stream would be read again from 0 (duplicated output).
			throw new ToolError({
				code: "validation",
				message: "stdout_offset and stderr_offset go together",
				hint: "pass both offsets of the previous answer, or none for the tail.",
			});
		}
		const asked: Record<Stream, number> = {
			stdout: args.stdout_offset ?? 0,
			stderr: args.stderr_offset ?? 0,
		};
		let c = await getCommand(ctx, path);
		const nothingNew = () =>
			STREAMS.every((s) => asked[s] >= streamState(c, s).size);
		if (
			(args.wait_seconds ?? 0) > 0 &&
			RUNNING_STATUSES.has(c.status) &&
			nothingNew()
		) {
			await waitForOutput(
				ctx,
				args.sandbox,
				args.command_id,
				asked,
				waitEndsAt,
			);
			c = await getCommand(ctx, path);
		}

		const state = {
			stdout: streamState(c, "stdout"),
			stderr: streamState(c, "stderr"),
		};
		for (const s of STREAMS) {
			if (forward && asked[s] > state[s].size) {
				throw new ToolError({
					code: "validation",
					message: `${s}_offset ${asked[s]} is past the end of ${s} (${state[s].size} bytes)`,
					hint: "pass the offsets of the previous answer, or none for the tail.",
				});
			}
		}
		// Tail: the last bytes still held. Forward: from the asked offsets.
		const tail = !forward && c.streams !== null;
		const begin = (s: Stream) =>
			tail
				? state[s].availableFrom
				: Math.max(asked[s], state[s].availableFrom);
		const budget = splitBudget(max, {
			stdout: state.stdout.size - begin("stdout"),
			stderr: state.stderr.size - begin("stderr"),
		});

		const spans = {} as Record<Stream, ByteSpan>;
		const availableFrom = {} as Record<Stream, number>;
		const ended = {} as Record<Stream, boolean>;
		for (const s of STREAMS) {
			const offset = tail ? state[s].size - budget[s] : asked[s];
			availableFrom[s] = state[s].availableFrom;
			ended[s] = state[s].end !== null;
			if (budget[s] > 0) {
				const chunk = await readOutput(ctx, path, s, offset, budget[s]);
				availableFrom[s] = chunk.availableFrom;
				ended[s] = chunk.end !== null && chunk.nextOffset >= chunk.end;
				spans[s] = {
					bytes: chunk.data,
					offset: chunk.offset,
					size: Math.max(state[s].size, chunk.end ?? 0, chunk.nextOffset),
					// A returned offset is a character boundary; a retention cut is not.
					atStart: chunk.offset === 0 || (forward && chunk.offset === offset),
					final: ended[s],
				};
			} else {
				const at = Math.max(offset, availableFrom[s]);
				spans[s] = {
					bytes: new Uint8Array(),
					offset: at,
					size: state[s].size,
					atStart: true,
					final: ended[s],
				};
			}
		}
		const windows = fitStreams(spans, tail ? "tail" : "head");
		const notes: string[] = [];
		for (const s of STREAMS) {
			const w = windows[s];
			const avail = availableFrom[s];
			if (forward && asked[s] < avail) {
				notes.push(
					`${s}: ${avail - asked[s]} bytes were dropped by retention; reading starts at ${avail}.`,
				);
			}
			const note = truncationNote(s, {
				...w,
				mode: tail ? "tail" : "forward",
			});
			if (note !== null && w.to > w.from) notes.push(note);
			state[s].end = ended[s] ? w.size : null;
		}

		const offsets = { stdout: windows.stdout.to, stderr: windows.stderr.to };
		const running = RUNNING_STATUSES.has(c.status);
		const done =
			!running &&
			STREAMS.every((s) => offsets[s] >= (state[s].end ?? state[s].size));
		if (running) notes.push(continueHint(c.id, offsets));
		else if (!done) {
			notes.push(
				`more output: call exec_output with stdout_offset=${offsets.stdout}, stderr_offset=${offsets.stderr}`,
			);
		}
		return answer(
			{
				command_id: c.id,
				status: c.status,
				exit_code: c.exitCode,
				signal: c.signal,
				stdout: streamView(windows.stdout, availableFrom.stdout),
				stderr: streamView(windows.stderr, availableFrom.stderr),
				stdout_offset: offsets.stdout,
				stderr_offset: offsets.stderr,
				done: done ? true : undefined,
			},
			notes,
			windows,
		);
	},
});

export const execList = defineTool({
	name: "exec_list",
	title: "List commands",
	description:
		"Lists a sandbox's commands, newest first; running only unless status=all.",
	toolset: "core",
	scopes: ["commands:read"],
	annotations: {
		readOnlyHint: true,
		destructiveHint: false,
		idempotentHint: true,
		openWorldHint: false,
	},
	sandboxArg: true,
	shape: {
		status: z.enum(["running", "all"]).optional().describe("Default running"),
		limit: z
			.number()
			.int()
			.min(1)
			.max(100)
			.optional()
			.describe("Page size (default 20)"),
		cursor: z
			.string()
			.min(1)
			.optional()
			.describe("next_cursor of the previous page"),
	},
	async handler(args, ctx) {
		const { data } = await ctx.sbx().raw.GET(COMMANDS_PATH, {
			params: {
				path: { sandbox: args.sandbox },
				query: compact({
					status: args.status === "all" ? undefined : "running",
					limit: args.limit ?? 20,
					cursor: args.cursor,
				}),
			},
			...ctx.call,
		});
		const rows = data.data.map((c) => {
			const line = c.command ?? (c.argv ?? []).join(" ");
			return {
				id: c.id,
				status: c.status,
				mode: c.mode,
				command:
					line.length > LIST_COMMAND_CHARS
						? `${line.slice(0, LIST_COMMAND_CHARS)}...`
						: line,
				exit_code: c.exitCode,
				created_at: c.createdAt,
			};
		});
		const notes: string[] = [];
		if (rows.length === 0) notes.push("no command matches");
		if (data.nextCursor !== null) {
			notes.push("more commands: call exec_list again with cursor=next_cursor");
		}
		return toolText(
			{ count: rows.length, commands: rows, next_cursor: data.nextCursor },
			notes.length > 0 ? [notes.join("\n")] : [],
		);
	},
});

export const execKill = defineTool({
	name: "exec_kill",
	title: "Stop a command",
	description:
		"SIGTERM, then SIGKILL after 10 s (default); or SIGINT or SIGKILL.",
	toolset: "core",
	scopes: ["commands:exec"],
	annotations: {
		readOnlyHint: false,
		destructiveHint: false,
		idempotentHint: true,
		openWorldHint: true,
	},
	sandboxArg: true,
	shape: {
		command_id: commandIdShape,
		signal: z
			.enum(["SIGTERM", "SIGINT", "SIGKILL"])
			.optional()
			.describe("Signal (default SIGTERM)"),
	},
	async handler(args, ctx) {
		const path = { sandbox: args.sandbox, command: args.command_id };
		const signal = args.signal ?? "SIGTERM";
		const { data } =
			signal === "SIGTERM"
				? await ctx.sbx().raw.POST(`${COMMAND_PATH}/kill`, {
						params: { path },
						body: { graceMs: SIGTERM_GRACE_MS },
						...ctx.call,
					})
				: await ctx.sbx().raw.POST(`${COMMAND_PATH}/signal`, {
						params: { path },
						body: { signal },
						...ctx.call,
					});
		const note =
			signal === "SIGTERM"
				? `SIGTERM sent; SIGKILL follows after ${SIGTERM_GRACE_MS / 1000} s if it still runs.`
				: `${signal} sent.`;
		return toolText(
			{
				command_id: data.id,
				status: data.status,
				exit_code: data.exitCode,
				signal: data.signal,
			},
			[`${note} exec_output shows the final status.`],
		);
	},
});

export const COMMAND_TOOLS = [
	execRun,
	execStart,
	execOutput,
	execList,
	execKill,
];
