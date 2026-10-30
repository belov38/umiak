// PTY over WebSocket, subprotocol sbx.pty.v1 (S7 §10.2).
//
// The WebSocket comes from `SbxOptions.webSocket` (default: the global
// WebSocket with `{protocols, headers}`, undici in Node, Bun) and carries
// `Authorization: Bearer`. A factory can add TLS options (a private CA) or a
// proxy. Browsers cannot set that header: there the PTY is reached only
// through the dashboard origin, not this SDK.
//
// The connection is reopened by offset (the bytes received so far) after a
// drop, close 1012 (server shutdown), 1011, 4503 (agent unavailable) or a
// failed handshake; 20 connections in a row without new bytes end it.
// 4401/4403/4404/4409/1008 are final. Input written while disconnected is
// queued (up to 1 MiB) and sent after the next `attached`; input in flight
// when a connection drops may be lost, never applied twice.

import {
	type CallOptions,
	type ClientCore,
	defaultWebSocket,
} from "./client.ts";
import {
	Command,
	callOf,
	type ExitEvent,
	frameError,
	type SandboxRef,
	STREAM_MAX_FAILURES,
} from "./commands.ts";
import { SbxError, UNSUPPORTED_RUNTIME } from "./errors.ts";
import { newIdempotencyKey } from "./ids.ts";
import { isRetryable, retryDelayMs } from "./retry.ts";

export const PTY_SUBPROTOCOL = "sbx.pty.v1";

export interface PtyOptions extends CallOptions {
	cols?: number;
	rows?: number;
	/** Shell command line; null or absent: the user's login shell. */
	command?: string | null;
	cwd?: string | null;
	env?: Record<string, string>;
	user?: string;
	term?: string;
}

export interface PtyConnectOptions extends CallOptions {
	/** Start at this output offset (default 0: the whole scrollback the agent keeps). */
	offset?: number;
	/** Or start this many bytes before the end (e.g. 65 536 for a terminal redraw). */
	tailBytes?: number;
}

/** The exit frame of the terminal (`ptyOffset` is the final output size). */
export type PtyExit = ExitEvent;

const FINAL_CLOSE_CODES: Record<number, string> = {
	4401: "unauthorized",
	4403: "forbidden",
	4404: "not_found",
	4409: "sandbox_not_ready",
	1008: "validation",
};
const MAX_QUEUED_INPUT = 1024 * 1024;

/** Creates a terminal (POST .../ptys) and connects to it. */
export async function openPty(
	sb: SandboxRef,
	opts: PtyOptions = {},
): Promise<Pty> {
	const body: Record<string, unknown> = {};
	for (const k of ["cols", "rows", "command", "cwd", "env", "user", "term"]) {
		const v = (opts as Record<string, unknown>)[k];
		if (v !== undefined) body[k] = v;
	}
	const { data } = await sb.core.raw.POST("/v1/sandboxes/{sandbox}/ptys", {
		params: { path: { sandbox: sb.id } },
		body,
		...callOf(opts),
		idempotencyKey: opts.idempotencyKey ?? newIdempotencyKey(),
	});
	return connectPty(sb, new Command(sb, data.id, data), callOf(opts));
}

/** Connects to an existing terminal command. */
export async function connectPty(
	sb: SandboxRef,
	command: Command,
	opts: PtyConnectOptions = {},
): Promise<Pty> {
	const pty = new Pty(sb.core, command, opts);
	await pty.ready;
	return pty;
}

export class Pty {
	readonly command: Command;
	/** Resolves with the exit frame; rejects on a final error or `close()`. */
	readonly exited: Promise<PtyExit>;
	/** Resolves once the first connection is attached. */
	readonly ready: Promise<void>;

	readonly #core: ClientCore;
	readonly #path: string;
	#offset: number;
	#tailBytes: number | undefined;
	#ws: WebSocket | null = null;
	#attached = false;
	#done = false;
	#failures = 0;
	#lastError: SbxError | undefined;
	#size: { cols: number; rows: number } | undefined;
	#queue: Uint8Array[] = [];
	#queued = 0;
	#timer: ReturnType<typeof setTimeout> | undefined;
	readonly #listeners = new Set<(data: Uint8Array) => void>();
	#resolveExit!: (e: PtyExit) => void;
	#rejectExit!: (e: unknown) => void;
	#resolveReady!: () => void;

