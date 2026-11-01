// The output contract of `sbx` (S7 §14.3).
// - JSON when stdout is not a terminal, with --json or SBX_OUTPUT=json;
//   --human (SBX_OUTPUT=human) turns it off. The flag wins over the env.
// - result(v): one JSON value (the API resource as is) or text.
// - event(name, v): a JSON Lines record whose discriminator is `event`.
// - error(err): in JSON mode the last line of stdout is
//   {"event":"error",code,message,retryable,details,requestId}; the text for a
//   person goes to stderr. Commands whose stdout is data (`rawData`: exec,
//   run, logs, cp, push, auth token) print that line to stderr unless the
//   --json flag was given; a protocol command (`sbx mcp`) always does.
// - Raw-data commands switch to JSON (NDJSON frames) only with the --json
//   flag, never with SBX_OUTPUT=json (ruling R25): `sbx exec … > file`
//   writes bytes whatever the env says.
// - data()/errData()/event() wait for 'drain' when the stream is full, so
//   large piped output does not pile up in memory.
// - A reader that goes away (`sbx exec … | head -1`: EPIPE, 'error' or
//   'close' on stdout) ends the wait: data() rejects with OutputClosedError,
//   nothing more is written to stdout, and the runner exits 141 (128 +
//   SIGPIPE, what a shell reports for a tool killed by a broken pipe) without
//   an error message. A closed stderr is ignored.

import { SbxError } from "@sbx/sdk";

export interface Writer {
	/** false: the stream is full; wait for 'drain' (Node streams). */
	write(s: string | Uint8Array): unknown;
	once?(event: string, listener: () => void): unknown;
	/** 'error' and 'close' tell that the reader went away. */
	on?(event: string, listener: () => void): unknown;
	off?(event: string, listener: () => void): unknown;
}

/** Exit code when the reader of stdout went away (128 + SIGPIPE). */
export const EXIT_BROKEN_PIPE = 141;

/** stdout was closed by its reader (EPIPE); the command stops quietly. */
export class OutputClosedError extends Error {
	constructor() {
		super("stdout was closed by its reader");
		this.name = "OutputClosedError";
	}
}

/** A writer and whether its reader has gone away. */
class Sink {
	closed = false;
	readonly #w: Writer;
	/** The one wait for 'drain' that all pending writes share. */
	#pending: Promise<void> | null = null;
	/** Ends #pending (drain or the reader leaving); null when none is pending. */
	#release: (() => void) | null = null;

	constructor(w: Writer) {
		this.#w = w;
		const onGone = () => {
			this.closed = true;
			this.#release?.();
		};
		// The listener also keeps an EPIPE from being an uncaught error.
		w.on?.("error", onGone);
		w.on?.("close", onGone);
	}

	write(chunk: string | Uint8Array): boolean {
		if (this.closed) return true;
		try {
			return this.#w.write(chunk) !== false;
		} catch {
			// A synchronous EPIPE (some runtimes): the reader is gone.
			this.closed = true;
			return true;
		}
	}

	/**
	 * Writes; when the stream is full, waits for 'drain' or the reader leaving.
	 * Writes made while the stream is full share one wait (one 'drain'
	 * listener), since a 'drain' means everything written so far was flushed.
	 */
	async writeDrained(chunk: string | Uint8Array): Promise<void> {
		if (this.write(chunk) || typeof this.#w.once !== "function") return;
		if (this.closed) return;
		this.#pending ??= new Promise<void>((resolve) => {
			const done = () => {
				this.#w.off?.("drain", done);
				this.#pending = null;
				this.#release = null;
				resolve();
			};
			this.#release = done;
			this.#w.once?.("drain", done);
		});
		await this.#pending;
	}
}

export interface OutputOptions {
	stdout: Writer;
	stderr: Writer;
	/** stdout is a terminal. */
	isTTY: boolean;
	/** --json given (or SBX_OUTPUT=json). */
	explicitJson?: boolean;
	/** --human given (or SBX_OUTPUT=human). */
	explicitHuman?: boolean;
	/** The --json flag itself was given (not SBX_OUTPUT). */
	jsonFlag?: boolean;
}

export interface ErrorPayload {
	code: string;
	message: string;
	retryable: boolean;
	details: Record<string, unknown>;
	requestId: string | null;
}

export type Human<T> = (v: T) => string;

export function errorPayload(err: unknown): ErrorPayload {
	if (err instanceof SbxError) {
		return {
			code: err.code,
			message: err.message,
			retryable: err.retryable,
			details: err.details,
			requestId: err.requestId,
		};
	}
	return {
		code: "internal",
		message: err instanceof Error ? err.message : String(err),
		retryable: false,
		details: {},
		requestId: null,
	};
}

export class Output {
	/** Print JSON (one value, or JSON Lines for events). */
	readonly json: boolean;
	/** --json was asked for, not only implied by a non-terminal stdout. */
	readonly explicitJson: boolean;
	/**
	 * The --json flag was given (and not --human): the only switch of raw-data
	 * commands to JSON frames (ruling R25).
	 */
	readonly jsonFlag: boolean;
	/** stdout carries data of the command (set by the command runner). */
	rawData = false;
	/** stdout carries a protocol (`sbx mcp`): an error never goes there, not even with --json. */
	protocol = false;
	readonly #stdout: Sink;
	readonly #stderr: Sink;

