// The output contract of `sbx` (S7 §14.3).
// - JSON when stdout is not a terminal, with --json or SBX_OUTPUT=json;
//   --human (SBX_OUTPUT=human) turns it off. The flag wins over the env.
// - result(v): one JSON value (the API resource as is) or text.
// - event(name, v): a JSON Lines record whose discriminator is `event`.
// - error(err): in JSON mode the last line of stdout is
//   {"event":"error",code,message,retryable,details,requestId}; the text for a
//   person goes to stderr. Commands whose stdout is data (`rawData`: exec,
//   run, logs, cp, push, auth token) print that line to stderr unless the
//   --json flag was given.
// - Raw-data commands switch to JSON (NDJSON frames) only with the --json
//   flag, never with SBX_OUTPUT=json (ruling R25): `sbx exec … > file`
//   writes bytes whatever the env says.
// - data()/errData() wait for 'drain' when the stream is full, so large
//   piped output does not pile up in memory.

import { SbxError } from "@sbx/sdk";

export interface Writer {
	/** false: the stream is full; wait for 'drain' (Node streams). */
	write(s: string | Uint8Array): unknown;
	once?(event: "drain", listener: () => void): unknown;
}

/** Writes and, when the stream reports it is full, waits for 'drain'. */
async function writeDrained(
	w: Writer,
	chunk: string | Uint8Array,
): Promise<void> {
	if (w.write(chunk) !== false || typeof w.once !== "function") return;
	await new Promise<void>((resolve) => {
		w.once?.("drain", resolve);
	});
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
	readonly #stdout: Writer;
	readonly #stderr: Writer;

	constructor(o: OutputOptions) {
		this.#stdout = o.stdout;
		this.#stderr = o.stderr;
		this.explicitJson = o.explicitJson === true && o.explicitHuman !== true;
		this.jsonFlag = o.jsonFlag === true && o.explicitHuman !== true;
		this.json = this.explicitJson || (!o.isTTY && o.explicitHuman !== true);
	}

	/** The result of a command: the value as JSON, or `human(v)` as text. */
	result<T>(v: T, human: Human<T> = formatHuman): void {
		if (this.json) this.#line(this.#stdout, JSON.stringify(v));
		else this.#text(this.#stdout, human(v));
	}

	/** A JSON Lines record `{"event": name, ...v}`; text in human mode. */
	event<T extends object>(name: string, v: T, human?: Human<T>): void {
		if (this.json) {
			this.#line(this.#stdout, JSON.stringify({ event: name, ...v }));
		} else if (human !== undefined) {
			this.#text(this.#stdout, human(v));
		}
	}

	/** Data of a raw command, written as is (resolves once it is taken). */
	data(chunk: string | Uint8Array): Promise<void> {
		return writeDrained(this.#stdout, chunk);
	}

	/** Data of a raw command meant for stderr (exec's stderr), as is. */
	errData(chunk: string | Uint8Array): Promise<void> {
		return writeDrained(this.#stderr, chunk);
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
		if (this.rawData && !this.jsonFlag) {
			this.#line(this.#stderr, line);
			return;
		}
		this.#line(this.#stderr, humanError(p));
		this.#line(this.#stdout, line);
	}

	#text(w: Writer, s: string): void {
		if (s !== "") this.#line(w, s.replace(/\n+$/, ""));
	}

	#line(w: Writer, s: string): void {
		w.write(`${s}\n`);
	}
}

function humanError(p: ErrorPayload): string {
	const extra = [p.code, p.requestId].filter((x) => x !== null).join(", ");
	return `sbx: ${p.message} (${extra})`;
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