	constructor(core: ClientCore, command: Command, opts: PtyConnectOptions) {
		this.#core = core;
		this.command = command;
		this.#path = `/v1/sandboxes/${encodeURIComponent(command.sandboxId)}/ptys/${encodeURIComponent(command.id)}/connect`;
		this.#offset = opts.offset ?? 0;
		this.#tailBytes = opts.tailBytes;
		this.exited = new Promise<PtyExit>((resolve, reject) => {
			this.#resolveExit = resolve;
			this.#rejectExit = reject;
		});
		// Not awaiting `exited` must not make an unhandled rejection.
		this.exited.catch(() => {});
		this.ready = new Promise<void>((resolve, reject) => {
			this.#resolveReady = resolve;
			this.exited.then(() => resolve(), reject);
		});
		this.ready.catch(() => {});
		const { signal } = opts;
		if (signal?.aborted) {
			this.#finish(signal.reason);
		} else {
			signal?.addEventListener("abort", () => this.#finish(signal.reason), {
				once: true,
			});
			void this.#connect(signal);
		}
	}

	/** Output bytes received so far (the offset the next connection starts at). */
	get offset(): number {
		return this.#offset;
	}

	/** Calls `cb` with every chunk of output; returns the unsubscribe function. */
	onData(cb: (data: Uint8Array) => void): () => void {
		this.#listeners.add(cb);
		return () => this.#listeners.delete(cb);
	}

	/**
	 * Sends input (keystrokes or pasted text). While reconnecting, input is
	 * queued up to 1 MiB; more throws `pty_input_overflow` (nothing is dropped
	 * silently).
	 */
	write(data: string | Uint8Array): void {
		if (this.#done) return;
		const bytes =
			typeof data === "string" ? new TextEncoder().encode(data) : data;
		if (bytes.length === 0) return;
		const ws = this.#ws;
		if (ws !== null && this.#attached && ws.readyState === WebSocket.OPEN) {
			ws.send(bytes as Uint8Array<ArrayBuffer>);
			return;
		}
		if (this.#queued + bytes.length > MAX_QUEUED_INPUT) {
			throw new SbxError({
				status: 0,
				code: "pty_input_overflow",
				message: `the PTY is reconnecting and ${this.#queued} bytes of input are queued already (at most ${MAX_QUEUED_INPUT}); write again later`,
				retryable: true,
			});
		}
		this.#queue.push(bytes);
		this.#queued += bytes.length;
	}

	/** Resizes the terminal (also after every reconnect). */
	resize(cols: number, rows: number): void {
		this.#size = { cols, rows };
		this.#sendResize();
	}

	/**
	 * Closes the connection. The terminal keeps running until it exits (the
	 * agent ends it after 10 min without a client); use `kill()` to end it.
	 */
	close(): void {
		this.#finish(
			new SbxError({
				status: 0,
				code: "pty_closed",
				message: "the PTY connection was closed by the client",
				retryable: false,
			}),
		);
	}

	/** Ends the terminal command (SIGTERM, then SIGKILL) and waits for its exit. */
	async kill(opts: CallOptions & { graceMs?: number } = {}): Promise<void> {
		await this.command.kill(opts);
	}

	#sendResize() {
		const ws = this.#ws;
		if (this.#size === undefined || ws === null || !this.#attached) return;
		if (ws.readyState !== WebSocket.OPEN) return;
		ws.send(JSON.stringify({ type: "resize", ...this.#size }));
	}

	#finish(err: unknown) {
		if (this.#done) return;
		this.#done = true;
		clearTimeout(this.#timer);
		this.#rejectExit(err);
		this.#ws?.close(1000);
		this.#ws = null;
	}

	async #url(): Promise<{ url: string; headers: Record<string, string> }> {
		const creds = await this.#core.credentials();
		const token = await creds.getToken(false);
		const base = new URL(creds.baseUrl);
		base.protocol = base.protocol === "https:" ? "wss:" : "ws:";
		const url = new URL(`${base.toString().replace(/\/+$/, "")}${this.#path}`);
		if (this.#tailBytes !== undefined) {
			url.searchParams.set("tailBytes", String(this.#tailBytes));
		} else {
			url.searchParams.set("offset", String(this.#offset));
		}
		const headers: Record<string, string> = {
			Authorization: `Bearer ${token}`,
			"User-Agent": this.#core.userAgent,
		};
		if (creds.team !== undefined) headers["Sbx-Team"] = creds.team;
		return { url: url.toString(), headers };
	}

	async #connect(signal?: AbortSignal) {
		if (this.#done) return;
		let target: { url: string; headers: Record<string, string> };
		try {
			target = await this.#url();
		} catch (err) {
			if (signal?.aborted) return;
			if (err instanceof SbxError && err.retryable) {
				this.#lastError = err;
				this.#retry(false, false);
			} else {
				this.#finish(err);
			}
			return;
		}
		if (this.#done) return;
		let progressed = false;
		let immediate = false;
		let opened = false;
		this.#attached = false;
		let ws: WebSocket;
		try {
			ws = (this.#core.webSocket ?? defaultWebSocket)(target.url, {
				protocols: [PTY_SUBPROTOCOL],
				headers: target.headers,
			});
		} catch (err) {
			this.#finish(
				new SbxError({
					status: 0,
					code: UNSUPPORTED_RUNTIME,
					message: `cannot open the PTY WebSocket: ${err instanceof Error ? err.message : String(err)}`,
					retryable: false,
					cause: err,
				}),
			);
			return;
		}
		ws.binaryType = "arraybuffer";
		this.#ws = ws;
		ws.onopen = () => {
			opened = true;
		};
		ws.onmessage = (ev: MessageEvent) => {
			if (this.#ws !== ws) return;
			if (typeof ev.data !== "string") {
				const bytes = new Uint8Array(ev.data as ArrayBuffer);
				this.#offset += bytes.length;
				if (bytes.length > 0) progressed = true;
				for (const cb of this.#listeners) cb(bytes);
				return;
			}
			let f: Record<string, unknown>;
			try {
				f = JSON.parse(ev.data) as Record<string, unknown>;
			} catch {
				return;
			}
			switch (f.type) {
				case "attached":
					if (typeof f.offset === "number") this.#offset = f.offset;
					this.#tailBytes = undefined;
					this.#attached = true;
					this.#flush(ws);
					this.#sendResize();
					this.#resolveReady();
					break;
				case "truncated":
					if (typeof f.availableFrom === "number") {
						this.#offset = f.availableFrom;
						progressed = true;
					}
					break;
				case "exit":
					this.#exit(f);
					break;
				case "error":
					this.#lastError = frameError(f);
					break;
				case "reconnect":
					if (typeof f.offset === "number") this.#offset = f.offset;
					immediate = true;
					break;
				default:
					break;
			}
		};
		ws.onclose = (ev: CloseEvent) => {
			if (this.#ws !== ws) return;
			this.#ws = null;
			this.#attached = false;
			if (this.#done) return;
			const final = FINAL_CLOSE_CODES[ev.code];
			if (final !== undefined) {
				this.#finish(
					this.#lastError ??
						new SbxError({
							status: 0,
							code: final,
							message: `the PTY connection was closed (${ev.code}${ev.reason ? `: ${ev.reason}` : ""})`,
							retryable: false,
						}),
				);
				return;
			}
			if (!opened) {
				// The handshake was refused; the WebSocket API hides the answer.
				void this.#probe().then((final) => {
					if (final === null) this.#retry(false, false);
					else this.#finish(final);
				});
				return;
			}
			this.#retry(progressed, immediate || ev.code === 1012);
		};
	}

	/**
	 * After a refused handshake: the same route as plain HTTP shows why. 426
	 * (upgrade required) means the request itself is fine: retry. A final
	 * answer (401, 403, 404, ...) ends the PTY; null: retry.
	 */
	async #probe(): Promise<SbxError | null> {
		try {
			await this.#core.raw.GET(
				"/v1/sandboxes/{sandbox}/ptys/{command}/connect",
				{
					params: {
						path: { sandbox: this.command.sandboxId, command: this.command.id },
						query: { offset: this.#offset },
					},
					retryBudgetMs: 0,
				},
			);
			return null;
		} catch (err) {
			if (!(err instanceof SbxError)) return null;
			if (err.status === 426) return null;
			if (isRetryable(err, true)) {
				this.#lastError = err;
				return null;
			}
			return err;
		}
	}

	#retry(progressed: boolean, immediate: boolean) {
		this.#failures = progressed ? 0 : this.#failures + 1;
		if (this.#failures >= STREAM_MAX_FAILURES) {
			this.#finish(
				this.#lastError ??
					new SbxError({
						status: 0,
						code: "network_error",
						message: `the PTY connection failed ${this.#failures} times in a row`,
						retryable: true,
					}),
			);
			return;
		}
		const wait =
			immediate && this.#failures <= 1
				? 0
				: retryDelayMs(this.#lastError, Math.max(0, this.#failures - 1));
		this.#lastError = undefined;
		this.#timer = setTimeout(() => void this.#connect(), wait);
	}

	#flush(ws: WebSocket) {
		for (const b of this.#queue) ws.send(b as Uint8Array<ArrayBuffer>);
		this.#queue = [];
		this.#queued = 0;
	}

	#exit(f: Record<string, unknown>) {
		if (this.#done) return;
		this.#done = true;
		const ev: PtyExit = {
			type: "exit",
			status: f.status as PtyExit["status"],
			exitCode: typeof f.exitCode === "number" ? f.exitCode : null,
			signal: typeof f.signal === "string" ? f.signal : null,
			reason: typeof f.reason === "string" ? f.reason : null,
			stdoutOffset: Number(f.stdoutOffset ?? 0),
			stderrOffset: Number(f.stderrOffset ?? 0),
		};
		if (typeof f.ptyOffset === "number") ev.ptyOffset = f.ptyOffset;
		this.#resolveExit(ev);
		// The server closes with 1000 after exit; do not wait for it.
		this.#ws?.close(1000);
		this.#ws = null;
	}
}