	constructor(o: OutputOptions) {
		this.#stdout = new Sink(o.stdout);
		this.#stderr = new Sink(o.stderr);
		this.explicitJson = o.explicitJson === true && o.explicitHuman !== true;
		this.jsonFlag = o.jsonFlag === true && o.explicitHuman !== true;
		this.json = this.explicitJson || (!o.isTTY && o.explicitHuman !== true);
	}

	/** The result of a command: the value as JSON, or `human(v)` as text. */
	result<T>(v: T, human: Human<T> = formatHuman): void {
		if (this.json) this.#line(this.#stdout, JSON.stringify(v));
		else this.#text(this.#stdout, human(v));
	}

	/**
	 * A JSON Lines record `{"event": name, ...v}`; text in human mode.
	 * Resolves once the stream took it (never rejects: a stream of frames
	 * checks `throwIfClosed()` after it).
	 */
	event<T extends object>(name: string, v: T, human?: Human<T>): Promise<void> {
		if (this.json) {
			return this.#stdout.writeDrained(
				`${JSON.stringify({ event: name, ...v })}\n`,
			);
		}
		if (human !== undefined) this.#text(this.#stdout, human(v));
		return Promise.resolve();
	}

	/**
	 * Data of a raw command, written as is (resolves once it is taken);
	 * rejects with OutputClosedError once the reader of stdout is gone.
	 */
	async data(chunk: string | Uint8Array): Promise<void> {
		this.throwIfClosed();
		await this.#stdout.writeDrained(chunk);
		this.throwIfClosed();
	}

	/** Data of a raw command meant for stderr (exec's stderr), as is. */
	errData(chunk: string | Uint8Array): Promise<void> {
		return this.#stderr.writeDrained(chunk);
	}

	/** The reader of stdout went away (EPIPE). */
	get stdoutClosed(): boolean {
		return this.#stdout.closed;
	}

	/** Throws OutputClosedError when the reader of stdout went away. */
	throwIfClosed(): void {
		if (this.#stdout.closed) throw new OutputClosedError();
	}

	/** A question for the person on stderr, without a new line. */
	prompt(question: string): void {
		this.#stderr.write(question);
	}

	/** A note for the person (progress, prompts): always stderr. */
	info(message: string): void {
		this.#line(this.#stderr, message);
	}

	warn(message: string): void {
		this.#line(this.#stderr, `warning: ${message}`);
	}

	error(err: unknown): void {
		const p = errorPayload(err);
		if (!this.json) {
			this.#line(this.#stderr, humanError(p));
			return;
		}
		const line = JSON.stringify({ event: "error", ...p });
		if (this.protocol || (this.rawData && !this.jsonFlag)) {
			this.#line(this.#stderr, line);
			return;
		}
		this.#line(this.#stderr, humanError(p));
		this.#line(this.#stdout, line);
	}

	#text(w: Sink, s: string): void {
		if (s !== "") this.#line(w, s.replace(/\n+$/, ""));
	}

	#line(w: Sink, s: string): void {
		w.write(`${s}\n`);
	}
}

/** The next step for a person after an API error, by its code (stderr only). */
const HINTS: Record<string, string> = {
	// A running Windows sandbox is forked or saved only from a stopped VM (S9 §24.8).
	snapshot_requires_stop:
		"use --force-stop to stop the sandbox, take the snapshot and start it again (running commands and sessions are interrupted)",
};

function humanError(p: ErrorPayload): string {
	const extra = [p.code, p.requestId].filter((x) => x !== null).join(", ");
	const hint = HINTS[p.code];
	return `sbx: ${p.message} (${extra})${hint === undefined ? "" : `\nhint: ${hint}`}`;
}

/** Plain text of a value: `key: value` lines, nested objects indented. */
export function formatHuman(v: unknown, indent = ""): string {
	if (v === null || v === undefined) return "";
	if (typeof v !== "object") return `${indent}${String(v)}`;
	if (Array.isArray(v)) {
		return v
			.map((x) =>
				typeof x === "object" && x !== null
					? `${indent}-\n${formatHuman(x, `${indent}  `)}`
					: `${indent}- ${String(x)}`,
			)
			.join("\n");
	}
	const lines: string[] = [];
	for (const [k, x] of Object.entries(v)) {
		if (x === null || x === undefined) continue;
		if (typeof x === "object") {
			const inner = formatHuman(x, `${indent}  `);
			if (inner !== "") lines.push(`${indent}${k}:`, inner);
		} else {
			lines.push(`${indent}${k}: ${String(x)}`);
		}
	}
	return lines.join("\n");
}

/** Whether the arguments, env and terminal ask for JSON (see Output). */
export function outputMode(
	argv: readonly string[],
	env: Record<string, string | undefined>,
): { explicitJson: boolean; explicitHuman: boolean; jsonFlag: boolean } {
	let json = false;
	let human = false;
	for (const a of argv) {
		if (a === "--") break;
		if (a === "--json") json = true;
		else if (a === "--human") human = true;
	}
	const jsonFlag = json && !human;
	if (!json && !human) {
		if (env.SBX_OUTPUT === "json") json = true;
		else if (env.SBX_OUTPUT === "human") human = true;
	}
	return { explicitJson: json && !human, explicitHuman: human, jsonFlag };
}
